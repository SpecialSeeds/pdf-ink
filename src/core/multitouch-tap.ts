/**
 * Recognising a quick multi-finger tap. Pure — plain points, no DOM.
 *
 * Exists because the Apple Pencil's own gestures are not reachable from a plugin:
 * double-tap and squeeze are delivered to native code through UIPencilInteraction,
 * and WKWebView does not forward them to the page. A tap with the fingers already
 * resting on the glass is the nearest thing the web platform can see, and it suits
 * the same moment — switching tool without putting the pen down.
 *
 * A tap is distinguished from a pinch or a pan by two things only: it is short,
 * and nothing moved far.
 */

export interface TapPoint {
	readonly id: number;
	readonly x: number;
	readonly y: number;
}

/** Longer than this is a hold, not a tap. */
export const TAP_MAX_MS = 320;

/** Further than this from where it landed and the finger was dragging. */
export const TAP_MAX_MOVE_PX = 14;

interface Tracked {
	readonly startedAt: number;
	/** The most fingers seen at once, which is what the tap is counted by. */
	fingers: number;
	moved: boolean;
	readonly origins: Map<number, TapPoint>;
}

export class MultiTouchTap {
	private tracked: Tracked | null = null;

	constructor(
		private readonly maxDurationMs = TAP_MAX_MS,
		private readonly maxMovePx = TAP_MAX_MOVE_PX,
	) {}

	/**
	 * A touch began. Safe to call for every touch of a gesture: the first starts
	 * the tracking and later ones only raise the finger count.
	 */
	start(points: readonly TapPoint[], now: number): void {
		if (!this.tracked) {
			this.tracked = {
				startedAt: now,
				fingers: points.length,
				moved: false,
				origins: new Map(),
			};
		}
		for (const point of points) {
			// Keep the first position seen for a finger, so movement is measured from
			// where it landed rather than from where it last was.
			if (!this.tracked.origins.has(point.id)) {
				this.tracked.origins.set(point.id, point);
			}
		}
		this.tracked.fingers = Math.max(this.tracked.fingers, points.length);
	}

	/** Positions changed. Any real movement disqualifies the gesture. */
	update(points: readonly TapPoint[], now: number): void {
		const tracked = this.tracked;
		if (!tracked || tracked.moved) return;
		if (now - tracked.startedAt > this.maxDurationMs) {
			tracked.moved = true;
			return;
		}
		for (const point of points) {
			const origin = tracked.origins.get(point.id);
			if (!origin) continue;
			const dx = point.x - origin.x;
			const dy = point.y - origin.y;
			if (Math.hypot(dx, dy) > this.maxMovePx) {
				tracked.moved = true;
				return;
			}
		}
	}

	/**
	 * A touch ended. Returns the finger count once the last one lifts and the
	 * gesture was a clean tap, and null otherwise.
	 */
	end(remaining: number, now: number): number | null {
		const tracked = this.tracked;
		if (!tracked) return null;
		// Still fingers down: the gesture is not over yet.
		if (remaining > 0) return null;

		this.tracked = null;
		if (tracked.moved) return null;
		if (now - tracked.startedAt > this.maxDurationMs) return null;
		return tracked.fingers;
	}

	/** Abandon the gesture — a pen landed, or the view is going away. */
	cancel(): void {
		this.tracked = null;
	}

	get isTracking(): boolean {
		return this.tracked !== null;
	}
}
