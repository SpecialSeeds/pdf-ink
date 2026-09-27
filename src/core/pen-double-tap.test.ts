import { describe, expect, it } from 'vitest';
import {
	PEN_DOUBLE_TAP_GAP_MS,
	PEN_DOUBLE_TAP_MAX_DISTANCE_PX,
	PEN_TAP_MAX_MS,
	PEN_TAP_MAX_TRAVEL_PX,
	PenDoubleTap,
	type PenTap,
	isTap,
} from './pen-double-tap';

function tap(over: Partial<PenTap> = {}): PenTap {
	return { x: 100, y: 100, at: 1000, durationMs: 60, travelPx: 2, ...over };
}

describe('isTap', () => {
	it('accepts a brief, still contact', () => {
		expect(isTap(tap())).toBe(true);
	});

	it('rejects a stroke that lasted', () => {
		expect(isTap(tap({ durationMs: PEN_TAP_MAX_MS + 1 }))).toBe(false);
	});

	it('rejects a mark that travelled', () => {
		expect(isTap(tap({ travelPx: PEN_TAP_MAX_TRAVEL_PX + 1 }))).toBe(false);
	});

	it('accepts exactly at the limits', () => {
		expect(
			isTap(tap({ durationMs: PEN_TAP_MAX_MS, travelPx: PEN_TAP_MAX_TRAVEL_PX })),
		).toBe(true);
	});
});

describe('PenDoubleTap', () => {
	it('fires on the second tap, not the first', () => {
		const gesture = new PenDoubleTap();
		expect(gesture.register(tap({ at: 1000 }))).toBe(false);
		expect(gesture.register(tap({ at: 1150 }))).toBe(true);
	});

	it('does not fire again on a third tap', () => {
		// Otherwise a triple tap would toggle twice and land back where it started.
		const gesture = new PenDoubleTap();
		gesture.register(tap({ at: 1000 }));
		expect(gesture.register(tap({ at: 1100 }))).toBe(true);
		expect(gesture.register(tap({ at: 1200 }))).toBe(false);
	});

	it('fires on a fourth tap, starting a fresh pair', () => {
		const gesture = new PenDoubleTap();
		gesture.register(tap({ at: 1000 }));
		gesture.register(tap({ at: 1100 }));
		gesture.register(tap({ at: 1200 }));
		expect(gesture.register(tap({ at: 1300 }))).toBe(true);
	});

	it('refuses a second tap that came too late', () => {
		const gesture = new PenDoubleTap();
		gesture.register(tap({ at: 1000 }));
		expect(
			gesture.register(tap({ at: 1000 + PEN_DOUBLE_TAP_GAP_MS + 1 })),
		).toBe(false);
	});

	it('refuses a second tap somewhere else on the page', () => {
		// Writing quickly produces short marks in a row; they are not a gesture.
		const gesture = new PenDoubleTap();
		gesture.register(tap({ at: 1000, x: 100 }));
		expect(
			gesture.register(
				tap({ at: 1100, x: 100 + PEN_DOUBLE_TAP_MAX_DISTANCE_PX + 1 }),
			),
		).toBe(false);
	});

	it('keeps a refused tap as the new first, so the next one can pair', () => {
		const gesture = new PenDoubleTap();
		gesture.register(tap({ at: 1000, x: 0 }));
		gesture.register(tap({ at: 1100, x: 500 }));
		expect(gesture.register(tap({ at: 1200, x: 500 }))).toBe(true);
	});

	it('a drawn mark between two taps breaks the pair', () => {
		const gesture = new PenDoubleTap();
		gesture.register(tap({ at: 1000 }));
		// A real stroke, not a tap.
		expect(gesture.register(tap({ at: 1050, durationMs: 900 }))).toBe(false);
		expect(gesture.hasPendingTap).toBe(false);
		expect(gesture.register(tap({ at: 1100 }))).toBe(false);
	});

	it('measures distance in both axes', () => {
		const gesture = new PenDoubleTap();
		gesture.register(tap({ at: 1000, x: 0, y: 0 }));
		// 3-4-5: 50px away, beyond the limit, despite each axis being under it.
		expect(gesture.register(tap({ at: 1100, x: 30, y: 40 }))).toBe(false);
	});

	it('can be reset', () => {
		const gesture = new PenDoubleTap();
		gesture.register(tap({ at: 1000 }));
		expect(gesture.hasPendingTap).toBe(true);
		gesture.reset();
		expect(gesture.register(tap({ at: 1100 }))).toBe(false);
	});

	it('takes its own thresholds', () => {
		const strict = new PenDoubleTap(50, 5);
		strict.register(tap({ at: 1000 }));
		expect(strict.register(tap({ at: 1100 }))).toBe(false);
	});

	it('does not pair two full stops written a word apart', () => {
		// The case that decides the thresholds: quick punctuation while writing.
		const gesture = new PenDoubleTap();
		gesture.register(tap({ at: 1000, x: 120, y: 300 }));
		expect(gesture.register(tap({ at: 1180, x: 260, y: 300 }))).toBe(false);
	});
});
