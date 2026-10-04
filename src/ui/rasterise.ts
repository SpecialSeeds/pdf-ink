import type { PageTheme } from '../core/theme';
import type { Matrix, PageViewport, RenderTask } from '../types/pdfjs';
import type { PageSource } from '../types/view';
import { paintInsertedPage } from './template-painter';

/** A render into a scratch canvas that nothing on screen is showing yet. */
export interface Raster {
	readonly canvas: HTMLCanvasElement;
	readonly task: RenderTask;
}

const DONE: Promise<void> = Promise.resolve();

/**
 * Draw a page into a fresh canvas of `width` x `height` device px, with
 * `transform` mapping the viewport's CSS px onto it. `theme` colours an inserted
 * page; a page of the PDF is drawn as the PDF has it.
 *
 * Always a fresh canvas, and never the one on screen. The on-screen bitmap stays
 * put — stretched by CSS to the new box after a zoom — until a complete
 * replacement exists, so a slow page never flashes blank. It also keeps pdf.js
 * away from every canvas we might want to resize: pdf.js refuses to render into
 * a canvas with a task in flight, and corrupts its state if one is resized under
 * it.
 */
export function rasterise(
	doc: Document,
	source: PageSource,
	viewport: PageViewport,
	width: number,
	height: number,
	transform: Matrix,
	theme: PageTheme,
): Raster | null {
	const canvas = doc.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	// Not { alpha: false }: the copy onto the visible canvas is what matters, and
	// the white background below makes the bitmap opaque regardless.
	const ctx = canvas.getContext('2d');
	if (!ctx) {
		releaseCanvas(canvas);
		return null;
	}

	if (source.kind === 'inserted') {
		// No worker, nothing to decode: done before it returns.
		paintInsertedPage(
			ctx,
			viewport,
			source.page,
			viewport.width,
			viewport.height,
			transform,
			theme,
		);
		return { canvas, task: { promise: DONE, cancel: () => undefined } };
	}

	const task = source.page.render({
		canvasContext: ctx,
		// CSS-pixel scale. Device px and any offset arrive through `transform`, so
		// the viewport stays the one convertToPdfPoint uses.
		viewport,
		transform: isIdentity(transform) ? null : transform,
		background: '#ffffff',
		intent: 'display',
	});
	return { canvas, task };
}

/** Copy a finished raster onto `target`, resizing it, and free the scratch. */
export function adoptRaster(
	target: HTMLCanvasElement,
	scratch: HTMLCanvasElement,
): void {
	target.width = scratch.width;
	target.height = scratch.height;
	target.getContext('2d')?.drawImage(scratch, 0, 0);
	releaseCanvas(scratch);
}

/**
 * Zeroing is what releases a backing store promptly; WebKit on iOS otherwise
 * holds it until garbage collection, and counts it against a hard limit meanwhile.
 */
export function releaseCanvas(canvas: HTMLCanvasElement): void {
	canvas.width = 0;
	canvas.height = 0;
}

function isIdentity(m: Matrix): boolean {
	return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
}
