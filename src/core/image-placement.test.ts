import { describe, expect, it } from 'vitest';
import { MAX_PAGE_FRACTION, POINTS_PER_PX, placeImage, placeImages } from './image-placement';

const PAGE = { minX: 0, minY: 0, maxX: 612, maxY: 792 };

describe('placeImage', () => {
	it('keeps a small picture at its natural size, centred where asked', () => {
		const box = placeImage(200, 100, PAGE, [300, 400]);
		expect(box.w).toBeCloseTo(200 * POINTS_PER_PX);
		expect(box.h).toBeCloseTo(100 * POINTS_PER_PX);
		expect(box.x + box.w / 2).toBeCloseTo(300);
		expect(box.y + box.h / 2).toBeCloseTo(400);
	});

	it('shrinks a large picture to fit, keeping its proportions', () => {
		const box = placeImage(4000, 3000, PAGE, [306, 396]);
		expect(box.w).toBeCloseTo(612 * MAX_PAGE_FRACTION);
		expect(box.w / box.h).toBeCloseTo(4 / 3);
	});

	it('is pulled back onto the page near an edge', () => {
		const box = placeImage(200, 200, PAGE, [5, 790]);
		expect(box.x).toBe(0);
		expect(box.y + box.h).toBeCloseTo(792);
	});

	it('respects a page whose corner is not at the origin', () => {
		const board = { minX: 0, minY: -500, maxX: 600, maxY: 800 };
		const box = placeImage(100, 100, board, [50, -480]);
		expect(box.y).toBe(-500);
	});
});

describe('placeImages', () => {
	const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a): boolean =>
		a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

	it('places one picture exactly as placeImage does', () => {
		expect(placeImages([{ width: 200, height: 100 }], PAGE, [300, 400])).toEqual([
			placeImage(200, 100, PAGE, [300, 400]),
		]);
	});

	it('places none for nothing', () => {
		expect(placeImages([], PAGE, [300, 400])).toEqual([]);
	});

	it('lays several out without overlapping, all on the page', () => {
		const sizes = Array.from({ length: 5 }, () => ({ width: 2000, height: 1500 }));
		const boxes = placeImages(sizes, PAGE, [306, 396]);
		expect(boxes).toHaveLength(5);
		for (let i = 0; i < boxes.length; i++) {
			const a = boxes[i]!;
			expect(a.x).toBeGreaterThanOrEqual(PAGE.minX);
			expect(a.y).toBeGreaterThanOrEqual(PAGE.minY);
			expect(a.x + a.w).toBeLessThanOrEqual(PAGE.maxX + 1e-9);
			expect(a.y + a.h).toBeLessThanOrEqual(PAGE.maxY + 1e-9);
			expect(a.w / a.h).toBeCloseTo(4 / 3);
			for (let j = i + 1; j < boxes.length; j++) expect(overlaps(a, boxes[j]!)).toBe(false);
		}
	});

	it('reads left to right, then top down', () => {
		const sizes = Array.from({ length: 4 }, () => ({ width: 100, height: 100 }));
		const [a, b, c] = placeImages(sizes, PAGE, [306, 396]);
		expect(b!.x).toBeGreaterThan(a!.x);
		expect(b!.y).toBeCloseTo(a!.y);
		// y is up in PDF space: the second row is lower.
		expect(c!.y).toBeLessThan(a!.y);
	});

	it('is pulled back onto the page near an edge', () => {
		const sizes = [{ width: 100, height: 100 }, { width: 100, height: 100 }];
		const boxes = placeImages(sizes, PAGE, [0, 0]);
		for (const box of boxes) {
			expect(box.x).toBeGreaterThanOrEqual(0);
			expect(box.y).toBeGreaterThanOrEqual(0);
		}
	});
});
