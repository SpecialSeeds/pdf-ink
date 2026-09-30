import type { CssRect } from '../core/detail-region';
import type { ItemStore } from '../core/ink-store';
import { type Item, type StrokeSample, inZOrder } from '../core/items';
import type { Matrix } from '../types/pdfjs';
import type { PageRecord } from '../types/view';
import { detailCssRect } from './detail-renderer';
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
 * One pair of ink canvases to draw a page's items into: the whole-page pair, and,
 * on a page too large to draw sharply whole, the pair over its visible detail.
 * Every drawing call works in page CSS px; `transform` maps them to the bitmap.
 */
interface Surface {
	readonly ink: HTMLCanvasElement;
	readonly highlight: HTMLCanvasElement;
	readonly transform: Matrix;
	/** Page CSS px to leave clear, because the detail above draws them. */
	readonly hole: CssRect | null;
}

/**
 * How far inside the detail's edge the whole-page ink is cut away, in CSS px.
 * The two bitmaps round the boundary differently; cutting slightly short means
 * they overlap by a hair rather than leave a visible gap.
 */
const HOLE_INSET = 1;

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
	/** Keyed by the surface's on-screen ink canvas. */
	private readonly committed = new WeakMap<HTMLCanvasElement, CachedLayers>();

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
		const transient =
			live !== null || (pending?.size ?? 0) > 0 || (preview?.length ?? 0) > 0;
		for (const surface of surfacesFor(record, transient)) {
			this.paintSurface(record, surface, live, pending, preview);
		}
	}

	private paintSurface(
		record: PageRecord,
		surface: Surface,
		live: LiveItem | null,
		pending: ReadonlySet<Item> | null,
		preview: readonly Item[] | undefined,
	): void {
		const inkCtx = surface.ink.getContext('2d');
		const highlightCtx = surface.highlight.getContext('2d');
		if (!inkCtx || !highlightCtx) return;

		const layers = this.layersFor(record, surface, pending);
		for (const [ctx, source] of [
			[highlightCtx, layers?.highlight],
			[inkCtx, layers?.ink],
		] as const) {
			// Both bitmaps are the same size in device px, so this blit is pixel
			// exact with no transform at all.
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
			if (source && source.width > 0 && source.height > 0) {
				ctx.drawImage(source, 0, 0);
			}
			ctx.setTransform(...surface.transform);
			const hole = surface.hole;
			if (hole && hole.w > 2 * HOLE_INSET && hole.h > 2 * HOLE_INSET) {
				ctx.clearRect(
					hole.x + HOLE_INSET,
					hole.y + HOLE_INSET,
					hole.w - 2 * HOLE_INSET,
					hole.h - 2 * HOLE_INSET,
				);
			}
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
		for (const surface of surfacesFor(record, true)) {
			const ctx = surface.ink.getContext('2d');
			if (ctx) drawLasso(ctx, surface.transform, first, points);
		}
	}

	private layersFor(
		record: PageRecord,
		surface: Surface,
		pending: ReadonlySet<Item> | null,
	): CachedLayers | null {
		const { width, height } = surface.ink;
		const key = [
			this.store.version,
			...surface.transform,
			width,
			height,
			pending?.size ?? 0,
		].join(':');

		const cached = this.committed.get(surface.ink);
		if (cached && cached.key === key) return cached;

		const doc = record.inkCanvasEl.doc;
		const ink = cached?.ink ?? doc.createElement('canvas');
		const highlight = cached?.highlight ?? doc.createElement('canvas');

		const inkCtx = resize(ink, width, height, surface.transform);
		const highlightCtx = resize(highlight, width, height, surface.transform);
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
		this.committed.set(surface.ink, layers);
		return layers;
	}
}

/**
 * The surfaces a paint should reach.
 *
 * While a gesture is in progress and the page has a detail, only the detail is
 * drawn: it covers everything on screen, and redrawing the whole-page pair too at
 * pencil rate would double the cost of every frame for pixels nobody can see. The
 * whole-page pair catches up on the next settled paint, when the item commits.
 */
function surfacesFor(record: PageRecord, transient: boolean): Surface[] {
	const base: Surface = {
		ink: record.inkCanvasEl,
		highlight: record.highlightCanvasEl,
		transform: [record.bitmapDpr, 0, 0, record.bitmapDpr, 0, 0],
		hole: null,
	};
	const detail = record.detail;
	const rect = detailCssRect(record);
	if (!detail?.shown || !rect || detail.inkCanvasEl.width === 0) return [base];

	// Page CSS px at the current scale to detail device px. The detail may have
	// been drawn at an earlier zoom, which the scale ratio accounts for.
	const k = (detail.shown.dpr * detail.shown.scale) / record.viewport.scale;
	const sharp: Surface = {
		ink: detail.inkCanvasEl,
		highlight: detail.highlightCanvasEl,
		transform: [k, 0, 0, k, -rect.x * k, -rect.y * k],
		hole: null,
	};
	return transient ? [sharp] : [{ ...base, hole: rect }, sharp];
}

function drawLasso(
	ctx: CanvasRenderingContext2D,
	transform: Matrix,
	first: [number, number],
	points: readonly [number, number][],
): void {
	ctx.setTransform(...transform);
	ctx.save();
	ctx.beginPath();
	ctx.moveTo(first[0], first[1]);
	for (const [x, y] of points.slice(1)) ctx.lineTo(x, y);
	ctx.closePath();
	ctx.setLineDash([4, 4]);
	// One CSS px whatever the surface's density.
	ctx.lineWidth = 1;
	ctx.strokeStyle = '#3b82f6';
	ctx.stroke();
	ctx.fillStyle = 'rgba(59, 130, 246, 0.08)';
	ctx.fill();
	ctx.restore();
}

function resize(
	canvasEl: HTMLCanvasElement,
	width: number,
	height: number,
	transform: Matrix,
): CanvasRenderingContext2D | null {
	canvasEl.width = width;
	canvasEl.height = height;
	const ctx = canvasEl.getContext('2d');
	if (!ctx) return null;
	// Assigning .width resets the transform.
	ctx.setTransform(...transform);
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
