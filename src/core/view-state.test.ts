import { describe, expect, it } from 'vitest';
import { readInkViewState, writeInkViewState } from './view-state';

describe('readInkViewState', () => {
	it('restores a fit-width mode', () => {
		expect(readInkViewState({ zoomMode: 'fit-width' }).zoomMode).toEqual({
			kind: 'fit-width',
		});
	});

	it('restores fit-page', () => {
		expect(readInkViewState({ zoomMode: 'fit-page' }).zoomMode).toEqual({
			kind: 'fit-page',
		});
	});

	it('round-trips every fit mode through write', () => {
		for (const mode of [
			{ kind: 'fit-width' },
			{ kind: 'fit-page' },
		] as const) {
			const written = writeInkViewState(mode, 1.2, 1, 'pdf:0');
			expect(readInkViewState(written).zoomMode).toEqual(mode);
		}
	});

	it('restores a fixed zoom', () => {
		expect(
			readInkViewState({ zoomMode: 'fixed', zoom: 1.5 }).zoomMode,
		).toEqual({ kind: 'fixed', zoom: 1.5 });
	});

	it('ignores a fixed mode with no usable zoom', () => {
		for (const zoom of [0, -1, Number.NaN, '2', null, undefined]) {
			expect(readInkViewState({ zoomMode: 'fixed', zoom }).zoomMode).toBeNull();
		}
	});

	it('reads a page key straight through', () => {
		expect(readInkViewState({ pageKey: 'pdf:7' }).pageKey).toBe('pdf:7');
		expect(readInkViewState({ pageKey: 'ins:abc' }).pageKey).toBe('ins:abc');
	});

	it('falls back to the page number from a pre-insertion workspace', () => {
		// Before pages could be inserted, the display position *was* the original
		// page index, so an old workspace's number still names the right page.
		expect(readInkViewState({ page: 4 }).pageKey).toBe('pdf:3');
		expect(readInkViewState({ page: 1 }).pageKey).toBe('pdf:0');
	});

	it('prefers the key over the number when both are present', () => {
		// The number is written for legibility and drifts as pages are inserted; the
		// key is the authority.
		expect(readInkViewState({ page: 4, pageKey: 'ins:x' }).pageKey).toBe('ins:x');
	});

	it('rejects a key that names no page', () => {
		expect(readInkViewState({ pageKey: 'pdf:' }).pageKey).toBeNull();
		expect(readInkViewState({ pageKey: 'page-3' }).pageKey).toBeNull();
		expect(readInkViewState({ pageKey: 7 }).pageKey).toBeNull();
	});

	it('degrades to defaults for anything unrecognisable', () => {
		for (const state of [null, undefined, 'nonsense', 42, {}, []]) {
			expect(readInkViewState(state)).toEqual({
				zoomMode: null,
				pageKey: null,
				theme: null,
			});
		}
	});

	it('ignores a page number that is not a 1-based integer', () => {
		for (const page of [0, -3, 1.5, '2', null]) {
			expect(readInkViewState({ page }).pageKey).toBeNull();
		}
	});
});

describe('the page theme', () => {
	it('round-trips per tab', () => {
		for (const theme of ['light', 'dark'] as const) {
			const written = writeInkViewState({ kind: 'fit-width' }, 1, 1, null, theme);
			expect(readInkViewState(written).theme).toBe(theme);
		}
	});

	it('is null when absent or unrecognised, so the tab follows Obsidian', () => {
		expect(readInkViewState({}).theme).toBeNull();
		expect(readInkViewState({ theme: 'sepia' }).theme).toBeNull();
		expect('theme' in writeInkViewState({ kind: 'fit-width' }, 1, 1, null)).toBe(false);
	});
});

describe('writeInkViewState', () => {
	it('records the mode, zoom, page number and page key', () => {
		expect(
			writeInkViewState({ kind: 'fixed', zoom: 2 }, 2, 5, 'pdf:4'),
		).toEqual({ zoomMode: 'fixed', zoom: 2, page: 5, pageKey: 'pdf:4' });
	});

	it('omits the key when there is none, rather than writing null', () => {
		const state = writeInkViewState({ kind: 'fit-width' }, 1.3, 1, null);
		expect(state).toEqual({ zoomMode: 'fit-width', zoom: 1.3, page: 1 });
		expect('pageKey' in state).toBe(false);
	});

	it('round-trips through read', () => {
		for (const key of ['pdf:0', 'ins:9f2c', null]) {
			const written = writeInkViewState({ kind: 'fixed', zoom: 3 }, 3, 2, key);
			const read = readInkViewState(written);
			expect(read.zoomMode).toEqual({ kind: 'fixed', zoom: 3 });
			// With no key, the page number fills in — which is right, because a
			// document with no insertions has position equal to index.
			expect(read.pageKey).toBe(key ?? 'pdf:1');
		}
	});
});
