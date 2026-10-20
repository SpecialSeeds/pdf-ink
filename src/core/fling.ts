/**
 * Glide after a swipe, for scrolling the plugin does itself (the scroll lock).
 *
 * The same curve as iOS's own scrolling: speed falls by a fixed fraction every
 * millisecond, so a fling feels like the native one it stands in for.
 */

/** UIScrollView's normal deceleration rate: speed kept per millisecond. */
export const DECELERATION_PER_MS = 0.998;
/** Slower than this at release, in px/ms, and the page just stops. */
export const MIN_FLING_SPEED = 0.1;
/** The glide ends once it is this slow, in px/ms. */
export const STOP_SPEED = 0.02;
/** How far back the release speed is measured, in ms. */
export const VELOCITY_WINDOW_MS = 100;

/** A finger's position along the scrolling axis, in px, at a time in ms. */
export interface AxisSample {
	readonly time: number;
	readonly position: number;
}

/**
 * The finger's speed as it lifted, in px/ms, from the moves just before. Zero
 * when it had stopped, since a finger held still before lifting means no fling.
 */
export function releaseVelocity(samples: readonly AxisSample[], now: number): number {
	const recent = samples.filter((sample) => now - sample.time <= VELOCITY_WINDOW_MS);
	const first = recent[0];
	const last = recent[recent.length - 1];
	if (!first || !last || last.time <= first.time) return 0;
	return (last.position - first.position) / (last.time - first.time);
}

/**
 * Advance a glide by `dt` ms. Exact rather than per frame, so a dropped frame
 * covers the ground the missing ones would have.
 */
export function flingStep(
	velocity: number,
	dt: number,
): { readonly distance: number; readonly velocity: number } {
	const kept = DECELERATION_PER_MS ** dt;
	return {
		distance: (velocity * (kept - 1)) / Math.log(DECELERATION_PER_MS),
		velocity: velocity * kept,
	};
}
