import type { Component } from 'obsidian';
import {
	type AxisSample,
	MIN_FLING_SPEED,
	STOP_SPEED,
	flingStep,
	releaseVelocity,
} from '../core/fling';
import type { ScrollAxis } from '../core/settings-schema';

/** What the locked scroller needs to know about zooming. */
export interface LockedScrollZoom {
	/** Two fingers pan only while the zoom is locked; otherwise they pinch. */
	readonly isLocked: boolean;
	readonly isGesturing: boolean;
}

/**
 * Scrolling done in script while the scroll lock is on.
 *
 * Native scrolling cannot be held to one axis on iOS: `touch-action` holds a
 * drag but not a swipe that lands mid-fling, and any correction afterwards is
 * visible as a jerk, because iOS scrolls on its own thread. So with a lock on the
 * scroller takes no touch scrolling at all (`touch-action: none`, see
 * styles.css), and this moves it along the allowed axis only, with a glide on
 * iOS's own curve. The locked axis is never moved, so there is nothing to undo.
 *
 * Touches the ink layer has claimed for drawing are left alone.
 */
export class LockedScroll {
	private axis: ScrollAxis = 'both';
	/** The finger position and scroll offset a drag is measured from. */
	private anchor: { readonly finger: number; readonly scroll: number } | null = null;
	private samples: AxisSample[] = [];
	private frame = 0;

	constructor(
		private readonly component: Component,
		private readonly scrollEl: HTMLElement,
		private readonly zoom: LockedScrollZoom,
	) {}

	setAxis(axis: ScrollAxis): void {
		// Settings are re-applied on every save; that must not cut a glide short.
		if (axis === this.axis) return;
		this.axis = axis;
		this.anchor = null;
		this.stopFling();
	}

	attach(): void {
		const el = this.scrollEl;
		this.component.registerDomEvent(el, 'touchstart', (evt) => {
			this.onTouches(evt, 'start');
		}, { passive: true });
		this.component.registerDomEvent(el, 'touchmove', (evt) => {
			this.onTouches(evt, 'move');
		}, { passive: true });
		for (const type of ['touchend', 'touchcancel'] as const) {
			this.component.registerDomEvent(el, type, (evt) => {
				this.onTouches(evt, 'end');
			}, { passive: true });
		}
		// passive: false, to take over a wheel or trackpad scroll that strays.
		this.component.registerDomEvent(el, 'wheel', (evt) => {
			this.onWheel(evt);
		}, { passive: false });
		this.component.register(() => {
			this.stopFling();
		});
	}

	private onTouches(evt: TouchEvent, phase: 'start' | 'move' | 'end'): void {
		if (this.axis === 'both') return;
		if (phase === 'start') this.stopFling();

		const fingers = Array.from(evt.touches).filter((touch) => touch.touchType !== 'stylus');
		const usable =
			!evt.defaultPrevented &&
			fingers.length === evt.touches.length &&
			fingers.length > 0 &&
			(fingers.length === 1 || this.zoom.isLocked) &&
			!this.zoom.isGesturing;

		if (!usable) {
			// The ink layer, a pinch or the pen has it. A lift with fingers still
			// down is not a release, so there is no glide either.
			const lifted = phase === 'end' && evt.touches.length === 0;
			if (lifted && this.anchor) this.release(evt.timeStamp);
			else this.anchor = null;
			return;
		}

		const finger = this.along(fingers);
		// A finger added or lifted moves the midpoint: measure from here instead.
		if (phase !== 'move' || !this.anchor) {
			this.anchor = { finger, scroll: this.offset() };
			this.samples = [{ time: evt.timeStamp, position: finger }];
			return;
		}
		this.setOffset(this.anchor.scroll + this.anchor.finger - finger);
		this.samples.push({ time: evt.timeStamp, position: finger });
		if (this.samples.length > 32) this.samples.shift();
	}

	private release(now: number): void {
		this.anchor = null;
		// The page moves against the finger: dragging up scrolls down.
		const velocity = -releaseVelocity(this.samples, now);
		this.samples = [];
		if (Math.abs(velocity) < MIN_FLING_SPEED) return;
		this.startFling(velocity, now);
	}

	private startFling(initial: number, start: number): void {
		const win = this.scrollEl.win;
		let velocity = initial;
		let last = start;
		const step = (now: number): void => {
			const dt = Math.max(0, now - last);
			last = now;
			const next = flingStep(velocity, dt);
			velocity = next.velocity;
			const before = this.offset();
			this.setOffset(before + next.distance);
			// Stopped by its own slowing, or by the end of the document.
			const stuck = next.distance !== 0 && this.offset() === before;
			if (Math.abs(velocity) < STOP_SPEED || stuck) {
				this.frame = 0;
				return;
			}
			this.frame = win.requestAnimationFrame(step);
		};
		this.frame = win.requestAnimationFrame(step);
	}

	private stopFling(): void {
		if (this.frame === 0) return;
		this.scrollEl.win.cancelAnimationFrame(this.frame);
		this.frame = 0;
	}

	/** Apply only the allowed part of a wheel or trackpad scroll. */
	private onWheel(evt: WheelEvent): void {
		// Ctrl and Cmd scrolls are zooms, handled in zoom-gestures.ts.
		if (this.axis === 'both' || evt.ctrlKey || evt.metaKey) return;
		const stray = this.axis === 'vertical' ? evt.deltaX : evt.deltaY;
		if (stray === 0) return;
		evt.preventDefault();
		const unit = evt.deltaMode === 1 ? 16 : evt.deltaMode === 2 ? this.scrollEl.clientHeight : 1;
		const kept = this.axis === 'vertical' ? evt.deltaY : evt.deltaX;
		this.setOffset(this.offset() + kept * unit);
	}

	/** The fingers' midpoint along the allowed axis, in client px. */
	private along(fingers: readonly Touch[]): number {
		let sum = 0;
		for (const touch of fingers) sum += this.axis === 'vertical' ? touch.clientY : touch.clientX;
		return sum / fingers.length;
	}

	private offset(): number {
		return this.axis === 'vertical' ? this.scrollEl.scrollTop : this.scrollEl.scrollLeft;
	}

	private setOffset(value: number): void {
		if (this.axis === 'vertical') this.scrollEl.scrollTop = value;
		else this.scrollEl.scrollLeft = value;
	}
}
