import type { Component } from 'obsidian';
import { FIT_WIDTH_GUTTER, SETTLE_DELAY_MS } from '../constants';
import {
	anchoredScroll,
	clampZoom,
	fitPageZoom,
	fitWidthZoom,
	nextZoom,
	prevZoom,
} from '../core/layout';
import type { ZoomMode } from '../types/view';

/** What the controller needs from the view. */
export interface ZoomHost {
	readonly scrollEl: HTMLElement;
	readonly sizerEl: HTMLElement;
	readonly pagesEl: HTMLElement;
	/** Widest page at scale 1, for fit-width. */
	maxBaseWidth(): number;
	/** Tallest page at scale 1, for fit-page. */
	maxBaseHeight(): number;
	/** Current committed content box, in CSS px. */
	contentSize(): { width: number; height: number };
	/** Relayout every page at this zoom. */
	applyZoom(zoom: number): void;
	/** Report the zoom for the toolbar readout. */
	onZoomChanged(zoom: number, mode: ZoomMode): void;
}

/**
 * The anchor point of a zoom, captured once at gesture start.
 *
 * Every frame is then computed absolutely from this snapshot. Accumulating a
 * per-frame ratio instead drifts visibly over a long pinch.
 */
interface Anchor {
	/** Position inside the scroll viewport. */
	readonly viewportX: number;
	readonly viewportY: number;
	/** The same point inside the unscaled content. */
	readonly contentX: number;
	readonly contentY: number;
	readonly contentWidth: number;
	readonly contentHeight: number;
	readonly startZoom: number;
}

interface Pinch {
	readonly startDistance: number;
	readonly startZoom: number;
}

export class ZoomController {
	private mode: ZoomMode = { kind: 'fit-width' };
	private zoom = 1;

	private anchor: Anchor | null = null;
	private pending: number | null = null;
	private frame = 0;
	private settleTimer = 0;
	private pinch: Pinch | null = null;
	private locked = false;

	constructor(
		private readonly component: Component,
		private readonly host: ZoomHost,
	) {}

	/** Whether the user has locked the zoom. Resizing still re-fits a fit mode. */
	get isLocked(): boolean {
		return this.locked;
	}

	setLocked(locked: boolean): void {
		this.locked = locked;
		// A gesture in flight when the lock lands is settled where it is.
		if (locked && this.anchor) this.commit();
	}

	getZoom(): number {
		return this.zoom;
	}

	getMode(): ZoomMode {
		return this.mode;
	}

	/** Zoom a gesture is currently heading towards, or the committed one. */
	getGestureZoom(): number {
		return this.pending ?? this.zoom;
	}

	/** Release the rAF handle and settle timer on view unload. */
	registerCleanup(): void {
		this.component.register(() => {
			this.cancelFrame();
			this.cancelSettle();
		});
	}

	zoomIn(): void {
		if (this.locked) return;
		this.setZoom(nextZoom(this.zoom), { kind: 'fixed', zoom: 0 });
	}

	zoomOut(): void {
		if (this.locked) return;
		this.setZoom(prevZoom(this.zoom), { kind: 'fixed', zoom: 0 });
	}

	fitWidth(): void {
		if (this.locked) return;
		this.setZoom(this.computeFitWidth(), { kind: 'fit-width' });
	}

	fitPage(): void {
		if (this.locked) return;
		this.setZoom(this.computeFitPage(), { kind: 'fit-page' });
	}

	/** Re-fit after a pane or window resize, but only while in a fit mode. */
	recomputeFit(): void {
		if (this.mode.kind === 'fixed') return;
		this.setZoom(this.computeFit(this.mode), this.mode);
	}

	/**
	 * Take on a zoom the caller has already laid out at — used on open and on
	 * workspace restore. Deliberately does not relayout, so a freshly built page
	 * list is not rasterised twice.
	 */
	adopt(zoom: number, mode: ZoomMode): void {
		this.mode = mode;
		this.zoom = clampZoom(zoom);
		this.host.onZoomChanged(this.zoom, this.mode);
	}

	/** Zoom the current fit-width mode resolves to, for the initial layout. */
	resolveInitialZoom(mode: ZoomMode): number {
		return mode.kind === 'fixed' ? clampZoom(mode.zoom) : this.computeFit(mode);
	}

	private computeFit(mode: ZoomMode): number {
		return mode.kind === 'fit-page'
			? this.computeFitPage()
			: this.computeFitWidth();
	}

	private computeFitWidth(): number {
		return fitWidthZoom(
			this.host.scrollEl.clientWidth,
			FIT_WIDTH_GUTTER,
			this.host.maxBaseWidth(),
		);
	}

	private computeFitPage(): number {
		return fitPageZoom(
			this.host.scrollEl.clientWidth,
			this.host.scrollEl.clientHeight,
			FIT_WIDTH_GUTTER,
			this.host.maxBaseWidth(),
			this.host.maxBaseHeight(),
		);
	}

	/** Commit a zoom straight away, anchored on the viewport centre. */
	private setZoom(zoom: number, mode: ZoomMode): void {
		const anchor = this.captureAnchor();
		const next = clampZoom(zoom);
		this.mode = mode.kind === 'fixed' ? { kind: 'fixed', zoom: next } : mode;
		this.zoom = next;
		this.host.applyZoom(next);
		this.restoreAnchor(anchor, next / anchor.startZoom);
		this.host.onZoomChanged(next, this.mode);
	}

	private captureAnchor(clientX?: number, clientY?: number): Anchor {
		const { scrollEl, sizerEl } = this.host;
		const rect = scrollEl.getBoundingClientRect();
		const viewportX =
			clientX === undefined
				? scrollEl.clientWidth / 2
				: clientX - rect.left;
		const viewportY =
			clientY === undefined
				? scrollEl.clientHeight / 2
				: clientY - rect.top;
		// The sizer is centred with auto margins, so the content origin drifts
		// horizontally as the content crosses the viewport width. Ignoring that
		// makes the anchor slide sideways exactly when you zoom through fit-width.
		const marginLeft = sizerEl.offsetLeft;
		const size = this.host.contentSize();
		return {
			viewportX,
			viewportY,
			contentX: scrollEl.scrollLeft + viewportX - marginLeft,
			contentY: scrollEl.scrollTop + viewportY,
			contentWidth: size.width,
			contentHeight: size.height,
			startZoom: this.zoom,
		};
	}

	private restoreAnchor(anchor: Anchor, factor: number): void {
		const { scrollEl } = this.host;
		const size = this.host.contentSize();
		const margin = Math.max(0, (scrollEl.clientWidth - size.width) / 2);
		scrollEl.scrollLeft = anchoredScroll(
			anchor.contentX,
			anchor.viewportX,
			factor,
			margin,
			size.width + 2 * margin - scrollEl.clientWidth,
		);
		scrollEl.scrollTop = anchoredScroll(
			anchor.contentY,
			anchor.viewportY,
			factor,
			0,
			size.height - scrollEl.clientHeight,
		);
	}

	beginGesture(clientX: number, clientY: number): void {
		if (this.anchor || this.locked) return;
		this.anchor = this.captureAnchor(clientX, clientY);
		this.host.pagesEl.addClass('is-zooming');
	}

	/**
	 * Show a CSS-transform preview of `zoom`.
	 *
	 * Re-rasterising every frame would mean 2N style writes plus a forced layout
	 * per frame, and a transform keeps scrollHeight exactly proportional, which is
	 * what makes the anchor formula exact rather than approximate.
	 */
	preview(zoom: number): void {
		if (this.locked) return;
		this.pending = clampZoom(zoom);
		if (this.frame !== 0) return;
		this.frame = this.host.scrollEl.win.requestAnimationFrame(() => {
			this.frame = 0;
			this.paintPreview();
		});
	}

	private paintPreview(): void {
		const anchor = this.anchor;
		const zoom = this.pending;
		if (!anchor || zoom === null) return;

		const factor = zoom / anchor.startZoom;
		const width = anchor.contentWidth * factor;
		const height = anchor.contentHeight * factor;
		const { scrollEl, sizerEl, pagesEl } = this.host;

		// Sizes first, then scroll offsets, all in one task before paint —
		// splitting them across frames produces a visible one-frame jump.
		sizerEl.setCssProps({
			'--pdf-ink-sizer-w': `${String(width)}px`,
			'--pdf-ink-sizer-h': `${String(height)}px`,
		});
		pagesEl.setCssProps({ '--pdf-ink-zoom-preview': String(factor) });

		const margin = Math.max(0, (scrollEl.clientWidth - width) / 2);
		scrollEl.scrollLeft = anchoredScroll(
			anchor.contentX,
			anchor.viewportX,
			factor,
			margin,
			width + 2 * margin - scrollEl.clientWidth,
		);
		scrollEl.scrollTop = anchoredScroll(
			anchor.contentY,
			anchor.viewportY,
			factor,
			0,
			height - scrollEl.clientHeight,
		);

		this.host.onZoomChanged(zoom, { kind: 'fixed', zoom });
	}

	/** Swap the preview transform for a real relayout at the same geometry. */
	commit(): void {
		this.cancelSettle();
		this.cancelFrame();

		const anchor = this.anchor;
		const zoom = this.pending;
		this.anchor = null;
		this.pending = null;

		const { pagesEl } = this.host;
		pagesEl.removeClass('is-zooming');
		pagesEl.setCssProps({ '--pdf-ink-zoom-preview': '1' });

		if (!anchor || zoom === null) return;

		this.mode = { kind: 'fixed', zoom };
		this.zoom = zoom;
		this.host.applyZoom(zoom);
		this.restoreAnchor(anchor, zoom / anchor.startZoom);
		this.host.onZoomChanged(zoom, this.mode);
	}

	scheduleSettle(): void {
		this.cancelSettle();
		this.settleTimer = this.host.scrollEl.win.setTimeout(() => {
			this.settleTimer = 0;
			this.commit();
		}, SETTLE_DELAY_MS);
	}

	private cancelSettle(): void {
		if (this.settleTimer !== 0) {
			this.host.scrollEl.win.clearTimeout(this.settleTimer);
			this.settleTimer = 0;
		}
	}

	private cancelFrame(): void {
		if (this.frame !== 0) {
			this.host.scrollEl.win.cancelAnimationFrame(this.frame);
			this.frame = 0;
		}
	}

}
