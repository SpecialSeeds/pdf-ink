import {
	BlendMode,
	LineCapStyle,
	PDFDocument,
	type PDFFont,
	type PDFImage,
	type PDFPage,
	degrees,
	rgb,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { Vec2 } from 'perfect-freehand';
import {
	type ImageItem,
	type Item,
	type PathItem,
	type ShapeItem,
	type Stroke,
	type TextItem,
	inZOrder,
} from '../core/items';
import { pathGeometry, simplifyPathCommands, simplifyRing } from '../core/path';
import {
	DEFAULT_EXPORT_QUALITY,
	type ExportQuality,
	QUALITY_PROFILES,
	type QualityProfile,
	formatCoordinate,
} from '../core/export-quality';
import {
	HEADER_DATE_SIZE,
	HEADER_RULE_WIDTH,
	HEADER_TITLE_SIZE,
	type HeaderText,
	headerLayout,
	reserveHeaderBand,
} from '../core/header';
import { type InsertedPage, type PageKey, orderPages, pageOrigin } from '../core/pages';
import {
	type PathCommand,
	type PathSegment,
	shapeGeometry,
	shapeLineStyle,
} from '../core/shapes';
import { type PageTemplate, templateGeometry, translateTemplate } from '../core/templates';
import { MIN_VISIBLE_STROKE_CSS, outlineToPathData, strokeOutlinePdf } from '../core/stroke';
import { layoutTextLines } from '../core/text-layout';
import { normalizeHex, parseHex } from '../core/color';
import {
	DEFAULT_PAGE_THEMES,
	type HighlighterBlend,
	type PageTheme,
	type PageThemes,
	type ThemeName,
	highlighterBlend,
	renderColor,
	themeForPage,
} from '../core/theme';
import { embeddedFontBytes } from './font';
import { addInkAnnotation } from './ink-annotations';

/** A colour string the exporter understands, as 0–1 channels. Black for junk. */
export function parseColor(color: string): { r: number; g: number; b: number } {
	const rgb = parseHex(color);
	if (!rgb) return { r: 0, g: 0, b: 0 };
	return { r: rgb.r / 255, g: rgb.g / 255, b: rgb.b / 255 };
}

function toRgb(color: string): ReturnType<typeof rgb> {
	const { r, g, b } = parseColor(color);
	return rgb(r, g, b);
}

/**
 * pdf-lib's `drawSvgPath` reads its path in a y-DOWN space anchored at the given
 * point. Negating y and anchoring at the origin therefore places a PDF-space path
 * exactly where it belongs.
 */
function toSvgSpace(pathData: string): string {
	return pathData.replace(
		/(-?\d*\.?\d+)\s+(-?\d*\.?\d+)/g,
		(_match, x: string, y: string) => `${x} ${String(-Number(y))}`,
	);
}

/**
 * A stroke's outline for export: the screen's own outline, worked out in
 * quarter points (`strokeOutlinePdf`), never at the scale of a point.
 * perfect-freehand's fixed lengths are in units: it draws the last 3 units of a
 * stroke as one straight chord and needs a unit between kept points. In whole
 * points that is 3 pt, half a letter of small handwriting, so every hook at a
 * stroke's end became a chord that twisted into a hairline and a loose dot, and
 * a stroke under 3 pt became a blob. The narrowest width stays 1.4 pt, as before.
 */
export function exportStrokeOutline(stroke: Stroke): Vec2[] {
	return strokeOutlinePdf(stroke, MIN_VISIBLE_STROKE_CSS);
}

function drawStroke(
	page: PDFPage,
	stroke: Stroke,
	blend: HighlighterBlend,
	quality: QualityProfile,
): void {
	const outline = exportStrokeOutline(stroke);
	if (outline.length === 0) return;
	// The outline is already written to hundredths at full quality, as on screen.
	const simplified = simplifyRing(outline, quality.inkTolerance);
	page.drawSvgPath(toSvgSpace(outlineToPathData(simplified, quality.decimals ?? 2)), {
		// drawSvgPath reads its path y-DOWN from the anchor, so the path is emitted
		// with y negated and anchored at the origin. Verified by rasterising against
		// the cropped-MediaBox and rotated fixtures: absolute user-space coordinates
		// land correctly, and a non-zero MediaBox origin needs no adjustment.
		x: 0,
		y: 0,
		color: toRgb(stroke.color),
		opacity: stroke.opacity,
		borderWidth: 0,
		// A highlighter multiplies with light paper, exactly as it does on screen, so
		// text stays legible through it instead of being washed out — and screens
		// over dark paper, where multiplying would leave nothing to see.
		blendMode:
			stroke.tool !== 'highlighter'
				? BlendMode.Normal
				: blend === 'screen'
					? BlendMode.Screen
					: BlendMode.Multiply,
	});
}

function drawSegment(
	page: PDFPage,
	shape: ShapeItem,
	segment: PathSegment,
	decimals: number | null,
): void {
	const pathData = toSvgSpace(segmentPathData(segment.commands, decimals));
	if (pathData.length === 0) return;

	if (segment.fill === true) {
		// Arrowheads are solid in the outline colour.
		page.drawSvgPath(pathData, {
			x: 0,
			y: 0,
			color: toRgb(shape.color),
			opacity: shape.opacity,
			borderWidth: 0,
		});
		return;
	}
	page.drawSvgPath(pathData, {
		x: 0,
		y: 0,
		borderColor: toRgb(shape.color),
		borderWidth: shape.width,
		borderOpacity: shape.opacity,
		borderDashArray: segment.dash ? [...segment.dash] : undefined,
		// A zero-length dash is a dot, and only a round cap makes it visible.
		...(segment.dash?.[0] === 0 ? { borderLineCap: LineCapStyle.Round } : {}),
		...(shape.fill === null
			? {}
			: { color: toRgb(shape.fill), opacity: shape.opacity }),
	});
}

function segmentPathData(commands: readonly PathCommand[], decimals: number | null): string {
	const n = (value: number): string => formatCoordinate(value, decimals);
	const parts: string[] = [];
	for (const command of commands) {
		if (command.op === 'move') parts.push(`M ${n(command.x)} ${n(command.y)}`);
		else if (command.op === 'line') parts.push(`L ${n(command.x)} ${n(command.y)}`);
		else if (command.op === 'cubic') {
			parts.push(
				`C ${n(command.x1)} ${n(command.y1)} ${n(command.x2)} ${n(command.y2)} ${n(command.x)} ${n(command.y)}`,
			);
		} else parts.push('Z');
	}
	return parts.join(' ');
}

function drawShape(page: PDFPage, shape: ShapeItem, quality: QualityProfile): void {
	for (const segment of shapeGeometry(shape.kind, shape.box, shape.width, shapeLineStyle(shape))
		.segments) {
		drawSegment(page, shape, segment, quality.decimals);
	}
}

/** The importer's default simplification (`--simplify`), in points. */
const IMPORTED_PATH_TOLERANCE = 0.1;

/** A path, from the same geometry the screen draws. */
function drawPath(
	page: PDFPage,
	item: PathItem,
	blend: HighlighterBlend,
	quality: QualityProfile,
): void {
	const blendMode =
		item.highlight !== true
			? BlendMode.Normal
			: blend === 'screen'
				? BlendMode.Screen
				: BlendMode.Multiply;
	for (const segment of pathGeometry(item).segments) {
		// Imported ink is already simplified to 0.1 pt, so only a coarser
		// tolerance than that changes anything.
		const commands =
			quality.inkTolerance > IMPORTED_PATH_TOLERANCE
				? simplifyPathCommands(segment.commands, quality.inkTolerance)
				: segment.commands;
		const pathData = toSvgSpace(segmentPathData(commands, quality.decimals));
		if (pathData.length === 0) continue;
		if (segment.fill === true) {
			page.drawSvgPath(pathData, {
				x: 0,
				y: 0,
				color: toRgb(item.color),
				opacity: item.opacity,
				borderWidth: 0,
				blendMode,
			});
		} else {
			page.drawSvgPath(pathData, {
				x: 0,
				y: 0,
				borderColor: toRgb(item.color),
				borderWidth: item.strokeWidth ?? 1,
				borderOpacity: item.opacity,
				borderLineCap: LineCapStyle.Round,
				blendMode,
			});
		}
	}
}

function drawText(page: PDFPage, item: TextItem, font: PDFFont): void {
	// Measured with the embedded font, so the wrapping is the same as on screen.
	const lines = layoutTextLines(item.text, item.box, item.fontSize, (text) =>
		font.widthOfTextAtSize(text, item.fontSize),
	);
	const color = toRgb(item.color);
	const centreX = item.box.x + item.box.w / 2;
	const centreY = item.box.y + item.box.h / 2;
	const radians = (item.rotation * Math.PI) / 180;

	for (const line of lines) {
		if (line.text.length === 0) continue;
		let { x, y } = line;
		if (item.rotation !== 0) {
			// Clockwise about the box centre, matching ItemBase.rotation.
			const dx = x - centreX;
			const dy = y - centreY;
			x = centreX + dx * Math.cos(radians) + dy * Math.sin(radians);
			y = centreY - dx * Math.sin(radians) + dy * Math.cos(radians);
		}
		page.drawText(line.text, {
			x,
			y,
			size: item.fontSize,
			font,
			color,
			opacity: item.opacity,
			// pdf-lib rotates counter-clockwise, so the sign flips.
			rotate: degrees(-item.rotation),
		});
	}
}

/**
 * How annotations are written into the exported file.
 *
 * `flatten` draws everything as page content: it looks identical everywhere and
 * cannot be altered. `native` writes strokes as /Ink annotations instead, so they
 * stay selectable and editable in Acrobat and Preview.
 */
export type ExportMode = 'flatten' | 'native';

/**
 * An item as it renders under `theme`: base ink swapped for the theme's.
 *
 * A copy for drawing only — the export never writes anything back, so the stored
 * colours are untouched, exactly as on screen.
 */
function themed(item: Item, theme: PageTheme): Item {
	const color = renderColor(item.color, theme);
	if (item.type === 'shape') {
		const fill = item.fill === null ? null : renderColor(item.fill, theme);
		return { ...item, color, fill };
	}
	return { ...item, color };
}

/**
 * A picture over its box, turned about the box's centre, as on screen.
 *
 * pdf-lib turns an image about its bottom-left corner, so the corner is placed
 * where the turn about the centre would put it. A picture that was not supplied,
 * or could not be embedded, is left out.
 */
function drawImage(page: PDFPage, item: ImageItem, image: PDFImage | undefined): void {
	if (!image) return;
	const { x, y, w, h } = item.box;
	// Counter-clockwise, which is what pdf-lib means by a positive angle.
	const radians = (-item.rotation * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const cx = x + w / 2;
	const cy = y + h / 2;
	page.drawImage(image, {
		x: cx + (-w / 2) * cos - (-h / 2) * sin,
		y: cy + (-w / 2) * sin + (-h / 2) * cos,
		width: w,
		height: h,
		rotate: degrees(-item.rotation),
		opacity: item.opacity,
	});
}

/** PNG and JPEG are the formats a PDF embeds directly; anything else is left out. */
async function embedImage(doc: PDFDocument, bytes: Uint8Array): Promise<PDFImage | undefined> {
	try {
		if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
			return await doc.embedPng(bytes);
		}
		if (bytes[0] === 0xff && bytes[1] === 0xd8) return await doc.embedJpg(bytes);
	} catch {
		// A damaged picture is left out rather than failing the whole export.
	}
	return undefined;
}

function drawItem(
	doc: PDFDocument,
	page: PDFPage,
	stored: Item,
	font: PDFFont,
	mode: ExportMode,
	theme: PageTheme,
	images: ReadonlyMap<string, PDFImage>,
	quality: QualityProfile,
): void {
	// A picture keeps its own colours under every theme.
	if (stored.type === 'image') {
		drawImage(page, stored, images.get(stored.src));
		return;
	}
	const item = themed(stored, theme);
	const blend = highlighterBlend(theme.paper);
	switch (item.type) {
		case 'stroke':
			// Shapes and text have no native equivalent that round-trips reliably, so
			// only strokes take the annotation path; the rest stay flattened.
			if (mode === 'native' && addInkAnnotation(doc, page, item, blend)) break;
			drawStroke(page, item, blend, quality);
			break;
		case 'shape':
			drawShape(page, item, quality);
			break;
		case 'text':
			drawText(page, item, font);
			break;
		case 'path':
			drawPath(page, item, blend, quality);
			break;
		case 'image':
			break;
	}
}

/** An inserted page's paper and ruling, in its theme, under whatever is on it. */
function drawTemplate(
	page: PDFPage,
	inserted: InsertedPage,
	theme: PageTheme,
	header?: { readonly text: HeaderText; readonly font: PDFFont },
): void {
	const { width, height } = inserted.size;
	const origin = pageOrigin(inserted);
	// A PDF page is white already, so white paper costs nothing to draw.
	if (normalizeHex(theme.paper) !== '#ffffff') {
		page.drawRectangle({
			x: origin.x,
			y: origin.y,
			width,
			height,
			color: toRgb(theme.paper),
			borderWidth: 0,
		});
	}
	const layout = headerLayout(inserted);
	drawRuling(
		page,
		inserted.template,
		width,
		height,
		theme.grid,
		origin.x,
		origin.y,
		header ? layout.bandBottom : undefined,
	);
	if (!header) return;

	// The same layout the screen draws: title in base ink, date muted, rule in
	// the grid colour.
	page.drawText(header.text.title, {
		x: layout.x,
		y: layout.titleBaseline,
		size: HEADER_TITLE_SIZE,
		font: header.font,
		color: toRgb(theme.baseInk),
	});
	page.drawText(header.text.date, {
		x: layout.x,
		y: layout.dateBaseline,
		size: HEADER_DATE_SIZE,
		font: header.font,
		color: toRgb(theme.headerMuted),
	});
	page.drawLine({
		start: { x: layout.x, y: layout.ruleY },
		end: { x: layout.ruleX2, y: layout.ruleY },
		thickness: HEADER_RULE_WIDTH,
		color: toRgb(theme.grid),
	});
}

/**
 * The longest side a PDF page may have: 200 inches, the limit PDF readers
 * enforce. A board larger than this is scaled down to fit when exported.
 */
export const MAX_PDF_PAGE_SIDE = 14_400;

/**
 * Draw a template's ruling onto a page whose MediaBox starts at the origin given,
 * (0, 0) unless the page is a board that has grown downward.
 *
 * Shared by export and by creating a new PDF, so a ruled page looks the same
 * whichever way it came to exist.
 */
export function drawRuling(
	page: PDFPage,
	template: PageTemplate,
	width: number,
	height: number,
	gridColor: string,
	originX = 0,
	originY = 0,
	/** A notebook header's band on this page: nothing is ruled above it. */
	headerBandBottom?: number,
): void {
	const ruling = translateTemplate(templateGeometry(template, width, height), originX, originY);
	const geometry =
		headerBandBottom === undefined ? ruling : reserveHeaderBand(ruling, headerBandBottom);
	const color = toRgb(gridColor);
	// Not drawSvgPath: these are page-space primitives with no y-flip to undo, and
	// an inserted page's MediaBox origin is (0, 0) by construction.
	for (const line of geometry.lines) {
		page.drawLine({
			start: { x: line.x1, y: line.y1 },
			end: { x: line.x2, y: line.y2 },
			thickness: geometry.lineWidth,
			color,
		});
	}
	for (const dot of geometry.dots) {
		page.drawCircle({
			x: dot.x,
			y: dot.y,
			size: geometry.dotRadius,
			color,
			borderWidth: 0,
		});
	}
}

export interface ExportOptions {
	/**
	 * The original PDF's bytes. Never modified. Absent for a notebook, whose every
	 * page is an inserted one.
	 */
	readonly pdfBytes?: Uint8Array;
	/** Items per page, keyed by page key — `pdf:<n>` or `ins:<uuid>`. */
	readonly pages: Readonly<Record<PageKey, Item[]>>;
	/** Page records for pages that are not in the source document. */
	readonly insertedPages?: readonly InsertedPage[];
	/** Defaults to flattening. */
	readonly mode?: ExportMode;
	/**
	 * The theme inserted pages export in. Original PDF pages always take the light
	 * mapping, as on screen. Defaults to light.
	 */
	readonly theme?: ThemeName;
	/** The themes' colours, as configured. Defaults to the built-in ones. */
	readonly themes?: PageThemes;
	/** A notebook's title header, drawn on its first page. */
	readonly header?: HeaderText;
	/**
	 * The bytes of every picture the items name, by vault path. A picture missing
	 * from here is left out of the export.
	 */
	readonly images?: ReadonlyMap<string, Uint8Array>;
	/**
	 * How finely ink is written. Pictures are embedded as given; the caller
	 * resamples them for the quality first. Defaults to {@link DEFAULT_EXPORT_QUALITY}.
	 */
	readonly quality?: ExportQuality;
}

/**
 * Flatten annotations onto a copy of the original PDF.
 *
 * The source bytes are only ever read. Every original page keeps its size and its
 * relative order; inserted pages are spliced in at the positions the sidecar's page
 * records describe, which is the one way the output's page count differs from the
 * input's.
 */
export async function exportAnnotatedPdf(
	options: ExportOptions,
): Promise<Uint8Array> {
	return (await exportAnnotatedPdfWithReport(options)).bytes;
}

/** A page the export had to shrink to fit {@link MAX_PDF_PAGE_SIDE}. */
export interface ScaledPage {
	/** 0-based position in the exported document. */
	readonly index: number;
	/** The uniform factor applied, below 1. */
	readonly factor: number;
}

/**
 * What the export notice says about pages too large for a PDF, or nothing.
 * A board can outgrow the 200 inch limit; the user should know it was shrunk.
 */
export function scaledNote(scaled: readonly ScaledPage[]): string {
	if (scaled.length === 0) return '';
	const percent = (factor: number): string => `${String(Math.floor(factor * 100))}%`;
	const limit = MAX_PDF_PAGE_SIDE.toLocaleString('en-US');
	if (scaled.length === 1) {
		const [only] = scaled;
		return `. Page ${String((only?.index ?? 0) + 1)} was larger than PDF's ${limit} pt limit and was scaled to ${percent(only?.factor ?? 1)} to fit.`;
	}
	return `. ${String(scaled.length)} pages were larger than PDF's ${limit} pt limit and were scaled down to fit.`;
}

export interface ExportReport {
	readonly bytes: Uint8Array;
	readonly scaledPages: readonly ScaledPage[];
}

/** {@link exportAnnotatedPdf}, also saying which pages had to be scaled down. */
export async function exportAnnotatedPdfWithReport(
	options: ExportOptions,
): Promise<ExportReport> {
	const doc = options.pdfBytes
		? await PDFDocument.load(options.pdfBytes)
		: await PDFDocument.create();
	const themes = options.themes ?? DEFAULT_PAGE_THEMES;
	const quality = QUALITY_PROFILES[options.quality ?? DEFAULT_EXPORT_QUALITY];
	const viewTheme = options.theme ?? 'light';
	const themeFor = (kind: 'pdf' | 'inserted'): PageTheme =>
		themes[themeForPage(kind, viewTheme)];
	// Required before embedding a TrueType font.
	doc.registerFontkit(fontkit);
	const font = await doc.embedFont(embeddedFontBytes(), { subset: true });
	// Each picture once, however many times it is placed.
	const images = new Map<string, PDFImage>();
	for (const [src, bytes] of options.images ?? []) {
		const image = await embedImage(doc, bytes);
		if (image) images.set(src, image);
	}

	const order = orderPages(doc.getPageCount(), options.insertedPages ?? []);

	/*
	 * Ascending display index. Each slot's index already accounts for every
	 * insertion before it, so by the time this reaches slot n the pages ahead of it
	 * have all shifted into place and insertPage lands exactly where the order says.
	 */
	for (const slot of order) {
		if (slot.kind !== 'inserted') continue;
		const { width, height } = slot.page.size;
		const origin = pageOrigin(slot.page);
		const page = doc.insertPage(slot.index, [width, height]);
		// A board that grew downward has its corner below (0, 0); its items are
		// stored in that same space, so the MediaBox moves rather than the ink.
		if (origin.x !== 0 || origin.y !== 0) page.setMediaBox(origin.x, origin.y, width, height);
		// A notebook's header goes on its first page.
		const header =
			options.header && slot.index === 0 ? { text: options.header, font } : undefined;
		drawTemplate(page, slot.page, themeFor('inserted'), header);
	}

	const indexByKey = new Map<PageKey, number>();
	const kindByKey = new Map<PageKey, 'pdf' | 'inserted'>();
	for (const slot of order) {
		indexByKey.set(slot.key, slot.index);
		kindByKey.set(slot.key, slot.kind);
	}

	for (const [key, items] of Object.entries(options.pages)) {
		const index = indexByKey.get(key);
		// Items belonging to a page this document does not have — a sidecar written
		// against a different PDF — are left alone rather than drawn somewhere wrong.
		if (index === undefined) continue;
		const page = doc.getPage(index);
		const theme = themeFor(kindByKey.get(key) ?? 'pdf');
		for (const item of inZOrder(items)) {
			drawItem(doc, page, item, font, options.mode ?? 'flatten', theme, images, quality);
		}
	}

	// Last, once everything is drawn: pdf-lib scales the page box, its content
	// and its annotations together, so the page looks the same, only smaller.
	const scaledPages: ScaledPage[] = [];
	for (const slot of order) {
		if (slot.kind !== 'inserted') continue;
		const longest = Math.max(slot.page.size.width, slot.page.size.height);
		if (longest <= MAX_PDF_PAGE_SIDE) continue;
		const factor = MAX_PDF_PAGE_SIDE / longest;
		doc.getPage(slot.index).scale(factor, factor);
		scaledPages.push({ index: slot.index, factor });
	}
	return { bytes: await doc.save(), scaledPages };
}
