import type { Component } from 'obsidian';
import type { ScrollAxis } from '../core/settings-schema';
import type { ZoomController } from './zoom-controller';

interface Pinch {
	readonly startDistance: number;
	readonly startZoom: number;
	/** The midpoint the gesture began at, in client px. */
	readonly startX: number;
	readonly startY: number;
}

/**
 * Wire ctrl+wheel and two-finger pinch to a {@link ZoomController}.
 *
 * Touch events rather than `gesturestart`/`gesturechange`: those are WebKit-only,
 * so they would work on Obsidian for iOS and silently fail on Android and on
 * desktop touchscreens. Pointer events are reserved for the ink layer, where
 * `pressure` and `pointerType` matter.
 */
export function attachZoomGestures(
	component: Component,
	scrollEl: HTMLElement,
	zoom: ZoomController,
): void {
	let pinch: Pinch | null = null;

	// passive: false so preventDefault actually suppresses the webview's own
	// pinch-zoom and Obsidian's ctrl+wheel interface zoom.
	component.registerDomEvent(
		scrollEl,
		'wheel',
		(evt) => {
			// ctrlKey is what a trackpad pinch emits on desktop; metaKey covers
			// the habitual cmd+wheel. Anything else is an ordinary scroll.
			if (!evt.ctrlKey && !evt.metaKey) {
				lockWheel(evt, scrollEl, zoom.scrollAxis);
				return;
			}
			// Still swallowed when locked, or Obsidian would zoom its whole interface.
			evt.preventDefault();
			if (zoom.isLocked) return;

			zoom.beginGesture(evt.clientX, evt.clientY);
			const unit =
				evt.deltaMode === 1
					? 16
					: evt.deltaMode === 2
						? scrollEl.clientHeight
						: 1;
			// Multiplicative: additive steps on a percentage feel wrong in one
			// direction or the other.
			zoom.preview(
				zoom.getGestureZoom() * Math.exp((-evt.deltaY * unit) / 400),
			);
			// `wheel` has no end event, so a timer is the only way to know it
			// has stopped.
			zoom.scheduleSettle();
		},
		{ passive: false },
	);

	/*
	 * A pinch that ends without a commit leaves `is-zooming` on the pages, which
	 * takes the ink canvas out of hit testing: the pen then draws nothing until
	 * something else settles the zoom. Every way out of a pinch goes through here.
	 */
	const endPinch = (): void => {
		pinch = null;
		if (zoom.isGesturing) zoom.commit();
	};

	component.registerDomEvent(
		scrollEl,
		'touchstart',
		(evt) => {
			/*
			 * Fingers only, and never while the pen is down. The Pencil is a touch
			 * too, so a pen and a resting palm used to count as a pinch mid-stroke;
			 * and a palm adding a third contact to a pinch dropped it without the
			 * commit, freezing the page until the app was backgrounded.
			 */
			const fingers = fingerTouches(evt);
			if (fingers.length !== 2 || hasStylus(evt) || zoom.isLocked) {
				// Locked, two fingers are left to the browser, which pans with them.
				if (pinch) endPinch();
				return;
			}
			const [a, b] = fingers;
			if (!a || !b) return;
			evt.preventDefault();
			const midpoint = touchMidpoint(a, b);
			pinch = {
				startDistance: touchDistance(a, b),
				startZoom: zoom.getZoom(),
				startX: midpoint.x,
				startY: midpoint.y,
			};
			// Anchor on the INITIAL midpoint: a live midpoint drifts and feeds
			// back into the zoom, which oscillates.
			zoom.beginGesture(midpoint.x, midpoint.y);
		},
		{ passive: false },
	);

	component.registerDomEvent(
		scrollEl,
		'touchmove',
		(evt) => {
			if (!pinch) return;
			const [a, b] = fingerTouches(evt);
			if (!a || !b || pinch.startDistance === 0) return;
			const distance = touchDistance(a, b);
			const midpoint = touchMidpoint(a, b);
			// Only two-finger moves are swallowed, so one-finger panning still
			// scrolls natively. Two fingers both zoom and pan: the page follows
			// their midpoint, which is how a wide board is moved around by touch.
			evt.preventDefault();
			zoom.preview((pinch.startZoom * distance) / pinch.startDistance, {
				x: midpoint.x - pinch.startX,
				y: midpoint.y - pinch.startY,
			});
		},
		{ passive: false },
	);

	const liftFinger = (evt: TouchEvent): void => {
		if (!pinch || fingerTouches(evt).length >= 2) return;
		endPinch();
	};
	component.registerDomEvent(scrollEl, 'touchend', liftFinger);
	component.registerDomEvent(scrollEl, 'touchcancel', liftFinger);

	/*
	 * Backstops for a lift iOS never reported, which otherwise leaves a phantom
	 * finger holding the pinch open: the pen landing, and the app losing focus.
	 * Captured, so it runs before the ink layer looks at the pen.
	 */
	component.registerDomEvent(
		scrollEl,
		'pointerdown',
		(evt) => {
			if (evt.pointerType === 'pen' && (pinch || zoom.isGesturing)) endPinch();
		},
		{ capture: true },
	);
	component.registerDomEvent(scrollEl.doc, 'visibilitychange', () => {
		if (scrollEl.doc.visibilityState === 'hidden') endPinch();
	});
	component.registerDomEvent(scrollEl.win, 'blur', endPinch);

	zoom.registerCleanup();
}

/**
 * Hold a wheel or trackpad scroll to the unlocked axis. touch-action only reaches
 * touches, so a trackpad's diagonal drift is dropped here instead: the scroll is
 * taken over, and only its allowed part is applied.
 */
function lockWheel(evt: WheelEvent, scrollEl: HTMLElement, axis: ScrollAxis): void {
	if (axis === 'both') return;
	const stray = axis === 'vertical' ? evt.deltaX : evt.deltaY;
	if (stray === 0) return;
	evt.preventDefault();
	const unit = evt.deltaMode === 1 ? 16 : evt.deltaMode === 2 ? scrollEl.clientHeight : 1;
	if (axis === 'vertical') scrollEl.scrollTop += evt.deltaY * unit;
	else scrollEl.scrollLeft += evt.deltaX * unit;
}

/** The fingers on the glass: every touch except a stylus. */
function fingerTouches(evt: TouchEvent): Touch[] {
	return Array.from(evt.touches).filter((touch) => touch.touchType !== 'stylus');
}

function hasStylus(evt: TouchEvent): boolean {
	return Array.from(evt.touches).some((touch) => touch.touchType === 'stylus');
}

function touchDistance(a: Touch, b: Touch): number {
	return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function touchMidpoint(a: Touch, b: Touch): { x: number; y: number } {
	return {
		x: (a.clientX + b.clientX) / 2,
		y: (a.clientY + b.clientY) / 2,
	};
}
