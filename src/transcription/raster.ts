import type { Block } from '../core/blocks';
import type { Bounds } from '../core/hit-test';
import { inZOrder } from '../core/items';
import { DEFAULT_PAGE_THEMES } from '../core/theme';
import { layerFor, rendererFor } from '../ui/item-renderers';
import type { PageViewport } from '../types/pdfjs';
import type { SourcePage } from './sources';

/** 150 dpi, in pixels per point. */
export const TRANSCRIPTION_SCALE = 150 / 72;

/** Colours the block outlines cycle through, so neighbours are told apart. */
const BLOCK_COLOURS = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#9333ea', '#0891b2'];

export interface RasterOptions {
	/** Pixels per point. */
	readonly scale: number;
	/** Draw in shades of grey; the block outlines keep their colour. */
	readonly grayscale?: boolean;
	/** Outline these, each with its id at its top left. */
	readonly blocks?: readonly Block[];
	/** Draw only this part of the page, in PDF space. */
	readonly region?: Bounds;
	/** The most pixels the canvas may have; the scale shrinks to fit. */
	readonly maxPixels?: number;
}

export interface Raster {
	readonly canvas: HTMLCanvasElement;
	/** Pixels per point actually used. */
	readonly scale: number;
}

/**
 * A page drawn offscreen: the PDF page as pdf.js draws it, or white paper with
 * no ruling for a notebook page, and its ink over it in the light theme, through
 * the same renderers as the screen.
 */
export async function rasterisePage(page: SourcePage, options: RasterOptions): Promise<Raster> {
	const base = page.geometry.baseViewport;
	let scale = options.scale;

	const area = (k: number): Bounds => {
		const viewport = base.clone({ scale: k });
		if (!options.region) return { minX: 0, minY: 0, maxX: viewport.width, maxY: viewport.height };
		const r = options.region;
		const corners = [
			viewport.convertToViewportPoint(r.minX, r.minY),
			viewport.convertToViewportPoint(r.maxX, r.maxY),
		];
		const xs = corners.map((c) => c[0] ?? 0);
		const ys = corners.map((c) => c[1] ?? 0);
		return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
	};
	let box = area(scale);
	const maxPixels = options.maxPixels ?? 1 << 24;
	const pixels = (box.maxX - box.minX) * (box.maxY - box.minY);
	if (pixels > maxPixels) {
		scale *= Math.sqrt(maxPixels / pixels);
		box = area(scale);
	}

	const width = Math.max(1, Math.ceil(box.maxX - box.minX));
	const height = Math.max(1, Math.ceil(box.maxY - box.minY));
	const viewport: PageViewport = base.clone({ scale, offsetX: -box.minX, offsetY: -box.minY });
	// The global createEl makes a detached element. Called on a node it also
	// appends to that node, and on the document that throws: it already has
	// its one element.
	const canvas = createEl('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d');
	if (!ctx) return { canvas, scale };

	ctx.fillStyle = '#ffffff';
	ctx.fillRect(0, 0, width, height);
	if (page.geometry.source.kind === 'pdf') {
		await page.geometry.source.page.render({
			canvasContext: ctx,
			viewport,
			background: '#ffffff',
			intent: 'print',
		}).promise;
	}

	// Highlighter first, multiplied, then everything else over it: as on screen,
	// where highlights sit on a layer of their own under the pen.
	const theme = DEFAULT_PAGE_THEMES.light;
	const target = { ctx, viewport, scale, theme };
	const items = inZOrder(page.items);
	ctx.globalCompositeOperation = 'multiply';
	for (const item of items) if (layerFor(item) === 'highlight') rendererFor(item)?.(item, target);
	ctx.globalCompositeOperation = 'source-over';
	for (const item of items) if (layerFor(item) === 'ink') rendererFor(item)?.(item, target);

	if (options.grayscale) toGrayscale(ctx, width, height);
	if (options.blocks) drawBlocks(ctx, viewport, options.blocks);
	return { canvas, scale };
}

/** Every pixel to its luminance. */
function toGrayscale(ctx: CanvasRenderingContext2D, width: number, height: number): void {
	const image = ctx.getImageData(0, 0, width, height);
	const px = image.data;
	for (let i = 0; i < px.length; i += 4) {
		const y = Math.round(0.299 * (px[i] ?? 0) + 0.587 * (px[i + 1] ?? 0) + 0.114 * (px[i + 2] ?? 0));
		px[i] = y;
		px[i + 1] = y;
		px[i + 2] = y;
	}
	ctx.putImageData(image, 0, 0);
}

/** A thin coloured rectangle round each block, its id in a small label at the top left. */
function drawBlocks(ctx: CanvasRenderingContext2D, viewport: PageViewport, blocks: readonly Block[]): void {
	ctx.save();
	ctx.font = 'bold 12px sans-serif';
	ctx.textBaseline = 'top';
	blocks.forEach((block, i) => {
		const colour = BLOCK_COLOURS[i % BLOCK_COLOURS.length] ?? '#e11d48';
		const [x1 = 0, y1 = 0] = viewport.convertToViewportPoint(block.bounds.minX, block.bounds.maxY);
		const [x2 = 0, y2 = 0] = viewport.convertToViewportPoint(block.bounds.maxX, block.bounds.minY);
		const pad = 3;
		const left = Math.min(x1, x2) - pad;
		const top = Math.min(y1, y2) - pad;
		ctx.strokeStyle = colour;
		ctx.lineWidth = 1.5;
		ctx.strokeRect(left, top, Math.abs(x2 - x1) + 2 * pad, Math.abs(y2 - y1) + 2 * pad);
		const labelWidth = ctx.measureText(block.id).width + 6;
		ctx.fillStyle = colour;
		ctx.fillRect(left, top - 15, labelWidth, 15);
		ctx.fillStyle = '#ffffff';
		ctx.fillText(block.id, left + 3, top - 13);
	});
	ctx.restore();
}

/** A canvas as PNG bytes. */
export function canvasToPng(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
	return new Promise((resolve, reject) => {
		canvas.toBlob((blob) => {
			if (!blob) {
				reject(new Error('the page could not be encoded as PNG'));
				return;
			}
			void blob.arrayBuffer().then(resolve, reject);
		}, 'image/png');
	});
}
