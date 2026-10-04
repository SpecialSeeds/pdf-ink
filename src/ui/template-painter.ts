import { type InsertedPage, pageOrigin } from '../core/pages';
import {
	HEADER_DATE_SIZE,
	HEADER_RULE_WIDTH,
	HEADER_TITLE_SIZE,
	type HeaderText,
	headerLayout,
	reserveHeaderBand,
} from '../core/header';
import {
	type TemplateGeometry,
	minorGridAlpha,
	templateGeometry,
	templateSpacing,
	translateTemplate,
} from '../core/templates';
import { TEXT_FONT_STACK } from './item-renderers';
import type { PageTheme } from '../core/theme';
import type { Matrix, PageViewport } from '../types/pdfjs';

/**
 * Below this a hairline rounds away to nothing on screen. The exported PDF keeps
 * the true width — this floor only stops the ruling vanishing when zoomed out.
 */
const MIN_SCREEN_WIDTH = 0.4;

/**
 * Draw an inserted page: paper, then its ruling, in the page theme's colours.
 *
 * Works in CSS pixels, like every other drawing path here, with `transform`
 * mapping them to the bitmap: the device pixel ratio, plus an offset when only
 * part of the page is being drawn. Geometry comes from
 * {@link templateGeometry} in PDF space and is projected through the page's
 * viewport, so the screen and the export agree by construction rather than by two
 * implementations happening to match.
 */
export function paintInsertedPage(
	ctx: CanvasRenderingContext2D,
	viewport: PageViewport,
	page: InsertedPage,
	cssWidth: number,
	cssHeight: number,
	transform: Matrix,
	theme: PageTheme,
	/** A notebook's title header, on its first page. */
	header?: HeaderText,
): void {
	// Resizing the canvas reset the transform, so it has to be re-applied here.
	ctx.setTransform(...transform);
	ctx.fillStyle = theme.paper;
	ctx.fillRect(0, 0, cssWidth, cssHeight);

	const origin = pageOrigin(page);
	const ruling = translateTemplate(
		templateGeometry(page.template, page.size.width, page.size.height),
		origin.x,
		origin.y,
	);
	// The header keeps its band clear: the writing area starts below it.
	const geometry = header ? reserveHeaderBand(ruling, headerLayout(page).bandBottom) : ruling;
	paintRuling(ctx, viewport, page, geometry, theme);
	if (header) paintHeader(ctx, viewport, page, header, theme);
}

/**
 * Title, date and rule, in the page theme: the title in its base ink, the date
 * in its muted grey, the rule in its grid colour. The exporter draws the same
 * layout from {@link headerLayout}.
 */
function paintHeader(
	ctx: CanvasRenderingContext2D,
	viewport: PageViewport,
	page: InsertedPage,
	header: HeaderText,
	theme: PageTheme,
): void {
	const layout = headerLayout(page);
	const scale = viewport.scale;
	ctx.save();
	ctx.textBaseline = 'alphabetic';
	ctx.fillStyle = theme.baseInk;
	ctx.font = `${String(HEADER_TITLE_SIZE * scale)}px ${TEXT_FONT_STACK}`;
	const [tx, ty] = viewport.convertToViewportPoint(layout.x, layout.titleBaseline);
	ctx.fillText(header.title, tx, ty);

	ctx.fillStyle = theme.headerMuted;
	ctx.font = `${String(HEADER_DATE_SIZE * scale)}px ${TEXT_FONT_STACK}`;
	const [dx, dy] = viewport.convertToViewportPoint(layout.x, layout.dateBaseline);
	ctx.fillText(header.date, dx, dy);

	ctx.strokeStyle = theme.grid;
	ctx.lineWidth = Math.max(MIN_SCREEN_WIDTH, HEADER_RULE_WIDTH * scale);
	const [x1, y1] = viewport.convertToViewportPoint(layout.x, layout.ruleY);
	const [x2, y2] = viewport.convertToViewportPoint(layout.ruleX2, layout.ruleY);
	ctx.beginPath();
	ctx.moveTo(x1, y1);
	ctx.lineTo(x2, y2);
	ctx.stroke();
	ctx.restore();
}

function paintRuling(
	ctx: CanvasRenderingContext2D,
	viewport: PageViewport,
	page: InsertedPage,
	geometry: TemplateGeometry,
	theme: PageTheme,
): void {
	if (geometry.lines.length === 0 && geometry.dots.length === 0) return;

	const scale = viewport.scale;
	ctx.save();
	ctx.strokeStyle = theme.grid;
	ctx.fillStyle = theme.grid;
	ctx.lineWidth = Math.max(MIN_SCREEN_WIDTH, geometry.lineWidth * scale);

	// Level of detail: a grid packed tighter than the eye can use turns the page
	// grey, so its minor lines fade out as it is zoomed out and only every fifth
	// line stays. Ruled lines are not graded and always draw.
	const minorAlpha = minorGridAlpha(templateSpacing(page.template) * scale);
	for (const [pass, alpha] of [
		['major', 1],
		['minor', minorAlpha],
	] as const) {
		if (alpha <= 0) continue;
		const wanted = (major: boolean | undefined): boolean =>
			pass === 'major' ? major !== false : major === false;
		ctx.globalAlpha = alpha;

		const lines = geometry.lines.filter((line) => wanted(line.major));
		if (lines.length > 0) {
			ctx.beginPath();
			for (const line of lines) {
				const [x1, y1] = viewport.convertToViewportPoint(line.x1, line.y1);
				const [x2, y2] = viewport.convertToViewportPoint(line.x2, line.y2);
				ctx.moveTo(x1, y1);
				ctx.lineTo(x2, y2);
			}
			ctx.stroke();
		}

		const dots = geometry.dots.filter((dot) => wanted(dot.major));
		if (dots.length > 0) {
			const radius = Math.max(MIN_SCREEN_WIDTH, geometry.dotRadius * scale);
			// One path for every dot: thousands of separate fill() calls on a dot
			// grid is the difference between a smooth zoom and a visible stall.
			ctx.beginPath();
			for (const dot of dots) {
				const [x, y] = viewport.convertToViewportPoint(dot.x, dot.y);
				ctx.moveTo(x + radius, y);
				ctx.arc(x, y, radius, 0, Math.PI * 2);
			}
			ctx.fill();
		}
	}

	ctx.restore();
}
