import { describe, expect, it } from 'vitest';
import {
	MultiTouchTap,
	type TapOutcome,
	TAP_MAX_MOVE_PX,
	TAP_MAX_MS,
	type TapPoint,
} from './multitouch-tap';

const at = (id: number, x: number, y: number): TapPoint => ({ id, x, y });

/** Finger count when the gesture was a tap, else null. */
const fingers = (outcome: TapOutcome): number | null =>
	outcome.kind === 'tap' ? outcome.fingers : null;

const reason = (outcome: TapOutcome): string =>
	outcome.kind === 'rejected' ? outcome.reason : outcome.kind;

describe('MultiTouchTap', () => {
	it('recognises a two-finger tap', () => {
		const tap = new MultiTouchTap();
		tap.start([at(1, 100, 100), at(2, 160, 100)], 0);
		tap.update([at(1, 101, 100), at(2, 161, 101)], 50);
		expect(fingers(tap.end(0, 90))).toBe(2);
	});

	it('recognises a three-finger tap', () => {
		const tap = new MultiTouchTap();
		tap.start([at(1, 10, 10), at(2, 40, 10), at(3, 70, 10)], 0);
		expect(fingers(tap.end(0, 100))).toBe(3);
	});

	it('counts the most fingers seen, even if they land separately', () => {
		// Two fingers rarely touch down in the same event.
		const tap = new MultiTouchTap();
		tap.start([at(1, 10, 10)], 0);
		tap.start([at(1, 10, 10), at(2, 40, 10)], 20);
		expect(fingers(tap.end(0, 80))).toBe(2);
	});

	it('rejects a two-finger pan', () => {
		const tap = new MultiTouchTap();
		tap.start([at(1, 100, 100), at(2, 160, 100)], 0);
		tap.update([at(1, 100, 300), at(2, 160, 300)], 50);
		expect(fingers(tap.end(0, 90))).toBeNull();
	});

	it('rejects a pinch, where the fingers move apart', () => {
		const tap = new MultiTouchTap();
		tap.start([at(1, 100, 100), at(2, 160, 100)], 0);
		// The centre stays put; only the spread changes, which is a pinch exactly.
		tap.update([at(1, 0, 100), at(2, 260, 100)], 40);
		expect(fingers(tap.end(0, 80))).toBeNull();
	});

	it('allows two fingers settling against the glass', () => {
		// The case that made this look broken: a deliberate two-finger tap always
		// shuffles a little, and judging each finger on its own rejected it.
		const tap = new MultiTouchTap();
		tap.start([at(1, 100, 100), at(2, 160, 100)], 0);
		tap.update([at(1, 108, 112), at(2, 150, 94)], 60);
		tap.update([at(1, 112, 116), at(2, 146, 90)], 120);
		expect(fingers(tap.end(0, 400))).toBe(2);
	});

	it('rejects a hold', () => {
		const tap = new MultiTouchTap();
		tap.start([at(1, 100, 100), at(2, 160, 100)], 0);
		expect(fingers(tap.end(0, TAP_MAX_MS + 1))).toBeNull();
	});

	it('judges duration at the end, not while moving', () => {
		/*
		 * The fix for taps that silently did nothing on a tablet. A finger resting on
		 * glass still produces a stream of touchmove events, and treating a late one
		 * as a drag rejected taps that had not moved at all. Only the lift decides.
		 */
		const tap = new MultiTouchTap();
		tap.start([at(1, 100, 100), at(2, 160, 100)], 0);
		for (let now = 10; now <= 400; now += 10) {
			tap.update([at(1, 100, 100), at(2, 160, 100)], now);
		}
		expect(fingers(tap.end(0, 420))).toBe(2);
	});

	it('still rejects a genuine hold', () => {
		const tap = new MultiTouchTap();
		tap.start([at(1, 100, 100), at(2, 160, 100)], 0);
		tap.update([at(1, 100, 100), at(2, 160, 100)], TAP_MAX_MS + 50);
		expect(fingers(tap.end(0, TAP_MAX_MS + 60))).toBeNull();
	});

	it('allows a window long enough for two fingers to land and lift', () => {
		// A device log showed a deliberate two-finger tap taking 553ms.
		expect(TAP_MAX_MS).toBeGreaterThanOrEqual(600);
		expect(TAP_MAX_MOVE_PX).toBeGreaterThanOrEqual(40);
	});

	it('allows a single finger to move up to its threshold', () => {
		const tap = new MultiTouchTap();
		tap.start([at(1, 0, 0)], 0);
		tap.update([at(1, TAP_MAX_MOVE_PX - 1, 0)], 20);
		expect(fingers(tap.end(0, 60))).toBe(1);
	});

	it('measures movement from where a finger landed, not from the last sample', () => {
		// Creeping a pixel at a time must still add up to a drag.
		const tap = new MultiTouchTap();
		tap.start([at(1, 0, 0)], 0);
		for (let x = 1; x <= TAP_MAX_MOVE_PX + 5; x++) {
			tap.update([at(1, x, 0)], 10);
		}
		expect(fingers(tap.end(0, 60))).toBeNull();
	});

	it('reports nothing while fingers are still down', () => {
		const tap = new MultiTouchTap();
		tap.start([at(1, 0, 0), at(2, 50, 0)], 0);
		expect(fingers(tap.end(1, 40))).toBeNull();
		// And still recognises it once the last one lifts.
		expect(fingers(tap.end(0, 60))).toBe(2);
	});

	it('reports a single-finger tap as one, for the caller to ignore', () => {
		const tap = new MultiTouchTap();
		tap.start([at(1, 0, 0)], 0);
		expect(fingers(tap.end(0, 50))).toBe(1);
	});

	it('forgets a cancelled gesture', () => {
		const tap = new MultiTouchTap();
		tap.start([at(1, 0, 0), at(2, 50, 0)], 0);
		tap.cancel();
		expect(tap.isTracking).toBe(false);
		expect(fingers(tap.end(0, 50))).toBeNull();
	});

	it('is reusable: a rejected gesture does not poison the next', () => {
		const tap = new MultiTouchTap();
		tap.start([at(1, 0, 0), at(2, 50, 0)], 0);
		tap.update([at(1, 0, 300), at(2, 50, 300)], 40);
		expect(fingers(tap.end(0, 80))).toBeNull();

		tap.start([at(3, 0, 0), at(4, 50, 0)], 100);
		expect(fingers(tap.end(0, 150))).toBe(2);
	});

	it('ignores updates for fingers it never saw land', () => {
		const tap = new MultiTouchTap();
		tap.start([at(1, 0, 0), at(2, 50, 0)], 0);
		tap.update([at(9, 999, 999)], 20);
		expect(fingers(tap.end(0, 60))).toBe(2);
	});

	it('takes its own thresholds', () => {
		const strict = new MultiTouchTap(50, 2);
		strict.start([at(1, 0, 0), at(2, 50, 0)], 0);
		expect(fingers(strict.end(0, 80))).toBeNull();
	});
});

describe('outcomes say why a gesture was not a tap', () => {
	it('tells a pan from a pinch', () => {
		const pan = new MultiTouchTap();
		pan.start([at(1, 0, 0), at(2, 50, 0)], 0);
		pan.update([at(1, 0, 400), at(2, 50, 400)], 30);
		expect(reason(pan.end(0, 60))).toBe('panned');

		const pinch = new MultiTouchTap();
		pinch.start([at(1, 0, 0), at(2, 50, 0)], 0);
		pinch.update([at(1, -100, 0), at(2, 150, 0)], 30);
		expect(reason(pinch.end(0, 60))).toBe('pinched');
	});

	it('reports a hold as too slow', () => {
		const tap = new MultiTouchTap();
		tap.start([at(1, 0, 0), at(2, 50, 0)], 0);
		expect(reason(tap.end(0, TAP_MAX_MS + 100))).toBe('too-slow');
	});

	it('reports a lift it never saw begin', () => {
		expect(reason(new MultiTouchTap().end(0, 10))).toBe('not-tracking');
	});

	it('reports fingers still down as pending', () => {
		const tap = new MultiTouchTap();
		tap.start([at(1, 0, 0), at(2, 50, 0)], 0);
		expect(reason(tap.end(1, 40))).toBe('pending');
	});

	it('carries the finger count on a rejection, for the diagnostics log', () => {
		const tap = new MultiTouchTap();
		tap.start([at(1, 0, 0), at(2, 50, 0)], 0);
		tap.update([at(1, 0, 400), at(2, 50, 400)], 30);
		const outcome = tap.end(0, 60);
		expect(outcome.kind).toBe('rejected');
		if (outcome.kind === 'rejected') expect(outcome.fingers).toBe(2);
	});
});
