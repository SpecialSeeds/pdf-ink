import { describe, expect, it } from 'vitest';
import { MAX_PAGE_FRACTION, POINTS_PER_PX, placeImage } from './image-placement';

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
