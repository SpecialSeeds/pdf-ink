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

/** Longer than this and the pen was drawing, not tapping. */
export const PEN_TAP_MAX_MS = 200;

/** A tap that travelled further than this was a mark, however short. */
export const PEN_TAP_MAX_TRAVEL_PX = 8;

/** The second tap has to follow this quickly. */
export const PEN_DOUBLE_TAP_GAP_MS = 320;

/** And land this close, so two marks in different places are never a gesture. */
export const PEN_DOUBLE_TAP_MAX_DISTANCE_PX = 32;

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
	register(tap: PenTap): boolean {
		if (!isTap(tap)) {
			this.first = null;
			return false;
		}
		const first = this.first;
		if (!first) {
			this.first = tap;
			return false;
		}
		const elapsed = tap.at - first.at;
		const distance = Math.hypot(tap.x - first.x, tap.y - first.y);
		if (elapsed > this.gapMs || distance > this.maxDistancePx) {
			// Too late or too far to pair, but it is a perfectly good first tap.
			this.first = tap;
			return false;
		}
		// Consumed, so a third tap starts a fresh pair rather than firing again.
		this.first = null;
		return true;
	}

	reset(): void {
		this.first = null;
	}

	get hasPendingTap(): boolean {
		return this.first !== null;
	}
}
