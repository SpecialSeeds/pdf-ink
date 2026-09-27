import { describe, expect, it } from 'vitest';
import { polylineLength } from './erase';
import { SizedEraseSession, isErasable, radiusToPdf } from './erase-session';
import type { ItemRef } from './history';
import type { Item, ShapeItem, StrokeSample, TextItem } from './items';
import { createStroke } from './stroke';

const RADIUS = 10;

function strokeRef(
	id: string,
	points: StrokeSample[],
	index = 0,
): ItemRef {
	const item = createStroke({ tool: 'pen', color: '#111', width: 2, opacity: 1 }, id);
	item.points.push(...points);
	return { pageKey: 'pdf:0', index, item };
}

const textRef: ItemRef = {
	pageKey: 'pdf:0',
	index: 0,
	item: {
		type: 'text',
		id: 'txt',
		color: '#000',
		opacity: 1,
		rotation: 0,
		z: 0,
		updatedAt: 0,
		box: { x: 0, y: 0, w: 100, h: 20 },
		text: 'hello',
		fontSize: 12,
	} satisfies TextItem,
};

let counter = 0;
const nextId = (): string => `f${String(counter++)}`;

describe('radiusToPdf', () => {
	it('divides screen pixels by the viewport scale', () => {
		expect(radiusToPdf(20, 2)).toBe(10);
		expect(radiusToPdf(20, 0.5)).toBe(40);
	});

	it('is the identity at scale 1 and survives a zero scale', () => {
		expect(radiusToPdf(16, 1)).toBe(16);
		expect(radiusToPdf(16, 0)).toBe(16);
	});

	it('means the eraser feels the same size at any zoom', () => {
		// 16 screen px is a smaller PDF-space bite when zoomed in.
		expect(radiusToPdf(16, 4)).toBeLessThan(radiusToPdf(16, 1));
	});
});

describe('isErasable', () => {
	it('covers strokes and shapes but not text', () => {
		expect(isErasable(strokeRef('a', [[0, 0, 1], [1, 1, 1]]).item)).toBe(true);
		expect(isErasable(textRef.item)).toBe(false);
	});
});

describe('SizedEraseSession', () => {
	it('derives the resample spacing from the radius', () => {
		expect(new SizedEraseSession(10).spacing).toBe(5);
		// Never coarser than the floor, however tiny the eraser.
		expect(new SizedEraseSession(0.01).spacing).toBeGreaterThan(0);
	});

	it('starts empty and reports nothing to commit', () => {
		const session = new SizedEraseSession(RADIUS);
		expect(session.isEmpty).toBe(true);
		expect(session.commit(nextId)).toEqual({ removed: [], added: [] });
	});

	it('a swipe across a sparse stroke commits one removal and two fragments', () => {
		const session = new SizedEraseSession(RADIUS);
		const ref = strokeRef('long', [[0, 0, 0.5], [200, 0, 0.5]]);

		// A fast swipe: two samples, well apart, crossing the stroke.
		session.sample(100, -40, [ref]);
		session.sample(100, 40, [ref]);

		expect(session.isEmpty).toBe(false);
		const { removed, added } = session.commit(nextId);
		expect(removed.map((r) => r.item.id)).toEqual(['long']);
		expect(added).toHaveLength(2);
		for (const fragment of added) {
			expect(fragment.item.type).toBe('stroke');
			expect(fragment.pageKey).toBe('pdf:0');
		}
	});

	it('fragments take the original slot and inherit its z', () => {
		const session = new SizedEraseSession(RADIUS);
		const ref = strokeRef('long', [[0, 0, 0.5], [200, 0, 0.5]], 7);
		ref.item.z = 42;
		session.sample(100, 0, [ref]);
		const { added } = session.commit(nextId);
		for (const fragment of added) {
			expect(fragment.index).toBe(7);
			expect(fragment.item.z).toBe(42);
		}
	});

	it('reports hit ids so the caller can hide the originals', () => {
		const session = new SizedEraseSession(RADIUS);
		const hit = strokeRef('hit', [[0, 0, 1], [200, 0, 1]], 0);
		const miss = strokeRef('miss', [[0, 500, 1], [200, 500, 1]], 1);
		session.sample(100, 0, [hit, miss]);
		expect([...session.hitIds()]).toEqual(['hit']);
	});

	it('the prefilter keeps a far-away item entirely untouched', () => {
		const session = new SizedEraseSession(RADIUS);
		const far = strokeRef('far', [[1000, 1000, 1], [1100, 1000, 1]]);
		expect(session.sample(0, 0, [far])).toBe(false);
		expect(session.isEmpty).toBe(true);
	});

	it('a swipe that misses by just over the radius does nothing', () => {
		const session = new SizedEraseSession(RADIUS);
		const ref = strokeRef('a', [[0, 0, 1], [200, 0, 1]]);
		expect(session.sample(100, RADIUS + 0.5, [ref])).toBe(false);
		expect(session.sample(100, RADIUS - 0.5, [ref])).toBe(true);
	});

	it('ignores text boxes entirely', () => {
		const session = new SizedEraseSession(RADIUS);
		expect(session.sample(10, 10, [textRef])).toBe(false);
		expect(session.isEmpty).toBe(true);
		expect(session.commit(nextId).removed).toEqual([]);
	});

	it('erases shapes, turning them into pen-stroke fragments', () => {
		const shape: ShapeItem = {
			type: 'shape',
			id: 'r',
			color: '#abcdef',
			opacity: 1,
			rotation: 0,
			z: 1,
			updatedAt: 0,
			kind: 'rect',
			box: { x: 0, y: 0, w: 200, h: 100 },
			width: 2,
			fill: null,
		};
		const session = new SizedEraseSession(RADIUS);
		session.sample(100, 0, [{ pageKey: 'pdf:0', index: 0, item: shape }]);
		const { removed, added } = session.commit(nextId);
		expect(removed).toHaveLength(1);
		expect(added.length).toBeGreaterThan(0);
		for (const fragment of added) {
			expect(fragment.item.type).toBe('stroke');
			expect(fragment.item.color).toBe('#abcdef');
		}
	});

	it('is incremental: what one sample erased stays erased', () => {
		const session = new SizedEraseSession(RADIUS);
		const ref = strokeRef('a', [[0, 0, 1], [300, 0, 1]]);
		const surviving = (refs: ItemRef[]): number =>
			refs.reduce(
				(sum, r) =>
					sum + (r.item.type === 'stroke' ? polylineLength(r.item.points) : 0),
				0,
			);

		session.sample(100, 0, [ref]);
		const first = surviving(session.commit(nextId).added);

		session.sample(200, 0, [ref]);
		const second = session.commit(nextId).added;
		expect(surviving(second)).toBeLessThan(first);

		// Nothing has come back anywhere the eraser has already been.
		for (const r of second) {
			if (r.item.type !== 'stroke') continue;
			for (const [x] of r.item.points) {
				expect(Math.abs(x - 100)).toBeGreaterThan(RADIUS - 1e-6);
			}
		}
	});

	it('consecutive samples sweep the span between them, not just two discs', () => {
		// This is what stops a fast swipe from skipping: dragging 100 -> 200 must
		// erase everything in between, leaving two fragments rather than three.
		const session = new SizedEraseSession(RADIUS);
		const ref = strokeRef('a', [[0, 0, 1], [300, 0, 1]]);
		session.sample(100, 0, [ref]);
		session.sample(200, 0, [ref]);

		const { added } = session.commit(nextId);
		expect(added).toHaveLength(2);
		for (const r of added) {
			if (r.item.type !== 'stroke') continue;
			for (const [x] of r.item.points) {
				// Nothing survives inside the swept corridor.
				expect(x < 100 - RADIUS + 1e-6 || x > 200 + RADIUS - 1e-6).toBe(true);
			}
		}
	});

	it('reports no change when a sample erases nothing new', () => {
		const session = new SizedEraseSession(RADIUS);
		const ref = strokeRef('a', [[0, 0, 1], [200, 0, 1]]);
		expect(session.sample(100, 0, [ref])).toBe(true);
		// Same spot again: everything there is already gone.
		expect(session.sample(100, 0, [ref])).toBe(false);
	});

	it('the preview matches what will be committed', () => {
		const session = new SizedEraseSession(RADIUS);
		const ref = strokeRef('a', [[0, 0, 1], [200, 0, 1]]);
		session.sample(100, 0, [ref]);
		const preview = session.preview(() => 'p');
		const committed = session.commit(() => 'c');
		expect(preview).toHaveLength(committed.added.length);
		expect(preview.map((s) => s.points.length)).toEqual(
			committed.added.map((r) =>
				r.item.type === 'stroke' ? r.item.points.length : 0,
			),
		);
	});

	it('a swipe covering a whole stroke removes it with no fragments', () => {
		const session = new SizedEraseSession(60);
		const ref = strokeRef('a', [[0, 0, 1], [50, 0, 1]]);
		session.sample(25, 0, [ref]);
		const { removed, added } = session.commit(nextId);
		expect(removed).toHaveLength(1);
		expect(added).toEqual([]);
	});

	it('handles several items in one gesture', () => {
		const session = new SizedEraseSession(RADIUS);
		const a = strokeRef('a', [[0, 0, 1], [200, 0, 1]], 0);
		const b = strokeRef('b', [[0, 20, 1], [200, 20, 1]], 1);
		session.sample(100, 10, [a, b]);
		const { removed } = session.commit(nextId);
		expect(removed.map((r) => r.item.id).sort()).toEqual(['a', 'b']);
	});

	it('a zero-length first capsule still erases, so a tap works', () => {
		const session = new SizedEraseSession(RADIUS);
		const ref = strokeRef('a', [[0, 0, 1], [200, 0, 1]]);
		expect(session.sample(100, 0, [ref])).toBe(true);
	});

	it('does not mutate the original item', () => {
		const ref = strokeRef('a', [[0, 0, 1], [200, 0, 1]]);
		const before: Item = JSON.parse(JSON.stringify(ref.item)) as Item;
		const session = new SizedEraseSession(RADIUS);
		session.sample(100, 0, [ref]);
		session.commit(nextId);
		expect(ref.item).toEqual(before);
	});
});
