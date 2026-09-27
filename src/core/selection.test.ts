import { describe, expect, it } from 'vitest';
import type { ItemRef } from './history';
import type { Item, ShapeItem } from './items';
import { recolorChanges } from './selection';
import { DEFAULT_PEN, createStroke } from './stroke';

function strokeRef(id: string, color: string, index = 0): ItemRef {
	const item: Item = { ...createStroke(DEFAULT_PEN, id), color };
	return { pageKey: 'pdf:0', index, item };
}

function shapeRef(id: string, color: string, fill: string | null): ItemRef {
	const item: ShapeItem = {
		type: 'shape',
		id,
		color,
		opacity: 1,
		rotation: 0,
		z: 0,
		updatedAt: 0,
		kind: 'rect',
		box: { x: 0, y: 0, w: 10, h: 10 },
		width: 2,
		fill,
	};
	return { pageKey: 'pdf:1', index: 0, item };
}

describe('recolorChanges', () => {
	it('produces one change per selected item', () => {
		const changes = recolorChanges(
			[strokeRef('a', '#000000', 0), strokeRef('b', '#111111', 1)],
			'#ff0000',
		);
		expect(changes).toHaveLength(2);
		expect(changes.map((c) => c.after.color)).toEqual(['#ff0000', '#ff0000']);
	});

	it('carries the original item as `before`, so undo restores it', () => {
		const [change] = recolorChanges([strokeRef('a', '#123456')], '#ff0000');
		expect(change).toBeDefined();
		if (!change) return;
		expect(change.before.color).toBe('#123456');
		expect(change.after.color).toBe('#ff0000');
		expect(change.after.id).toBe(change.before.id);
	});

	it('skips items already in that colour, so a no-op records no history', () => {
		expect(recolorChanges([strokeRef('a', '#ff0000')], '#ff0000')).toEqual([]);
	});

	it('recolours only the differing items in a mixed selection', () => {
		const changes = recolorChanges(
			[strokeRef('same', '#ff0000', 0), strokeRef('diff', '#000000', 1)],
			'#ff0000',
		);
		expect(changes.map((c) => c.after.id)).toEqual(['diff']);
	});

	it('does not mutate the selected items', () => {
		const ref = strokeRef('a', '#000000');
		recolorChanges([ref], '#ff0000');
		expect(ref.item.color).toBe('#000000');
	});

	it('preserves every other field, including geometry and z', () => {
		const ref = strokeRef('a', '#000000');
		ref.item.z = 5;
		if (ref.item.type === 'stroke') ref.item.points.push([1, 2, 0.5]);
		const [change] = recolorChanges([ref], '#ff0000');
		if (!change || change.after.type !== 'stroke') return;
		expect(change.after.z).toBe(5);
		expect(change.after.points).toEqual([[1, 2, 0.5]]);
	});

	it('leaves a shape fill alone: an outline recolour is not a fill recolour', () => {
		const [change] = recolorChanges([shapeRef('s', '#000000', '#eeeeee')], '#ff0000');
		if (!change || change.after.type !== 'shape') return;
		expect(change.after.color).toBe('#ff0000');
		expect(change.after.fill).toBe('#eeeeee');
	});

	it('keeps each item on its own page', () => {
		const changes = recolorChanges(
			[strokeRef('a', '#000'), shapeRef('s', '#000', null)],
			'#ff0000',
		);
		expect(changes.map((c) => c.pageKey)).toEqual(['pdf:0', 'pdf:1']);
	});

	it('an empty selection produces no changes', () => {
		expect(recolorChanges([], '#ff0000')).toEqual([]);
	});
});
