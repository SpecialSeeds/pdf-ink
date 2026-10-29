import { destinationTop } from '../core/pdf-links';
import type { PDFDestination, PDFDocumentProxy, PDFRef } from '../types/pdfjs';

/** A destination resolved to a page of the source document. */
export interface ResolvedDestination {
	/** 0-based index within the source document. */
	readonly pdfIndex: number;
	/** The PDF-space y to show at the top of the view, or null for the page top. */
	readonly top: number | null;
}

/**
 * Resolve a destination, from an outline entry or a link, to a page.
 *
 * A destination is either an array whose first element references a page, or a
 * name that has to be looked up first. Null when it cannot be resolved.
 */
export async function resolveDestination(
	doc: PDFDocumentProxy,
	dest: PDFDestination | string | null,
): Promise<ResolvedDestination | null> {
	if (dest === null) return null;
	const resolved = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
	if (!resolved) return null;
	const ref = resolved[0];
	// Some writers give a 0-based page number in place of a reference.
	const pdfIndex = isPdfRef(ref)
		? await doc.getPageIndex(ref)
		: typeof ref === 'number' && Number.isInteger(ref)
			? ref
			: null;
	if (pdfIndex === null || pdfIndex < 0 || pdfIndex >= doc.numPages) return null;
	return { pdfIndex, top: destinationTop(resolved) };
}

function isPdfRef(value: unknown): value is PDFRef {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as PDFRef).num === 'number' &&
		typeof (value as PDFRef).gen === 'number'
	);
}
