import {
	BlendMode,
	PDFDocument,
	type PDFFont,
	type PDFPage,
	degrees,
	rgb,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { type Item, type ShapeItem, type Stroke, type TextItem, inZOrder } from '../core/items';
import { type InsertedPage, type PageKey, orderPages } from '../core/pages';
import { type PathSegment, shapeGeometry } from '../core/shapes';
import { type PageTemplate, templateGeometry } from '../core/templates';
import { outlineToPathData, strokeOutline } from '../core/stroke';
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

function drawStroke(page: PDFPage, stroke: Stroke, blend: HighlighterBlend): void {
	// The same outline generator the screen uses, in PDF points.
	const outline = strokeOutline(stroke.points, stroke.width, true, stroke.tool, {
		start: stroke.cutStart,
		end: stroke.cutEnd,
	});
	if (outline.length === 0) return;
	page.drawSvgPath(toSvgSpace(outlineToPathData(outline)), {
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

function drawSegment(page: PDFPage, shape: ShapeItem, segment: PathSegment): void {
	const pathData = toSvgSpace(segmentPathData(segment));
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
		...(shape.fill === null
			? {}
			: { color: toRgb(shape.fill), opacity: shape.opacity }),
	});
}

function segmentPathData(segment: PathSegment): string {
	const parts: string[] = [];
	for (const command of segment.commands) {
		if (command.op === 'move') parts.push(`M ${String(command.x)} ${String(command.y)}`);
		else if (command.op === 'line') parts.push(`L ${String(command.x)} ${String(command.y)}`);
		else if (command.op === 'cubic') {
			parts.push(
				`C ${String(command.x1)} ${String(command.y1)} ${String(command.x2)} ${String(command.y2)} ${String(command.x)} ${String(command.y)}`,
			);
		} else parts.push('Z');
	}
	return parts.join(' ');
}

function drawShape(page: PDFPage, shape: ShapeItem): void {
	for (const segment of shapeGeometry(shape.kind, shape.box, shape.width).segments) {
		drawSegment(page, shape, segment);
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

function drawItem(
	doc: PDFDocument,
	page: PDFPage,
	stored: Item,
	font: PDFFont,
	mode: ExportMode,
	theme: PageTheme,
): void {
	const item = themed(stored, theme);
	const blend = highlighterBlend(theme.paper);
	switch (item.type) {
		case 'stroke':
			// Shapes and text have no native equivalent that round-trips reliably, so
			// only strokes take the annotation path; the rest stay flattened.
			if (mode === 'native' && addInkAnnotation(doc, page, item, blend)) break;
			drawStroke(page, item, blend);
			break;
		case 'shape':
			drawShape(page, item);
			break;
		case 'text':
			drawText(page, item, font);
			break;
	}
}

/** An inserted page's paper and ruling, in its theme, under whatever is on it. */
function drawTemplate(page: PDFPage, inserted: InsertedPage, theme: PageTheme): void {
	const { width, height } = inserted.size;
	// A PDF page is white already, so white paper costs nothing to draw.
	if (normalizeHex(theme.paper) !== '#ffffff') {
		page.drawRectangle({
			x: 0,
			y: 0,
			width,
			height,
			color: toRgb(theme.paper),
			borderWidth: 0,
		});
	}
	drawRuling(page, inserted.template, width, height, theme.grid);
}

/**
 * Draw a template's ruling onto a page whose MediaBox starts at (0, 0).
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
): void {
	const geometry = templateGeometry(template, width, height);
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
	const doc = options.pdfBytes
		? await PDFDocument.load(options.pdfBytes)
		: await PDFDocument.create();
	const themes = options.themes ?? DEFAULT_PAGE_THEMES;
	const viewTheme = options.theme ?? 'light';
	const themeFor = (kind: 'pdf' | 'inserted'): PageTheme =>
		themes[themeForPage(kind, viewTheme)];
	// Required before embedding a TrueType font.
	doc.registerFontkit(fontkit);
	const font = await doc.embedFont(embeddedFontBytes(), { subset: true });

	const order = orderPages(doc.getPageCount(), options.insertedPages ?? []);

	/*
	 * Ascending display index. Each slot's index already accounts for every
	 * insertion before it, so by the time this reaches slot n the pages ahead of it
	 * have all shifted into place and insertPage lands exactly where the order says.
	 */
	for (const slot of order) {
		if (slot.kind !== 'inserted') continue;
		const { width, height } = slot.page.size;
		drawTemplate(
			doc.insertPage(slot.index, [width, height]),
			slot.page,
			themeFor('inserted'),
		);
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
			drawItem(doc, page, item, font, options.mode ?? 'flatten', theme);
		}
	}
	return doc.save();
}
