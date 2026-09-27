import { describe, expect, it } from 'vitest';
import {
	PEN_DOUBLE_TAP_GAP_MS,
	PEN_DOUBLE_TAP_MAX_DISTANCE_PX,
	PEN_TAP_MAX_MS,
	PEN_TAP_MAX_TRAVEL_PX,
	PenDoubleTap,
	type PenTap,
	type PenTapResult,
	isTap,
} from './pen-double-tap';

/** True when a registration completed a pair. */
const paired = (result: PenTapResult): boolean => result.kind === 'paired';

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
		expect(paired(gesture.register(tap({ at: 1000 })))).toBe(false);
		expect(paired(gesture.register(tap({ at: 1150 })))).toBe(true);
	});

	it('does not fire again on a third tap', () => {
		// Otherwise a triple tap would toggle twice and land back where it started.
		const gesture = new PenDoubleTap();
		gesture.register(tap({ at: 1000 }));
		expect(paired(gesture.register(tap({ at: 1100 })))).toBe(true);
		expect(paired(gesture.register(tap({ at: 1200 })))).toBe(false);
	});

	it('fires on a fourth tap, starting a fresh pair', () => {
		const gesture = new PenDoubleTap();
		gesture.register(tap({ at: 1000 }));
		gesture.register(tap({ at: 1100 }));
		gesture.register(tap({ at: 1200 }));
		expect(paired(gesture.register(tap({ at: 1300 })))).toBe(true);
	});

	it('refuses a second tap that came too late', () => {
		const gesture = new PenDoubleTap();
		gesture.register(tap({ at: 1000 }));
		expect(
			paired(gesture.register(tap({ at: 1000 + PEN_DOUBLE_TAP_GAP_MS + 1 }))),
		).toBe(false);
	});

	it('refuses a second tap somewhere else on the page', () => {
		// Writing quickly produces short marks in a row; they are not a gesture.
		const gesture = new PenDoubleTap();
		gesture.register(tap({ at: 1000, x: 100 }));
		expect(
			paired(
				gesture.register(
					tap({ at: 1100, x: 100 + PEN_DOUBLE_TAP_MAX_DISTANCE_PX + 1 }),
				),
			),
		).toBe(false);
	});

	it('keeps a refused tap as the new first, so the next one can pair', () => {
		const gesture = new PenDoubleTap();
		gesture.register(tap({ at: 1000, x: 0 }));
		gesture.register(tap({ at: 1100, x: 500 }));
		expect(paired(gesture.register(tap({ at: 1200, x: 500 })))).toBe(true);
	});

	it('a drawn mark between two taps breaks the pair', () => {
		const gesture = new PenDoubleTap();
		gesture.register(tap({ at: 1000 }));
		// A real stroke, not a tap.
		expect(paired(gesture.register(tap({ at: 1050, durationMs: 900 })))).toBe(false);
		expect(gesture.hasPendingTap).toBe(false);
		expect(paired(gesture.register(tap({ at: 1100 })))).toBe(false);
	});

	it('measures distance in both axes', () => {
		const gesture = new PenDoubleTap();
		gesture.register(tap({ at: 1000, x: 0, y: 0 }));
		// 3-4-5: 50px away, beyond the limit, despite each axis being under it.
		expect(paired(gesture.register(tap({ at: 1100, x: 30, y: 40 })))).toBe(false);
	});

	it('can be reset', () => {
		const gesture = new PenDoubleTap();
		gesture.register(tap({ at: 1000 }));
		expect(gesture.hasPendingTap).toBe(true);
		gesture.reset();
		expect(paired(gesture.register(tap({ at: 1100 })))).toBe(false);
	});

	it('takes its own thresholds', () => {
		const strict = new PenDoubleTap(50, 5);
		strict.register(tap({ at: 1000 }));
		expect(paired(strict.register(tap({ at: 1100 })))).toBe(false);
	});

	it('does not pair two full stops written a word apart', () => {
		// The case that decides the thresholds: quick punctuation while writing.
		const gesture = new PenDoubleTap();
		gesture.register(tap({ at: 1000, x: 120, y: 300 }));
		expect(paired(gesture.register(tap({ at: 1180, x: 260, y: 300 })))).toBe(false);
	});
});

describe('PenDoubleTap results say which threshold was missed', () => {
	it('names a pair', () => {
		const gesture = new PenDoubleTap();
		gesture.register(tap({ at: 1000 }));
		expect(gesture.register(tap({ at: 1100 })).kind).toBe('paired');
	});

	it('names the first tap of a pair', () => {
		expect(new PenDoubleTap().register(tap()).kind).toBe('first');
	});

	it('names a stroke that was never a tap', () => {
		expect(new PenDoubleTap().register(tap({ durationMs: 5000 })).kind).toBe(
			'not-a-tap',
		);
	});

	it('reports how late a second tap was', () => {
		const gesture = new PenDoubleTap();
		gesture.register(tap({ at: 1000 }));
		const result = gesture.register(
			tap({ at: 1000 + PEN_DOUBLE_TAP_GAP_MS + 200 }),
		);
		expect(result.kind).toBe('too-late');
		if (result.kind === 'too-late') {
			expect(result.elapsedMs).toBe(PEN_DOUBLE_TAP_GAP_MS + 200);
		}
	});

	it('reports how far a second tap landed', () => {
		const gesture = new PenDoubleTap();
		gesture.register(tap({ at: 1000, x: 0, y: 0 }));
		const result = gesture.register(tap({ at: 1100, x: 300, y: 400 }));
		expect(result.kind).toBe('too-far');
		if (result.kind === 'too-far') expect(result.distancePx).toBe(500);
	});
});

describe('thresholds match what a real stylus reports', () => {
	it('accepts a tap that skidded, as a tip on glass does', () => {
		// Measured on an iPad: a deliberate tap, 59ms and 15px. An 8px allowance
		// rejected it, which is what made the gesture look broken.
		expect(isTap(tap({ durationMs: 59, travelPx: 15 }))).toBe(true);
		expect(isTap(tap({ durationMs: 29, travelPx: 2 }))).toBe(true);
	});

	it('still rejects a short drawn mark', () => {
		expect(isTap(tap({ durationMs: 363, travelPx: 44 }))).toBe(false);
		expect(isTap(tap({ durationMs: 830, travelPx: 106 }))).toBe(false);
	});
});
