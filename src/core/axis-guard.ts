import type { ScrollAxis } from './settings-schema';

/**
 * How long after the last input or scroll a scroll still counts as the user's.
 * Every frame of a fling is a scroll event, so the window stays open for the
 * whole glide and closes soon after it stops.
 */
export const USER_SCROLL_SETTLE_MS = 300;

/** A scroll offset in CSS px. */
export interface ScrollOffset {
	readonly left: number;
	readonly top: number;
}

/**
 * Holds the scroll lock's locked axis where it is while the user scrolls.
 *
 * `touch-action` holds a drag to one axis, but not a swipe that lands while the
 * page is still gliding from the last one: iOS hands that touch to its own
 * scroller, which moves both ways. Nor can the locked axis be made unscrollable,
 * because iOS then resets its offset to zero the moment the user scrolls. So a
 * scroll the user caused that moved the locked axis is put back, and any scroll
 * outside a gesture is the plugin's own (a zoom keeping its anchor, a jump to a
 * page) and becomes the position to hold.
 */
export class AxisGuard {
	private axis: ScrollAxis = 'both';
	private held: ScrollOffset = { left: 0, top: 0 };
	private touches = 0;
	private activeUntil = -Infinity;

	setAxis(axis: ScrollAxis, at: ScrollOffset): void {
		this.axis = axis;
		this.held = at;
	}

	/** The plugin moved the page itself: hold it there. */
	hold(at: ScrollOffset): void {
		this.held = at;
	}

	/** Fingers on the scroller, now `count` of them. */
	touched(count: number, now: number): void {
		this.touches = count;
		this.activeUntil = Math.max(this.activeUntil, now + USER_SCROLL_SETTLE_MS);
	}

	/** A wheel or trackpad scroll. */
	wheeled(now: number): void {
		this.activeUntil = Math.max(this.activeUntil, now + USER_SCROLL_SETTLE_MS);
	}

	/**
	 * The page scrolled to `at`. Returns the offset to put it back to when the
	 * user's scroll moved the locked axis, or null to leave it.
	 */
	scrolled(at: ScrollOffset, now: number): ScrollOffset | null {
		const byUser = this.touches > 0 || now <= this.activeUntil;
		if (this.axis === 'both' || !byUser) {
			this.held = at;
			return null;
		}
		this.activeUntil = now + USER_SCROLL_SETTLE_MS;
		const next =
			this.axis === 'vertical'
				? { left: this.held.left, top: at.top }
				: { left: at.left, top: this.held.top };
		this.held = next;
		return next.left === at.left && next.top === at.top ? null : next;
	}
}
