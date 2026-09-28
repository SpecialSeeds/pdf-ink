/**
 * Creating a PDF from scratch: page sizes, naming, and the ruling a new PDF
 * declares for pages inserted into it later. Pure.
 */

import { MM, type PageTemplate, isPageTemplate } from './templates';

export type NewPdfPageSize = 'letter' | 'a4';

/** Page sizes in PDF points. */
export const PAGE_SIZES: Record<NewPdfPageSize, { width: number; height: number }> = {
	letter: { width: 612, height: 792 },
	a4: { width: 210 * MM, height: 297 * MM },
};

export const PAGE_SIZE_LABELS: Record<NewPdfPageSize, string> = {
	letter: 'Letter',
	a4: 'A4',
};

export function isNewPdfPageSize(value: unknown): value is NewPdfPageSize {
	return value === 'letter' || value === 'a4';
}

/**
 * The keyword a PDF made here carries, naming its ruling.
 *
 * A page of the source PDF has no template of its own, so a page inserted beside
 * one would otherwise start blank. Written into the PDF's own Keywords rather
 * than the sidecar, so the schema is unchanged and the fact travels with the
 * file.
 */
const RULING_KEYWORD = 'pdf-ink-ruling:';

export function rulingKeyword(template: PageTemplate): string {
	return `${RULING_KEYWORD}${template}`;
}

/** The ruling a PDF's Keywords declare, or null for any other PDF. */
export function rulingFromKeywords(keywords: unknown): PageTemplate | null {
	if (typeof keywords !== 'string') return null;
	for (const word of keywords.split(/[\s,;]+/)) {
		if (!word.startsWith(RULING_KEYWORD)) continue;
		const template = word.slice(RULING_KEYWORD.length);
		if (isPageTemplate(template)) return template;
	}
	return null;
}

/**
 * `folder/Untitled.pdf`, or the first `folder/Untitled N.pdf` that is free.
 *
 * `folder` is a vault path, '' or '/' for the root.
 */
export function untitledPdfPath(
	folder: string,
	exists: (path: string) => boolean,
): string {
	const prefix = folder === '' || folder === '/' ? '' : `${folder}/`;
	const base = `${prefix}Untitled`;
	if (!exists(`${base}.pdf`)) return `${base}.pdf`;
	for (let n = 1; ; n++) {
		const candidate = `${base} ${String(n)}.pdf`;
		if (!exists(candidate)) return candidate;
	}
}
