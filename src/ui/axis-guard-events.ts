import type { Component } from 'obsidian';
import type { AxisGuard } from '../core/axis-guard';

/**
 * Feed the scroller's touches, wheel and scrolls to an {@link AxisGuard}, and
 * apply what it puts back. All passive: the guard never blocks a scroll, it only
 * undoes the locked axis's share of one.
 */
export function attachAxisGuard(
	component: Component,
	scrollEl: HTMLElement,
	guard: AxisGuard,
): void {
	const touched = (evt: TouchEvent): void => {
		guard.touched(evt.touches.length, evt.timeStamp);
	};
	for (const type of ['touchstart', 'touchend', 'touchcancel'] as const) {
		component.registerDomEvent(scrollEl, type, touched, { passive: true });
	}
	component.registerDomEvent(
		scrollEl,
		'wheel',
		(evt) => {
			guard.wheeled(evt.timeStamp);
		},
		{ passive: true },
	);
	component.registerDomEvent(
		scrollEl,
		'scroll',
		(evt) => {
			const back = guard.scrolled(
				{ left: scrollEl.scrollLeft, top: scrollEl.scrollTop },
				evt.timeStamp,
			);
			if (!back) return;
			if (back.left !== scrollEl.scrollLeft) scrollEl.scrollLeft = back.left;
			if (back.top !== scrollEl.scrollTop) scrollEl.scrollTop = back.top;
		},
		{ passive: true },
	);
}
