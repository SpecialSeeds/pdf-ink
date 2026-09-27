/**
 * A {@link PageViewport} for a page pdf.js has never heard of. Pure.
 *
 * Inserted pages have no `PDFPageProxy` to ask for a viewport, but everything
 * downstream — stroke capture, the selection overlay, the renderers — converts
 * between screen and PDF space through one. Rather than special-case every call
 * site, an inserted page gets a viewport of its own that behaves exactly like
 * pdf.js's for an unrotated page: same y-flip, same `viewBox`, same transform
 * matrix, same `clone`.
 *
 * Rotation is deliberately not supported: an inserted page is created upright and
 * has no `/Rotate` to honour, so a rotated clone would be a silent lie. Callers
 * asking for one get the unrotated viewport back.
 */

import type { Matrix, PageViewport, Point, Rect } from '../types/pdfjs';

export function syntheticViewport(
	width: number,
	height: number,
	scale = 1,
	offsetX = 0,
	offsetY = 0,
): PageViewport {
	// Guard the degenerate case: a zero-area wrapper is reported as never
	// intersecting, which would stall virtualization on that page forever.
	const w = width > 0 ? width : 1;
	const h = height > 0 ? height : 1;
	const s = scale > 0 ? scale : 1;
	const viewBox: Rect = [0, 0, w, h];

	// pdf.js's rotation-0 matrix: x scales straight through, y flips about the top
	// of the view box, and the box origin is folded in. Ours is (0, 0), so the
	// translation is just the page height.
	const transform: Matrix = [s, 0, 0, -s, offsetX, h * s + offsetY];

	return {
		width: w * s,
		height: h * s,
		scale: s,
		rotation: 0,
		viewBox,
		transform,
		clone: (params) =>
			syntheticViewport(
				w,
				h,
				params?.scale ?? s,
				params?.offsetX ?? offsetX,
				params?.offsetY ?? offsetY,
			),
		convertToPdfPoint: (x: number, y: number): Point => [
			(x - offsetX) / s,
			h - (y - offsetY) / s,
		],
		convertToViewportPoint: (x: number, y: number): Point => [
			x * s + offsetX,
			(h - y) * s + offsetY,
		],
	};
}
