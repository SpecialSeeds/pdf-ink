import { type App, type TFile } from 'obsidian';
import type {
	PDFDocumentLoadingTask,
	PDFDocumentProxy,
	PdfJsModule,
} from '../types/pdfjs';
import { rulingFromKeywords } from '../core/new-pdf';
import { pdfPageKey } from '../core/pages';
import type { PageTemplate } from '../core/templates';
import type { PageGeometry } from '../types/view';

/** How many page-tree lookups to keep in flight during the sizing sweep. */
const SWEEP_CONCURRENCY = 8;

/**
 * Asset paths Obsidian's own PDF viewer passes. Without cMaps, CJK documents
 * render with missing glyphs; without the wasm/standard-font URLs, JPX images
 * and non-embedded base fonts fail. All are app-relative, so they work on
 * mobile too.
 */
const PDFJS_ASSETS = {
	cMapUrl: '/lib/pdfjs/cmaps/',
	cMapPacked: true,
	standardFontDataUrl: '/lib/pdfjs/standard_fonts/',
	wasmUrl: '/lib/pdfjs/wasm/',
	iccUrl: '/lib/pdfjs/iccs/',
	// Obsidian sets this too; eval is not needed to render.
	isEvalSupported: false,
} as const;

export interface PdfInkDocument {
	readonly doc: PDFDocumentProxy;
	readonly loadingTask: PDFDocumentLoadingTask;
	/**
	 * One entry per page of the source document, in order.
	 *
	 * Inserted pages are not here: they come from the sidecar and are spliced in by
	 * the view, which is the only place that knows about both.
	 */
	readonly geometry: readonly PageGeometry[];
	/**
	 * The ruling this PDF declares for pages inserted into it, when it was made by
	 * this plugin. Null for any other PDF.
	 */
	readonly ruling: PageTemplate | null;
}

/** Metadata is a nicety: a PDF whose Info dictionary cannot be read has none. */
async function readRuling(doc: PDFDocumentProxy): Promise<PageTemplate | null> {
	try {
		const { info } = await doc.getMetadata();
		return rulingFromKeywords(info['Keywords']);
	} catch {
		return null;
	}
}

async function readGeometry(
	doc: PDFDocumentProxy,
	pageNumber: number,
): Promise<PageGeometry> {
	const page = await doc.getPage(pageNumber);
	// Rotation defaults to page.rotate, and the resulting width/height already
	// account for /Rotate and /UserUnit. Never reconstruct these by hand.
	const baseViewport = page.getViewport({ scale: 1 });
	return {
		key: pdfPageKey(pageNumber - 1),
		source: { kind: 'pdf', pdfIndex: pageNumber - 1, page },
		baseViewport,
		baseWidth: baseViewport.width,
		baseHeight: baseViewport.height,
		rotation: page.rotate,
	};
}

/**
 * Open a PDF and measure every page up front.
 *
 * Measuring eagerly rather than lazily is deliberate: page heights vary within a
 * document, so a placeholder guess makes the scrollbar resize as you scroll and
 * makes the zoom anchor math wrong. A zero-area wrapper is also reported as not
 * intersecting, which would deadlock virtualization — no size, so never visible,
 * so never rendered, so never sized. `getPage` only walks the page tree, so the
 * sweep costs no I/O.
 */
export async function openPdfDocument(
	app: App,
	file: TFile,
	pdfjs: PdfJsModule,
): Promise<PdfInkDocument> {
	const raw = await app.vault.readBinary(file);
	// pdf.js detaches whatever buffer it is handed. The original bytes are not
	// retained: a later pdf-lib export re-reads the file, which also avoids
	// holding two copies of a large scan for the lifetime of the tab.
	const data = new Uint8Array(raw.slice(0));

	const loadingTask = pdfjs.getDocument({ data, ...PDFJS_ASSETS });
	const doc = await loadingTask.promise;

	const geometry: PageGeometry[] = [];
	for (let start = 1; start <= doc.numPages; start += SWEEP_CONCURRENCY) {
		const batch: Promise<PageGeometry>[] = [];
		const end = Math.min(start + SWEEP_CONCURRENCY - 1, doc.numPages);
		for (let n = start; n <= end; n++) {
			batch.push(readGeometry(doc, n));
		}
		geometry.push(...(await Promise.all(batch)));
	}

	return { doc, loadingTask, geometry, ruling: await readRuling(doc) };
}
