import { describe, expect, it } from 'vitest';
import {
	LINK_CACHE_VERSION,
	isCacheFresh,
	movedWithFolder,
	readLinkCache,
	resolveSourceLinks,
	sameCounts,
	sourceOfStorage,
} from './link-index';

describe('sourceOfStorage', () => {
	it('keys a sidecar by its PDF, a base by its notebook, a notebook by itself', () => {
		expect(sourceOfStorage('a/WS 1.pdf.ink.json')).toBe('a/WS 1.pdf');
		expect(sourceOfStorage('a/Week.inknote.gz')).toBe('a/Week.inknote');
		expect(sourceOfStorage('a/Week.inknote')).toBe('a/Week.inknote');
	});

	it('ignores backups, temp files and everything else', () => {
		expect(sourceOfStorage('a.pdf.ink.json.bak')).toBeNull();
		expect(sourceOfStorage('a.pdf.ink.json.tmp')).toBeNull();
		expect(sourceOfStorage('a.inknote.bak')).toBeNull();
		expect(sourceOfStorage('note.md')).toBeNull();
		expect(sourceOfStorage('a.png.ink.json')).toBeNull();
	});
});

describe('resolveSourceLinks', () => {
	it('counts resolved targets by file and missing links by link path', () => {
		const files: Record<string, string> = { Note: 'notes/Note.md', 'b.pdf': 'pdfs/b.pdf' };
		const result = resolveSourceLinks(['Note', 'b.pdf', 'Note', 'Gone'], (l) => files[l] ?? null);
		expect(result.resolved).toEqual({ 'notes/Note.md': 2, 'pdfs/b.pdf': 1 });
		expect(result.unresolved).toEqual({ Gone: 1 });
		expect(result.targets).toEqual({ Note: 'notes/Note.md', 'b.pdf': 'pdfs/b.pdf' });
	});

	it('resolves each link path once', () => {
		let calls = 0;
		resolveSourceLinks(['a', 'a', 'a'], () => {
			calls++;
			return 'a.md';
		});
		expect(calls).toBe(1);
	});
});

describe('sameCounts', () => {
	it('compares by content, treating absent as empty', () => {
		expect(sameCounts({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
		expect(sameCounts({ a: 1 }, { a: 2 })).toBe(false);
		expect(sameCounts({ a: 1 }, { a: 1, b: 1 })).toBe(false);
		expect(sameCounts(undefined, {})).toBe(true);
	});
});

describe('link cache', () => {
	const entry = { store: 'a.pdf.ink.json', mtime: 5, size: 10, links: ['x'] };

	it('is fresh only for the same store, mtime and size, with its base read', () => {
		expect(isCacheFresh(entry, 'a.pdf.ink.json', { mtime: 5, size: 10 })).toBe(true);
		expect(isCacheFresh(entry, 'a.pdf.ink.json', { mtime: 6, size: 10 })).toBe(false);
		expect(isCacheFresh(entry, 'a.pdf.ink.json', { mtime: 5, size: 11 })).toBe(false);
		expect(isCacheFresh(entry, 'b.pdf.ink.json', { mtime: 5, size: 10 })).toBe(false);
		expect(isCacheFresh({ ...entry, baseMissing: true }, 'a.pdf.ink.json', { mtime: 5, size: 10 })).toBe(false);
		expect(isCacheFresh(undefined, 'a', { mtime: 5, size: 10 })).toBe(false);
	});

	it('reads back what it wrote and drops malformed entries', () => {
		const cache = readLinkCache({
			version: LINK_CACHE_VERSION,
			sources: { 'a.pdf': entry, bad: { store: 1 }, worse: null, 'n.inknote': { ...entry, baseMissing: true } },
		});
		expect(cache.sources).toEqual({ 'a.pdf': entry, 'n.inknote': { ...entry, baseMissing: true } });
		expect(readLinkCache({ version: 999, sources: { 'a.pdf': entry } }).sources).toEqual({});
		expect(readLinkCache('nonsense').sources).toEqual({});
	});
});

describe('movedWithFolder', () => {
	it('moves paths inside the folder only', () => {
		expect(movedWithFolder('math/ws/a.pdf', 'math/ws', 'math/old')).toBe('math/old/a.pdf');
		expect(movedWithFolder('math/wsx/a.pdf', 'math/ws', 'math/old')).toBeNull();
	});
});
