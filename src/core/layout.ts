/**
 * Pure layout, zoom and anchor math. No DOM, no Obsidian, no pdf.js — every
 * function here is deterministic and unit-testable.
 */

import {
	MAX_ZOOM,
	MIN_ZOOM,
	PDF_TO_CSS_UNITS,
	ZOOM_LADDER,
} from '../constants';
import type { LayoutResult, PageBox } from '../types/view';

/** The only thing layout needs to know about a page. */
export interface PageBase {
	readonly baseWidth: number;
	readonly baseHeight: number;
}

export function clampZoom(zoom: number): number {
	if (!Number.isFinite(zoom)) return 1;
	return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** The next ladder stop strictly above `zoom`. */
export function nextZoom(zoom: number): number {
	for (const stop of ZOOM_LADDER) {
		if (stop > zoom + 1e-6) return stop;
	}
	return MAX_ZOOM;
}

/** The next ladder stop strictly below `zoom`. */
export function prevZoom(zoom: number): number {
	for (let i = ZOOM_LADDER.length - 1; i >= 0; i--) {
		const stop = ZOOM_LADDER[i];
		if (stop !== undefined && stop < zoom - 1e-6) return stop;
	}
	return MIN_ZOOM;
}

/**
 * Zoom at which the widest page fills the available width.
 *
 * A single uniform zoom fitted to the widest page, deliberately not a per-page
 * fit: per-page would look tidier but would make one nominal pen width map to a
 * different PDF-space width on every page, baking that inconsistency into
 * stored strokes.
 */
export function fitWidthZoom(
	clientWidth: number,
	gutter: number,
	maxBaseWidth: number,
): number {
	if (maxBaseWidth <= 0) return 1;
	const available = clientWidth - 2 * gutter;
	return clampZoom(available / maxBaseWidth / PDF_TO_CSS_UNITS);
}

export function maxBaseWidth(pages: readonly PageBase[]): number {
	let max = 0;
	for (const page of pages) {
		if (page.baseWidth > max) max = page.baseWidth;
	}
	return max;
}

/**
 * Snap a page's box to whole CSS pixels, then re-derive the scale from the
 * snapped box.
 *
 * Order matters. A fractional CSS box over an integer bitmap resamples and
 * looks soft, so the box is rounded first and the scale follows it. Per-page
 * snapped scales then differ by up to ~1e-4 across mixed page sizes, which is
 * imperceptible and much cheaper than the blur the alternative produces.
 */
export function pageBoxAt(page: PageBase, scale: number): PageBox {
	const cssWidth = Math.max(1, Math.round(page.baseWidth * scale));
	const cssHeight = Math.max(1, Math.round(page.baseHeight * scale));
	return {
		scale: cssWidth / page.baseWidth,
		cssWidth,
		cssHeight,
		offsetTop: 0,
	};
}

/**
 * Resolve every page's box and cumulative offset for a given zoom.
 *
 * Offsets are cumulative rather than `pageHeight * i` because page heights vary
 * within a single document (`mixed_page_sizes.pdf` runs 595 to 1008 pt).
 */
export function computeLayout(
	pages: readonly PageBase[],
	zoom: number,
	gap: number,
): LayoutResult {
	const scale = zoom * PDF_TO_CSS_UNITS;
	const boxes: PageBox[] = [];
	let offsetTop = 0;
	let contentWidth = 0;

	for (const page of pages) {
		const box = pageBoxAt(page, scale);
		boxes.push({ ...box, offsetTop });
		if (box.cssWidth > contentWidth) contentWidth = box.cssWidth;
		offsetTop += box.cssHeight + gap;
	}

	// The trailing gap is not part of the content box.
	const contentHeight = boxes.length > 0 ? offsetTop - gap : 0;

	return { zoom, contentWidth, contentHeight, pages: boxes };
}

export interface VisibleRange {
	readonly first: number;
	readonly last: number;
}

/**
 * Pages overlapping the viewport, by index. `first > last` means none.
 *
 * IntersectionObserver is the event source for visibility, but it cannot answer
 * at mount (no callback has fired) or immediately after a programmatic scroll
 * (delivery is deferred a frame). This is the synchronous authority used at
 * those points, which is what keeps zooming from flashing blank.
 */
export function visibleIndices(
	layout: LayoutResult,
	scrollTop: number,
	clientHeight: number,
): VisibleRange {
	const boxes = layout.pages;
	const viewTop = scrollTop;
	const viewBottom = scrollTop + clientHeight;

	// Binary search for the first page whose bottom edge is past the viewport top.
	let lo = 0;
	let hi = boxes.length - 1;
	let first = boxes.length;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const box = boxes[mid];
		if (box === undefined) break;
		if (box.offsetTop + box.cssHeight > viewTop) {
			first = mid;
			hi = mid - 1;
		} else {
			lo = mid + 1;
		}
	}

	let last = first - 1;
	for (let i = first; i < boxes.length; i++) {
		const box = boxes[i];
		if (box === undefined || box.offsetTop >= viewBottom) break;
		last = i;
	}

	return { first, last };
}

/**
 * Scroll offset that keeps a content point pinned under the same screen point
 * across a scale change.
 *
 * `contentOffset` is the anchor's position within the unscaled content, and
 * `viewportOffset` is where it currently sits inside the scroll viewport.
 * Computed absolutely from a gesture-start snapshot rather than accumulated per
 * frame, which would drift visibly over a long pinch.
 */
export function anchoredScroll(
	contentOffset: number,
	viewportOffset: number,
	factor: number,
	margin: number,
	maxScroll: number,
): number {
	const target = contentOffset * factor + margin - viewportOffset;
	return Math.min(Math.max(0, target), Math.max(0, maxScroll));
}
