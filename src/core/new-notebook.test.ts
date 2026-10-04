import { describe, expect, it } from 'vitest';
import { parseInkData } from './ink-serialization';
import { untitledPath } from './new-pdf';
import { mergeInkData } from './merge';
import {
	NOTEBOOK_EXTENSION,
	isNotebookPath,
	isNumberedCopyName,
	newNotebookData,
	newNotebookText,
	shouldAppendPage,
	withNewDocId,
} from './new-notebook';
import { orderPages } from './pages';

describe('newNotebookData', () => {
	it('has one Letter grid page and nothing on it', () => {
		const data = newNotebookData(1000, 'p1');
		expect(data.pages).toEqual({});
		expect(data.insertedPages).toHaveLength(1);
		const [page] = data.insertedPages;
		expect(page?.id).toBe('p1');
		expect(page?.template).toBe('grid5');
		expect(page?.size).toEqual({ width: 612, height: 792 });
		expect(page?.afterPdfPage).toBe(-1);
		expect(orderPages(0, data.insertedPages).map((slot) => slot.key)).toEqual(['ins:p1']);
	});

	it('round-trips through the sidecar parser, identity included', () => {
		const parsed = parseInkData(newNotebookText(1000, 'p1', 'doc-1'));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.migrated).toBe(false);
		expect(parsed.data).toEqual(newNotebookData(1000, 'p1', 'doc-1'));
		expect(parsed.data.docId).toBe('doc-1');
	});

	it('gives every new notebook its own identity', () => {
		const a = newNotebookData(1000).docId;
		const b = newNotebookData(1000).docId;
		expect(a).toMatch(/^[0-9a-f-]{36}$/);
		expect(a).not.toBe(b);
	});
});

describe('notebook paths', () => {
	it('recognises the extension in any case', () => {
		expect(NOTEBOOK_EXTENSION).toBe('inknote');
		expect(isNotebookPath('a/Notes.inknote')).toBe(true);
		expect(isNotebookPath('a/Notes.INKNOTE')).toBe(true);
		expect(isNotebookPath('a/Notes.pdf')).toBe(false);
		expect(isNotebookPath('a/Notes.inknote.bak')).toBe(false);
	});

	it('names an untitled notebook like an untitled PDF', () => {
		const taken = new Set(['Untitled.inknote', 'Untitled 1.inknote']);
		expect(untitledPath('', 'inknote', (path) => taken.has(path))).toBe(
			'Untitled 2.inknote',
		);
		expect(untitledPath('Class', 'inknote', () => false)).toBe(
			'Class/Untitled.inknote',
		);
	});
});

describe('notebook identity', () => {
	it('gives a copy a new id and leaves its ink alone', () => {
		const data = newNotebookData(1000, 'p1', 'doc-1');
		const copy = withNewDocId(data);
		expect(copy.docId).not.toBe('doc-1');
		expect(copy.insertedPages).toEqual(data.insertedPages);
	});

	it('keeps our id through a merge, and only fills a missing one', () => {
		const ours = newNotebookData(1000, 'p1', 'ours');
		const theirs = newNotebookData(1000, 'p1', 'theirs');
		expect(mergeInkData(ours, theirs).data.docId).toBe('ours');
		const { docId: _drop, ...anonymous } = ours;
		expect(mergeInkData(anonymous, theirs).data.docId).toBe('theirs');
	});

	it('recognises a numbered copy name in the same folder', () => {
		expect(isNumberedCopyName('a/Notes.inknote', 'a/Notes 2.inknote')).toBe(true);
		expect(isNumberedCopyName('a/Notes.inknote', 'a/Notes 12.inknote')).toBe(true);
		for (const other of [
			'a/Notes.inknote',
			'a/Notes 2.pdf',
			'a/Notes2.inknote',
			'a/Notes two.inknote',
			'a/Notes 2 3.inknote',
			'b/Notes 2.inknote',
			'a/Notes 2/x.inknote',
		]) {
			expect(isNumberedCopyName('a/Notes.inknote', other), other).toBe(false);
		}
	});
});

describe('shouldAppendPage', () => {
	it('appends for writing in the bottom 15% of the last page', () => {
		expect(shouldAppendPage(50, 0, 792, true)).toBe(true);
		expect(shouldAppendPage(118, 0, 792, true)).toBe(true);
		expect(shouldAppendPage(120, 0, 792, true)).toBe(false);
		expect(shouldAppendPage(400, 0, 792, true)).toBe(false);
	});

	it('never appends below a page that is not the last', () => {
		expect(shouldAppendPage(10, 0, 792, false)).toBe(false);
	});

	it('measures from the page bottom, wherever it sits', () => {
		expect(shouldAppendPage(110, 100, 792, true)).toBe(true);
		expect(shouldAppendPage(300, 100, 792, true)).toBe(false);
	});
});
