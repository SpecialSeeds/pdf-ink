/**
 * Where to draw a page sharply when the whole page cannot be. Pure — no DOM, no
 * Obsidian, no pdf.js.
 *
 * A page whose full bitmap would exceed the canvas budget is drawn twice: once
 * whole, at whatever dpr the budget allows (see {@link effectiveDpr}), and once
 * more for only the part in view, at the real dpr. The second drawing is the
 * "detail". A OneNote export 156 inches wide is ~15,000 CSS px across at 100%
 * zoom; the whole-page bitmap gets a dpr near 0.2 on an iPad, and without the
 * detail it reads as a smear however far in you zoom.
 *
 * One region per page rather than a grid of tiles, on purpose. pdf.js replays a
 * page's entire content stream for every render, clipped or not, and handwriting
 * exports carry tens of megabytes of path operators. A dozen tiles would be a
 * dozen full replays per scroll; one region is one.
 */

import { type CanvasBudget, effectiveDpr } from './canvas-budget';

/** An axis-aligned rectangle in a page's CSS px, origin at its top left. */
export interface CssRect {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
}

export interface DetailRegion {
	/** Whole CSS px, inside the page. */
	readonly rect: CssRect;
	/** Device px per CSS px for this region; at most the display's own dpr. */
	readonly dpr: number;
}

/**
 * Extra area rendered around the visible part, as a fraction of its larger side,
 * so a short pan stays sharp without a re-render. Given up first when the budget
 * is tight: on an iPad the visible part alone nearly fills the mobile budget.
 */
export const DETAIL_MARGIN = 0.25;

/**
 * A detail is only worth a second render when it is visibly sharper than the
 * whole-page bitmap under it. Below this ratio the two are indistinguishable.
 */
const MIN_GAIN = 1.1;

/** Bitmap size of a region: what the canvas is allocated at. */
export function detailBitmapSize(region: DetailRegion): {
	width: number;
	height: number;
} {
	return {
		width: Math.ceil(region.rect.w * region.dpr),
		height: Math.ceil(region.rect.h * region.dpr),
	};
}

export function intersectRect(a: CssRect, b: CssRect): CssRect | null {
	const x = Math.max(a.x, b.x);
	const y = Math.max(a.y, b.y);
	const right = Math.min(a.x + a.w, b.x + b.w);
	const bottom = Math.min(a.y + a.h, b.y + b.h);
	if (right <= x || bottom <= y) return null;
	return { x, y, w: right - x, h: bottom - y };
}

/** Whether `outer` contains all of `inner`. */
export function containsRect(outer: CssRect, inner: CssRect): boolean {
	return (
		inner.x >= outer.x &&
		inner.y >= outer.y &&
		inner.x + inner.w <= outer.x + outer.w &&
		inner.y + inner.h <= outer.y + outer.h
	);
}

/**
 * The region to render sharply, or null when the page needs none: it is out of
 * view, or its whole-page bitmap is already as sharp as the display.
 *
 * `visible` is the part of the page inside the scroll viewport, in page CSS px.
 * It need not be clipped to the page; that happens here.
 */
export function detailRegion(
	pageWidth: number,
	pageHeight: number,
	visible: CssRect,
	rawDpr: number,
	budget: CanvasBudget,
	margin: number = DETAIL_MARGIN,
): DetailRegion | null {
	const page: CssRect = { x: 0, y: 0, w: pageWidth, h: pageHeight };
	const seen = intersectRect(visible, page);
	if (!seen) return null;

	const baseDpr = effectiveDpr(pageWidth, pageHeight, rawDpr, budget);
	// Whole pixels, grown outward, so the region always covers what is seen.
	const core = snapOut(seen, page);
	const dpr = effectiveDpr(core.w + 1, core.h + 1, rawDpr, budget);
	if (dpr < baseDpr * MIN_GAIN) return null;

	// Largest uniform pad that keeps the padded region inside the budget. The
	// +1 in each dimension absorbs snapping, which can add a pixel either way.
	const w = core.w + 1;
	const h = core.h + 1;
	const bySide = (budget.maxSide / dpr - Math.max(w, h)) / 2;
	const area = budget.maxArea / (dpr * dpr);
	// (w + 2p)(h + 2p) <= area, solved for p.
	const byArea =
		(-(w + h) + Math.sqrt((w + h) * (w + h) - 4 * (w * h - area))) / 4;
	const pad = Math.max(
		0,
		Math.floor(Math.min(margin * Math.max(core.w, core.h), bySide, byArea)),
	);

	const rect = snapOut(
		{ x: core.x - pad, y: core.y - pad, w: core.w + 2 * pad, h: core.h + 2 * pad },
		page,
	);
	return { rect, dpr };
}

/** Round outward to whole CSS px, then clip to `bounds`. */
function snapOut(rect: CssRect, bounds: CssRect): CssRect {
	const x = Math.max(bounds.x, Math.floor(rect.x));
	const y = Math.max(bounds.y, Math.floor(rect.y));
	const right = Math.min(bounds.x + bounds.w, Math.ceil(rect.x + rect.w));
	const bottom = Math.min(bounds.y + bounds.h, Math.ceil(rect.y + rect.h));
	return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) };
}
