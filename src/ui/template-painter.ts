import type { InsertedPage } from '../core/pages';
import { templateGeometry } from '../core/templates';
import type { Matrix, PageViewport } from '../types/pdfjs';

/**
 * The paper colour of an inserted page.
 *
 * White rather than a themed background: a page is a page in every viewer and on
 * paper, and an inserted page that went dark with the theme would stop matching
 * the rasterised PDF pages above and below it.
 */
const PAGE_COLOR = '#ffffff';

/**
 * Below this a hairline rounds away to nothing on screen. The exported PDF keeps
 * the true width — this floor only stops the ruling vanishing when zoomed out.
 */
const MIN_SCREEN_WIDTH = 0.4;

/**
 * Draw an inserted page: paper, then its ruling.
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
): void {
	// Resizing the canvas reset the transform, so it has to be re-applied here.
	ctx.setTransform(...transform);
	ctx.fillStyle = PAGE_COLOR;
	ctx.fillRect(0, 0, cssWidth, cssHeight);

	const geometry = templateGeometry(
		page.template,
		page.size.width,
		page.size.height,
	);
	if (geometry.lines.length === 0 && geometry.dots.length === 0) return;

	const scale = viewport.scale;
	ctx.save();
	ctx.strokeStyle = geometry.color;
	ctx.fillStyle = geometry.color;
	ctx.lineWidth = Math.max(MIN_SCREEN_WIDTH, geometry.lineWidth * scale);

	if (geometry.lines.length > 0) {
		ctx.beginPath();
		for (const line of geometry.lines) {
			const [x1, y1] = viewport.convertToViewportPoint(line.x1, line.y1);
			const [x2, y2] = viewport.convertToViewportPoint(line.x2, line.y2);
			ctx.moveTo(x1, y1);
			ctx.lineTo(x2, y2);
		}
		ctx.stroke();
	}

	if (geometry.dots.length > 0) {
		const radius = Math.max(MIN_SCREEN_WIDTH, geometry.dotRadius * scale);
		// One path for every dot: thousands of separate fill() calls on a dot grid
		// is the difference between a smooth zoom and a visible stall.
		ctx.beginPath();
		for (const dot of geometry.dots) {
			const [x, y] = viewport.convertToViewportPoint(dot.x, dot.y);
			ctx.moveTo(x + radius, y);
			ctx.arc(x, y, radius, 0, Math.PI * 2);
		}
		ctx.fill();
	}

	ctx.restore();
}
