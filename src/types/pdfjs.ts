/**
 * Minimal structural types for the subset of pdf.js that pdf-ink uses.
 *
 * Obsidian's `loadPdfJs()` is declared `Promise<any>` and we must not bundle a
 * second copy of pdf.js. These declarations are the single boundary where that
 * `any` is given a shape: it is cast once, in `src/pdf/pdfjs.ts`.
 *
 * Verified against the pdf.js build inside Obsidian 1.12.3. Fixed-length values
 * are tuples on purpose — `noUncheckedIndexedAccess` widens `number[]` indexing
 * to `number | undefined`, but leaves tuple indexing alone.
 */

/** 2D affine matrix [a, b, c, d, e, f]. */
export type Matrix = [number, number, number, number, number, number];

/** PDF rectangle [llx, lly, urx, ury] in user space (points, y up). */
export type Rect = [number, number, number, number];

export type Point = [number, number];

export interface PageViewport {
	/** CSS px at this viewport's scale. Already includes /Rotate and /UserUnit. */
	readonly width: number;
	readonly height: number;
	readonly scale: number;
	readonly rotation: number;
	/** page.view — CropBox intersected with MediaBox. Origin may not be (0,0). */
	readonly viewBox: Rect;
	/** PDF user space to viewport CSS px: y-flipped, viewBox origin folded in. */
	readonly transform: Matrix;
	/** Synchronous — rescale without another async getPage(). */
	clone(params?: {
		scale?: number;
		rotation?: number;
		offsetX?: number;
		offsetY?: number;
		dontFlip?: boolean;
	}): PageViewport;
	/** Viewport CSS px to PDF user space. The stroke storage invariant. */
	convertToPdfPoint(x: number, y: number): Point;
	convertToViewportPoint(x: number, y: number): Point;
}

export interface RenderTask {
	/** Rejects with a RenderingCancelledException after cancel(). */
	readonly promise: Promise<void>;
	cancel(extraDelay?: number): void;
}

export interface RenderParameters {
	canvasContext: CanvasRenderingContext2D;
	viewport: PageViewport;
	/** Pre-multiplied into the viewport transform — our devicePixelRatio hook. */
	transform?: Matrix | null;
	intent?: 'display' | 'print';
	background?: string;
}

export interface PDFPageProxy {
	readonly pageNumber: number;
	/** Normalised to 0 | 90 | 180 | 270; an absent /Rotate becomes 0. */
	readonly rotate: number;
	readonly view: Rect;
	/** `rotation` defaults to `this.rotate` — never pass it. */
	getViewport(params: {
		scale: number;
		rotation?: number;
		offsetX?: number;
		offsetY?: number;
		dontFlip?: boolean;
	}): PageViewport;
	render(params: RenderParameters): RenderTask;
	/** Drops the operator list and decoded images. Only call once settled. */
	cleanup(resetStats?: boolean): boolean;
}

export interface PDFDocumentProxy {
	readonly numPages: number;
	/** 1-based. */
	getPage(pageNumber: number): Promise<PDFPageProxy>;
	destroy(): Promise<void>;
}

export interface PDFDocumentLoadingTask {
	readonly promise: Promise<PDFDocumentProxy>;
	destroy(): Promise<void>;
}

export interface GetDocumentParameters {
	/** pdf.js detaches this buffer — always hand it a copy. */
	data: Uint8Array;
	cMapUrl?: string;
	cMapPacked?: boolean;
	standardFontDataUrl?: string;
	wasmUrl?: string;
	iccUrl?: string;
	isEvalSupported?: boolean;
}

export interface PdfJsModule {
	getDocument(params: GetDocumentParameters): PDFDocumentLoadingTask;
	readonly version?: string;
}

/**
 * Cancellation is a normal part of scrolling and zooming, so it must never be
 * logged. Matched by name rather than by class: the exception is not reliably
 * reachable through `loadPdfJs()`, and the name is stable across pdf.js majors.
 */
export function isRenderCancelled(err: unknown): boolean {
	return (
		typeof err === 'object' &&
		err !== null &&
		(err as { name?: unknown }).name === 'RenderingCancelledException'
	);
}
