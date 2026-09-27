import { describe, expect, it } from 'vitest';
import {
	MultiTouchTap,
	TAP_MAX_MOVE_PX,
	TAP_MAX_MS,
	type TapPoint,
} from './multitouch-tap';

const at = (id: number, x: number, y: number): TapPoint => ({ id, x, y });

describe('MultiTouchTap', () => {
	it('recognises a two-finger tap', () => {
		const tap = new MultiTouchTap();
		tap.start([at(1, 100, 100), at(2, 160, 100)], 0);
		tap.update([at(1, 101, 100), at(2, 161, 101)], 50);
		expect(tap.end(0, 90)).toBe(2);
	});

	it('recognises a three-finger tap', () => {
		const tap = new MultiTouchTap();
		tap.start([at(1, 10, 10), at(2, 40, 10), at(3, 70, 10)], 0);
		expect(tap.end(0, 100)).toBe(3);
	});

	it('counts the most fingers seen, even if they land separately', () => {
		// Two fingers rarely touch down in the same event.
		const tap = new MultiTouchTap();
		tap.start([at(1, 10, 10)], 0);
		tap.start([at(1, 10, 10), at(2, 40, 10)], 20);
		expect(tap.end(0, 80)).toBe(2);
	});

	it('rejects a drag', () => {
		const tap = new MultiTouchTap();
		tap.start([at(1, 100, 100), at(2, 160, 100)], 0);
		tap.update([at(1, 100, 200), at(2, 160, 200)], 50);
		expect(tap.end(0, 90)).toBeNull();
	});

	it('rejects a pinch, where the fingers move apart', () => {
		const tap = new MultiTouchTap();
		tap.start([at(1, 100, 100), at(2, 160, 100)], 0);
		tap.update([at(1, 60, 100), at(2, 200, 100)], 40);
		expect(tap.end(0, 80)).toBeNull();
	});

	it('rejects a hold', () => {
		const tap = new MultiTouchTap();
		tap.start([at(1, 100, 100), at(2, 160, 100)], 0);
		expect(tap.end(0, TAP_MAX_MS + 1)).toBeNull();
	});

	it('rejects a hold even when the release event is the first update', () => {
		const tap = new MultiTouchTap();
		tap.start([at(1, 100, 100)], 0);
		tap.update([at(1, 100, 100)], TAP_MAX_MS + 50);
		expect(tap.end(0, TAP_MAX_MS + 60)).toBeNull();
	});

	it('allows movement up to the threshold', () => {
		const tap = new MultiTouchTap();
		tap.start([at(1, 0, 0), at(2, 50, 0)], 0);
		tap.update([at(1, TAP_MAX_MOVE_PX - 1, 0), at(2, 50, 0)], 20);
		expect(tap.end(0, 60)).toBe(2);
	});

	it('measures movement from where a finger landed, not from the last sample', () => {
		// Creeping a pixel at a time must still add up to a drag.
		const tap = new MultiTouchTap();
		tap.start([at(1, 0, 0), at(2, 50, 0)], 0);
		for (let x = 1; x <= TAP_MAX_MOVE_PX + 5; x++) {
			tap.update([at(1, x, 0), at(2, 50, 0)], 10);
		}
		expect(tap.end(0, 60)).toBeNull();
	});

	it('reports nothing while fingers are still down', () => {
		const tap = new MultiTouchTap();
		tap.start([at(1, 0, 0), at(2, 50, 0)], 0);
		expect(tap.end(1, 40)).toBeNull();
		// And still recognises it once the last one lifts.
		expect(tap.end(0, 60)).toBe(2);
	});

	it('reports a single-finger tap as one, for the caller to ignore', () => {
		const tap = new MultiTouchTap();
		tap.start([at(1, 0, 0)], 0);
		expect(tap.end(0, 50)).toBe(1);
	});

	it('forgets a cancelled gesture', () => {
		const tap = new MultiTouchTap();
		tap.start([at(1, 0, 0), at(2, 50, 0)], 0);
		tap.cancel();
		expect(tap.isTracking).toBe(false);
		expect(tap.end(0, 50)).toBeNull();
	});

	it('is reusable: a rejected gesture does not poison the next', () => {
		const tap = new MultiTouchTap();
		tap.start([at(1, 0, 0), at(2, 50, 0)], 0);
		tap.update([at(1, 0, 300), at(2, 50, 300)], 40);
		expect(tap.end(0, 80)).toBeNull();

		tap.start([at(3, 0, 0), at(4, 50, 0)], 100);
		expect(tap.end(0, 150)).toBe(2);
	});

	it('ignores updates for fingers it never saw land', () => {
		const tap = new MultiTouchTap();
		tap.start([at(1, 0, 0), at(2, 50, 0)], 0);
		tap.update([at(9, 999, 999)], 20);
		expect(tap.end(0, 60)).toBe(2);
	});

	it('takes its own thresholds', () => {
		const strict = new MultiTouchTap(50, 2);
		strict.start([at(1, 0, 0), at(2, 50, 0)], 0);
		expect(strict.end(0, 80)).toBeNull();
	});
});
