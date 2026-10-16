/**
 * Selection state and the operations that act on it. Pure.
 *
 * The operations are written once, against the generic `transform` history
 * operation, so the select tool and anything else that acts on a selection share
 * them.
 */

import type { ItemChange, ItemRef } from './history';
import type { Item } from './items';

/**
 * Which colour palette an item answers to: highlighter ink, or everything else.
 *
 * A selection of handwriting with highlighting over it gets one palette for each,
 * since a highlighter colour is rarely a sensible pen colour and vice versa.
 */
export type ColorLayer = 'ink' | 'highlight';

export function colorLayerOf(item: Item): ColorLayer {
	if (item.type === 'stroke' && item.tool === 'highlighter') return 'highlight';
	if (item.type === 'path' && item.highlight === true) return 'highlight';
	return 'ink';
}

/** A palette the selection needs, and the colour every item on it shares. */
export interface LayerColor {
	readonly layer: ColorLayer;
	/** Null when the items on this layer are not all one colour. */
	readonly color: string | null;
}

/** The palettes a selection needs, ink first, each only if it has items. */
export function selectionLayers(refs: readonly ItemRef[]): LayerColor[] {
	const layers: LayerColor[] = [];
	for (const layer of ['ink', 'highlight'] as const) {
		const colors = new Set(
			refs
				.filter((ref) => colorLayerOf(ref.item) === layer)
				.map((ref) => ref.item.color.toLowerCase()),
		);
		if (colors.size === 0) continue;
		const [only] = colors;
		layers.push({ layer, color: colors.size === 1 ? (only ?? null) : null });
	}
	return layers;
}

/**
 * Whole-item replacements that recolour the selected items, or only those on
 * `layer` when one is given.
 */
export function recolorChanges(
	refs: readonly ItemRef[],
	color: string,
	layer?: ColorLayer,
): ItemChange[] {
	const changes: ItemChange[] = [];
	for (const ref of refs) {
		if (layer !== undefined && colorLayerOf(ref.item) !== layer) continue;
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
