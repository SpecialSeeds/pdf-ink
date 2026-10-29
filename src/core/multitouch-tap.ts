/**
 * Recognising a quick multi-finger tap. Pure — plain points, no DOM.
 *
 * Exists because the Apple Pencil's own gestures are not reachable from a plugin:
 * double-tap and squeeze are delivered to native code through UIPencilInteraction,
 * and WKWebView does not forward them to the page. A tap with the fingers already
 * resting on the glass is the nearest thing the web platform can see, and it suits
 * the same moment — switching tool without putting the pen down.
 *
 * A tap is distinguished from a pinch or a pan by two things: it is short, and
 * nothing moved far. It is distinguished from a resting palm by two more: no pen
 * touched the glass during it or just before it, and no contact was palm sized.
 */

export interface TapPoint {
	readonly id: number;
	readonly x: number;
	readonly y: number;
	/**
	 * Contact radius in CSS px, the larger of WebKit's `radiusX` and `radiusY`.
	 * Zero or absent when the platform does not report one.
	 */
	readonly radius?: number;
}

/**
 * Longer than this is a hold, not a tap.
 *
 * Generous, because two fingers rarely land or lift together and a tablet is held
 * in the other hand. A window that is too tight reads an ordinary tap as a hold and
 * silently does nothing, which is indistinguishable from the feature being broken.
 */
export const TAP_MAX_MS = 800;

/**
 * The range the "Two-finger tap window" setting offers, in ms. Some hands tap
 * slowly, and a window they cannot meet makes the gesture look broken.
 */
export const TAP_WINDOW_RANGE = { min: 300, max: 2000, step: 50 } as const;

export function clampTapWindow(ms: number): number {
	if (!Number.isFinite(ms)) return TAP_MAX_MS;
	return Math.min(TAP_WINDOW_RANGE.max, Math.max(TAP_WINDOW_RANGE.min, Math.round(ms)));
}

/**
 * Movement thresholds, measured against the gesture as a whole rather than each
 * finger on its own.
 *
 * Two fingers tapped together always shuffle — a device log showed a deliberate
 * two-finger tap rejected for movement — but what separates a tap from a pinch is
 * the fingers' spread changing, and from a pan is their centre travelling. Judging
 * each finger's own displacement confuses all three.
 */
export const TAP_MAX_PAN_PX = 56;
export const TAP_MAX_SPREAD_PX = 40;

/** A single finger has no spread, so this is its only movement limit. */
export const TAP_MAX_MOVE_PX = 56;

/**
 * A contact wider than this is a palm, not a fingertip.
 *
 * A fingertip reports a radius of roughly 10 to 30 px; the heel or side of a hand
 * well over 50. Set between the two, so a firm finger never trips it.
 */
export const TAP_MAX_RADIUS_PX = 45;

/**
 * Touches that begin this soon after the pen left the glass are the writing hand.
 *
 * A palm resting while you write lifts just after the pen does, and that lift
 * read as a quick two-finger tap, switching to the eraser mid-sentence. Short
 * enough that a deliberate tap after a pause still counts.
 */
export const TAP_PEN_QUIET_MS = 350;

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
			readonly reason:
				| 'panned'
				| 'pinched'
				| 'moved'
				| 'too-slow'
				| 'pen'
				| 'palm'
				| 'not-tracking';
			readonly fingers: number;
		};

interface Tracked {
	readonly startedAt: number;
	/** The most fingers seen at once, which is what the tap is counted by. */
	fingers: number;
	moved: 'panned' | 'pinched' | 'moved' | null;
	/** Why the hand is a resting palm rather than tapping fingers, once known. */
	resting: 'pen' | 'palm' | null;
	readonly origins: Map<number, TapPoint>;
}

interface Spread {
	readonly cx: number;
	readonly cy: number;
	/** Mean distance from the centre, which is what a pinch changes. */
	readonly radius: number;
}

function spreadOf(points: readonly TapPoint[]): Spread | null {
	if (points.length === 0) return null;
	let sx = 0;
	let sy = 0;
	for (const point of points) {
		sx += point.x;
		sy += point.y;
	}
	const cx = sx / points.length;
	const cy = sy / points.length;
	let total = 0;
	for (const point of points) total += Math.hypot(point.x - cx, point.y - cy);
	return { cx, cy, radius: total / points.length };
}

function palmSized(points: readonly TapPoint[]): boolean {
	return points.some((point) => (point.radius ?? 0) > TAP_MAX_RADIUS_PX);
}

export class MultiTouchTap {
	private tracked: Tracked | null = null;
	/** When a pen last touched the glass, or null if it never has. */
	private lastPenAt: number | null = null;

	constructor(
		private maxDurationMs = TAP_MAX_MS,
		private readonly maxMovePx = TAP_MAX_MOVE_PX,
	) {}

	/** Change how long a tap may last; see {@link TAP_WINDOW_RANGE}. */
	setMaxDuration(ms: number): void {
		this.maxDurationMs = ms;
	}

	/**
	 * A touch began. Safe to call for every touch of a gesture: the first starts
	 * the tracking and later ones only raise the finger count.
	 */
	start(points: readonly TapPoint[], now: number): void {
		if (!this.tracked) {
			this.tracked = {
				startedAt: now,
				fingers: points.length,
				moved: null,
				resting:
					this.lastPenAt !== null && now - this.lastPenAt < TAP_PEN_QUIET_MS
						? 'pen'
						: null,
				origins: new Map(),
			};
		}
		if (this.tracked.resting === null && palmSized(points)) {
			this.tracked.resting = 'palm';
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

	/**
	 * Positions changed. A pinch or a pan disqualifies the gesture; fingers merely
	 * settling against the glass does not.
	 */
	update(points: readonly TapPoint[], _now: number): void {
		const tracked = this.tracked;
		if (!tracked) return;
		// A contact can spread as the hand settles, so size is judged throughout.
		if (tracked.resting === null && palmSized(points)) tracked.resting = 'palm';
		if (tracked.moved !== null) return;

		// Compare only the fingers that were there at the start, so a late arrival
		// cannot look like a sudden lurch.
		const known = points.filter((point) => tracked.origins.has(point.id));
		if (known.length === 0) return;
		const origins = known.map((point) => {
			const origin = tracked.origins.get(point.id);
			return origin ?? point;
		});

		const now = spreadOf(known);
		const then = spreadOf(origins);
		if (!now || !then) return;

		if (Math.hypot(now.cx - then.cx, now.cy - then.cy) > TAP_MAX_PAN_PX) {
			tracked.moved = 'panned';
			return;
		}
		if (known.length > 1 && Math.abs(now.radius - then.radius) > TAP_MAX_SPREAD_PX) {
			tracked.moved = 'pinched';
			return;
		}
		// One finger has no spread to judge, so its own displacement is the test.
		if (known.length === 1) {
			const point = known[0];
			const origin = origins[0];
			if (point && origin) {
				const travelled = Math.hypot(point.x - origin.x, point.y - origin.y);
				if (travelled > this.maxMovePx) tracked.moved = 'moved';
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
		if (tracked.resting !== null) {
			return { kind: 'rejected', reason: tracked.resting, fingers };
		}
		if (tracked.moved !== null) {
			return { kind: 'rejected', reason: tracked.moved, fingers };
		}
		if (now - tracked.startedAt > this.maxDurationMs) {
			return { kind: 'rejected', reason: 'too-slow', fingers };
		}
		return { kind: 'tap', fingers };
	}

	/**
	 * A pen is touching the glass. Any gesture under way is the hand holding it,
	 * and so is one that begins within {@link TAP_PEN_QUIET_MS} of the pen lifting.
	 */
	pen(now: number): void {
		this.lastPenAt = now;
		if (this.tracked) this.tracked.resting = 'pen';
	}

	/** Abandon the gesture — the view is going away. */
	cancel(): void {
		this.tracked = null;
	}

	get isTracking(): boolean {
		return this.tracked !== null;
	}
}
