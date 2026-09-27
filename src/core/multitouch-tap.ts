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

/**
 * Longer than this is a hold, not a tap.
 *
 * Generous, because two fingers rarely land or lift together and a tablet is held
 * in the other hand. A window that is too tight reads an ordinary tap as a hold and
 * silently does nothing, which is indistinguishable from the feature being broken.
 */
export const TAP_MAX_MS = 500;

/** Further than this from where it landed and the finger was dragging. */
export const TAP_MAX_MOVE_PX = 24;

/**
 * Why a gesture was not a tap.
 *
 * Reported rather than swallowed so the diagnostics overlay can say what happened:
 * "nothing at all" and "you held it a shade too long" need very different fixes.
 */
export type TapOutcome =
	| { readonly kind: 'tap'; readonly fingers: number }
	/** Fingers are still down; nothing decided yet. */
	| { readonly kind: 'pending' }
	| {
			readonly kind: 'rejected';
			readonly reason: 'moved' | 'too-slow' | 'not-tracking';
			readonly fingers: number;
		};

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
	 * A touch ended. Decides the gesture once the last finger lifts.
	 *
	 * Duration is judged here, at the end, rather than while moving: a stationary
	 * finger still produces a stream of touchmove events on a tablet, and treating a
	 * late one as a drag rejected taps that never moved at all.
	 */
	end(remaining: number, now: number): TapOutcome {
		const tracked = this.tracked;
		if (!tracked) return { kind: 'rejected', reason: 'not-tracking', fingers: 0 };
		// Still fingers down: the gesture is not over yet.
		if (remaining > 0) return { kind: 'pending' };

		this.tracked = null;
		const fingers = tracked.fingers;
		if (tracked.moved) return { kind: 'rejected', reason: 'moved', fingers };
		if (now - tracked.startedAt > this.maxDurationMs) {
			return { kind: 'rejected', reason: 'too-slow', fingers };
		}
		return { kind: 'tap', fingers };
	}

	/** Abandon the gesture — a pen landed, or the view is going away. */
	cancel(): void {
		this.tracked = null;
	}

	get isTracking(): boolean {
		return this.tracked !== null;
	}
}
