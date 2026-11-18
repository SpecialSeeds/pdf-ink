import { describe, expect, it } from 'vitest';
import {
	CANVAS_FOLDER,
	MAX_CANVAS_SIDE,
	NEW_CANVAS_SIZE,
	canvasDataPath,
	canvasImagesFolder,
	canvasStep,
	grownCanvasPage,
	isCanvasId,
	isCanvasPath,
	newCanvasData,
	NOTEBOOK_MARGIN,
	selectionForNotebook,
	withSentPage,
} from './canvas';
import { newNotebookData } from './new-notebook';
import { HEADER_BAND } from './header';
import { orderPages } from './pages';
import { itemBounds } from './hit-test';
import type { Item } from './items';
import { parseInkData, serializeInkData } from './ink-serialization';
import { type InsertedPage, pageOrigin } from './pages';
import { templateGeometry, templateSpacing, translateTemplate } from './templates';

function canvas(over: Partial<InsertedPage> = {}): InsertedPage {
	return {
		id: 'c',
		afterPdfPage: -1,
		sortKey: 'a0',
		template: 'grid5',
		size: { width: 1000, height: 600 },
		updatedAt: 0,
		...over,
	};
}

const STEP = canvasStep('grid5');

describe('temporary board paths', () => {
	it('keeps everything for one board in its own hidden folder', () => {
		expect(CANVAS_FOLDER.startsWith('.')).toBe(true);
		expect(canvasDataPath('abc')).toBe(`${CANVAS_FOLDER}/abc/board.inknote`);
		expect(canvasImagesFolder('abc')).toBe(`${CANVAS_FOLDER}/abc/images`);
		expect(isCanvasPath(canvasImagesFolder('abc') + '/x.png')).toBe(true);
		expect(isCanvasPath('Notes/images/x.png')).toBe(false);
	});

	it('accepts only ids it could have made', () => {
		expect(isCanvasId('0b1e6a52-7d3c-4c1f-9a7e-2f1d5e0c9b11')).toBe(true);
		expect(isCanvasId('../etc')).toBe(false);
		expect(isCanvasId(3)).toBe(false);
	});
});

describe('newCanvasData', () => {
	it('is one ruled board page that round-trips', () => {
		const data = newCanvasData(5, 'p', 'd');
		expect(data.layout).toBe('board');
		expect(data.insertedPages).toHaveLength(1);
		expect(data.insertedPages[0]?.size).toEqual(NEW_CANVAS_SIZE);
		const parsed = parseInkData(serializeInkData(data));
		expect(parsed.ok && parsed.data).toEqual(data);
	});
});

describe('grownCanvasPage', () => {
	it('leaves a page alone when the region is inside it', () => {
		expect(grownCanvasPage(canvas(), { minX: 10, minY: 10, maxX: 990, maxY: 590 }, 100, 1)).toBeNull();
	});

	it('grows right and up without moving the corner', () => {
		const grown = grownCanvasPage(canvas(), { minX: 10, minY: 10, maxX: 1010, maxY: 650 }, 100, 1)!;
		expect(grown.right).toBeGreaterThanOrEqual(100);
		expect(grown.top).toBeGreaterThanOrEqual(100);
		expect(grown.left).toBe(0);
		expect(grown.bottom).toBe(0);
		expect(grown.page.origin).toBeUndefined();
		expect(grown.page.updatedAt).toBe(1);
	});

	it('grows left and down by moving the corner, never past the region', () => {
		const grown = grownCanvasPage(canvas(), { minX: -30, minY: -400, maxX: 500, maxY: 500 }, 0, 1)!;
		const origin = pageOrigin(grown.page);
		expect(origin.x).toBeLessThanOrEqual(-30);
		expect(origin.y).toBeLessThanOrEqual(-400);
		expect(origin.x).toBe(-grown.left);
		expect(origin.y).toBe(-grown.bottom);
		// The old top-right corner stays where it was.
		expect(origin.x + grown.page.size.width).toBe(1000);
		expect(origin.y + grown.page.size.height).toBe(600);
	});

	it('grows in whole major grid steps, so the grid under the ink keeps its place', () => {
		const page = canvas();
		const grown = grownCanvasPage(page, { minX: -1, minY: -1, maxX: 1001, maxY: 601 }, 0, 1)!;
		for (const side of [grown.left, grown.right, grown.top, grown.bottom]) {
			expect(side / STEP).toBeCloseTo(Math.round(side / STEP));
		}
		// Every line of the old grid is still a line of the new one, with the same weight.
		const before = translateTemplate(templateGeometry('grid5', page.size.width, page.size.height), 0, 0);
		const o = pageOrigin(grown.page);
		const after = translateTemplate(templateGeometry('grid5', grown.page.size.width, grown.page.size.height), o.x, o.y);
		const verticals = (g: typeof before): Map<string, boolean> =>
			new Map(g.lines.filter((l) => l.x1 === l.x2).map((l) => [l.x1.toFixed(3), l.major === true]));
		const old = verticals(before);
		const now = verticals(after);
		expect(old.size).toBeGreaterThan(10);
		for (const [x, major] of old) expect(now.get(x)).toBe(major);
		expect(templateSpacing('grid5')).toBeGreaterThan(0);
	});

	it('stops at the largest side allowed', () => {
		const page = canvas({ size: { width: MAX_CANVAS_SIDE - STEP / 2, height: 600 } });
		const grown = grownCanvasPage(page, { minX: 0, minY: 0, maxX: MAX_CANVAS_SIDE * 2, maxY: 600 }, 0, 1);
		expect(grown).toBeNull();
	});
});

describe('selectionForNotebook', () => {
	const LETTER = { width: 612, height: 792 };
	const stroke = (id: string, x: number, y: number, z = 0): Item => ({
		type: 'stroke',
		tool: 'pen',
		id,
		color: '#000000',
		opacity: 1,
		rotation: 0,
		z,
		updatedAt: 0,
		width: 2,
		points: [
			[x, y, 0.5],
			[x + 100, y + 50, 0.5],
		],
	});
	let counter = 0;
	const nextId = (): string => `new${String(++counter)}`;

	it('puts the ink at the top left of a Letter page, inside the margin', () => {
		const sent = selectionForNotebook([stroke('a', -5000, 3000)], LETTER, 0, nextId, 9)!;
		expect(sent.size).toEqual(LETTER);
		const b = itemBounds(sent.items[0]!)!;
		expect(b.minX).toBeCloseTo(NOTEBOOK_MARGIN);
		expect(b.maxY).toBeCloseTo(LETTER.height - NOTEBOOK_MARGIN);
	});

	it('keeps clear of a header band', () => {
		const sent = selectionForNotebook([stroke('a', 0, 0)], LETTER, 64, nextId, 9)!;
		expect(itemBounds(sent.items[0]!)!.maxY).toBeCloseTo(LETTER.height - 64 - NOTEBOOK_MARGIN);
	});

	it('gives every copy a new id and the time it was sent', () => {
		const sent = selectionForNotebook([stroke('a', 0, 0), stroke('b', 50, 50)], LETTER, 0, nextId, 9)!;
		const ids = sent.items.map((item) => item.id);
		expect(ids).not.toContain('a');
		expect(new Set(ids).size).toBe(2);
		expect(sent.items.every((item) => item.updatedAt === 9)).toBe(true);
	});

	it('keeps paint order', () => {
		const sent = selectionForNotebook([stroke('top', 0, 0, 5), stroke('low', 0, 0, 1)], LETTER, 0, nextId, 9)!;
		const [first, second] = sent.items;
		expect(first!.z).toBeLessThan(second!.z);
		// The one painted lowest comes first.
		expect((first as Extract<Item, { type: 'stroke' }>).points[0]![0]).toBeCloseTo(
			(second as Extract<Item, { type: 'stroke' }>).points[0]![0],
		);
	});

	it('enlarges the page for ink bigger than it, never shrinking the ink', () => {
		const wide = { ...stroke('a', 0, 0), points: [[0, 0, 0.5], [2000, 10, 0.5]] as [number, number, number][] };
		const sent = selectionForNotebook([wide], LETTER, 0, nextId, 9)!;
		expect(sent.size.width).toBeGreaterThanOrEqual(2000 + 2 * NOTEBOOK_MARGIN);
		expect(sent.size.height).toBe(LETTER.height);
		const b = itemBounds(sent.items[0]!)!;
		expect(b.maxX - b.minX).toBeCloseTo(itemBounds(wide)!.maxX - itemBounds(wide)!.minX);
	});

	it('ignores deleted ink, and has nothing to send without live ink', () => {
		expect(selectionForNotebook([{ ...stroke('a', 0, 0), deletedAt: 3 }], LETTER, 0, nextId, 9)).toBeNull();
		expect(selectionForNotebook([], LETTER, 0, nextId, 9)).toBeNull();
	});
});

describe('withSentPage', () => {
	const ink = (id: string): Item => ({
		type: 'stroke',
		tool: 'pen',
		id,
		color: '#000000',
		opacity: 1,
		rotation: 0,
		z: 0,
		updatedAt: 0,
		width: 2,
		points: [
			[100, 100, 0.5],
			[200, 150, 0.5],
		],
	});
	let n = 0;
	const nextId = (): string => `id${String(++n)}`;

	it('adds a page after the last one, leaving the rest alone', () => {
		const notebook = newNotebookData(1, 'first', 'doc');
		const sent = withSentPage(notebook, [ink('a')], nextId, 7, 'second')!;
		expect(sent.pageNumber).toBe(2);
		const order = orderPages(0, sent.data.insertedPages);
		expect(order.map((slot) => slot.key)).toEqual(['ins:first', 'ins:second']);
		expect(sent.data.insertedPages[0]).toEqual(notebook.insertedPages[0]);
		expect(sent.data.pages['ins:second']).toHaveLength(1);
		expect(sent.data.docId).toBe('doc');
	});

	it('takes the last page\'s size and ruling', () => {
		const notebook = newNotebookData(1, 'first', 'doc');
		const landscape = {
			...notebook,
			insertedPages: [{ ...notebook.insertedPages[0]!, size: { width: 792, height: 612 }, template: 'dot' as const }],
		};
		const page = withSentPage(landscape, [ink('a')], nextId, 7, 'second')!.data.insertedPages[1]!;
		expect(page.size).toEqual({ width: 792, height: 612 });
		expect(page.template).toBe('dot');
	});

	it('keeps an empty notebook\'s first page clear of its header', () => {
		const empty = { ...newNotebookData(1, 'x', 'doc'), insertedPages: [], header: { createdAt: 1 } };
		const sent = withSentPage(empty, [ink('a')], nextId, 7, 'p')!;
		expect(sent.pageNumber).toBe(1);
		const top = itemBounds(sent.data.pages['ins:p']![0]!)!.maxY;
		const height = sent.data.insertedPages[0]!.size.height;
		expect(top).toBeCloseTo(height - HEADER_BAND - NOTEBOOK_MARGIN);
	});

	it('sends nothing without ink', () => {
		expect(withSentPage(newNotebookData(1), [], nextId, 7)).toBeNull();
	});
});
