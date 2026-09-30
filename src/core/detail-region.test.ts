import { describe, expect, it } from 'vitest';
import { DESKTOP_BUDGET, MOBILE_BUDGET, effectiveDpr } from './canvas-budget';
import {
	containsRect,
	detailBitmapSize,
	detailRegion,
	intersectRect,
} from './detail-region';

/** 11,244 x 4,449 pt, the iOS export of a OneNote page, at 100% zoom. */
const WIDE = { w: Math.round((11244 * 4) / 3), h: Math.round((4449 * 4) / 3) };
/** 612 x 8000 pt at 100% zoom. */
const TALL = { w: 816, h: Math.round((8000 * 4) / 3) };
/** An iPad viewport in CSS px. */
const IPAD = { w: 1180, h: 760 };

function withinBudget(
	region: { rect: { w: number; h: number }; dpr: number },
	budget: { maxSide: number; maxArea: number },
): boolean {
	const { width, height } = detailBitmapSize({
		rect: { x: 0, y: 0, ...region.rect },
		dpr: region.dpr,
	});
	return (
		width <= budget.maxSide &&
		height <= budget.maxSide &&
		width * height <= budget.maxArea
	);
}

describe('detailRegion', () => {
	it('is null when the whole page already fits the budget', () => {
		const region = detailRegion(
			800,
			1000,
			{ x: 0, y: 0, w: 800, h: 1000 },
			2,
			MOBILE_BUDGET,
		);
		expect(region).toBeNull();
	});

	it('is null when the page is out of view', () => {
		const region = detailRegion(
			WIDE.w,
			WIDE.h,
			{ x: 0, y: WIDE.h + 10, w: IPAD.w, h: IPAD.h },
			2,
			MOBILE_BUDGET,
		);
		expect(region).toBeNull();
	});

	it('renders the visible part of a huge page at the full dpr', () => {
		const visible = { x: 5000, y: 2000, w: IPAD.w, h: IPAD.h };
		const region = detailRegion(WIDE.w, WIDE.h, visible, 2, MOBILE_BUDGET);
		expect(region).not.toBeNull();
		if (!region) return;
		// The whole-page bitmap is stuck near 0.2 on mobile.
		expect(effectiveDpr(WIDE.w, WIDE.h, 2, MOBILE_BUDGET)).toBeLessThan(0.3);
		expect(region.dpr).toBe(2);
		expect(containsRect(region.rect, visible)).toBe(true);
		expect(withinBudget(region, MOBILE_BUDGET)).toBe(true);
	});

	it('pads around the visible part when the budget allows', () => {
		const visible = { x: 5000, y: 2000, w: 1000, h: 700 };
		const region = detailRegion(WIDE.w, WIDE.h, visible, 2, DESKTOP_BUDGET);
		expect(region?.rect).toEqual({ x: 4750, y: 1750, w: 1500, h: 1200 });
	});

	it('clips to the page edges', () => {
		const visible = { x: -100, y: -50, w: 1000, h: 700 };
		const region = detailRegion(WIDE.w, WIDE.h, visible, 2, DESKTOP_BUDGET);
		expect(region?.rect.x).toBe(0);
		expect(region?.rect.y).toBe(0);
	});

	it('handles a tall page at 300% zoom', () => {
		const w = TALL.w * 3;
		const h = TALL.h * 3;
		const visible = { x: 600, y: 20000, w: IPAD.w, h: IPAD.h };
		const region = detailRegion(w, h, visible, 2, MOBILE_BUDGET);
		expect(region?.dpr).toBe(2);
		if (region) {
			expect(containsRect(region.rect, visible)).toBe(true);
			expect(withinBudget(region, MOBILE_BUDGET)).toBe(true);
		}
	});

	it('lowers the dpr only when the view alone exceeds the budget', () => {
		// A 4K desktop window at dpr 2 is well over the mobile budget.
		const visible = { x: 0, y: 0, w: 3840, h: 2160 };
		const region = detailRegion(WIDE.w, WIDE.h, visible, 2, MOBILE_BUDGET);
		expect(region).not.toBeNull();
		if (!region) return;
		expect(region.dpr).toBeLessThan(2);
		expect(region.dpr).toBeGreaterThan(
			effectiveDpr(WIDE.w, WIDE.h, 2, MOBILE_BUDGET),
		);
		expect(containsRect(region.rect, visible)).toBe(true);
		expect(withinBudget(region, MOBILE_BUDGET)).toBe(true);
	});

	it('stays inside the budget with fractional inputs', () => {
		for (const dpr of [1, 1.5, 2, 2.625, 3]) {
			for (const budget of [MOBILE_BUDGET, DESKTOP_BUDGET]) {
				const visible = { x: 123.4, y: 567.8, w: 1179.6, h: 819.3 };
				const region = detailRegion(WIDE.w, WIDE.h, visible, dpr, budget);
				if (!region) continue;
				expect(containsRect(region.rect, visible)).toBe(true);
				expect(withinBudget(region, budget)).toBe(true);
				expect(Number.isInteger(region.rect.x)).toBe(true);
				expect(Number.isInteger(region.rect.w)).toBe(true);
			}
		}
	});
});

describe('rect helpers', () => {
	it('intersects and contains', () => {
		const a = { x: 0, y: 0, w: 10, h: 10 };
		expect(intersectRect(a, { x: 5, y: 5, w: 10, h: 10 })).toEqual({
			x: 5,
			y: 5,
			w: 5,
			h: 5,
		});
		expect(intersectRect(a, { x: 10, y: 0, w: 5, h: 5 })).toBeNull();
		expect(containsRect(a, { x: 1, y: 1, w: 9, h: 9 })).toBe(true);
		expect(containsRect(a, { x: 1, y: 1, w: 10, h: 9 })).toBe(false);
	});
});
