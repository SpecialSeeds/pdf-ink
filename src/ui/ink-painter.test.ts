import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InkStore, type ItemStore } from '../core/ink-store';
import type { Stroke, StrokeSample } from '../core/items';
import { syntheticViewport } from '../core/page-viewport';
import { DEFAULT_PEN, createStroke } from '../core/stroke';
import { DEFAULT_PAGE_THEMES } from '../core/theme';
import type { PageRecord } from '../types/view';
import { InkPainter } from './ink-painter';

/** Counts what a canvas is asked to do. */
class Ops {
	fills = 0;
	/** drawImage calls, by argument count: 3 is a whole copy, 9 a patch. */
	copies: number[] = [];
	clears: [number, number][] = [];
	reset(): void {
		this.fills = 0;
		this.copies = [];
		this.clears = [];
	}
}

function fakeCanvas(ops: Ops, width = 1224, height = 1584): HTMLCanvasElement {
	const ctx = {
		globalAlpha: 1,
		fillStyle: '',
		setTransform: () => undefined,
		transform: () => undefined,
		save: () => undefined,
		restore: () => undefined,
		clearRect: (_x: number, _y: number, w: number, h: number) => {
			ops.clears.push([w, h]);
		},
		drawImage: (...args: unknown[]) => {
			ops.copies.push(args.length);
		},
		fill: () => {
			ops.fills += 1;
		},
		beginPath: () => undefined,
		moveTo: () => undefined,
		lineTo: () => undefined,
		closePath: () => undefined,
		setLineDash: () => undefined,
		stroke: () => undefined,
	};
	const canvas = {
		width,
		height,
		getContext: () => ctx,
		doc: { createElement: () => fakeCanvas(ops, width, height) },
	};
	Object.assign(ctx, { canvas });
	return canvas as unknown as HTMLCanvasElement;
}

class FakePath2D {
	moveTo(): void {}
	lineTo(): void {}
	quadraticCurveTo(): void {}
	bezierCurveTo(): void {}
	closePath(): void {}
}

function record(key: string, ops: Ops): PageRecord {
	const viewport = syntheticViewport(612, 792, 1);
	return {
		geom: { key },
		viewport,
		cssWidth: 612,
		cssHeight: 792,
		bitmapScale: 1,
		bitmapDpr: 2,
		inkCanvasEl: fakeCanvas(ops),
		highlightCanvasEl: fakeCanvas(ops),
		detail: null,
	} as unknown as PageRecord;
}

/** A line of handwriting at row `n`. */
function stroke(id: string, n: number): Stroke {
	const s = createStroke(DEFAULT_PEN, id, 1);
	for (let i = 0; i < 40; i++) s.points.push([40 + i * 2 + Math.sin(i) * 3, 750 - (n % 50) * 14 + Math.cos(i / 2) * 4, 1]);
	return s;
}

beforeEach(() => {
	vi.stubGlobal('Path2D', FakePath2D);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe('painting committed ink', () => {
	function setup(strokes: number): { store: InkStore; painter: InkPainter; ops: Ops; page: PageRecord; other: PageRecord } {
		const store = new InkStore(() => 1);
		for (let i = 0; i < strokes; i++) store.add('pdf:0', stroke(`s${String(i)}`, i));
		store.add('pdf:1', stroke('other', 0));
		const ops = new Ops();
		const painter = new InkPainter(store as unknown as ItemStore, () => DEFAULT_PAGE_THEMES.light);
		return { store, painter, ops, page: record('pdf:0', ops), other: record('pdf:1', ops) };
	}

	it('draws a new stroke onto what is there, rather than every stroke again', () => {
		const { store, painter, ops, page } = setup(300);
		painter.paint(page, null, null);
		expect(ops.fills).toBe(300);

		ops.reset();
		store.add('pdf:0', stroke('new', 301));
		painter.paint(page, null, null);
		expect(ops.fills).toBe(1);
	});

	it('draws nothing again on a page a stroke elsewhere did not touch', () => {
		const { store, painter, ops, other } = setup(10);
		painter.paint(other, null, null);
		ops.reset();
		store.add('pdf:0', stroke('elsewhere', 11));
		painter.paint(other, null, null);
		expect(ops.fills).toBe(0);
	});

	it('draws the page again when an item is removed or changed', () => {
		const { store, painter, ops, page } = setup(20);
		painter.paint(page, null, null);
		ops.reset();
		store.removeById('pdf:0', 's3');
		painter.paint(page, null, null);
		expect(ops.fills).toBe(19);
	});

	it('copies only the stroke\'s patch on each frame of writing', () => {
		const { painter, ops, page } = setup(50);
		painter.paint(page, null, null);
		const live = stroke('live', 5);
		const samples: StrokeSample[] = live.points.map(([x, y, p]) => {
			const [cx, cy] = page.viewport.convertToViewportPoint(x, y);
			return [cx, cy, p];
		});
		for (let frame = 1; frame <= 3; frame++) {
			ops.reset();
			painter.paint(page, { item: live, samples: samples.slice(0, frame * 10) }, null);
			// Ink and highlighter canvases: a patch each, not the whole page.
			expect(ops.copies).toEqual([9, 9]);
			for (const [w, h] of ops.clears) expect(w * h).toBeLessThan(1224 * 1584 * 0.25);
			expect(ops.fills).toBe(1);
		}

		// Once the stroke is done, the next paint copies the whole page back.
		ops.reset();
		painter.paint(page, null, null);
		expect(ops.copies).toEqual([3, 3]);
	});

	it('copies the whole page after anything drawn outside a patch', () => {
		const { painter, ops, page } = setup(5);
		painter.paint(page, null, null);
		painter.paintLasso(page, [
			[10, 10],
			[50, 50],
		]);
		const live = stroke('live', 1);
		ops.reset();
		painter.paint(page, { item: live, samples: [[100, 100, 1]] }, null);
		expect(ops.copies).toEqual([3, 3]);
	});
});

describe('repainting cost', () => {
	it('is a stroke\'s worth after a stroke, not a page\'s worth', () => {
		const store = new InkStore(() => 1);
		for (let i = 0; i < 1500; i++) store.add('pdf:0', stroke(`s${String(i)}`, i));
		const ops = new Ops();
		const painter = new InkPainter(store as unknown as ItemStore, () => DEFAULT_PAGE_THEMES.light);
		const page = record('pdf:0', ops);

		let t = performance.now();
		painter.paint(page, null, null);
		const first = performance.now() - t;

		store.add('pdf:0', stroke('new', 1501));
		t = performance.now();
		painter.paint(page, null, null);
		const afterStroke = performance.now() - t;

		// Zooming repaints everything, at the new size, but reuses every outline.
		page.viewport = syntheticViewport(612, 792, 2);
		page.inkCanvasEl.width = 2448;
		page.inkCanvasEl.height = 3168;
		ops.reset();
		t = performance.now();
		painter.paint(page, null, null);
		const afterZoom = performance.now() - t;

		expect(afterStroke).toBeLessThan(first / 20);
		expect(ops.fills).toBe(1501);
		expect(afterZoom).toBeLessThan(first / 5);
	});
});
