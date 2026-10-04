import type { Component } from 'obsidian';
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
			if (!evt.ctrlKey && !evt.metaKey) return;
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

	component.registerDomEvent(
		scrollEl,
		'touchstart',
		(evt) => {
			// Locked, two fingers are left to the browser, which pans with them.
			if (evt.touches.length !== 2 || zoom.isLocked) {
				pinch = null;
				return;
			}
			const distance = touchDistance(evt);
			const midpoint = touchMidpoint(evt);
			if (distance === null || midpoint === null) return;
			evt.preventDefault();
			pinch = {
				startDistance: distance,
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
			if (!pinch || evt.touches.length !== 2) return;
			const distance = touchDistance(evt);
			const midpoint = touchMidpoint(evt);
			if (distance === null || midpoint === null || pinch.startDistance === 0) return;
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

	const endPinch = (evt: TouchEvent): void => {
		if (!pinch || evt.touches.length >= 2) return;
		pinch = null;
		zoom.commit();
	};
	component.registerDomEvent(scrollEl, 'touchend', endPinch);
	component.registerDomEvent(scrollEl, 'touchcancel', endPinch);

	zoom.registerCleanup();
}

/**
 * TouchList is read through `item()`, which returns `Touch | null`. The
 * subscript form is widened to `Touch | undefined` by noUncheckedIndexedAccess
 * anyway, and `item()` states the contract honestly.
 */
function touchPair(evt: TouchEvent): [Touch, Touch] | null {
	const a = evt.touches.item(0);
	const b = evt.touches.item(1);
	if (!a || !b) return null;
	return [a, b];
}

function touchDistance(evt: TouchEvent): number | null {
	const pair = touchPair(evt);
	if (!pair) return null;
	const [a, b] = pair;
	return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function touchMidpoint(evt: TouchEvent): { x: number; y: number } | null {
	const pair = touchPair(evt);
	if (!pair) return null;
	const [a, b] = pair;
	return {
		x: (a.clientX + b.clientX) / 2,
		y: (a.clientY + b.clientY) / 2,
	};
}
