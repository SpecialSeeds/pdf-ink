import { describe, expect, it } from 'vitest';
import {
	INK_DATA_VERSION,
	type Item,
	SHAPE_KINDS,
	type ShapeItem,
	type TextItem,
	emptyInkData,
	inZOrder,
	isShape,
	isShapeKind,
	isStroke,
	isText,
} from './items';
import { DEFAULT_PEN, createStroke } from './stroke';

function shape(id: string, z: number): ShapeItem {
	return {
		type: 'shape',
		id,
		color: '#000',
		opacity: 1,
		rotation: 0,
		z,
		updatedAt: 0,
		kind: 'rect',
		box: { x: 0, y: 0, w: 10, h: 10 },
		width: 1,
		fill: null,
	};
}

function text(id: string, z: number): TextItem {
	return {
		type: 'text',
		id,
		color: '#000',
		opacity: 1,
		rotation: 0,
		z,
		updatedAt: 0,
		box: { x: 0, y: 0, w: 10, h: 10 },
		text: 'hi',
		fontSize: 12,
	};
}

function strokeAt(id: string, z: number): Item {
	return { ...createStroke(DEFAULT_PEN, id), z };
}

describe('schema', () => {
	it('is version 4', () => {
		expect(INK_DATA_VERSION).toBe(4);
		expect(emptyInkData()).toEqual({
			version: 4,
			pages: {},
			insertedPages: [],
		});
	});

	it('lists every shape kind from the spec', () => {
		expect([...SHAPE_KINDS]).toEqual([
			'line',
			'arrow',
			'rect',
			'ellipse',
			'triangle',
			'axes2d_q',
			'axes2d_c',
			'axes3d_c',
		]);
	});

	it('validates shape kinds', () => {
		for (const kind of SHAPE_KINDS) expect(isShapeKind(kind)).toBe(true);
		for (const bad of ['circle', '', 'RECT', 1, null, undefined]) {
			expect(isShapeKind(bad)).toBe(false);
		}
	});
});

describe('type guards narrow the union', () => {
	it('separates the three item types', () => {
		const items: Item[] = [strokeAt('s', 0), shape('h', 1), text('t', 2)];
		expect(items.filter(isStroke).map((i) => i.id)).toEqual(['s']);
		expect(items.filter(isShape).map((i) => i.id)).toEqual(['h']);
		expect(items.filter(isText).map((i) => i.id)).toEqual(['t']);
	});
});

describe('inZOrder', () => {
	it('sorts ascending, so higher z paints last', () => {
		const items = [strokeAt('c', 5), strokeAt('a', 1), strokeAt('b', 3)];
		expect(inZOrder(items).map((i) => i.id)).toEqual(['a', 'b', 'c']);
	});

	it('is stable for equal z, preserving insertion order', () => {
		const items = [strokeAt('a', 2), strokeAt('b', 2), strokeAt('c', 2)];
		expect(inZOrder(items).map((i) => i.id)).toEqual(['a', 'b', 'c']);
	});

	it('does not mutate its input', () => {
		const items = [strokeAt('b', 9), strokeAt('a', 1)];
		inZOrder(items);
		expect(items.map((i) => i.id)).toEqual(['b', 'a']);
	});

	it('handles negative and fractional z', () => {
		const items = [strokeAt('c', 0.5), strokeAt('a', -3), strokeAt('b', 0)];
		expect(inZOrder(items).map((i) => i.id)).toEqual(['a', 'b', 'c']);
	});

	it('is a no-op for an empty page', () => {
		expect(inZOrder([])).toEqual([]);
	});
});
