import { describe, expect, it } from 'vitest';
import type { Bounds } from './hit-test';
import type { StrokeSample } from './items';
import {
	clampPoint,
	clipStrokeToPage,
	fitBoxFromAnchor,
	pageBounds,
	shiftInside,
} from './page-bounds';
import { syntheticViewport } from './page-viewport';

const PAGE: Bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

describe('pageBounds', () => {
	it('is the page rectangle in PDF space', () => {
		const viewport = syntheticViewport(612, 792, 2);
		const bounds = pageBounds(viewport, 612 * 2, 792 * 2);
		expect(bounds.minX).toBeCloseTo(0, 6);
		expect(bounds.minY).toBeCloseTo(0, 6);
		expect(bounds.maxX).toBeCloseTo(612, 6);
		expect(bounds.maxY).toBeCloseTo(792, 6);
	});
});

describe('clipStrokeToPage', () => {
	it('leaves a stroke on the page whole and uncut', () => {
		const points: StrokeSample[] = [
			[10, 10, 1],
			[50, 50, 1],
			[90, 20, 1],
		];
		expect(clipStrokeToPage(points, PAGE)).toEqual([
			{ points, cutStart: false, cutEnd: false },
		]);
	});

	it('drops a stroke entirely off the page', () => {
		expect(
			clipStrokeToPage(
				[
					[-10, 10, 1],
					[-20, 50, 1],
				],
				PAGE,
			),
		).toEqual([]);
	});

	it('ends a stroke exactly on the edge it ran off', () => {
		const pieces = clipStrokeToPage(
			[
				[50, 50, 1],
				[150, 50, 1],
			],
			PAGE,
		);
		expect(pieces).toHaveLength(1);
		expect(pieces[0]?.points).toEqual([
			[50, 50, 1],
			[100, 50, 1],
		]);
		expect(pieces[0]?.cutStart).toBe(false);
		expect(pieces[0]?.cutEnd).toBe(true);
	});

	it('splits a stroke that leaves and comes back into two pieces', () => {
		const pieces = clipStrokeToPage(
			[
				[80, 50, 1],
				[120, 50, 1],
				[120, 60, 1],
				[80, 60, 1],
			],
			PAGE,
		);
		expect(pieces).toHaveLength(2);
		expect(pieces[0]?.points.at(-1)?.[0]).toBeCloseTo(100, 9);
		expect(pieces[1]?.points[0]?.[0]).toBeCloseTo(100, 9);
		expect(pieces[1]?.cutStart).toBe(true);
		expect(pieces[1]?.cutEnd).toBe(false);
	});

	it('keeps the on-page chord of a segment that crosses a corner', () => {
		const pieces = clipStrokeToPage(
			[
				[-50, 50, 1],
				[50, -50, 1],
			],
			PAGE,
		);
		// The line x + y = 0 touches the page only at the origin.
		expect(pieces).toHaveLength(1);
		for (const [x, y] of pieces[0]?.points ?? []) {
			expect(x).toBeCloseTo(0, 9);
			expect(y).toBeCloseTo(0, 9);
		}
	});

	it('never produces a point off the page', () => {
		const points: StrokeSample[] = [];
		for (let i = 0; i < 60; i++) {
			points.push([50 + Math.cos(i / 3) * 90, 50 + Math.sin(i / 2) * 90, 1]);
		}
		for (const piece of clipStrokeToPage(points, PAGE)) {
			for (const [x, y] of piece.points) {
				expect(x).toBeGreaterThanOrEqual(-1e-9);
				expect(x).toBeLessThanOrEqual(100 + 1e-9);
				expect(y).toBeGreaterThanOrEqual(-1e-9);
				expect(y).toBeLessThanOrEqual(100 + 1e-9);
			}
		}
	});
});

describe('fitBoxFromAnchor', () => {
	it('leaves a box on the page alone', () => {
		const box = { x: 10, y: 10, w: 50, h: -5 };
		expect(fitBoxFromAnchor(box, PAGE)).toEqual(box);
	});

	it('shrinks uniformly so the far corner lands on the edge', () => {
		const fitted = fitBoxFromAnchor({ x: 50, y: 50, w: 100, h: 20 }, PAGE);
		expect(fitted.x).toBe(50);
		expect(fitted.w).toBeCloseTo(50, 9);
		// Same proportions as the drag.
		expect(fitted.h).toBeCloseTo(10, 9);
	});

	it('handles a drag towards the origin', () => {
		const fitted = fitBoxFromAnchor({ x: 20, y: 20, w: -40, h: -40 }, PAGE);
		expect(fitted.w).toBeCloseTo(-20, 9);
		expect(fitted.h).toBeCloseTo(-20, 9);
	});
});

describe('clampPoint', () => {
	it('pulls a point onto the nearest edge', () => {
		expect(clampPoint(PAGE, -5, 120)).toEqual([0, 100]);
		expect(clampPoint(PAGE, 40, 60)).toEqual([40, 60]);
	});
});

describe('shiftInside', () => {
	it('needs no shift for something already on the page', () => {
		expect(shiftInside({ minX: 10, minY: 10, maxX: 20, maxY: 20 }, PAGE)).toEqual([
			0, 0,
		]);
	});

	it('pushes something hanging off an edge back on', () => {
		expect(
			shiftInside({ minX: 90, minY: -5, maxX: 110, maxY: 15 }, PAGE),
		).toEqual([-10, 5]);
	});

	it('aligns something too big for the page to its low edge', () => {
		expect(
			shiftInside({ minX: -30, minY: 0, maxX: 150, maxY: 10 }, PAGE),
		).toEqual([30, 0]);
	});
});
