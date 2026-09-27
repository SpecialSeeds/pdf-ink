import type { ItemStore } from '../core/ink-store';
import { type Item, type StrokeSample, inZOrder } from '../core/items';
import type { PageRecord } from '../types/view';
import {
	type LayerName,
	type RenderTarget,
	layerFor,
	renderLiveStroke,
	rendererFor,
} from './item-renderers';

/**
 * The item currently under the pointer, which is not in the store yet.
 *
 * A freehand stroke carries the canvas-space samples captured this gesture, so the
 * live preview needs no reprojection; a shape has none and is drawn from its box.
 */
export interface LiveItem {
	readonly item: Item;
	readonly samples?: readonly StrokeSample[];
}

interface CachedLayers {
	readonly ink: HTMLCanvasElement;
	readonly highlight: HTMLCanvasElement;
	key: string;
}

/**
 * Draws a page's items onto its two ink canvases.
 *
 * Committed items are pre-rendered to offscreen canvases and blitted, because
 * otherwise every pointermove would re-run every item's renderer over the whole
 * page. Only the live stroke is recomputed per frame.
 *
 * Items are drawn in z order through a per-type renderer, so a new item type only
 * needs an entry in ITEM_RENDERERS. The one ordering caveat is that highlighter
 * ink lives on its own multiply-composited canvas beneath the opaque one, so z
 * orders items within a layer and a highlighter never paints over pen ink.
 */
export class InkPainter {
	private readonly committed = new WeakMap<PageRecord, CachedLayers>();

	constructor(private readonly store: ItemStore) {}

	paint(
		record: PageRecord,
		live: LiveItem | null,
		/** Items hidden mid-erase, before the gesture commits. */
		pending: ReadonlySet<Item> | null,
		/**
		 * Sized-erase survivors, drawn uncached because they change on every
		 * pointer sample.
		 */
		preview?: readonly Item[],
	): void {
		if (!isDrawable(record)) return;
		const inkCtx = record.inkCanvasEl.getContext('2d');
		const highlightCtx = record.highlightCanvasEl.getContext('2d');
		if (!inkCtx || !highlightCtx) return;

		// Both contexts carry a devicePixelRatio transform, so everything below is
		// in CSS pixels.
		inkCtx.clearRect(0, 0, record.cssWidth, record.cssHeight);
		highlightCtx.clearRect(0, 0, record.cssWidth, record.cssHeight);

		const layers = this.layersFor(record, pending);
		if (layers) {
			// Source is device px, destination CSS px, and the dpr transform maps
			// them back 1:1 — so these blits are pixel exact.
			this.blit(highlightCtx, layers.highlight, record);
			this.blit(inkCtx, layers.ink, record);
		}

		for (const item of preview ?? []) {
			const ctx = layerFor(item) === 'highlight' ? highlightCtx : inkCtx;
			rendererFor(item)?.(item, {
				ctx,
				viewport: record.viewport,
				scale: record.viewport.scale,
			});
		}

		if (live) {
			const ctx = layerFor(live.item) === 'highlight' ? highlightCtx : inkCtx;
			const target = {
				ctx,
				viewport: record.viewport,
				scale: record.viewport.scale,
			};
			if (live.samples && live.item.type === 'stroke') {
				renderLiveStroke(live.item, live.samples, target);
			} else {
				rendererFor(live.item)?.(live.item, target);
			}
		}
	}

	/** The in-progress lasso loop, in canvas CSS px. Dashed, and never cached. */
	paintLasso(record: PageRecord, points: readonly [number, number][]): void {
		const first = points[0];
		if (!first || points.length < 2) return;
		const ctx = record.inkCanvasEl.getContext('2d');
		if (!ctx) return;

		ctx.save();
		ctx.beginPath();
		ctx.moveTo(first[0], first[1]);
		for (const [x, y] of points.slice(1)) ctx.lineTo(x, y);
		ctx.closePath();
		ctx.setLineDash([4, 4]);
		ctx.lineWidth = 1;
		ctx.strokeStyle = '#3b82f6';
		ctx.stroke();
		ctx.fillStyle = 'rgba(59, 130, 246, 0.08)';
		ctx.fill();
		ctx.restore();
	}

	private blit(
		ctx: CanvasRenderingContext2D,
		source: HTMLCanvasElement,
		record: PageRecord,
	): void {
		if (source.width === 0 || source.height === 0) return;
		ctx.drawImage(source, 0, 0, record.cssWidth, record.cssHeight);
	}

	private layersFor(
		record: PageRecord,
		pending: ReadonlySet<Item> | null,
	): CachedLayers | null {
		const key = [
			this.store.version,
			record.bitmapScale,
			record.bitmapDpr,
			pending?.size ?? 0,
		].join(':');

		const cached = this.committed.get(record);
		if (cached && cached.key === key) return cached;

		const doc = record.inkCanvasEl.doc;
		const ink = cached?.ink ?? doc.createElement('canvas');
		const highlight = cached?.highlight ?? doc.createElement('canvas');
		const dpr = record.bitmapDpr;

		const inkCtx = resize(ink, record, dpr);
		const highlightCtx = resize(highlight, record, dpr);
		if (!inkCtx || !highlightCtx) return null;

		const targets: Record<LayerName, RenderTarget> = {
			ink: { ctx: inkCtx, viewport: record.viewport, scale: record.viewport.scale },
			highlight: {
				ctx: highlightCtx,
				viewport: record.viewport,
				scale: record.viewport.scale,
			},
		};

		for (const item of inZOrder(this.store.itemsFor(record.geom.key))) {
			// Items under the eraser vanish immediately, before the gesture ends.
			if (pending?.has(item)) continue;
			const render = rendererFor(item);
			// No renderer yet for this type: skip it rather than guess. The store
			// still round-trips it to disk untouched.
			if (!render) continue;
			render(item, targets[layerFor(item)]);
		}

		const layers: CachedLayers = { ink, highlight, key };
		this.committed.set(record, layers);
		return layers;
	}
}

function resize(
	canvasEl: HTMLCanvasElement,
	record: PageRecord,
	dpr: number,
): CanvasRenderingContext2D | null {
	canvasEl.width = Math.round(record.cssWidth * dpr);
	canvasEl.height = Math.round(record.cssHeight * dpr);
	const ctx = canvasEl.getContext('2d');
	if (!ctx) return null;
	// Assigning .width resets the transform.
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	return ctx;
}

/**
 * A page can only be drawn on once it has a real bitmap at a known scale —
 * `bitmapScale` is zeroed when a page is evicted, and its viewport would then
 * disagree with a canvas that has no pixels.
 */
export function isDrawable(record: PageRecord): boolean {
	return record.bitmapScale > 0 && record.cssWidth > 0 && record.cssHeight > 0;
}
