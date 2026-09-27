import { loadPdfJs } from 'obsidian';
import type { PdfJsModule } from '../types/pdfjs';

let cached: Promise<PdfJsModule> | null = null;

/**
 * Obsidian's bundled pdf.js, memoised.
 *
 * `loadPdfJs()` is declared `Promise<any>`; this is the one place that `any` is
 * given a shape. Obsidian has already set `GlobalWorkerOptions.workerSrc` by the
 * time this resolves, so the worker must not be reconfigured here.
 */
export function getPdfJs(): Promise<PdfJsModule> {
	if (cached === null) {
		cached = loadPdfJs().then((lib: unknown) => lib as PdfJsModule);
	}
	return cached;
}
