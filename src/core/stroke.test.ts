import { describe, expect, it } from 'vitest';
import type { Rect } from '../types/pdfjs';
import { createPageTransform } from './coords';
import { InkStore } from './ink-store';
import {
	INK_DATA_VERSION,
	type InkData,
	type Stroke,
	type StrokeSample,
	emptyInkData,
	isStroke,
} from './items';
import {
	DEFAULT_PEN,
	MIN_VISIBLE_STROKE_CSS,
	strokeOptions,
	createStroke,
	createStrokeId,
	outlineToPathData,
	strokeOutline,
	toCanvasSamples,
} from './stroke';

const LETTER: Rect = [0, 0, 612, 792];
/** cropped_mediabox.pdf page 1 — non-zero origin. */
const OFFSET_BOX: Rect = [53.18, 97.03, 591.91, 702.28];
const ROTATIONS = [0, 90, 180, 270] as const;

/** Simulate capturing a stroke: canvas CSS px in, PDF-space stroke out. */
/** Narrow a parsed item to a stroke, so tests can read stroke-only fields. */
function strokeAt(data: InkData, page: string, index = 0): Stroke | undefined {
	const item = data.pages[page]?.[index];
	return item && isStroke(item) ? item : undefined;
}

function capture(
	canvasSamples: readonly StrokeSample[],
	viewBox: Rect,
	scale: number,
	rotation: number,
): Stroke {
	const vp = createPageTransform({ viewBox, scale, rotation });
	const stroke = createStroke(DEFAULT_PEN);
	for (const [x, y, pressure] of canvasSamples) {
		const [pdfX, pdfY] = vp.convertToPdfPoint(x, y);
		stroke.points.push([pdfX, pdfY, pressure]);
	}
	return stroke;
}

describe('createStroke', () => {
	it('copies the preset and starts empty', () => {
		const stroke = createStroke(DEFAULT_PEN, 'fixed-id', 1234);
		expect(stroke).toEqual({
			type: 'stroke',
			id: 'fixed-id',
			tool: 'pen',
			color: DEFAULT_PEN.color,
			width: DEFAULT_PEN.width,
			opacity: DEFAULT_PEN.opacity,
			rotation: 0,
			z: 0,
			updatedAt: 1234,
			points: [],
			cutStart: false,
			cutEnd: false,
		});
	});

	it('generates distinct ids', () => {
		const ids = new Set(Array.from({ length: 500 }, () => createStrokeId()));
		expect(ids.size).toBe(500);
	});
});

describe('stored strokes are independent of zoom', () => {
	// The whole point of storing PDF user space: capture at one zoom, redraw at
	// another, and the ink must sit on the same spot on the page.
	const canvasSamples: StrokeSample[] = [
		[100, 100, 0.4],
		[200, 150, 0.6],
		[300, 400, 0.9],
	];

	for (const rotation of ROTATIONS) {
		it(`survives a zoom change at rotation ${String(rotation)}`, () => {
			const captureScale = 1;
			const stroke = capture(canvasSamples, LETTER, captureScale, rotation);

			for (const redrawScale of [0.5, 1, 2, 3.75]) {
				const vp = createPageTransform({
					viewBox: LETTER,
					scale: redrawScale,
					rotation,
				});
				const redrawn = toCanvasSamples(stroke, vp);
				const ratio = redrawScale / captureScale;
				redrawn.forEach((sample, i) => {
					const original = canvasSamples[i];
					expect(original).toBeDefined();
					if (!original) return;
					// Same point, scaled by exactly the zoom ratio.
					expect(sample[0]).toBeCloseTo(original[0] * ratio, 4);
					expect(sample[1]).toBeCloseTo(original[1] * ratio, 4);
					expect(sample[2]).toBe(original[2]);
				});
			}
		});
	}

	it('survives a zoom change on a non-zero-origin page', () => {
		const stroke = capture(canvasSamples, OFFSET_BOX, 1, 0);
		// Every stored point must be inside the page's own box, not near (0,0).
		for (const [x, y] of stroke.points) {
			expect(x).toBeGreaterThanOrEqual(OFFSET_BOX[0]);
			expect(x).toBeLessThanOrEqual(OFFSET_BOX[2]);
			expect(y).toBeGreaterThanOrEqual(OFFSET_BOX[1]);
			expect(y).toBeLessThanOrEqual(OFFSET_BOX[3]);
		}
		const vp = createPageTransform({ viewBox: OFFSET_BOX, scale: 2, rotation: 0 });
		toCanvasSamples(stroke, vp).forEach((sample, i) => {
			const original = canvasSamples[i];
			if (!original) return;
			expect(sample[0]).toBeCloseTo(original[0] * 2, 4);
			expect(sample[1]).toBeCloseTo(original[1] * 2, 4);
		});
	});

	it('keeps pressure out of the coordinate transform', () => {
		const stroke = capture([[10, 20, 0.123]], LETTER, 2.5, 90);
		expect(stroke.points[0]?.[2]).toBe(0.123);
	});
});

describe('strokeOutline', () => {
	const samples: StrokeSample[] = [
		[10, 10, 0.5],
		[20, 20, 0.5],
		[40, 15, 0.7],
	];

	it('returns nothing for no samples', () => {
		expect(strokeOutline([], 4, true)).toEqual([]);
	});

	it('produces a closed polygon of [x, y] pairs', () => {
		const outline = strokeOutline(samples, 4, true);
		expect(outline.length).toBeGreaterThan(3);
		for (const point of outline) {
			expect(point).toHaveLength(2);
			expect(Number.isFinite(point[0])).toBe(true);
			expect(Number.isFinite(point[1])).toBe(true);
		}
	});

	it('a single tap still produces a mark', () => {
		expect(strokeOutline([[5, 5, 0.5]], 6, false).length).toBeGreaterThan(0);
	});

	it('a wider nib produces a wider outline', () => {
		const spread = (size: number): number => {
			const xs = strokeOutline(samples, size, true).map((p) => p[0]);
			return Math.max(...xs) - Math.min(...xs);
		};
		expect(spread(20)).toBeGreaterThan(spread(4));
	});

	it('never emits NaN, even with degenerate repeated samples', () => {
		const outline = strokeOutline(
			[
				[5, 5, 0.5],
				[5, 5, 0.5],
				[5, 5, 0.5],
			],
			4,
			true,
		);
		for (const point of outline) {
			expect(Number.isNaN(point[0])).toBe(false);
			expect(Number.isNaN(point[1])).toBe(false);
		}
	});
});

describe('outlineToPathData', () => {
	it('is empty for an empty outline', () => {
		expect(outlineToPathData([])).toBe('');
	});

	it('starts with a move and closes the path', () => {
		const data = outlineToPathData(strokeOutline(
			[
				[0, 0, 0.5],
				[10, 10, 0.5],
			],
			4,
			true,
		));
		expect(data.startsWith('M ')).toBe(true);
		expect(data.endsWith('Z')).toBe(true);
		expect(data).toContain('Q ');
	});

	it('emits a drawable segment for a single outline point', () => {
		const data = outlineToPathData([[3, 4]]);
		expect(data.startsWith('M 3 4')).toBe(true);
		expect(data).toContain('L ');
	});

	it('contains no NaN or undefined', () => {
		const data = outlineToPathData(strokeOutline(
			[
				[1, 2, 0.3],
				[50, 60, 0.9],
			],
			8,
			true,
		));
		expect(data).not.toMatch(/NaN|undefined/);
	});
});

describe('InkStore', () => {
	it('starts empty', () => {
		const store = new InkStore();
		expect(store.isEmpty).toBe(true);
		expect(store.itemsFor('pdf:0')).toEqual([]);
	});

	it('keeps strokes per page', () => {
		const store = new InkStore();
		store.add('pdf:0', createStroke(DEFAULT_PEN, 'a'));
		store.add('pdf:2', createStroke(DEFAULT_PEN, 'b'));
		store.add('pdf:0', createStroke(DEFAULT_PEN, 'c'));
		expect(store.itemsFor('pdf:0').map((s) => s.id)).toEqual(['a', 'c']);
		expect(store.itemsFor('pdf:2').map((s) => s.id)).toEqual(['b']);
		expect(store.itemsFor('pdf:1')).toEqual([]);
	});

	it('bumps its version on every mutation, for later dirty tracking', () => {
		const store = new InkStore();
		const before = store.version;
		store.add('pdf:0', createStroke(DEFAULT_PEN, 'a'));
		expect(store.version).toBeGreaterThan(before);
	});

	it('removeLast tombstones the last live item on the page', () => {
		const store = new InkStore();
		store.add('pdf:1', createStroke(DEFAULT_PEN, 'a'));
		expect(store.removeLast('pdf:1')?.id).toBe('a');
		// Gone from the live list, but the tombstone remains so a merge cannot
		// resurrect it.
		expect(store.itemsFor('pdf:1')).toEqual([]);
		expect(store.allItemsFor('pdf:1')).toHaveLength(1);
		expect(store.removeLast('pdf:1')).toBeUndefined();
	});

	it('serialises to the documented ink.json schema', () => {
		const store = new InkStore();
		const stroke = createStroke(DEFAULT_PEN, 'a');
		stroke.points.push([100, 200, 0.5]);
		store.add('pdf:3', stroke);

		const data = store.toData();
		expect(data.version).toBe(INK_DATA_VERSION);
		// Keys are the page's identity, not its position in the document.
		expect(Object.keys(data.pages)).toEqual(['pdf:3']);
		expect(strokeAt(data, 'pdf:3')?.points).toEqual([[100, 200, 0.5]]);
		// Round-trips through JSON without loss.
		expect(JSON.parse(JSON.stringify(data))).toEqual(data);
	});

	it('keeps a tombstone for a page whose strokes were all removed', () => {
		const store = new InkStore();
		store.add('pdf:0', createStroke(DEFAULT_PEN, 'a'));
		store.removeLast('pdf:0');
		// Serialised so other devices learn about the deletion.
		const page = store.toData().pages['pdf:0'];
		expect(page).toHaveLength(1);
		expect(page?.[0]?.deletedAt).toBeGreaterThan(0);
		expect(store.itemsFor('pdf:0')).toEqual([]);
	});

	it('emptyInkData matches the serialised empty store', () => {
		expect(new InkStore().toData()).toEqual(emptyInkData());
	});
});

describe('cut ends are blunt', () => {
	it('sets taper false on an end the eraser cut', () => {
		const options = strokeOptions(4, true, 'pen', { start: true, end: false });
		expect(options.start?.taper).toBe(false);
		// An end the pen lifted off keeps the normal treatment.
		expect(options.end?.taper).toBe(0);
	});

	it('leaves both ends alone for an uncut stroke', () => {
		const options = strokeOptions(4, true, 'pen');
		expect(options.start?.taper).toBe(0);
		expect(options.end?.taper).toBe(0);
	});

	it('still caps both ends either way', () => {
		const cut = strokeOptions(4, true, 'pen', { start: true, end: true });
		expect(cut.start?.cap).toBe(true);
		expect(cut.end?.cap).toBe(true);
	});

	it('a highlighter keeps its flat nib when cut', () => {
		expect(strokeOptions(4, true, 'highlighter', { end: true }).thinning).toBe(0);
	});
});

describe('ink is constant width', () => {
	const thickness = (outline: [number, number][]): number => {
		const ys = outline.map(([, y]) => y);
		return Math.max(...ys) - Math.min(...ys);
	};
	const line = (pressure: number): [number, number, number][] => [
		[0, 0, pressure],
		[10, 0, pressure],
		[20, 0, pressure],
	];

	it('ignores pressure entirely, for new and stored strokes alike', () => {
		const light = strokeOutline(line(0.05), 4, true, 'pen');
		const heavy = strokeOutline(line(1), 4, true, 'pen');
		expect(light).toEqual(heavy);
	});

	it('uses no thinning and no simulated pressure for any tool', () => {
		for (const tool of ['pen', 'highlighter'] as const) {
			const options = strokeOptions(6, true, tool);
			expect(options.thinning).toBe(0);
			expect(options.simulatePressure).toBe(false);
		}
	});

	it('keeps a stroke at its nominal width', () => {
		const sizeCss = 12 * (96 / 72);
		expect(strokeOptions(sizeCss, true, 'pen').size).toBeCloseTo(sizeCss, 6);
		expect(strokeOptions(20, true, 'highlighter').size).toBe(20);
	});

	it('never draws thinner than a visible line', () => {
		expect(strokeOptions(0.2, true, 'pen').size).toBe(MIN_VISIBLE_STROKE_CSS);
		expect(thickness(strokeOutline(line(1), 0.2, true, 'pen'))).toBeGreaterThanOrEqual(
			MIN_VISIBLE_STROKE_CSS - 1e-9,
		);
	});
});
