import { describe, expect, it } from 'vitest';
import {
	type Capsule,
	boundsIntersect,
	capsuleBounds,
	capsuleContains,
	distanceToSegment,
	fragmentToStroke,
	itemBounds,
	itemToPolylines,
	polylineLength,
	prefilterBounds,
	resamplePolyline,
	shapeToPolylines,
	splitByMask,
} from './erase';
import type { Item, ShapeItem, Stroke, StrokeSample } from './items';
import { createStroke } from './stroke';

const RADIUS = 10;
const SPACING = RADIUS / 2;

function stroke(points: StrokeSample[], width = 2): Stroke {
	const item = createStroke(
		{ tool: 'pen', color: '#111', width, opacity: 1 },
		'src',
	);
	item.points.push(...points);
	return item;
}

function rect(width = 2): ShapeItem {
	return {
		type: 'shape',
		id: 'r',
		color: '#111',
		opacity: 1,
		rotation: 0,
		z: 3,
		updatedAt: 0,
		kind: 'rect',
		box: { x: 0, y: 0, w: 200, h: 100 },
		width,
		fill: null,
	};
}

/** Erase along a path, exactly as the session does: capsule per sample pair. */
function eraseAlong(
	item: Item,
	path: readonly [number, number][],
	radius: number,
): { fragments: Stroke[]; polylines: StrokeSample[][] } {
	const spacing = radius / 2;
	const polylines = itemToPolylines(item, spacing);
	const keep = polylines.map((line) => line.map(() => true));
	let previous = path[0];

	for (const point of path) {
		const from = previous ?? point;
		const capsule: Capsule = {
			x1: from[0],
			y1: from[1],
			x2: point[0],
			y2: point[1],
		};
		polylines.forEach((line, p) => {
			const mask = keep[p];
			if (!mask) return;
			line.forEach((sample, i) => {
				if (mask[i] !== true) return;
				if (capsuleContains(sample[0], sample[1], capsule, radius)) {
					mask[i] = false;
				}
			});
		});
		previous = point;
	}

	const fragments: Stroke[] = [];
	polylines.forEach((line, p) => {
		const mask = keep[p];
		if (!mask) return;
		splitByMask(line, mask).forEach((fragment, index) => {
			const built = fragmentToStroke(item, fragment, `f${String(p)}-${String(index)}`);
			if (built) fragments.push(built);
		});
	});
	return { fragments, polylines };
}

describe('distanceToSegment', () => {
	it('measures perpendicular distance to the middle of a segment', () => {
		expect(distanceToSegment(50, 10, 0, 0, 100, 0)).toBeCloseTo(10, 9);
	});

	it('clamps to the endpoints beyond the segment', () => {
		expect(distanceToSegment(-30, 0, 0, 0, 100, 0)).toBeCloseTo(30, 9);
		expect(distanceToSegment(130, 0, 0, 0, 100, 0)).toBeCloseTo(30, 9);
	});

	it('handles a zero-length segment as a point', () => {
		expect(distanceToSegment(3, 4, 0, 0, 0, 0)).toBeCloseTo(5, 9);
	});
});

describe('capsuleContains', () => {
	const capsule: Capsule = { x1: 0, y1: 0, x2: 100, y2: 0 };

	it('includes points within the radius of the swept segment', () => {
		expect(capsuleContains(50, 9.9, capsule, RADIUS)).toBe(true);
		expect(capsuleContains(50, 10.1, capsule, RADIUS)).toBe(false);
	});

	it('includes rounded ends', () => {
		expect(capsuleContains(-7, 7, capsule, RADIUS)).toBe(true);
		expect(capsuleContains(-8, 8, capsule, RADIUS)).toBe(false);
	});
});

describe('bounds helpers', () => {
	it('brackets a capsule', () => {
		expect(capsuleBounds({ x1: 10, y1: 90, x2: 0, y2: 100 })).toEqual({
			minX: 0,
			minY: 90,
			maxX: 10,
			maxY: 100,
		});
	});

	it('detects overlap and separation', () => {
		const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
		expect(boundsIntersect(a, { minX: 9, minY: 9, maxX: 20, maxY: 20 })).toBe(true);
		expect(boundsIntersect(a, { minX: 11, minY: 0, maxX: 20, maxY: 10 })).toBe(false);
	});

	it('bounds a stroke from its points, with no outline generation', () => {
		expect(itemBounds(stroke([[0, 0, 1], [30, 40, 1]]))).toEqual({
			minX: 0,
			minY: 0,
			maxX: 30,
			maxY: 40,
		});
	});

	it('bounds a shape from its box, normalising a negative drag', () => {
		const negative: ShapeItem = { ...rect(), box: { x: 50, y: 50, w: -20, h: -10 } };
		expect(itemBounds(negative)).toEqual({
			minX: 30,
			minY: 40,
			maxX: 50,
			maxY: 50,
		});
	});

	it('ignores text in sized mode but still bounds it for other callers', () => {
		expect(itemToPolylines(
			{
				type: 'text',
				id: 't',
				color: '#000',
				opacity: 1,
				rotation: 0,
				z: 0,
				updatedAt: 0,
				box: { x: 0, y: 0, w: 10, h: 10 },
				text: 'hi',
				fontSize: 12,
			},
			SPACING,
		)).toEqual([]);
	});

	it('pads the prefilter box by the radius', () => {
		const padded = prefilterBounds(stroke([[0, 0, 1], [10, 0, 1]]), RADIUS);
		expect(padded).toEqual({ minX: -10, minY: -10, maxX: 20, maxY: 10 });
	});
});

describe('resamplePolyline', () => {
	it('never leaves a gap wider than the spacing', () => {
		const resampled = resamplePolyline([[0, 0, 0.5], [100, 0, 0.5]], SPACING);
		for (let i = 1; i < resampled.length; i++) {
			const a = resampled[i - 1];
			const b = resampled[i];
			if (!a || !b) continue;
			expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeLessThanOrEqual(
				SPACING + 1e-6,
			);
		}
	});

	it('keeps the original endpoints exactly', () => {
		const resampled = resamplePolyline([[3, 4, 0.2], [103, 4, 0.9]], SPACING);
		expect(resampled[0]).toEqual([3, 4, 0.2]);
		expect(resampled[resampled.length - 1]).toEqual([103, 4, 0.9]);
	});

	it('interpolates pressure along the way', () => {
		const resampled = resamplePolyline([[0, 0, 0], [100, 0, 1]], 50);
		const middle = resampled[1];
		expect(middle).toBeDefined();
		if (!middle) return;
		expect(middle[0]).toBeCloseTo(50, 6);
		expect(middle[2]).toBeCloseTo(0.5, 6);
	});

	it('preserves total length', () => {
		const original: StrokeSample[] = [[0, 0, 1], [40, 30, 1], [40, 90, 1]];
		expect(polylineLength(resamplePolyline(original, SPACING))).toBeCloseTo(
			polylineLength(original),
			4,
		);
	});

	it('handles degenerate inputs', () => {
		expect(resamplePolyline([], SPACING)).toEqual([]);
		expect(resamplePolyline([[1, 2, 0.5]], SPACING)).toEqual([[1, 2, 0.5]]);
		// Zero-length path collapses to one point rather than looping forever.
		expect(resamplePolyline([[1, 2, 0.5], [1, 2, 0.5]], SPACING)).toEqual([
			[1, 2, 0.5],
		]);
	});
});

describe('splitByMask', () => {
	const points: StrokeSample[] = Array.from(
		{ length: 5 },
		(_, i) => [i, 0, 1] as StrokeSample,
	);

	it('marks both ends cut when the middle survives', () => {
		const [fragment] = splitByMask(points, [false, true, true, true, false]);
		expect(fragment?.cutStart).toBe(true);
		expect(fragment?.cutEnd).toBe(true);
	});

	it('marks only the inner end cut when a run reaches the start', () => {
		const [fragment] = splitByMask(points, [true, true, false, false, false]);
		expect(fragment?.cutStart).toBe(false);
		expect(fragment?.cutEnd).toBe(true);
	});

	it('marks nothing cut when everything survives', () => {
		const [fragment] = splitByMask(points, [true, true, true, true, true]);
		expect(fragment?.cutStart).toBe(false);
		expect(fragment?.cutEnd).toBe(false);
		expect(fragment?.points).toHaveLength(5);
	});

	it('returns one fragment per surviving run', () => {
		const fragments = splitByMask(points, [true, false, true, false, true]);
		expect(fragments).toHaveLength(3);
	});

	it('returns nothing when the mask is all false', () => {
		expect(splitByMask(points, [false, false, false, false, false])).toEqual([]);
	});

	it('copies points rather than aliasing the input', () => {
		const [fragment] = splitByMask(points, [true, true, false, false, false]);
		fragment?.points[0]?.splice(0, 1);
		expect(points[0]).toEqual([0, 0, 1]);
	});
});

describe('fragmentToStroke', () => {
	const source = stroke([[0, 0, 1], [100, 0, 1]], 4);

	it('inherits colour, width, tool, opacity and z', () => {
		const built = fragmentToStroke(
			source,
			{ points: [[0, 0, 1], [50, 0, 1]], cutStart: false, cutEnd: true },
			'f1',
		);
		expect(built).not.toBeNull();
		if (!built) return;
		expect(built.color).toBe(source.color);
		expect(built.width).toBe(4);
		expect(built.tool).toBe('pen');
		expect(built.opacity).toBe(source.opacity);
		expect(built.z).toBe(source.z);
		expect(built.type).toBe('stroke');
	});

	it('records the cut ends so they are drawn blunt', () => {
		const built = fragmentToStroke(
			source,
			{ points: [[0, 0, 1], [50, 0, 1]], cutStart: true, cutEnd: false },
			'f1',
		);
		expect(built?.cutStart).toBe(true);
		expect(built?.cutEnd).toBe(false);
	});

	it('discards a fragment with fewer than two points', () => {
		expect(
			fragmentToStroke(source, { points: [[0, 0, 1]], cutStart: true, cutEnd: true }, 'f'),
		).toBeNull();
	});

	it('discards a fragment shorter than the stroke width', () => {
		// Width 4, length 3.
		expect(
			fragmentToStroke(
				source,
				{ points: [[0, 0, 1], [3, 0, 1]], cutStart: true, cutEnd: true },
				'f',
			),
		).toBeNull();
		expect(
			fragmentToStroke(
				source,
				{ points: [[0, 0, 1], [5, 0, 1]], cutStart: true, cutEnd: true },
				'f',
			),
		).not.toBeNull();
	});

	it('a fragment of a shape becomes a pen stroke', () => {
		const built = fragmentToStroke(
			rect(3),
			{ points: [[0, 0, 1], [50, 0, 1]], cutStart: true, cutEnd: true },
			'f',
		);
		expect(built?.tool).toBe('pen');
		expect(built?.width).toBe(3);
		expect(built?.z).toBe(3);
	});
});

describe('a sparse fast stroke erased mid length yields two fragments', () => {
	// Two samples 200pt apart: a fast swipe. Without resampling the eraser would
	// find nothing between them.
	const source = stroke([[0, 0, 0.5], [200, 0, 0.5]], 2);

	it('splits into exactly two fragments', () => {
		const { fragments } = eraseAlong(source, [[100, -40], [100, 40]], RADIUS);
		expect(fragments).toHaveLength(2);
	});

	it('leaves a gap about two radii wide at the cut', () => {
		const { fragments } = eraseAlong(source, [[100, -40], [100, 40]], RADIUS);
		const [left, right] = fragments;
		if (!left || !right) return;
		const leftEnd = left.points[left.points.length - 1];
		const rightStart = right.points[0];
		if (!leftEnd || !rightStart) return;
		const gap = rightStart[0] - leftEnd[0];
		// 2r, within one resampling step either side.
		expect(gap).toBeGreaterThan(2 * RADIUS - SPACING - 1e-6);
		expect(gap).toBeLessThan(2 * RADIUS + 2 * SPACING + 1e-6);
	});

	it('cuts the facing ends only', () => {
		const { fragments } = eraseAlong(source, [[100, -40], [100, 40]], RADIUS);
		const [left, right] = fragments;
		expect(left?.cutStart).toBe(false);
		expect(left?.cutEnd).toBe(true);
		expect(right?.cutStart).toBe(true);
		expect(right?.cutEnd).toBe(false);
	});

	it('keeps the outer endpoints of the original', () => {
		const { fragments } = eraseAlong(source, [[100, -40], [100, 40]], RADIUS);
		const [left, right] = fragments;
		expect(left?.points[0]).toEqual([0, 0, 0.5]);
		expect(right?.points[right.points.length - 1]).toEqual([200, 0, 0.5]);
	});

	it('a swipe that never reaches the stroke changes nothing', () => {
		const { fragments } = eraseAlong(source, [[100, -80], [100, -40]], RADIUS);
		expect(fragments).toHaveLength(1);
		expect(fragments[0]?.cutStart).toBe(false);
		expect(fragments[0]?.cutEnd).toBe(false);
	});

	it('a single stationary sample still erases, via a zero-length capsule', () => {
		const { fragments } = eraseAlong(source, [[100, 0]], RADIUS);
		expect(fragments).toHaveLength(2);
	});
});

describe('erasing an end yields one fragment with a blunt end', () => {
	const source = stroke([[0, 0, 0.5], [200, 0, 0.5]], 2);

	it('produces a single fragment', () => {
		const { fragments } = eraseAlong(source, [[0, -40], [0, 40]], RADIUS);
		expect(fragments).toHaveLength(1);
	});

	it('the cut end is blunt and the far end is untouched', () => {
		const { fragments } = eraseAlong(source, [[0, -40], [0, 40]], RADIUS);
		const [only] = fragments;
		expect(only?.cutStart).toBe(true);
		expect(only?.cutEnd).toBe(false);
	});

	it('starts beyond the eraser and still reaches the original far end', () => {
		const { fragments } = eraseAlong(source, [[0, -40], [0, 40]], RADIUS);
		const [only] = fragments;
		if (!only) return;
		const start = only.points[0];
		const end = only.points[only.points.length - 1];
		expect(start?.[0]).toBeGreaterThanOrEqual(RADIUS - 1e-6);
		expect(end).toEqual([200, 0, 0.5]);
	});

	it('erasing the other end is the mirror image', () => {
		const { fragments } = eraseAlong(source, [[200, -40], [200, 40]], RADIUS);
		const [only] = fragments;
		expect(only?.cutStart).toBe(false);
		expect(only?.cutEnd).toBe(true);
	});

	it('a swipe covering the whole stroke leaves nothing', () => {
		const { fragments } = eraseAlong(source, [[-50, 0], [250, 0]], 40);
		expect(fragments).toEqual([]);
	});
});

describe('erasing across a rectangle yields polyline strokes with the correct gap', () => {
	const source = rect(2);

	it('explodes the rectangle into a closed polyline before cutting', () => {
		const polylines = shapeToPolylines(source, SPACING);
		expect(polylines).toHaveLength(1);
		const [outline] = polylines;
		if (!outline) return;
		// Closed: the last point returns to the first.
		expect(outline[0]).toEqual(outline[outline.length - 1]);
		expect(polylineLength(outline)).toBeCloseTo(2 * (200 + 100), 6);
	});

	it('a swipe across the bottom edge leaves pen-stroke fragments', () => {
		const { fragments } = eraseAlong(source, [[100, -40], [100, 40]], RADIUS);
		expect(fragments.length).toBeGreaterThan(0);
		for (const fragment of fragments) {
			expect(fragment.type).toBe('stroke');
			expect(fragment.tool).toBe('pen');
			expect(fragment.color).toBe(source.color);
			expect(fragment.width).toBe(source.width);
		}
	});

	it('cuts a gap about two radii wide in the edge it crossed', () => {
		const { fragments } = eraseAlong(source, [[100, -40], [100, 40]], RADIUS);
		// Points remaining on the bottom edge, either side of the gap.
		const onBottom = fragments
			.flatMap((f) => f.points)
			.filter((p) => Math.abs(p[1]) < 1e-6)
			.map((p) => p[0])
			.sort((a, b) => a - b);

		let widest = 0;
		for (let i = 1; i < onBottom.length; i++) {
			const gap = (onBottom[i] ?? 0) - (onBottom[i - 1] ?? 0);
			if (gap > widest) widest = gap;
		}
		expect(widest).toBeGreaterThan(2 * RADIUS - SPACING - 1e-6);
		expect(widest).toBeLessThan(2 * RADIUS + 2 * SPACING + 1e-6);
	});

	it('leaves the three untouched edges intact', () => {
		const { fragments } = eraseAlong(source, [[100, -40], [100, 40]], RADIUS);
		const total = fragments.reduce((sum, f) => sum + polylineLength(f.points), 0);
		const perimeter = 2 * (200 + 100);
		// Perimeter less the gap, within a resampling step.
		expect(total).toBeGreaterThan(perimeter - 2 * RADIUS - 3 * SPACING);
		expect(total).toBeLessThan(perimeter - 2 * RADIUS + 3 * SPACING);
	});

	it('a swipe through a corner splits the outline at that corner', () => {
		const { fragments } = eraseAlong(source, [[-30, -30], [30, 30]], RADIUS);
		expect(fragments.length).toBeGreaterThanOrEqual(1);
		// The closed outline starts at that corner, so cutting it opens the loop.
		expect(fragments.some((f) => f.cutStart || f.cutEnd)).toBe(true);
	});

	it('an ellipse ends up fine enough to cut', () => {
		// shapeToPolylines samples curves in uniform t, which spreads out where an
		// ellipse flattens; itemToPolylines is what the eraser calls, and it
		// resamples by arc length afterwards. That is where the guarantee lives.
		const ellipse: ShapeItem = { ...rect(2), kind: 'ellipse' };
		const [outline] = itemToPolylines(ellipse, SPACING);
		expect(outline).toBeDefined();
		if (!outline) return;
		for (let i = 1; i < outline.length; i++) {
			const a = outline[i - 1];
			const b = outline[i];
			if (!a || !b) continue;
			expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeLessThanOrEqual(
				SPACING + 1e-6,
			);
		}
	});

	it('itemToPolylines enforces the spacing for every erasable kind', () => {
		const cases: Item[] = [
			stroke([[0, 0, 0.5], [300, 120, 0.5]]),
			rect(2),
			{ ...rect(2), kind: 'ellipse' },
			{ ...rect(2), kind: 'axes3d_c' },
			{ ...rect(2), kind: 'triangle' },
		];
		for (const item of cases) {
			for (const line of itemToPolylines(item, SPACING)) {
				for (let i = 1; i < line.length; i++) {
					const a = line[i - 1];
					const b = line[i];
					if (!a || !b) continue;
					expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeLessThanOrEqual(
						SPACING + 1e-6,
					);
				}
			}
		}
	});
});
