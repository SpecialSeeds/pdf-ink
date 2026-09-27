import { PAGE_CLEANUP_DELAY_MS } from '../constants';
import { type CanvasBudget, effectiveDpr } from '../core/canvas-budget';
import { isRenderCancelled } from '../types/pdfjs';
import type { PageBox, PageRecord } from '../types/view';
import { paintInsertedPage } from './template-painter';

/**
 * Renders and tears down a single page's canvases.
 *
 * Every mutation of a record goes through its `settled` chain, so a record only
 * ever has one operation in flight. That is not defensive style — pdf.js keeps a
 * WeakSet of canvases with live render tasks and throws "Cannot use the same
 * canvas during multiple render() operations" if you render into one again, or
 * zero its width, before the previous task has *settled*. `cancel()` is
 * synchronous; settling is not. Awaiting it is mandatory.
 */
export class PageRenderer {
	constructor(
		private readonly budget: CanvasBudget,
		/** Bumped by the view on close and on file switch. */
		private readonly currentViewEpoch: () => number,
		/**
		 * Called once a page's ink canvas has been resized — which clears it — so
		 * already-committed strokes can be repainted.
		 */
		private readonly onInkCanvasReset: (rec: PageRecord) => void,
	) {}

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
		await (rec.settled ?? Promise.resolve());
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
		rec.renderCanvasEl.width = bitmapWidth;
		rec.renderCanvasEl.height = bitmapHeight;
		for (const canvasEl of [rec.highlightCanvasEl, rec.inkCanvasEl]) {
			canvasEl.width = bitmapWidth;
			canvasEl.height = bitmapHeight;
			// Assigning .width resets the context transform, so the dpr transform
			// has to be re-applied after every resize. With it, the drawing pass
			// works in CSS px — the same space as pointer coordinates and
			// rec.viewport.
			canvasEl.getContext('2d')?.setTransform(effDpr, 0, 0, effDpr, 0, 0);
		}

		// Published before the first await: the ink layer must never observe a
		// viewport that disagrees with the canvas underneath it, not even while
		// a render is still in flight.
		rec.viewport = rec.geom.baseViewport.clone({ scale: box.scale });
		rec.cssWidth = box.cssWidth;
		rec.cssHeight = box.cssHeight;
		rec.bitmapScale = box.scale;
		rec.bitmapDpr = effDpr;

		// After the viewport and box above are published, so the repaint projects
		// stored PDF-space strokes through the new scale.
		this.onInkCanvasReset(rec);

		// Deliberately NOT { alpha: false }: resizing a canvas clears it, and an
		// opaque context clears to black. Transparent lets the wrapper's white
		// page colour show through for the frame or two before pixels land.
		const ctx = rec.renderCanvasEl.getContext('2d');
		if (!ctx) {
			this.markEmpty(rec);
			return;
		}

		const source = rec.geom.source;
		if (source.kind === 'inserted') {
			// Nothing to decode and no worker involved, so this needs no task, no
			// cancellation and no out-of-order guard: it is done before it returns.
			paintInsertedPage(
				ctx,
				rec.viewport,
				source.page,
				box.cssWidth,
				box.cssHeight,
				effDpr,
			);
			rec.state = 'ready';
			rec.wrapperEl.removeClass('is-empty');
			return;
		}

		rec.state = 'rendering';
		const task = source.page.render({
			canvasContext: ctx,
			// CSS-pixel scale. devicePixelRatio is supplied separately, via
			// `transform`, so that rec.viewport stays in CSS px for
			// convertToPdfPoint.
			viewport: rec.viewport,
			transform:
				effDpr === 1 ? null : [effDpr, 0, 0, effDpr, 0, 0],
			background: '#ffffff',
			intent: 'display',
		});
		rec.task = task;

		try {
			await task.promise;
		} catch (err) {
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
		if (rec.epoch !== epoch) return;
		if (viewEpoch !== this.currentViewEpoch()) return;

		rec.task = null;
		rec.state = 'ready';
		rec.wrapperEl.removeClass('is-empty');
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

	private markEmpty(rec: PageRecord): void {
		rec.state = 'blank';
		rec.bitmapScale = 0;
		rec.bitmapDpr = 0;
		rec.wrapperEl.addClass('is-empty');
	}
}
