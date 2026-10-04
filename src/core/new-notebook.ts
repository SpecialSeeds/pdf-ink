/**
 * Notebooks: a `.inknote` file that is a v4 ink document with no PDF behind it.
 * Every page is an inserted page. Pure.
 */

import { NOTEBOOK_SUFFIX, serializeInkData } from './ink-serialization';
import { INK_DATA_VERSION, type InkData } from './items';
import { PAGE_SIZES } from './new-pdf';
import {
	type InsertedPage,
	type PageSize,
	createInsertedPage,
	createPageId,
} from './pages';
import type { PageTemplate } from './templates';

/** The extension, without its dot, as Obsidian names it. */
export const NOTEBOOK_EXTENSION = NOTEBOOK_SUFFIX.slice(1);

/** A new notebook's first page: Letter, ruled as a 5 mm grid. */
export const NOTEBOOK_TEMPLATE: PageTemplate = 'grid5';
export const NOTEBOOK_PAGE_SIZE: PageSize = PAGE_SIZES.letter;

/**
 * Writing this close to the bottom of a notebook's last page, as a fraction of
 * its height, appends the next page.
 */
export const APPEND_ZONE = 0.15;

export function isNotebookPath(path: string): boolean {
	return path.toLowerCase().endsWith(NOTEBOOK_SUFFIX);
}

/**
 * The data of a new notebook: one page, nothing on it, and an identity of its
 * own. Every notebook the plugin creates gets a fresh `docId` — a copy that kept
 * its source's would be offered for merging as a sync conflict.
 */
export function newNotebookData(
	now: number,
	id = createPageId(),
	docId = createDocId(),
): InkData {
	const page: InsertedPage = createInsertedPage(
		[],
		0,
		NOTEBOOK_TEMPLATE,
		NOTEBOOK_PAGE_SIZE,
		now,
		id,
	);
	return { version: INK_DATA_VERSION, pages: {}, insertedPages: [page], docId };
}

/** A new notebook's file contents. */
export function newNotebookText(now: number, id?: string, docId?: string): string {
	return serializeInkData(newNotebookData(now, id, docId));
}

/** A fresh notebook identity: a v4 UUID, as page ids are. */
export function createDocId(): string {
	return createPageId();
}

/**
 * The same notebook under a new identity — what a copy must be given, so it is
 * never mistaken for a sync conflict of its source again.
 */
export function withNewDocId(data: InkData, docId = createDocId()): InkData {
	return { ...data, docId };
}

/**
 * Whether `candidate` is named like a sync client's numbered copy of the notebook
 * at `notebookPath`: `Notes 2.inknote` beside `Notes.inknote`. A name alone proves
 * nothing — the user may have made it — so a match is only ever offered for
 * merging when the two also share a `docId`, and never merged without asking.
 */
export function isNumberedCopyName(notebookPath: string, candidate: string): boolean {
	if (!isNotebookPath(notebookPath) || !isNotebookPath(candidate)) return false;
	const stem = notebookPath.slice(0, -NOTEBOOK_SUFFIX.length);
	const rest = candidate.slice(0, -NOTEBOOK_SUFFIX.length);
	if (!rest.startsWith(`${stem} `)) return false;
	return /^\d+$/.test(rest.slice(stem.length + 1));
}

/**
 * Whether an item that reaches down to `itemMinY` should grow the notebook.
 *
 * Only on the last page: writing low on page 2 of 5 means the next page is already
 * there. Coordinates are PDF user space, so y grows upward from `pageMinY`.
 */
export function shouldAppendPage(
	itemMinY: number,
	pageMinY: number,
	pageHeight: number,
	isLastPage: boolean,
): boolean {
	if (!isLastPage || pageHeight <= 0) return false;
	return itemMinY - pageMinY < pageHeight * APPEND_ZONE;
}
