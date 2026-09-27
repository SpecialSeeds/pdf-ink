/**
 * Selection transforms. Pure.
 *
 * Every transform is expressed in PDF user space and applied to the stored data,
 * never to a rendering matrix — so a moved stroke is genuinely moved in the
 * sidecar, and the result is identical on screen and on export.
 */

import type { ItemChange, ItemRef } from './history';
import type { Box, Item } from './items';
import { selectionBounds } from './lasso';
import type { Vec2 } from 'perfect-freehand';

/**
 * Scale about a pivot, then rotate about it, then translate.
 *
 * `degrees` is clockwise, matching `ItemBase.rotation`.
 */
export interface SelectionTransform {
	readonly dx: number;
	readonly dy: number;
	readonly sx: number;
	readonly sy: number;
	readonly pivotX: number;
	readonly pivotY: number;
	readonly degrees: number;
}

export const IDENTITY_TRANSFORM: SelectionTransform = {
	dx: 0,
	dy: 0,
	sx: 1,
	sy: 1,
	pivotX: 0,
	pivotY: 0,
	degrees: 0,
};

export function translation(dx: number, dy: number): SelectionTransform {
	return { ...IDENTITY_TRANSFORM, dx, dy };
}

export function scaleAbout(
	pivotX: number,
	pivotY: number,
	sx: number,
	sy: number,
): SelectionTransform {
	return { ...IDENTITY_TRANSFORM, pivotX, pivotY, sx, sy };
}

export function rotationAbout(
	pivotX: number,
	pivotY: number,
	degrees: number,
): SelectionTransform {
	return { ...IDENTITY_TRANSFORM, pivotX, pivotY, degrees };
}

export function isIdentity(t: SelectionTransform): boolean {
	return (
		t.dx === 0 &&
		t.dy === 0 &&
		t.sx === 1 &&
		t.sy === 1 &&
		t.degrees === 0
	);
}

/** Map one PDF-space point through the transform. */
export function mapPoint(x: number, y: number, t: SelectionTransform): Vec2 {
	const scaledX = t.pivotX + (x - t.pivotX) * t.sx;
	const scaledY = t.pivotY + (y - t.pivotY) * t.sy;

	if (t.degrees === 0) return [scaledX + t.dx, scaledY + t.dy];

	// Clockwise in a y-up space.
	const radians = (t.degrees * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const offsetX = scaledX - t.pivotX;
	const offsetY = scaledY - t.pivotY;
	return [
		t.pivotX + offsetX * cos + offsetY * sin + t.dx,
		t.pivotY - offsetX * sin + offsetY * cos + t.dy,
	];
}

function transformBox(box: Box, t: SelectionTransform): Box {
	// The centre moves through the full transform; the box keeps axis-aligned
	// dimensions and the item's own `rotation` carries the turn. A rotated box
	// scaled non-uniformly is therefore an approximation — unavoidable while the
	// schema stores a box plus an angle rather than a matrix.
	const centreX = box.x + box.w / 2;
	const centreY = box.y + box.h / 2;
	const [movedX, movedY] = mapPoint(centreX, centreY, t);
	const width = box.w * t.sx;
	const height = box.h * t.sy;
	return {
		x: movedX - width / 2,
		y: movedY - height / 2,
		w: width,
		h: height,
	};
}

/** A copy of `item` with the transform baked into its stored geometry. */
export function transformItem(item: Item, t: SelectionTransform): Item {
	if (item.type === 'stroke') {
		return {
			...item,
			// Pressure is untouched; only position changes.
			points: item.points.map(([x, y, pressure]) => {
				const [mx, my] = mapPoint(x, y, t);
				return [mx, my, pressure];
			}),
			// A stroke's turn is baked into its points, so its angle stays 0.
			rotation: item.rotation,
		};
	}
	const transformed = {
		...item,
		box: transformBox(item.box, t),
		rotation: item.rotation + t.degrees,
	};
	if (transformed.type === 'text') {
		// Vertical scale drives the font size; horizontal scale only changes the
		// wrap width, which is what dragging a box wider should do.
		return { ...transformed, fontSize: transformed.fontSize * Math.abs(t.sy) };
	}
	return transformed;
}

/** One change per selected item, for a single transform operation. */
export function transformChanges(
	refs: readonly ItemRef[],
	t: SelectionTransform,
): ItemChange[] {
	if (isIdentity(t)) return [];
	return refs.map((ref) => ({
		pageKey: ref.pageKey,
		before: ref.item,
		after: transformItem(ref.item, t),
	}));
}

/**
 * Copies of the selection, offset so the original's bottom-right corner becomes
 * the copy's top-left.
 *
 * A small nudge is not enough: the copy would overlap the original, and lassoing
 * the result would just select both. Offsetting by the selection's full size puts
 * the duplicate clear of it, diagonally down-right — which in PDF space (y up) is
 * one width across and one height *down*.
 */
export function duplicateItems(
	refs: readonly ItemRef[],
	nextId: () => string,
): Item[] {
	const bounds = selectionBounds(refs);
	const dx = bounds ? bounds.maxX - bounds.minX : 0;
	const dy = bounds ? -(bounds.maxY - bounds.minY) : 0;
	const offset = translation(dx, dy);
	return refs.map((ref) =>
		transformItem({ ...ref.item, id: nextId() }, offset),
	);
}

export type ZDirection = 'front' | 'back';

/**
 * Move the selection to the front or the back of its page.
 *
 * Front and back rather than one step at a time: with several items selected,
 * "one step" has no single meaning, whereas this is predictable.
 */
export function zChanges(
	refs: readonly ItemRef[],
	pageItems: readonly Item[],
	direction: ZDirection,
): ItemChange[] {
	if (refs.length === 0) return [];
	let highest = Number.NEGATIVE_INFINITY;
	let lowest = Number.POSITIVE_INFINITY;
	for (const item of pageItems) {
		if (item.z > highest) highest = item.z;
		if (item.z < lowest) lowest = item.z;
	}
	if (!Number.isFinite(highest)) return [];

	// Keep the selection's own relative order while moving it as a block.
	const ordered = [...refs].sort((a, b) => a.item.z - b.item.z);
	return ordered.map((ref, offset) => ({
		pageKey: ref.pageKey,
		before: ref.item,
		after: {
			...ref.item,
			z:
				direction === 'front'
					? highest + 1 + offset
					: lowest - refs.length + offset,
		},
	}));
}
