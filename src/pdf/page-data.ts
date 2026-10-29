import { type PageText, type TextRun, pageText } from '../core/pdf-find';
import { type PdfLink, linksFrom } from '../core/pdf-links';
import type { PDFDocumentProxy } from '../types/pdfjs';

/**
 * Each source page's text and links, read once and kept for the document's life.
 *
 * Both are small next to a rendered page, and searching again, or tapping a
 * second link on the same page, should not wait on pdf.js.
 */
export class PdfPageData {
	private readonly texts = new Map<number, Promise<PageText>>();
	private readonly links = new Map<number, Promise<PdfLink[]>>();

	constructor(readonly doc: PDFDocumentProxy) {}

	get pageCount(): number {
		return this.doc.numPages;
	}

	/** Page `pdfIndex`'s text. A page that cannot be read has none. */
	textFor(pdfIndex: number): Promise<PageText> {
		let text = this.texts.get(pdfIndex);
		if (!text) {
			text = this.readText(pdfIndex);
			this.texts.set(pdfIndex, text);
		}
		return text;
	}

	/** Page `pdfIndex`'s links. A page that cannot be read has none. */
	linksFor(pdfIndex: number): Promise<PdfLink[]> {
		let links = this.links.get(pdfIndex);
		if (!links) {
			links = this.readLinks(pdfIndex);
			this.links.set(pdfIndex, links);
		}
		return links;
	}

	private async readText(pdfIndex: number): Promise<PageText> {
		try {
			const page = await this.doc.getPage(pdfIndex + 1);
			const content = await page.getTextContent();
			return pageText(content.items.filter(isTextRun));
		} catch (err) {
			console.error('pdf-ink: could not read the text of a page', err);
			return pageText([]);
		}
	}

	private async readLinks(pdfIndex: number): Promise<PdfLink[]> {
		try {
			const page = await this.doc.getPage(pdfIndex + 1);
			return linksFrom(await page.getAnnotations({ intent: 'display' }));
		} catch (err) {
			console.error('pdf-ink: could not read the links of a page', err);
			return [];
		}
	}
}

function isTextRun(item: unknown): item is TextRun {
	if (typeof item !== 'object' || item === null) return false;
	const run = item as Partial<TextRun>;
	return (
		typeof run.str === 'string' &&
		Array.isArray(run.transform) &&
		typeof run.width === 'number' &&
		typeof run.height === 'number'
	);
}
