import { PDFDocument } from 'pdf-lib';
import { type NewPdfPageSize, PAGE_SIZES, rulingKeyword } from '../core/new-pdf';
import type { PageTemplate } from '../core/templates';
import { drawRuling } from './export';

export interface NewPdfOptions {
	readonly size: NewPdfPageSize;
	readonly template: PageTemplate;
}

/**
 * A one-page PDF, ruled, ready to write on.
 *
 * The ruling is drawn into the page itself, so the file reads the same in any
 * viewer, and named in the Keywords so pages inserted later match it.
 */
export async function createBlankPdf(options: NewPdfOptions): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	const { width, height } = PAGE_SIZES[options.size];
	drawRuling(doc.addPage([width, height]), options.template, width, height);
	doc.setKeywords([rulingKeyword(options.template)]);
	doc.setCreator('PDF ink');
	doc.setProducer('PDF ink');
	return doc.save();
}
