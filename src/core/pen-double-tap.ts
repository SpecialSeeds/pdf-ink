/**
 * Recognising a double-tap of a stylus tip against the screen. Pure.
 *
 * The Apple Pencil's own double-tap is a barrel gesture delivered to native code
 * through UIPencilInteraction; a web view never sees it, which the plugin's own
 * input log confirms — double-tapping the barrel produces no event of any kind.
 * Tapping the *tip* twice does produce events, and is the nearest thing to the
 * gesture people actually want: switch tool without putting the pen down.
 *
 * The cost is that a tap is also how you draw a full stop, so the thresholds are
 * deliberately tight: each tap must be brief and almost motionless, and the two
 * must land in nearly the same place in quick succession.
 */

/**
 * Longer than this and the pen was drawing, not tapping.
 *
 * The thresholds below are measured rather than guessed: a device log showed a
 * deliberate tap lasting 29ms and straying 2px, and another lasting 59ms and
 * straying 15px. A tip skids on glass, so an allowance of a few pixels rejected
 * taps that were plainly taps.
 */
export const PEN_TAP_MAX_MS = 250;

/** A tap that travelled further than this was a mark, however short. */
export const PEN_TAP_MAX_TRAVEL_PX = 20;

/** The second tap has to follow this quickly. */
export const PEN_DOUBLE_TAP_GAP_MS = 450;

/** And land this close, so two marks in different places are never a gesture. */
export const PEN_DOUBLE_TAP_MAX_DISTANCE_PX = 48;

export interface PenTap {
	/** Screen position of the tap, in CSS px. */
	readonly x: number;
	readonly y: number;
	/** When the pen lifted. */
	readonly at: number;
	/** How long the tip was down. */
	readonly durationMs: number;
	/** Furthest the tip moved from where it landed. */
	readonly travelPx: number;
}

/** Whether a completed stroke was brief and still enough to count as a tap. */
export function isTap(tap: PenTap): boolean {
	return (
		tap.durationMs <= PEN_TAP_MAX_MS && tap.travelPx <= PEN_TAP_MAX_TRAVEL_PX
	);
}

/**
 * What became of a stroke offered to the recogniser.
 *
 * Reported rather than reduced to a boolean so the diagnostics overlay can say
 * which threshold a gesture missed — "nothing happened" is not a bug report.
 */
export type PenTapResult =
	| { readonly kind: 'paired' }
	/** A tap, now waiting for a partner. */
	| { readonly kind: 'first' }
	/** Too long or too far to be a tap at all; any pending pair is broken. */
	| { readonly kind: 'not-a-tap' }
	| { readonly kind: 'too-late'; readonly elapsedMs: number }
	| { readonly kind: 'too-far'; readonly distancePx: number };

export class PenDoubleTap {
	private first: PenTap | null = null;

	constructor(
		private readonly gapMs = PEN_DOUBLE_TAP_GAP_MS,
		private readonly maxDistancePx = PEN_DOUBLE_TAP_MAX_DISTANCE_PX,
	) {}

	/**
	 * Offer a completed stroke. True when it closed a double-tap.
	 *
	 * A stroke that is not a tap clears the pending one: a mark drawn between two
	 * taps means they were not a pair, and treating them as one would fire the
	 * gesture in the middle of writing.
	 */
	register(tap: PenTap): PenTapResult {
		if (!isTap(tap)) {
			this.first = null;
			return { kind: 'not-a-tap' };
		}
		const first = this.first;
		if (!first) {
			this.first = tap;
			return { kind: 'first' };
		}
		const elapsedMs = tap.at - first.at;
		const distancePx = Math.hypot(tap.x - first.x, tap.y - first.y);
		if (elapsedMs > this.gapMs) {
			// Too late to pair, but a perfectly good first tap in its own right.
			this.first = tap;
			return { kind: 'too-late', elapsedMs };
		}
		if (distancePx > this.maxDistancePx) {
			this.first = tap;
			return { kind: 'too-far', distancePx };
		}
		// Consumed, so a third tap starts a fresh pair rather than firing again.
		this.first = null;
		return { kind: 'paired' };
	}

	reset(): void {
		this.first = null;
	}

	get hasPendingTap(): boolean {
		return this.first !== null;
	}
}
