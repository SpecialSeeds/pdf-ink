import { describe, expect, it } from 'vitest';
import {
	BOARD_EDGE_ZONE,
	BOARD_GROWTH,
	NEW_BOARD_SIZE,
	grownBoardPage,
	newBoardData,
} from './board';
import { DESKTOP_BUDGET, MOBILE_BUDGET } from './canvas-budget';
import { detailRegion } from './detail-region';
import { parseInkData, serializeInkData } from './ink-serialization';
import { fitHeightZoom } from './layout';
import { mergeInkData } from './merge';
import { pageBounds } from './page-bounds';
import { insertedGeometry, pagesSignature } from './page-composition';
import { syntheticViewport } from './page-viewport';
import { type InsertedPage, pageOrigin } from './pages';
import { templateGeometry, templateSpacing, translateTemplate } from './templates';
import { PDF_TO_CSS_UNITS } from '../constants';
import { readInkViewState, writeInkViewState } from './view-state';

function board(over: Partial<InsertedPage> = {}): InsertedPage {
	return {
		id: 'b',
		afterPdfPage: -1,
		sortKey: 'a0',
		template: 'grid5',
		size: { width: 1000, height: 600 },
		updatedAt: 0,
		...over,
	};
}

/** Ink as a small box at (x, y). */
function inkAt(x: number, y: number, size = 4): { minX: number; minY: number; maxX: number; maxY: number } {
	return { minX: x, minY: y, maxX: x + size, maxY: y + size };
}

describe('grownBoardPage', () => {
	it('leaves a board alone when the ink is clear of its right and bottom edges', () => {
		expect(grownBoardPage(board(), inkAt(500, 300), 1)).toBeNull();
		// The left and top edges never grow the board.
		expect(grownBoardPage(board(), inkAt(1, 590), 1)).toBeNull();
	});

	it('widens to the right for ink within 10% of the right edge', () => {
		const grown = grownBoardPage(board(), inkAt(1000 - BOARD_EDGE_ZONE * 1000 + 1, 300), 7);
		expect(grown).not.toBeNull();
		if (!grown) return;
		expect(grown.size.height).toBe(600);
		expect(grown.size.width).toBeGreaterThanOrEqual(1000 * (1 + BOARD_GROWTH));
		expect(grown.origin).toBeUndefined();
		expect(grown.updatedAt).toBe(7);
	});

	it('lengthens downward for ink within 10% of the bottom, keeping the top where it was', () => {
		const grown = grownBoardPage(board(), inkAt(500, 10), 1);
		if (!grown) throw new Error('did not grow');
		expect(grown.size.width).toBe(1000);
		expect(grown.size.height).toBeGreaterThanOrEqual(600 * (1 + BOARD_GROWTH));
		const origin = pageOrigin(grown);
		expect(origin.x).toBe(0);
		expect(origin.y + grown.size.height).toBeCloseTo(600, 9);
		expect(origin.y).toBeLessThan(0);
	});

	it('grows far enough that the ink is out of the edge zone', () => {
		const grown = grownBoardPage(board(), inkAt(990, 2, 8), 1);
		if (!grown) throw new Error('did not grow');
		const origin = pageOrigin(grown);
		expect(origin.x + grown.size.width * (1 - BOARD_EDGE_ZONE)).toBeGreaterThanOrEqual(998);
		expect(origin.y + grown.size.height * BOARD_EDGE_ZONE).toBeLessThanOrEqual(2);
		expect(grownBoardPage(grown, inkAt(990, 2, 8), 1)).toBeNull();
	});

	it('grows by whole grid cells, so the ruling under existing ink does not move', () => {
		const page = board();
		const grown = grownBoardPage(page, inkAt(950, 20), 1);
		if (!grown) throw new Error('did not grow');
		const step = templateSpacing('grid5');
		expect((grown.size.width - page.size.width) / step).toBeCloseTo(Math.round((grown.size.width - page.size.width) / step), 6);
		expect((grown.size.height - page.size.height) / step).toBeCloseTo(Math.round((grown.size.height - page.size.height) / step), 6);

		const ruling = (p: InsertedPage): { xs: Set<string>; ys: Set<string> } => {
			const o = pageOrigin(p);
			const g = translateTemplate(templateGeometry(p.template, p.size.width, p.size.height), o.x, o.y);
			const xs = new Set<string>();
			const ys = new Set<string>();
			for (const l of g.lines) {
				if (l.x1 === l.x2) xs.add(l.x1.toFixed(6));
				else ys.add(l.y1.toFixed(6));
			}
			return { xs, ys };
		};
		const before = ruling(page);
		const after = ruling(grown);
		for (const x of before.xs) expect(after.xs.has(x)).toBe(true);
		for (const y of before.ys) expect(after.ys.has(y)).toBe(true);
	});

	it('grows a blank board by any amount', () => {
		const grown = grownBoardPage(board({ template: 'blank' }), inkAt(950, 300), 1);
		expect(grown?.size.width).toBeCloseTo(1250, 9);
	});
});

describe('newBoardData', () => {
	it('is one wide ruled page marked as a board, and round-trips', () => {
		const data = newBoardData(5, 'p', 'd');
		expect(data.layout).toBe('board');
		expect(data.docId).toBe('d');
		expect(data.insertedPages).toEqual([
			expect.objectContaining({ id: 'p', template: 'grid5', size: NEW_BOARD_SIZE, afterPdfPage: -1 }),
		]);
		const parsed = parseInkData(serializeInkData(data));
		expect(parsed.ok && parsed.data).toEqual(data);
	});

	it('stays a board through a merge, and an unknown layout reads as pages', () => {
		const ours = newBoardData(5, 'p', 'd');
		const theirs = { ...ours, layout: undefined };
		expect(mergeInkData(theirs, ours).data.layout).toBe('board');
		const parsed = parseInkData(JSON.stringify({ ...ours, layout: 'spiral' }));
		expect(parsed.ok && parsed.data.layout).toBeUndefined();
	});
});

describe('a page with an origin', () => {
	const grown = board({ size: { width: 1000, height: 900 }, origin: { x: 0, y: -300 } });

	it('round-trips its origin through the sidecar, and drops a zero one', () => {
		const data = { version: 5, pages: {}, insertedPages: [grown, board({ id: 'z', origin: { x: 0, y: 0 } })] };
		const parsed = parseInkData(JSON.stringify(data));
		if (!parsed.ok) throw new Error('did not parse');
		expect(parsed.data.insertedPages[0]?.origin).toEqual({ x: 0, y: -300 });
		expect(parsed.data.insertedPages[1]?.origin).toBeUndefined();
	});

	it('has a viewport that maps its own corner to the canvas corner', () => {
		const geom = insertedGeometry(grown);
		const viewport = geom.baseViewport;
		expect(viewport.convertToViewportPoint(0, -300)).toEqual([0, 900]);
		expect(viewport.convertToViewportPoint(1000, 600)).toEqual([1000, 0]);
		const [x, y] = viewport.convertToPdfPoint(250, 450);
		expect(x).toBeCloseTo(250, 9);
		expect(y).toBeCloseTo(150, 9);
		expect(pageBounds(viewport, geom.baseWidth, geom.baseHeight)).toEqual({
			minX: 0,
			minY: -300,
			maxX: 1000,
			maxY: 600,
		});
		// A clone at another scale keeps the origin.
		const zoomed = viewport.clone({ scale: 2 });
		expect(zoomed.convertToViewportPoint(0, -300)).toEqual([0, 1800]);
	});

	it('rebuilds the page list when only its origin changes', () => {
		const a = pagesSignature([insertedGeometry(board({ size: { width: 1000, height: 900 } }))]);
		const b = pagesSignature([insertedGeometry(grown)]);
		expect(a).not.toBe(b);
	});

	it('is what syntheticViewport gives with that origin', () => {
		const viewport = syntheticViewport(100, 50, 1, 0, 0, 10, 20);
		expect(viewport.viewBox).toEqual([10, 20, 110, 70]);
		expect(viewport.convertToViewportPoint(10, 70)).toEqual([0, 0]);
	});
});

describe('opening a board', () => {
	it('fits the tallest page height to the pane', () => {
		const zoom = fitHeightZoom(900, 16, 2421);
		expect(zoom * PDF_TO_CSS_UNITS * 2421).toBeCloseTo(900 - 32, 6);
	});

	it('restores a fit-height zoom from the workspace', () => {
		const state = writeInkViewState({ kind: 'fit-height' }, 0.3, 1, null);
		expect(readInkViewState(state).zoomMode).toEqual({ kind: 'fit-height' });
	});

	it('draws a large board through the sharp detail region once its bitmap is clamped', () => {
		// The Section 1 board, at fit-height and zoomed in, on a phone and a desktop.
		const width = 4956 * PDF_TO_CSS_UNITS;
		const height = 2421 * PDF_TO_CSS_UNITS;
		for (const zoom of [0.3, 1]) {
			const w = width * zoom;
			const h = height * zoom;
			const view = { x: 0, y: 0, w: 1200, h: 800 };
			expect(detailRegion(w, h, view, 2, MOBILE_BUDGET)).not.toBeNull();
		}
		expect(detailRegion(width, height, { x: 0, y: 0, w: 1200, h: 800 }, 2, DESKTOP_BUDGET)).not.toBeNull();
	});
});
