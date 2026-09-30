import type { CanvasBudget } from '../core/canvas-budget';
import {
	type CssRect,
	containsRect,
	detailBitmapSize,
	detailRegion,
	intersectRect,
} from '../core/detail-region';
import { isRenderCancelled } from '../types/pdfjs';
import type {
	DetailTarget,
	PageBox,
	PageDetail,
	PageRecord,
} from '../types/view';
import { adoptRaster, rasterise, releaseCanvas } from './rasterise';

/**
 * Keeps the visible part of an oversized page sharp.
 *
 * The whole-page bitmap underneath is clamped by the canvas budget and can be
 * many times softer than the display. This draws just the part in view at the
 * display's own density, into canvases stacked over the whole-page ones. See
 * src/core/detail-region.ts for why it is one region and not a grid of tiles.
 *
 * Renders go through a scratch canvas, never the visible one, so a detail that
 * is superseded or dropped can be discarded at once: nothing waits on pdf.js.
 */
export class DetailRenderer {
	constructor(
		private readonly budget: CanvasBudget,
		private readonly currentViewEpoch: () => number,
		private readonly onInkCanvasReset: (rec: PageRecord) => void,
	) {}

	/**
	 * Make sure what is in view will be sharp. A no-op when the current detail, or
	 * the one being rendered, already covers it.
	 */
	update(
		rec: PageRecord,
		box: PageBox,
		dpr: number,
		visible: CssRect | null,
	): void {
		const region =
			visible && rec.wrapperEl.isConnected
				? detailRegion(box.cssWidth, box.cssHeight, visible, dpr, this.budget)
				: null;
		const seen =
			visible &&
			intersectRect(visible, { x: 0, y: 0, w: box.cssWidth, h: box.cssHeight });
		if (!region || !seen) {
			this.drop(rec);
			return;
		}

		const fits = (t: DetailTarget | null): boolean =>
			t !== null &&
			t.scale === box.scale &&
			t.dpr === region.dpr &&
			containsRect(t.rect, seen);

		const existing = rec.detail;
		if (existing) {
			if (fits(existing.target)) return;
			if (fits(existing.shown)) {
				// Scrolled back inside what is already drawn: the render heading
				// somewhere else is no longer wanted.
				existing.target = null;
				existing.task?.cancel();
				return;
			}
		}

		const detail = existing ?? this.create(rec);
		const target: DetailTarget = {
			rect: region.rect,
			scale: box.scale,
			dpr: region.dpr,
		};
		detail.task?.cancel();
		detail.target = target;

		const viewEpoch = this.currentViewEpoch();
		rec.detailSettled = (rec.detailSettled ?? Promise.resolve())
			.then(() => this.run(rec, detail, target, viewEpoch))
			.catch(() => undefined);
	}

	/** Discard the page's detail. Its canvases go immediately. */
	drop(rec: PageRecord): void {
		const detail = rec.detail;
		if (!detail) return;
		rec.detail = null;
		detail.target = null;
		detail.task?.cancel();
		for (const canvasEl of canvasesOf(detail)) {
			releaseCanvas(canvasEl);
			canvasEl.remove();
		}
		// The whole-page ink had a hole cut where the detail sat; fill it back in.
		if (detail.shown) this.onInkCanvasReset(rec);
	}

	/**
	 * Place the detail over its region at the page's current scale. Called after
	 * every layout change, so a zoom shows the old detail scaled until the sharp
	 * one for the new zoom lands.
	 */
	reposition(rec: PageRecord): void {
		const rect = detailCssRect(rec);
		if (!rect) return;
		rec.wrapperEl.setCssProps({
			'--pdf-ink-detail-x': `${String(rect.x)}px`,
			'--pdf-ink-detail-y': `${String(rect.y)}px`,
			'--pdf-ink-detail-w': `${String(rect.w)}px`,
			'--pdf-ink-detail-h': `${String(rect.h)}px`,
		});
	}

	private create(rec: PageRecord): PageDetail {
		// Each detail canvas goes directly after its whole-page counterpart: equal
		// z-index, later in the document, so it stacks above that layer and below
		// the next one. The highlighter blend then still applies to both.
		const after = (anchor: HTMLCanvasElement, cls: string): HTMLCanvasElement => {
			const canvasEl = rec.wrapperEl.doc.createElement('canvas');
			canvasEl.addClass(cls, 'pdf-ink-detail');
			canvasEl.width = 0;
			canvasEl.height = 0;
			anchor.after(canvasEl);
			return canvasEl;
		};
		const detail: PageDetail = {
			renderCanvasEl: after(rec.renderCanvasEl, 'pdf-ink-render'),
			highlightCanvasEl: after(rec.highlightCanvasEl, 'pdf-ink-highlight'),
			inkCanvasEl: after(rec.inkCanvasEl, 'pdf-ink-ink'),
			shown: null,
			target: null,
			task: null,
			epoch: 0,
		};
		rec.detail = detail;
		return detail;
	}

	private async run(
		rec: PageRecord,
		detail: PageDetail,
		target: DetailTarget,
		viewEpoch: number,
	): Promise<void> {
		const current = (): boolean =>
			viewEpoch === this.currentViewEpoch() &&
			rec.detail === detail &&
			detail.target === target;
		if (!current()) return;

		const epoch = ++detail.epoch;
		const { rect, dpr } = target;
		const { width, height } = detailBitmapSize(target);
		const raster = rasterise(
			rec.wrapperEl.doc,
			rec.geom.source,
			rec.geom.baseViewport.clone({ scale: target.scale }),
			width,
			height,
			// Device px, shifted so the region's top-left corner lands at 0,0.
			[dpr, 0, 0, dpr, -rect.x * dpr, -rect.y * dpr],
		);
		if (!raster) {
			if (detail.target === target) detail.target = null;
			return;
		}
		detail.task = raster.task;

		try {
			await raster.task.promise;
		} catch (err) {
			releaseCanvas(raster.canvas);
			if (detail.epoch === epoch) detail.task = null;
			if (detail.target === target) detail.target = null;
			if (!isRenderCancelled(err)) {
				console.error(
					`pdf-ink: could not render detail of page ${String(rec.index + 1)}`,
					err,
				);
			}
			return;
		}

		if (detail.epoch !== epoch || !current()) {
			releaseCanvas(raster.canvas);
			return;
		}

		detail.task = null;
		detail.target = null;
		adoptRaster(detail.renderCanvasEl, raster.canvas);
		for (const canvasEl of [detail.highlightCanvasEl, detail.inkCanvasEl]) {
			canvasEl.width = width;
			canvasEl.height = height;
		}
		detail.shown = target;
		this.reposition(rec);
		// Paints ink into the new detail, and cuts its hole in the whole-page ink.
		this.onInkCanvasReset(rec);
	}
}

/**
 * Where a page's shown detail sits, in page CSS px at the page's current scale,
 * or null when it has none.
 */
export function detailCssRect(rec: PageRecord): CssRect | null {
	const shown = rec.detail?.shown;
	if (!shown) return null;
	const k = rec.viewport.scale / shown.scale;
	return {
		x: shown.rect.x * k,
		y: shown.rect.y * k,
		w: shown.rect.w * k,
		h: shown.rect.h * k,
	};
}

function canvasesOf(detail: PageDetail): HTMLCanvasElement[] {
	return [detail.renderCanvasEl, detail.highlightCanvasEl, detail.inkCanvasEl];
}
