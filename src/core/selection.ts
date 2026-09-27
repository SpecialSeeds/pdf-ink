/**
 * Selection state and the operations that act on it. Pure.
 *
 * No tool populates a selection yet — there is no select tool. This exists so the
 * operations that act on one are written once, against the generic `transform`
 * history operation, rather than being invented alongside that tool.
 */

import type { ItemChange, ItemRef } from './history';
import type { Item } from './items';

/** Whole-item replacements that recolour every selected item. */
export function recolorChanges(
	refs: readonly ItemRef[],
	color: string,
): ItemChange[] {
	const changes: ItemChange[] = [];
	for (const ref of refs) {
		if (ref.item.color === color) continue;
		changes.push({
			pageKey: ref.pageKey,
			before: ref.item,
			after: recolored(ref.item, color),
		});
	}
	return changes;
}

/**
 * A copy of `item` in a new colour.
 *
 * A shape's `fill` is deliberately left alone: recolouring an outline should not
 * silently repaint a filled interior the user chose separately.
 */
function recolored(item: Item, color: string): Item {
	return { ...item, color };
}
