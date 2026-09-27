import type { Vec2 } from 'perfect-freehand';
import { describe, expect, it } from 'vitest';
import {
	boundsContain,
	distanceToPolygonEdge,
	expandBounds,
	hitTestShape,
	outlineBounds,
	pointInPolygon,
	itemHitShape,
} from './hit-test';
import type { Stroke, StrokeSample } from './items';
import { createStroke } from './stroke';
import { HIGHLIGHTER_OPACITY } from './tools';

const SQUARE: Vec2[] = [
	[0, 0],
	[10, 0],
	[10, 10],
	[0, 10],
];

function penStroke(points: StrokeSample[], width = 2): Stroke {
	const stroke = createStroke(
		{ tool: 'pen', color: '#000', width, opacity: 1 },
		'p',
	);
	stroke.points.push(...points);
	return stroke;
}

describe('bounds', () => {
	it('covers every outline point', () => {
		expect(outlineBounds(SQUARE)).toEqual({
			minX: 0,
			minY: 0,
			maxX: 10,
			maxY: 10,
		});
	});

	it('handles a single point and an empty outline', () => {
		expect(outlineBounds([[3, 4]])).toEqual({
			minX: 3,
			minY: 4,
			maxX: 3,
			maxY: 4,
		});
		expect(outlineBounds([])).toBeNull();
	});

	it('covers points in any order, including negatives', () => {
		const bounds = outlineBounds([
			[5, 5],
			[-7, 12],
			[2, -3],
		]);
		expect(bounds).toEqual({ minX: -7, minY: -3, maxX: 5, maxY: 12 });
	});

	it('expands symmetrically and tests containment', () => {
		const bounds = outlineBounds(SQUARE);
		expect(bounds).not.toBeNull();
		if (!bounds) return;
		expect(boundsContain(bounds, -1, 5)).toBe(false);
		expect(boundsContain(expandBounds(bounds, 2), -1, 5)).toBe(true);
		// Edges count as inside.
		expect(boundsContain(bounds, 0, 0)).toBe(true);
		expect(boundsContain(bounds, 10, 10)).toBe(true);
	});
});

describe('pointInPolygon', () => {
	it('is true inside and false outside', () => {
		expect(pointInPolygon(5, 5, SQUARE)).toBe(true);
		expect(pointInPolygon(-1, 5, SQUARE)).toBe(false);
		expect(pointInPolygon(11, 5, SQUARE)).toBe(false);
		expect(pointInPolygon(5, 11, SQUARE)).toBe(false);
	});

	it('handles a concave polygon', () => {
		// A C shape opening to the right.
		const c: Vec2[] = [
			[0, 0],
			[10, 0],
			[10, 3],
			[4, 3],
			[4, 7],
			[10, 7],
			[10, 10],
			[0, 10],
		];
		expect(pointInPolygon(2, 5, c)).toBe(true);
		// Inside the bounding box, but in the notch.
		expect(pointInPolygon(7, 5, c)).toBe(false);
	});

	it('is false for degenerate polygons', () => {
		expect(pointInPolygon(0, 0, [])).toBe(false);
		expect(pointInPolygon(0, 0, [[0, 0]])).toBe(false);
	});
});

describe('distanceToPolygonEdge', () => {
	it('measures to the nearest edge', () => {
		expect(distanceToPolygonEdge(-3, 5, SQUARE)).toBeCloseTo(3, 6);
		expect(distanceToPolygonEdge(5, 13, SQUARE)).toBeCloseTo(3, 6);
	});

	it('is zero on an edge and measures from inside too', () => {
		expect(distanceToPolygonEdge(5, 0, SQUARE)).toBeCloseTo(0, 6);
		expect(distanceToPolygonEdge(5, 5, SQUARE)).toBeCloseTo(5, 6);
	});

	it('measures to a corner diagonally', () => {
		expect(distanceToPolygonEdge(-3, -4, SQUARE)).toBeCloseTo(5, 6);
	});
});

describe('itemHitShape', () => {
	it('produces a shape whose bounds cover the stroke path', () => {
		const shape = itemHitShape(
			penStroke([
				[100, 700, 0.5],
				[200, 700, 0.5],
			]),
		);
		expect(shape).not.toBeNull();
		if (!shape) return;
		expect(shape.bounds.minX).toBeLessThanOrEqual(100);
		expect(shape.bounds.maxX).toBeGreaterThanOrEqual(200);
		expect(shape.outline.length).toBeGreaterThan(3);
	});

	it('is null for a stroke with no points', () => {
		expect(itemHitShape(penStroke([]))).toBeNull();
	});

	it('a wider stroke has wider bounds', () => {
		const thin = itemHitShape(penStroke([[0, 0, 0.5], [50, 0, 0.5]], 2));
		const thick = itemHitShape(penStroke([[0, 0, 0.5], [50, 0, 0.5]], 30));
		expect(thin).not.toBeNull();
		expect(thick).not.toBeNull();
		if (!thin || !thick) return;
		const height = (b: typeof thin.bounds): number => b.maxY - b.minY;
		expect(height(thick.bounds)).toBeGreaterThan(height(thin.bounds));
	});
});

describe('hitTestShape', () => {
	const stroke = penStroke(
		[
			[100, 700, 0.5],
			[200, 700, 0.5],
			[300, 700, 0.5],
		],
		4,
	);
	const shape = itemHitShape(stroke);

	it('hits a point on the stroke', () => {
		expect(shape).not.toBeNull();
		if (!shape) return;
		expect(hitTestShape(shape, 200, 700, 0)).toBe(true);
	});

	it('misses a point far away, via the bounding box prefilter', () => {
		if (!shape) return;
		expect(hitTestShape(shape, 1000, 1000, 2)).toBe(false);
		expect(hitTestShape(shape, 200, 400, 2)).toBe(false);
	});

	it('a near miss becomes a hit once the eraser radius covers it', () => {
		if (!shape) return;
		// Just above the stroke: outside the outline, inside the radius.
		const justAbove = 700 + 12;
		expect(hitTestShape(shape, 200, justAbove, 1)).toBe(false);
		expect(hitTestShape(shape, 200, justAbove, 20)).toBe(true);
	});

	it('a bigger radius never turns a hit into a miss', () => {
		if (!shape) return;
		let previous = false;
		for (const radius of [0, 1, 5, 10, 25, 60]) {
			const hit = hitTestShape(shape, 210, 716, radius);
			if (previous) expect(hit).toBe(true);
			previous = hit;
		}
		expect(previous).toBe(true);
	});

	it('works in PDF space on a page with a non-zero origin', () => {
		// Stroke coordinates sit well away from (0, 0), as they do on
		// cropped_mediabox.pdf. Nothing about the test needs a scale.
		const offset = itemHitShape(
			penStroke([
				[53.18, 702.28, 0.5],
				[120, 650, 0.5],
			]),
		);
		expect(offset).not.toBeNull();
		if (!offset) return;
		expect(hitTestShape(offset, 53.18, 702.28, 1)).toBe(true);
		expect(hitTestShape(offset, 0, 0, 1)).toBe(false);
	});

	it('hit testing a highlighter stroke accounts for its flat wide nib', () => {
		const highlighter = createStroke(
			{
				tool: 'highlighter',
				color: '#ffe066',
				width: 20,
				opacity: HIGHLIGHTER_OPACITY,
			},
			'h',
		);
		highlighter.points.push([100, 700, 1], [200, 700, 1]);
		const shape = itemHitShape(highlighter);
		expect(shape).not.toBeNull();
		if (!shape) return;
		// A 20pt nib should be hit ~8pt off the centreline with no radius.
		expect(hitTestShape(shape, 150, 708, 0)).toBe(true);
	});
});
