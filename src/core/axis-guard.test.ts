import { describe, expect, it } from 'vitest';
import { AxisGuard, USER_SCROLL_SETTLE_MS } from './axis-guard';

describe('AxisGuard', () => {
	it('puts back the locked axis when the user scrolls it', () => {
		const guard = new AxisGuard();
		guard.setAxis('vertical', { left: 120, top: 0 });
		guard.touched(1, 0);
		expect(guard.scrolled({ left: 140, top: 300 }, 16)).toEqual({ left: 120, top: 300 });
		// The correction's own scroll event is left alone.
		expect(guard.scrolled({ left: 120, top: 300 }, 17)).toBeNull();
	});

	it('holds through a fling, after the finger lifts', () => {
		const guard = new AxisGuard();
		guard.setAxis('vertical', { left: 50, top: 0 });
		guard.touched(1, 0);
		guard.touched(0, 100);
		// A glide well past the settle time still counts, frame by frame.
		let now = 100;
		for (let frame = 1; frame <= 120; frame++) {
			now += 16;
			expect(guard.scrolled({ left: 50 + frame, top: frame * 20 }, now)).toEqual({
				left: 50,
				top: frame * 20,
			});
		}
	});

	it('holds left and right, or up and down', () => {
		const guard = new AxisGuard();
		guard.setAxis('horizontal', { left: 0, top: 800 });
		guard.wheeled(0);
		expect(guard.scrolled({ left: 90, top: 810 }, 10)).toEqual({ left: 90, top: 800 });
	});

	it('adopts a scroll the plugin made, outside any gesture', () => {
		const guard = new AxisGuard();
		guard.setAxis('vertical', { left: 0, top: 0 });
		// A zoom moved both axes to keep its anchor.
		expect(guard.scrolled({ left: 300, top: 900 }, 0)).toBeNull();
		guard.touched(1, 1000);
		expect(guard.scrolled({ left: 310, top: 950 }, 1016)).toEqual({ left: 300, top: 950 });
	});

	it('holds what it is told, even mid-gesture', () => {
		const guard = new AxisGuard();
		guard.setAxis('vertical', { left: 0, top: 0 });
		guard.touched(2, 0);
		guard.hold({ left: 400, top: 200 });
		expect(guard.scrolled({ left: 400, top: 200 }, 16)).toBeNull();
	});

	it('lets go once the page has been still for a moment', () => {
		const guard = new AxisGuard();
		guard.setAxis('vertical', { left: 0, top: 0 });
		guard.touched(1, 0);
		guard.touched(0, 10);
		expect(guard.scrolled({ left: 70, top: 0 }, 10 + USER_SCROLL_SETTLE_MS + 1)).toBeNull();
	});

	it('does nothing while unlocked', () => {
		const guard = new AxisGuard();
		guard.touched(1, 0);
		expect(guard.scrolled({ left: 70, top: 30 }, 5)).toBeNull();
	});
});
