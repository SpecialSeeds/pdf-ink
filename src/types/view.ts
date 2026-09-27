import type { InsertedPage, PageKey } from '../core/pages';
import type { PDFPageProxy, PageViewport, RenderTask } from './pdfjs';

/**
 * Where a displayed page comes from: the source document, or an inserted record.
 *
 * Only the `pdf` case has a `PDFPageProxy` to rasterise. An inserted page is drawn
 * from its template instead, which is why this is a union rather than an optional
 * field — there is no code path that should reach for a pdf.js page without first
 * establishing that there is one.
 */
export type PageSource =
	| {
			readonly kind: 'pdf';
			/** 0-based index within the source document. */
			readonly pdfIndex: number;
			readonly page: PDFPageProxy;
		}
	| { readonly kind: 'inserted'; readonly page: InsertedPage };

/**
 * A page's intrinsic metadata: what it is and how big, never where it sits.
 *
 * Display position is deliberately absent. It changes whenever a page is inserted
 * or deleted, and a copy of it here would be one more thing to keep in step; the
 * position a page currently occupies lives on {@link PageRecord} instead.
 */
export interface PageGeometry {
	/**
	 * Stable identity, and the key items are filed under. Unlike a position, this
	 * survives an insertion — which is the whole reason the schema stores it.
	 */
	readonly key: PageKey;
	readonly source: PageSource;
	/** scale 1, rotation = page.rotate. Cloned for every other scale. */
	readonly baseViewport: PageViewport;
	/** Cached from baseViewport so layout math stays allocation-free. */
	readonly baseWidth: number;
	readonly baseHeight: number;
	/** page.rotate, for diagnostics only — never used in math. */
	readonly rotation: number;
}

export type PageRenderState = 'blank' | 'rendering' | 'ready';

/**
 * One page's live DOM and render state.
 *
 * `viewport` is non-null from construction and always reflects the current
 * layout scale in CSS pixels. The drawing pass stores stroke points through
 * `viewport.convertToPdfPoint`, so it must never observe a stale viewport or
 * one with devicePixelRatio folded in.
 */
export interface PageRecord {
	/**
	 * Replaced rather than mutated when the page changes — an inserted page's
	 * template edit arrives as a new record, and the renderer compares against it.
	 */
	geom: PageGeometry;
	/** Display position, 0-based. Reassigned when the page list changes. */
	index: number;
	readonly wrapperEl: HTMLElement;
	readonly renderCanvasEl: HTMLCanvasElement;
	/**
	 * Highlighter strokes only. A layer of its own because it is composited with
	 * `mix-blend-mode: multiply` so text shows through, which must not apply to
	 * opaque pen ink on the same page.
	 */
	readonly highlightCanvasEl: HTMLCanvasElement;
	readonly inkCanvasEl: HTMLCanvasElement;

	/** baseViewport.clone({ scale }). CSS px — never devicePixelRatio-scaled. */
	viewport: PageViewport;
	cssWidth: number;
	cssHeight: number;

	/** Scale and dpr actually baked into the bitmaps. 0 means "no bitmap". */
	bitmapScale: number;
	bitmapDpr: number;

	state: PageRenderState;
	/** Monotonic. A render result is discarded unless this still matches. */
	epoch: number;
	task: RenderTask | null;
	/**
	 * Single-flight chain: non-null while this record has async work pending,
	 * and resolves (never rejects) once quiescent. pdf.js throws "Cannot use
	 * the same canvas during multiple render() operations" unless the previous
	 * task has fully settled, so every mutation awaits this first.
	 */
	settled: Promise<void> | null;
	/** Deferred page.cleanup() after eviction; cancelled if the page returns. */
	cleanupTimer: number | null;
}

export type ZoomMode =
	| { readonly kind: 'fit-width' }
	| { readonly kind: 'fixed'; readonly zoom: number };

/** One page's resolved box. All CSS px. */
export interface PageBox {
	/** Snapped so the box is an integer number of CSS px. */
	readonly scale: number;
	readonly cssWidth: number;
	readonly cssHeight: number;
	/** Cumulative offset of the wrapper's top within the pages container. */
	readonly offsetTop: number;
}

/** Pure result of computeLayout(). */
export interface LayoutResult {
	readonly zoom: number;
	readonly contentWidth: number;
	readonly contentHeight: number;
	/** Parallel to the page array. */
	readonly pages: readonly PageBox[];
}
