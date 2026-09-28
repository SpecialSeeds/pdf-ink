/**
 * Keeping ink on the page. Pure.
 *
 * Nothing is stored outside the page's own rectangle: a stroke is cut where it
 * leaves the page, a shape or text box stops at the edge, and a selection cannot
 * be dragged off it. Everything here is in PDF user space.
 */

import type { Bounds } from './hit-test';
import type { Box, StrokeSample } from './items';

/** Anything that maps canvas CSS px to PDF space, such as a pdf.js viewport. */
export interface PdfPointConverter {
	convertToPdfPoint(x: number, y: number): [number, number] | number[];
}

/**
 * The page's rectangle in PDF space, from its canvas size.
 *
 * All four corners go through the viewport, so a rotated page or a MediaBox that
 * does not start at the origin comes out right.
 */
export function pageBounds(
	viewport: PdfPointConverter,
	cssWidth: number,
	cssHeight: number,
): Bounds {
	const corners = [
		viewport.convertToPdfPoint(0, 0),
		viewport.convertToPdfPoint(cssWidth, 0),
		viewport.convertToPdfPoint(0, cssHeight),
		viewport.convertToPdfPoint(cssWidth, cssHeight),
	];
	const xs = corners.map((point) => point[0] ?? 0);
	const ys = corners.map((point) => point[1] ?? 0);
	return {
		minX: Math.min(...xs),
		minY: Math.min(...ys),
		maxX: Math.max(...xs),
		maxY: Math.max(...ys),
	};
}

export function containsPoint(bounds: Bounds, x: number, y: number): boolean {
	return (
		x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY
	);
}

export function clampPoint(
	bounds: Bounds,
	x: number,
	y: number,
): [number, number] {
	return [
		Math.min(bounds.maxX, Math.max(bounds.minX, x)),
		Math.min(bounds.maxY, Math.max(bounds.minY, y)),
	];
}

/** One on-page run of a stroke, and whether each end was cut by the page edge. */
export interface StrokePiece {
	readonly points: StrokeSample[];
	readonly cutStart: boolean;
	readonly cutEnd: boolean;
}

/**
 * Cut a stroke's samples to the page.
 *
 * Each run that stays on the page becomes a piece, ending exactly on the edge
 * where the pen crossed it rather than at the last sample that happened to be
 * inside. A stroke that never leaves comes back as one uncut piece; one that is
 * entirely off the page comes back as none.
 */
export function clipStrokeToPage(
	points: readonly StrokeSample[],
	bounds: Bounds,
): StrokePiece[] {
	const pieces: StrokePiece[] = [];
	const first = points[0];
	if (!first) return pieces;

	let current: StrokeSample[] | null = containsPoint(bounds, first[0], first[1])
		? [first]
		: null;
	let cutStart = false;

	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1];
		const b = points[i];
		if (!a || !b) continue;
		const span = clipSegment(a, b, bounds);
		if (!span) {
			if (current) pieces.push({ points: current, cutStart, cutEnd: true });
			current = null;
			continue;
		}
		const [t0, t1] = span;
		if (!current) {
			current = [lerpSample(a, b, t0)];
			cutStart = true;
		}
		if (t1 < 1) {
			current.push(lerpSample(a, b, t1));
			pieces.push({ points: current, cutStart, cutEnd: true });
			current = null;
		} else {
			current.push(b);
		}
	}
	if (current) pieces.push({ points: current, cutStart, cutEnd: false });
	return pieces;
}

/**
 * The part of segment a→b inside the bounds, as parameters along it, or null.
 * Liang–Barsky.
 */
function clipSegment(
	a: StrokeSample,
	b: StrokeSample,
	bounds: Bounds,
): [number, number] | null {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	let t0 = 0;
	let t1 = 1;
	const edges: [number, number][] = [
		[-dx, a[0] - bounds.minX],
		[dx, bounds.maxX - a[0]],
		[-dy, a[1] - bounds.minY],
		[dy, bounds.maxY - a[1]],
	];
	for (const [p, q] of edges) {
		if (p === 0) {
			if (q < 0) return null;
			continue;
		}
		const r = q / p;
		if (p < 0) {
			if (r > t1) return null;
			if (r > t0) t0 = r;
		} else {
			if (r < t0) return null;
			if (r < t1) t1 = r;
		}
	}
	return [t0, t1];
}

function lerpSample(a: StrokeSample, b: StrokeSample, t: number): StrokeSample {
	return [
		a[0] + (b[0] - a[0]) * t,
		a[1] + (b[1] - a[1]) * t,
		a[2] + (b[2] - a[2]) * t,
	];
}

/**
 * Shrink a box dragged out from its anchor (`box.x`, `box.y`) until its far
 * corner is on the page.
 *
 * Scaled uniformly rather than clamped per axis, so a square stays square, an
 * equilateral triangle stays equilateral, and a snapped line keeps its angle.
 */
export function fitBoxFromAnchor(box: Box, bounds: Bounds): Box {
	const scale = Math.min(
		1,
		allowedScale(box.x, box.w, bounds.minX, bounds.maxX),
		allowedScale(box.y, box.h, bounds.minY, bounds.maxY),
	);
	if (scale >= 1) return box;
	return { ...box, w: box.w * scale, h: box.h * scale };
}

function allowedScale(
	start: number,
	extent: number,
	min: number,
	max: number,
): number {
	if (extent > 0) return Math.max(0, (max - start) / extent);
	if (extent < 0) return Math.max(0, (min - start) / extent);
	return 1;
}

/**
 * The shift that brings `inner` back onto the page.
 *
 * Something larger than the page along an axis is aligned to the page's low
 * edge on that axis, since it cannot fit either way.
 */
export function shiftInside(inner: Bounds, page: Bounds): [number, number] {
	return [
		axisShift(inner.minX, inner.maxX, page.minX, page.maxX),
		axisShift(inner.minY, inner.maxY, page.minY, page.maxY),
	];
}

function axisShift(lo: number, hi: number, min: number, max: number): number {
	if (hi - lo > max - min) return min - lo;
	if (lo < min) return min - lo;
	if (hi > max) return max - hi;
	return 0;
}
