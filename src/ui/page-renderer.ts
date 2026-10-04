import { PAGE_CLEANUP_DELAY_MS } from '../constants';
import { type CanvasBudget, effectiveDpr } from '../core/canvas-budget';
import type { CssRect } from '../core/detail-region';
import type { PageTheme } from '../core/theme';
import { isRenderCancelled } from '../types/pdfjs';
import type { PageBox, PageRecord } from '../types/view';
import { DetailRenderer } from './detail-renderer';
import { adoptRaster, rasterise, releaseCanvas } from './rasterise';

/**
 * Renders and tears down a single page's canvases.
 *
 * Every mutation of a record goes through its `settled` chain, so a record only
 * ever has one operation in flight. That is not defensive style — pdf.js keeps a
 * WeakSet of canvases with live render tasks and throws "Cannot use the same
 * canvas during multiple render() operations" if you render into one again, or
 * zero its width, before the previous task has *settled*. `cancel()` is
 * synchronous; settling is not. Awaiting it is mandatory.
 *
 * Renders land in a scratch canvas and are copied onto the page only once
 * complete, so after a zoom the previous bitmap stays on screen, stretched to the
 * new box, until its replacement is ready.
 */
export class PageRenderer {
	private readonly details: DetailRenderer;

	constructor(
		private readonly budget: CanvasBudget,
		/** Bumped by the view on close and on file switch. */
		private readonly currentViewEpoch: () => number,
		/**
		 * Called once a page's ink canvas has been resized — which clears it — so
		 * already-committed strokes can be repainted.
		 */
		private readonly onInkCanvasReset: (rec: PageRecord) => void,
		/** The colours an inserted page is painted in, under the view's theme. */
		private readonly insertedTheme: () => PageTheme,
	) {
		this.details = new DetailRenderer(
			budget,
			currentViewEpoch,
			onInkCanvasReset,
			insertedTheme,
		);
	}

	/**
	 * Forget that a page's bitmap is current, so the next {@link ensure} paints it
	 * again — after its template or the theme changed. The old bitmap stays on
	 * screen until the new one replaces it.
	 */
	invalidate(rec: PageRecord): void {
		this.details.drop(rec);
		rec.bitmapScale = 0;
		rec.bitmapDpr = 0;
		rec.renderedDensity = 0;
	}

	/**
	 * Bring a page's sharp drawing of its visible part up to date, or drop it.
	 * `visible` is in page CSS px at `box.scale`, null when out of view.
	 */
	updateDetail(
		rec: PageRecord,
		box: PageBox,
		dpr: number,
		visible: CssRect | null,
	): void {
		this.details.update(rec, box, dpr, visible);
	}

	/** Idempotent: a no-op when the bitmaps already match `box` and `dpr`. */
	ensure(rec: PageRecord, box: PageBox, dpr: number): void {
		this.cancelCleanup(rec);

		const effDpr = effectiveDpr(box.cssWidth, box.cssHeight, dpr, this.budget);
		if (
			rec.state === 'ready' &&
			rec.bitmapScale === box.scale &&
			rec.bitmapDpr === effDpr
		) {
			return;
		}

		// Cancel synchronously so a superseded render stops producing pixels
		// now; the chain below still waits for it to settle before touching the
		// canvas.
		rec.task?.cancel();

		const viewEpoch = this.currentViewEpoch();
		rec.settled = (rec.settled ?? Promise.resolve())
			.then(() => this.runRender(rec, box, effDpr, viewEpoch))
			.catch(() => undefined);
	}

	/** Free a page's bitmaps, keeping its wrapper and its viewport. */
	teardown(rec: PageRecord): void {
		this.details.drop(rec);
		if (rec.state === 'blank' && rec.task === null && rec.bitmapScale === 0) {
			return;
		}
		rec.task?.cancel();
		rec.settled = (rec.settled ?? Promise.resolve())
			.then(() => this.runTeardown(rec))
			.catch(() => undefined);
	}

	/** Resolves once the record has no work in flight. Never rejects. */
	async quiesce(rec: PageRecord): Promise<void> {
		this.cancelCleanup(rec);
		await Promise.all([rec.settled, rec.detailSettled]);
	}

	private cancelCleanup(rec: PageRecord): void {
		if (rec.cleanupTimer !== null) {
			rec.wrapperEl.win.clearTimeout(rec.cleanupTimer);
			rec.cleanupTimer = null;
		}
	}

	private async runRender(
		rec: PageRecord,
		box: PageBox,
		effDpr: number,
		viewEpoch: number,
	): Promise<void> {
		if (viewEpoch !== this.currentViewEpoch()) return;
		if (!rec.wrapperEl.isConnected) return;
		if (
			rec.state === 'ready' &&
			rec.bitmapScale === box.scale &&
			rec.bitmapDpr === effDpr
		) {
			return;
		}

		// Invalidate every earlier attempt on this record.
		const epoch = ++rec.epoch;

		const bitmapWidth = Math.round(box.cssWidth * effDpr);
		const bitmapHeight = Math.round(box.cssHeight * effDpr);
		for (const canvasEl of [rec.highlightCanvasEl, rec.inkCanvasEl]) {
			// Resizing clears these, and they are repainted synchronously below, so
			// unlike the page bitmap they can move to the new size straight away.
			canvasEl.width = bitmapWidth;
			canvasEl.height = bitmapHeight;
		}

		// Published before the first await: the ink layer must never observe a
		// viewport that disagrees with the canvas underneath it, not even while
		// a render is still in flight.
		rec.viewport = rec.geom.baseViewport.clone({ scale: box.scale });
		rec.cssWidth = box.cssWidth;
		rec.cssHeight = box.cssHeight;
		rec.bitmapScale = box.scale;
		rec.bitmapDpr = effDpr;
		// The detail keeps showing its last bitmap, scaled into the new box, until
		// the view settles and a sharper one replaces it.
		this.details.reposition(rec);

		// After the viewport and box above are published, so the repaint projects
		// stored PDF-space strokes through the new scale.
		this.onInkCanvasReset(rec);

		// A page held down by the canvas budget gets the same bitmap at every zoom:
		// its dpr shrinks exactly as its box grows. Rendering it again would spend
		// a full content-stream replay to reproduce the pixels already there.
		const density = box.scale * effDpr;
		if (
			rec.renderedDensity > 0 &&
			Math.abs(rec.renderedDensity - density) <= density * 1e-3 &&
			rec.renderCanvasEl.width === bitmapWidth &&
			rec.renderCanvasEl.height === bitmapHeight
		) {
			this.markReady(rec);
			return;
		}

		const raster = rasterise(
			rec.wrapperEl.doc,
			rec.geom.source,
			rec.viewport,
			bitmapWidth,
			bitmapHeight,
			[effDpr, 0, 0, effDpr, 0, 0],
			this.insertedTheme(),
		);
		if (!raster) {
			this.markEmpty(rec);
			return;
		}

		rec.state = 'rendering';
		rec.task = raster.task;

		try {
			await raster.task.promise;
		} catch (err) {
			releaseCanvas(raster.canvas);
			if (rec.epoch === epoch) rec.task = null;
			if (isRenderCancelled(err)) {
				// Normal during scrolling and zooming — never log it. Leave the
				// canvas as it is; a newer attempt is already queued.
				if (rec.epoch === epoch) rec.state = 'blank';
				return;
			}
			console.error(
				`pdf-ink: could not render page ${String(rec.index + 1)}`,
				err,
			);
			if (rec.epoch === epoch) this.markEmpty(rec);
			return;
		}

		// Out-of-order completion guards. Per-record epoch catches "this page was
		// re-rendered at a new zoom while the old render was still running";
		// view epoch catches "the file switched while it was running".
		if (rec.epoch !== epoch || viewEpoch !== this.currentViewEpoch()) {
			releaseCanvas(raster.canvas);
			return;
		}

		rec.task = null;
		adoptRaster(rec.renderCanvasEl, raster.canvas);
		rec.renderedDensity = density;
		this.markReady(rec);
	}

	private async runTeardown(rec: PageRecord): Promise<void> {
		const task = rec.task;
		if (task) {
			rec.task = null;
			task.cancel();
			// Must await: pdf.js releases the canvas only once the task settles,
			// and zeroing one it still owns corrupts its internal state.
			await task.promise.catch(() => undefined);
		}
		rec.epoch++;

		// Zeroing is what actually releases the backing store. The elements stay
		// in the DOM: their identity is the WeakMap key used by the observer, and
		// removing them would thrash layout.
		for (const canvasEl of [
			rec.renderCanvasEl,
			rec.highlightCanvasEl,
			rec.inkCanvasEl,
		]) {
			canvasEl.width = 0;
			canvasEl.height = 0;
		}
		this.markEmpty(rec);

		// Decoded images are the expensive residue — a single scanned page can
		// hold ~100 MB. Drop them, but only if the page stays evicted, so
		// scrolling back and forth across the boundary does not re-parse it.
		rec.cleanupTimer = rec.wrapperEl.win.setTimeout(() => {
			rec.cleanupTimer = null;
			if (rec.state === 'blank' && rec.task === null) {
				// Only a pdf.js page holds decoded images worth releasing.
				if (rec.geom.source.kind === 'pdf') rec.geom.source.page.cleanup();
			}
		}, PAGE_CLEANUP_DELAY_MS);
	}

	private markReady(rec: PageRecord): void {
		rec.state = 'ready';
		rec.wrapperEl.removeClass('is-empty');
	}

	private markEmpty(rec: PageRecord): void {
		rec.state = 'blank';
		rec.bitmapScale = 0;
		rec.bitmapDpr = 0;
		rec.renderedDensity = 0;
		rec.wrapperEl.addClass('is-empty');
	}
}
