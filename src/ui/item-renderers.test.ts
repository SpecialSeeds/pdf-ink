import { describe, expect, it } from 'vitest';
import type { Item, ShapeItem, TextItem } from '../core/items';
import { DEFAULT_PEN, createStroke } from '../core/stroke';
import { HIGHLIGHTER_OPACITY } from '../core/tools';
import { ITEM_RENDERERS, layerFor, rendererFor } from './item-renderers';

const pen: Item = createStroke(DEFAULT_PEN, 'pen');
const highlighter: Item = createStroke(
	{ tool: 'highlighter', color: '#ffe066', width: 16, opacity: HIGHLIGHTER_OPACITY },
	'hl',
);
const shape: ShapeItem = {
	type: 'shape',
	id: 's',
	color: '#000',
	opacity: 1,
	rotation: 0,
	z: 0,
	updatedAt: 0,
	kind: 'rect',
	box: { x: 0, y: 0, w: 1, h: 1 },
	width: 1,
	fill: null,
};
const text: TextItem = {
	type: 'text',
	id: 't',
	color: '#000',
	opacity: 1,
	rotation: 0,
	z: 0,
	updatedAt: 0,
	box: { x: 0, y: 0, w: 1, h: 1 },
	text: 'hi',
	fontSize: 12,
};

describe('layerFor', () => {
	it('puts highlighter ink on the multiply layer', () => {
		expect(layerFor(highlighter)).toBe('highlight');
	});

	it('puts pen ink on the opaque layer', () => {
		expect(layerFor(pen)).toBe('ink');
	});

	it('defaults other item types to the opaque layer', () => {
		expect(layerFor(shape)).toBe('ink');
		expect(layerFor(text)).toBe('ink');
	});
});

describe('per-type renderer dispatch', () => {
	it('resolves a renderer for strokes', () => {
		expect(typeof rendererFor(pen)).toBe('function');
		expect(typeof rendererFor(highlighter)).toBe('function');
	});

	it('resolves a renderer for shapes', () => {
		expect(typeof rendererFor(shape)).toBe('function');
	});

	it('resolves a renderer for text', () => {
		expect(typeof rendererFor(text)).toBe('function');
	});

	it('covers every item type in the schema', () => {
		expect(Object.keys(ITEM_RENDERERS).sort()).toEqual([
			'shape',
			'stroke',
			'text',
		]);
	});
});
