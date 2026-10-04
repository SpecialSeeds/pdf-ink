/**
 * Lasso selection rules. Pure.
 *
 * The loop is a polygon in PDF user space, so a selection made at one zoom picks
 * exactly the same items at another.
 */

import type { ItemRef } from './history';
import type { PageKey } from './pages';
import {
	type Bounds,
	hitTestShape,
	itemBounds,
	itemHitShape,
	pointInPolygon,
} from './hit-test';
import type { Item, StrokeSample } from './items';
import { flattenPath, pathCommands } from './path';
import type { Vec2 } from 'perfect-freehand';

/**
 * How much of a stroke must fall inside the loop for it to be selected.
 *
 * A fraction rather than all-or-nothing: users lasso roughly, and demanding every
 * point would make long strokes almost impossible to catch.
 */
export const LASSO_STROKE_THRESHOLD = 0.6;

/** The proportion of a stroke's points that fall inside the polygon. */
export function fractionInside(
	points: readonly StrokeSample[],
	polygon: readonly Vec2[],
): number {
	if (points.length === 0) return 0;
	let inside = 0;
	for (const [x, y] of points) {
		if (pointInPolygon(x, y, polygon)) inside += 1;
	}
	return inside / points.length;
}

export function boundsCenter(bounds: Bounds): Vec2 {
	return [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2];
}

/** An item's centre in PDF space, or null when it has no geometry. */
export function itemCenter(item: Item): Vec2 | null {
	const bounds = itemBounds(item);
	return bounds ? boundsCenter(bounds) : null;
}

/**
 * Whether the loop selects this item.
 *
 * Strokes and paths go by how much of their length is enclosed (a path is
 * usually imported handwriting, so it should lasso like a stroke); shapes and text boxes go by
 * their centre, because their outline is mostly empty space and requiring the
 * whole box would make a big shape unselectable.
 */
export function selectsItem(item: Item, polygon: readonly Vec2[]): boolean {
	if (polygon.length < 3) return false;
	if (item.type === 'stroke') {
		return fractionInside(item.points, polygon) >= LASSO_STROKE_THRESHOLD;
	}
	if (item.type === 'path') {
		const vertices = flattenPath(pathCommands(item), 1)
			.flat()
			.map(([x, y]): StrokeSample => [x, y, 1]);
		return fractionInside(vertices, polygon) >= LASSO_STROKE_THRESHOLD;
	}
	const centre = itemCenter(item);
	return centre ? pointInPolygon(centre[0], centre[1], polygon) : false;
}

/** Everything on the page the loop encloses, with its position in the list. */
export function selectByLasso(
	items: readonly Item[],
	polygon: readonly Vec2[],
	pageKey: PageKey,
): ItemRef[] {
	const selected: ItemRef[] = [];
	items.forEach((item, index) => {
		if (selectsItem(item, polygon)) {
			selected.push({ pageKey, index, item });
		}
	});
	return selected;
}

/** The union of the selected items' bounds, for the selection box. */
export function selectionBounds(refs: readonly ItemRef[]): Bounds | null {
	let union: Bounds | null = null;
	for (const ref of refs) {
		const bounds = itemBounds(ref.item);
		if (!bounds) continue;
		union = union
			? {
					minX: Math.min(union.minX, bounds.minX),
					minY: Math.min(union.minY, bounds.minY),
					maxX: Math.max(union.maxX, bounds.maxX),
					maxY: Math.max(union.maxY, bounds.maxY),
				}
			: bounds;
	}
	return union;
}

/**
 * How close a click has to be to count as hitting something, in SCREEN pixels.
 *
 * Converted to PDF units by the caller through the viewport scale, so the target
 * feels the same size whatever the zoom.
 */
export const SELECT_TOLERANCE_PX = 4;

/** How far a gesture may wander and still be a tap, in screen pixels. */
export const TAP_SLOP_PX = 5;

/**
 * Whether a gesture never really moved, and so is a click rather than a loop.
 *
 * Measured from the first point: a tap that jitters a pixel or two must not be
 * read as a lasso enclosing nothing.
 */
export function isTapGesture(
	points: readonly Vec2[],
	slop: number,
): boolean {
	const first = points[0];
	if (!first) return true;
	for (const [x, y] of points) {
		if (Math.hypot(x - first[0], y - first[1]) > slop) return false;
	}
	return true;
}

/**
 * The topmost item under a point, or null when the point hits nothing.
 *
 * "Topmost" is by paint order: highest z wins, and among equal z the one drawn
 * last. Strokes are tested against their real outline; shapes and text against
 * their box, so clicking inside an unfilled rectangle still selects it — which is
 * what the lasso's own centre rule already implies.
 */
export function selectByPoint(
	items: readonly Item[],
	x: number,
	y: number,
	tolerance: number,
	pageKey: PageKey,
): ItemRef | null {
	const candidates = items
		.map((item, index) => ({ item, index }))
		.sort((a, b) => b.item.z - a.item.z || b.index - a.index);

	for (const { item, index } of candidates) {
		const shape = itemHitShape(item);
		if (!shape) continue;
		if (hitTestShape(shape, x, y, tolerance)) {
			return { pageKey, index, item };
		}
	}
	return null;
}

/** Close a freehand loop, so the last point joins the first. */
export function closeLoop(points: readonly Vec2[]): Vec2[] {
	if (points.length < 3) return [...points];
	const first = points[0];
	const last = points[points.length - 1];
	if (!first || !last) return [...points];
	const already = first[0] === last[0] && first[1] === last[1];
	return already ? [...points] : [...points, [first[0], first[1]]];
}
