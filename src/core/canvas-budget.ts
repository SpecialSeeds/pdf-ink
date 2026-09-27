/**
 * Canvas size limits. Pure — no DOM, no Obsidian, no pdf.js.
 *
 * This is not a nicety. `scanned.pdf` holds 30x42 inch pages: at 400% zoom one
 * page is ~18 megapixels at dpr 1 and ~72 at dpr 2. Chromium would allocate a
 * few hundred MB; WebKit on iOS silently returns a zero-sized backing store, so
 * the page renders blank with no error — a memory limit that presents as a
 * rendering bug. Clamping degrades sharpness instead.
 */

export interface CanvasBudget {
	readonly maxSide: number;
	readonly maxArea: number;
}

export const DESKTOP_BUDGET: CanvasBudget = {
	maxSide: 16384,
	maxArea: 1 << 24, // 16.8 Mpx
};

export const MOBILE_BUDGET: CanvasBudget = {
	maxSide: 4096,
	maxArea: 1 << 22, // 4.2 Mpx
};

/**
 * Only guards against a degenerate zero-sized canvas. Deliberately tiny: the
 * budget is a hard constraint and must win, because a page whose CSS box alone
 * exceeds the budget still has to render as *something* rather than blank.
 */
const MIN_DPR = 0.05;

/**
 * Clamp the device pixel ratio, never the layout box: the page keeps its correct
 * size and scroll position and merely renders softer. Degrading the box instead
 * would corrupt the ink coordinate space.
 *
 * The budget is authoritative and is never overridden by a comfort floor. A
 * 30x42 inch page at 400% zoom is a ~186 megapixel CSS box, so the only way to
 * stay inside a 16.8 Mpx budget is a dpr well under 1 — and a soft page is a far
 * better outcome than the zero-sized backing store WebKit hands back when the
 * limit is exceeded, which renders blank with no error at all.
 */
export function effectiveDpr(
	cssWidth: number,
	cssHeight: number,
	rawDpr: number,
	budget: CanvasBudget,
): number {
	if (cssWidth <= 0 || cssHeight <= 0) return 1;
	const bySide = Math.min(
		budget.maxSide / cssWidth,
		budget.maxSide / cssHeight,
	);
	const byArea = Math.sqrt(budget.maxArea / (cssWidth * cssHeight));
	return Math.max(MIN_DPR, Math.min(rawDpr, bySide, byArea));
}
