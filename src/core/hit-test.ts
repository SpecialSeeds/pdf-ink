/**
 * Geometry for whole-stroke erasing. Pure, and all in PDF user space.
 *
 * Because a stroke's points and its width are both stored in PDF points, its
 * outline is scale-independent: it can be computed once and reused at any zoom.
 */

import type { Vec2 } from 'perfect-freehand';
import { type Item, isStroke } from './items';
import type { StrokeSample } from './items';
import { strokeOutline } from './stroke';

export interface Bounds {
	readonly minX: number;
	readonly minY: number;
	readonly maxX: number;
	readonly maxY: number;
}

export function outlineBounds(outline: readonly Vec2[]): Bounds | null {
	const first = outline[0];
	if (first === undefined) return null;
	let minX = first[0];
	let maxX = first[0];
	let minY = first[1];
	let maxY = first[1];
	for (const [x, y] of outline) {
		if (x < minX) minX = x;
		else if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		else if (y > maxY) maxY = y;
	}
	return { minX, minY, maxX, maxY };
}

export function expandBounds(bounds: Bounds, by: number): Bounds {
	return {
		minX: bounds.minX - by,
		minY: bounds.minY - by,
		maxX: bounds.maxX + by,
		maxY: bounds.maxY + by,
	};
}

export function boundsContain(bounds: Bounds, x: number, y: number): boolean {
	return (
		x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY
	);
}

export function boundsIntersect(a: Bounds, b: Bounds): boolean {
	return (
		a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY
	);
}

export function polylineBounds(points: readonly StrokeSample[]): Bounds | null {
	const first = points[0];
	if (!first) return null;
	let minX = first[0];
	let maxX = first[0];
	let minY = first[1];
	let maxY = first[1];
	for (const [x, y] of points) {
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}
	return { minX, minY, maxX, maxY };
}

/** A cheap bound for prefiltering — no outline generation. */
export function itemBounds(item: Item): Bounds | null {
	if (item.type === 'stroke') return polylineBounds(item.points);
	if (item.type === 'shape' || item.type === 'text') {
		const { box } = item;
		return {
			minX: Math.min(box.x, box.x + box.w),
			minY: Math.min(box.y, box.y + box.h),
			maxX: Math.max(box.x, box.x + box.w),
			maxY: Math.max(box.y, box.y + box.h),
		};
	}
	return null;
}

/** Ray casting. Points exactly on an edge may fall either way; callers also
 *	test edge distance, so the boundary is covered regardless. */
export function pointInPolygon(
	x: number,
	y: number,
	polygon: readonly Vec2[],
): boolean {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const a = polygon[i];
		const b = polygon[j];
		if (a === undefined || b === undefined) continue;
		const intersects =
			a[1] > y !== b[1] > y &&
			x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0];
		if (intersects) inside = !inside;
	}
	return inside;
}

function distanceToSegment(
	x: number,
	y: number,
	a: Vec2,
	b: Vec2,
): number {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const lengthSquared = dx * dx + dy * dy;
	if (lengthSquared === 0) return Math.hypot(x - a[0], y - a[1]);
	let t = ((x - a[0]) * dx + (y - a[1]) * dy) / lengthSquared;
	t = Math.min(1, Math.max(0, t));
	return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}

export function distanceToPolygonEdge(
	x: number,
	y: number,
	polygon: readonly Vec2[],
): number {
	let best = Number.POSITIVE_INFINITY;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const a = polygon[i];
		const b = polygon[j];
		if (a === undefined || b === undefined) continue;
		const distance = distanceToSegment(x, y, a, b);
		if (distance < best) best = distance;
	}
	return best;
}

/** An item's erase-testable shape, in PDF space. Cache one per item. */
export interface ItemHitShape {
	readonly bounds: Bounds;
	readonly outline: readonly Vec2[];
}

/**
 * The shape the eraser tests against, dispatched on item type.
 *
 * Shapes and text fall back to their box, which is correct for an axis-aligned
 * item and a usable approximation otherwise; once shapes have real geometry
 * functions this should consume those instead.
 */
export function itemHitShape(item: Item): ItemHitShape | null {
	const outline = isStroke(item)
		? // Width is in PDF points, so this outline is the real rendered shape at
			// any zoom level.
			strokeOutline(item.points, item.width, true, item.tool)
		: boxOutline(item.box);
	const bounds = outlineBounds(outline);
	if (!bounds) return null;
	return { bounds, outline };
}

function boxOutline(box: { x: number; y: number; w: number; h: number }): Vec2[] {
	return [
		[box.x, box.y],
		[box.x + box.w, box.y],
		[box.x + box.w, box.y + box.h],
		[box.x, box.y + box.h],
	];
}

/**
 * Whether an eraser at (x, y) with `radius` touches this stroke.
 *
 * The bounding box is checked first: on a page with many strokes that rejects
 * almost everything for the cost of four comparisons, so the expensive
 * point-in-polygon and edge-distance work only runs for real candidates.
 */
export function hitTestShape(
	shape: ItemHitShape,
	x: number,
	y: number,
	radius: number,
): boolean {
	if (!boundsContain(expandBounds(shape.bounds, radius), x, y)) return false;
	if (pointInPolygon(x, y, shape.outline)) return true;
	return distanceToPolygonEdge(x, y, shape.outline) <= radius;
}
