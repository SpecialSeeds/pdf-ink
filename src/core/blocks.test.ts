import { describe, expect, it } from 'vitest';
import { blockBox, blockTargetFor, segmentBlocks, segmentPage, typicalLineHeight } from './blocks';
import type { Item, Stroke, TextItem } from './items';
import { createStroke, DEFAULT_PEN } from './stroke';

/** A handwritten word: a short squiggle from (x, y), 8 pt tall, `w` wide. */
function word(id: string, x: number, y: number, w = 30): Stroke {
	const s = createStroke(DEFAULT_PEN, id, 1);
	for (let i = 0; i <= 10; i++) s.points.push([x + (i * w) / 10, y + (i % 2) * 8, 1]);
	return s;
}

/** A paragraph: `lines` lines of `perLine` words, 16 pt apart, from the top at `top`. */
function paragraph(prefix: string, x: number, top: number, lines: number, perLine = 4): Stroke[] {
	const out: Stroke[] = [];
	for (let l = 0; l < lines; l++) {
		for (let w = 0; w < perLine; w++) out.push(word(`${prefix}${String(l)}-${String(w)}`, x + w * 40, top - l * 16));
	}
	return out;
}

function text(id: string, x: number, y: number): TextItem {
	return { type: 'text', id, color: '#000', opacity: 1, rotation: 0, z: 0, updatedAt: 1, box: { x, y, w: 120, h: 14 }, text: 'hi', fontSize: 12 };
}

describe('segmentBlocks', () => {
	it('groups words into lines and lines into paragraphs', () => {
		const items: Item[] = [
			...paragraph('a', 40, 740, 3),
			...paragraph('b', 40, 620, 4),
			...paragraph('c', 40, 480, 2),
			...paragraph('d', 40, 380, 3),
			...paragraph('e', 40, 260, 2),
		];
		const blocks = segmentBlocks(items);
		expect(blocks.map((b) => b.id)).toEqual(['B1', 'B2', 'B3', 'B4', 'B5']);
		expect(blocks.map((b) => b.itemIds.length)).toEqual([12, 16, 8, 12, 8]);
		expect(blocks[0]?.itemIds.every((id) => id.startsWith('a'))).toBe(true);
		expect(blocks[4]?.itemIds.every((id) => id.startsWith('e'))).toBe(true);
	});

	it('reads top to bottom, and left to right within a row', () => {
		const items: Item[] = [
			...paragraph('right', 340, 740, 2, 3),
			...paragraph('left', 40, 742, 2, 3),
			...paragraph('below', 40, 600, 2, 3),
			...paragraph('low', 40, 450, 2, 3),
			...paragraph('lowest', 40, 300, 2, 3),
		];
		const blocks = segmentBlocks(items);
		const firstOf = (b: (typeof blocks)[number] | undefined): string => b?.itemIds[0]?.replace(/\d.*$/, '') ?? '';
		expect(blocks.map(firstOf)).toEqual(['left', 'right', 'below', 'low', 'lowest']);
	});

	it('cuts a dense page into no more than 20 blocks', () => {
		const items: Item[] = [];
		for (let p = 0; p < 40; p++) items.push(...paragraph(`p${String(p)}-`, 40 + (p % 2) * 300, 760 - Math.floor(p / 2) * 36, 1, 2));
		const blocks = segmentBlocks(items);
		expect(blocks.length).toBeLessThanOrEqual(20);
		expect(blocks.length).toBeGreaterThanOrEqual(5);
	});

	it('keeps blocks from overlapping', () => {
		const items: Item[] = [...paragraph('a', 40, 700, 3), text('t', 60, 690), ...paragraph('b', 40, 400, 3)];
		const blocks = segmentBlocks(items);
		for (let i = 0; i < blocks.length; i++) {
			for (let j = i + 1; j < blocks.length; j++) {
				const a = blocks[i]?.bounds;
				const b = blocks[j]?.bounds;
				if (!a || !b) continue;
				const overlap = a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
				expect(overlap).toBe(false);
			}
		}
	});

	it('ignores deleted items, and gives nothing for an empty page', () => {
		const gone = { ...word('gone', 40, 700), deletedAt: 5 };
		expect(segmentBlocks([gone])).toEqual([]);
		expect(segmentBlocks([])).toEqual([]);
	});

	it('is deterministic, so a transcript\'s ids keep their meaning', () => {
		const items: Item[] = [...paragraph('a', 40, 740, 3), ...paragraph('b', 40, 500, 3)];
		expect(segmentBlocks(items)).toEqual(segmentBlocks([...items].reverse()));
	});

	it('stores a box as x, y, width and height', () => {
		expect(blockBox({ minX: 10.04, minY: 20, maxX: 50.16, maxY: 35.5 })).toEqual([10, 20, 40.1, 15.5]);
		expect(typicalLineHeight([])).toBe(12);
	});
});

describe('block targets by page size', () => {
	it('are 5 to 20 for a Letter page or smaller, and grow with a larger page', () => {
		expect(blockTargetFor(612, 792)).toEqual({ min: 5, max: 20 });
		expect(blockTargetFor(300, 300)).toEqual({ min: 5, max: 20 });
		expect(blockTargetFor(1224, 1584)).toEqual({ min: 20, max: 80 });
	});

	it('let a board keep more blocks than a Letter page would', () => {
		const items: Item[] = [];
		for (let p = 0; p < 60; p++) items.push(...paragraph(`p${String(p)}-`, 40 + (p % 6) * 400, 1500 - Math.floor(p / 6) * 140, 2, 3));
		expect(segmentBlocks(items).length).toBeLessThanOrEqual(20);
		const board = segmentPage(items, 2448, 1584);
		expect(board.length).toBeGreaterThan(20);
		expect(board.length).toBeLessThanOrEqual(blockTargetFor(2448, 1584).max);
	});
});

describe('reading order beside a tall diagram', () => {
	it('numbers the lines beside it top to bottom, not all at the diagram\'s row', () => {
		// A tall diagram on the left; to its right, a line near its top and one lower down.
		const diagram: Item[] = [];
		for (let i = 0; i < 12; i++) diagram.push(word(`d${String(i)}`, 40, 740 - i * 20, 150));
		const items: Item[] = [
			...diagram,
			...paragraph('upper', 340, 735, 2, 3),
			...paragraph('lower', 340, 560, 1, 2),
			...paragraph('foot', 40, 380, 2, 3),
			...paragraph('end', 40, 250, 2, 3),
		];
		const order = segmentBlocks(items).map((b) => b.itemIds[0]?.replace(/[\d-].*$/, ''));
		expect(order.indexOf('upper')).toBeLessThan(order.indexOf('lower'));
		expect(order.indexOf('d')).toBeLessThan(order.indexOf('upper'));
		expect(order.indexOf('lower')).toBeLessThan(order.indexOf('foot'));
	});
});
