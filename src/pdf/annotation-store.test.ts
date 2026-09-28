import type { App, TFile } from 'obsidian';
// Imported by path, not via the `obsidian` specifier: the vitest alias makes
// this the same module instance the store itself gets, while tsc sees the
// stub's real shape (the published typings have no Notice.messages).
import { Notice } from '../test/obsidian-stub';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAVE_DEBOUNCE_MS } from '../constants';
import {
	BACKUP_SUFFIX,
	SIDECAR_SUFFIX,
	TEMP_SUFFIX,
	hashContent,
	sidecarPathFor,
} from '../core/ink-serialization';
import type { InkData } from '../core/items';
import { INK_DATA_VERSION } from '../core/items';
import { type InsertedPage, insertedPageKey } from '../core/pages';
import { TOMBSTONE_MAX_AGE_MS } from '../core/merge';
import { DEFAULT_PEN, createStroke } from '../core/stroke';
import { AnnotationStore } from './annotation-store';

const PDF_PATH = 'notes/paper.pdf';
const SIDECAR = sidecarPathFor(PDF_PATH);

/**
 * A vault that models the operations the atomic write needs.
 *
 * `commits` counts completed saves — a save is now a temp write plus two renames,
 * so counting raw writes would no longer mean anything.
 */
class FakeVault {
	readonly files = new Map<string, { data: string; mtime: number }>();
	readonly ops: string[] = [];
	/** Completed atomic writes to the sidecar. */
	commits = 0;
	failWrites = false;
	private clock = 1000;

	private tick(): number {
		this.clock += 1;
		return this.clock;
	}

	private toFile(path: string): TFile {
		const entry = this.files.get(path);
		const name = path.split('/').pop() ?? path;
		return {
			path,
			name,
			basename: name.replace(/\.[^.]+$/, ''),
			extension: name.split('.').pop() ?? '',
			stat: { mtime: entry?.mtime ?? 0, ctime: 0, size: entry?.data.length ?? 0 },
		} as TFile;
	}

	getFileByPath(path: string): TFile | null {
		return this.files.has(path) ? this.toFile(path) : null;
	}

	getFiles(): TFile[] {
		return [...this.files.keys()].map((path) => this.toFile(path));
	}

	read(file: TFile): Promise<string> {
		return Promise.resolve(this.files.get(file.path)?.data ?? '');
	}

	create(path: string, data: string): Promise<void> {
		if (this.failWrites) return Promise.reject(new Error('disk full'));
		this.files.set(path, { data, mtime: this.tick() });
		this.ops.push(`create:${path}`);
		return Promise.resolve();
	}

	modify(file: TFile, data: string): Promise<void> {
		if (this.failWrites) return Promise.reject(new Error('disk full'));
		this.files.set(file.path, { data, mtime: this.tick() });
		this.ops.push(`modify:${file.path}`);
		return Promise.resolve();
	}

	rename(file: TFile, to: string): Promise<void> {
		const entry = this.files.get(file.path);
		if (!entry) return Promise.reject(new Error('missing'));
		if (this.files.has(to)) return Promise.reject(new Error('exists'));
		this.files.delete(file.path);
		this.files.set(to, { data: entry.data, mtime: this.tick() });
		this.ops.push(`rename:${file.path}->${to}`);
		if (to.endsWith(SIDECAR_SUFFIX)) this.commits += 1;
		return Promise.resolve();
	}

	delete(file: TFile): Promise<void> {
		this.files.delete(file.path);
		this.ops.push(`delete:${file.path}`);
		return Promise.resolve();
	}

	/** Simulate another device writing the file behind our back. */
	writeExternally(path: string, data: string): void {
		this.files.set(path, { data, mtime: this.tick() });
	}
}

class FakeFileManager {
	readonly trashed: string[] = [];
	constructor(private readonly vault: FakeVault) {}
	trashFile(file: TFile): Promise<void> {
		this.vault.files.delete(file.path);
		this.trashed.push(file.path);
		return Promise.resolve();
	}
}

interface Harness {
	readonly store: AnnotationStore;
	readonly vault: FakeVault;
	readonly fileManager: FakeFileManager;
	/** Counts the repaint callback, which is how the view learns to redraw. */
	readonly loaded: { count: number };
}

function setup(): Harness {
	const vault = new FakeVault();
	const fileManager = new FakeFileManager(vault);
	const loaded = { count: 0 };
	const app = { vault, fileManager } as unknown as App;
	const store = new AnnotationStore(app, () => {
		loaded.count += 1;
	});
	return { store, vault, fileManager, loaded };
}

function pdfFile(vault: FakeVault, path = PDF_PATH): TFile {
	vault.writeExternally(path, 'fake pdf bytes');
	const found = vault.getFileByPath(path);
	if (!found) throw new Error('unreachable');
	return found;
}

function stroke(id: string) {
	const s = createStroke(DEFAULT_PEN, id);
	s.points.push([100, 700, 0.5], [110, 690, 0.6]);
	return s;
}

beforeEach(() => {
	vi.useFakeTimers();
	Notice.reset();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('debounced saving', () => {
	it('writes nothing until the quiet period elapses', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));

		store.addItem('pdf:0', stroke('a'));
		await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS - 1);
		expect(vault.commits).toBe(0);

		await vi.advanceTimersByTimeAsync(1);
		expect(vault.commits).toBe(1);
	});

	it('coalesces a burst of strokes into one write', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));

		for (let i = 0; i < 10; i++) {
			store.addItem('pdf:0', stroke(`s${String(i)}`));
			// Each stroke restarts the timer.
			await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS - 100);
		}
		expect(vault.commits).toBe(0);

		await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
		expect(vault.commits).toBe(1);
		// All ten strokes made it in.
		const saved: unknown = JSON.parse(vault.files.get(SIDECAR)?.data ?? '{}');
		const pages = (saved as { pages: Record<string, unknown[]> }).pages;
		expect(pages['pdf:0']).toHaveLength(10);
	});

	it('creates the sidecar when missing, then modifies it', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));

		store.addItem('pdf:0', stroke('a'));
		await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
		store.addItem('pdf:1', stroke('b'));
		await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);

		expect(vault.commits).toBe(2);
	});

	it('does not create an empty sidecar for a PDF that was only opened', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));
		await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 4);
		await store.flush();
		expect(vault.commits).toBe(0);
		expect(vault.files.has(SIDECAR)).toBe(false);
	});

	it('a clean store does no I/O on repeated flushes', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));
		store.addItem('pdf:0', stroke('a'));
		await store.flush();
		expect(vault.commits).toBe(1);
		await store.flush();
		await store.flush();
		expect(vault.commits).toBe(1);
	});

	it('surfaces a write failure without throwing', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));
		vault.failWrites = true;
		store.addItem('pdf:0', stroke('a'));
		await expect(store.flush()).resolves.toBeUndefined();
		expect(Notice.messages.join(' ')).toMatch(/could not save/i);
	});
});

describe('flush on close', () => {
	it('writes pending strokes immediately, without waiting out the debounce', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));
		store.addItem('pdf:0', stroke('a'));
		// No timer advance at all — this is the view closing straight away.
		await store.flush();
		expect(vault.commits).toBe(1);
	});

	it('a cancelled debounce cannot fire after the flush', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));
		store.addItem('pdf:0', stroke('a'));
		await store.flush();
		await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 4);
		expect(vault.commits).toBe(1);
	});

	it('discard drops pending work without writing', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));
		store.addItem('pdf:0', stroke('a'));
		store.discard();
		await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 4);
		expect(vault.commits).toBe(0);
	});
});

describe('loading', () => {
	it('reads strokes back from an existing sidecar', async () => {
		const { store, vault } = setup();
		const file = pdfFile(vault);
		vault.writeExternally(
			SIDECAR,
			JSON.stringify({
				version: INK_DATA_VERSION,
				pages: {
					'pdf:2': [
						{
							type: 'stroke',
							id: 'x',
							tool: 'pen',
							color: '#000',
							width: 2,
							opacity: 1,
							rotation: 0,
							z: 0,
							updatedAt: 500,
							points: [[10, 20, 0.5]],
						},
					],
				},
			}),
		);

		await store.load(file);
		expect(store.itemsFor('pdf:2').map((item) => item.id)).toEqual(['x']);
		expect(store.itemsFor('pdf:0')).toEqual([]);
		expect(store.isFrozen).toBe(false);
	});

	it('notifies the view to repaint once strokes have loaded', async () => {
		const { store, vault, loaded } = setup();
		const file = pdfFile(vault);
		vault.writeExternally(
			SIDECAR,
			JSON.stringify({
				version: INK_DATA_VERSION,
				pages: {
					'pdf:0': [
						{
							type: 'stroke',
							id: 'x',
							tool: 'pen',
							color: '#000',
							width: 2,
							opacity: 1,
							rotation: 0,
							z: 0,
							updatedAt: 500,
							points: [[10, 20, 0.5]],
						},
					],
				},
			}),
		);
		await store.load(file);
		expect(loaded.count).toBe(1);
	});

	it('does not ask for a repaint when there is no sidecar', async () => {
		const { store, vault, loaded } = setup();
		await store.load(pdfFile(vault));
		expect(loaded.count).toBe(0);
	});

	it('a freshly loaded store is clean and writes nothing', async () => {
		const { store, vault } = setup();
		const file = pdfFile(vault);
		vault.writeExternally(SIDECAR, JSON.stringify({ version: INK_DATA_VERSION, pages: {} }));
		await store.load(file);
		await store.flush();
		expect(vault.commits).toBe(0);
	});

	it('clears the previous document when loading another', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));
		store.addItem('pdf:0', stroke('a'));
		await store.flush();

		await store.load(pdfFile(vault, 'other/b.pdf'));
		expect(store.itemsFor('pdf:0')).toEqual([]);
	});
});

describe('schema version validation', () => {
	it('freezes on a newer version and never overwrites the file', async () => {
		const { store, vault } = setup();
		const file = pdfFile(vault);
		const original = JSON.stringify({ version: 99, pages: {} });
		vault.writeExternally(SIDECAR, original);

		await store.load(file);
		expect(store.isFrozen).toBe(true);
		expect(Notice.messages.join(' ')).toMatch(/version 99/);

		// Drawing is still allowed, but must not touch the file.
		store.addItem('pdf:0', stroke('a'));
		await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 4);
		await store.flush();
		expect(vault.commits).toBe(0);
		expect(vault.files.get(SIDECAR)?.data).toBe(original);
	});

	it('freezes on unreadable JSON rather than clobbering it', async () => {
		const { store, vault } = setup();
		const file = pdfFile(vault);
		vault.writeExternally(SIDECAR, '{ this is not json');

		await store.load(file);
		expect(store.isFrozen).toBe(true);
		store.addItem('pdf:0', stroke('a'));
		await store.flush();
		expect(vault.commits).toBe(0);
		expect(vault.files.get(SIDECAR)?.data).toBe('{ this is not json');
	});

	it('unfreezes when a later load succeeds', async () => {
		const { store, vault } = setup();
		vault.writeExternally(SIDECAR, JSON.stringify({ version: 99, pages: {} }));
		await store.load(pdfFile(vault));
		expect(store.isFrozen).toBe(true);

		await store.load(pdfFile(vault, 'other/b.pdf'));
		expect(store.isFrozen).toBe(false);
	});
});

describe('deleted PDFs', () => {
	it('a pending save does not resurrect the sidecar of a deleted PDF', async () => {
		const { store, vault } = setup();
		const file = pdfFile(vault);
		await store.load(file);
		store.addItem('pdf:0', stroke('a'));

		// The PDF disappears before the debounce fires.
		vault.files.delete(PDF_PATH);
		await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 4);
		await store.flush();

		expect(vault.commits).toBe(0);
		expect(vault.files.has(SIDECAR)).toBe(false);
	});
});

describe('undo / redo', () => {
	it('nothing to undo or redo on a fresh document', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));
		expect(store.canUndo).toBe(false);
		expect(store.canRedo).toBe(false);
		expect(store.undo()).toBe(false);
		expect(store.redo()).toBe(false);
	});

	it('undoes and redoes a single stroke', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));
		store.addItem('pdf:0', stroke('a'));
		expect(store.canUndo).toBe(true);

		expect(store.undo()).toBe(true);
		expect(store.itemsFor('pdf:0')).toEqual([]);
		expect(store.canRedo).toBe(true);

		expect(store.redo()).toBe(true);
		expect(store.itemsFor('pdf:0').map((item) => item.id)).toEqual(['a']);
	});

	it('undoes strokes newest first', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));
		store.addItem('pdf:0', stroke('a'));
		store.addItem('pdf:0', stroke('b'));
		store.addItem('pdf:0', stroke('c'));

		store.undo();
		expect(store.itemsFor('pdf:0').map((item) => item.id)).toEqual(['a', 'b']);
		store.undo();
		expect(store.itemsFor('pdf:0').map((item) => item.id)).toEqual(['a']);
		store.redo();
		expect(store.itemsFor('pdf:0').map((item) => item.id)).toEqual(['a', 'b']);
	});

	it('restores erased strokes to their original z-order, not the end', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));
		for (const id of ['a', 'b', 'c', 'd']) store.addItem('pdf:0', stroke(id));

		const before = store.itemsFor('pdf:0');
		// Erase the two in the middle, as one eraser gesture.
		const refs = [1, 2].map((index) => {
			const s = before[index];
			if (!s) throw new Error('unreachable');
			return { pageKey: 'pdf:0', index, item: s };
		});
		store.removeItems(refs);
		expect(store.itemsFor('pdf:0').map((item) => item.id)).toEqual(['a', 'd']);

		// One undo brings the whole gesture back, in place.
		expect(store.undo()).toBe(true);
		expect(store.itemsFor('pdf:0').map((item) => item.id)).toEqual(['a', 'b', 'c', 'd']);
	});

	it('an eraser gesture is a single undo step', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));
		for (const id of ['a', 'b', 'c']) store.addItem('pdf:0', stroke(id));
		const all = store.itemsFor('pdf:0');
		store.removeItems(
			all.map((item, index) => ({ pageKey: 'pdf:0', index, item })),
		);
		expect(store.itemsFor('pdf:0')).toEqual([]);

		store.undo();
		expect(store.itemsFor('pdf:0')).toHaveLength(3);
		// The three adds are still individually undoable beneath it.
		expect(store.canUndo).toBe(true);
	});

	it('erasing nothing records no history', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));
		store.removeItems([]);
		expect(store.canUndo).toBe(false);
	});

	it('redo is discarded once a new stroke is drawn', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));
		store.addItem('pdf:0', stroke('a'));
		store.undo();
		expect(store.canRedo).toBe(true);
		store.addItem('pdf:0', stroke('b'));
		expect(store.canRedo).toBe(false);
		expect(store.itemsFor('pdf:0').map((item) => item.id)).toEqual(['b']);
	});

	it('an undo is persisted like any other change', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));
		store.addItem('pdf:0', stroke('a'));
		await store.flush();
		expect(vault.commits).toBe(1);

		store.undo();
		await store.flush();
		expect(vault.commits).toBe(2);

		// The undone stroke is written as a tombstone, not removed: another device
		// holding the old copy must learn that it is gone.
		const saved: unknown = JSON.parse(vault.files.get(SIDECAR)?.data ?? '{}');
		const page = (saved as { pages: Record<string, { deletedAt?: number }[]> })
			.pages['pdf:0'];
		expect(page).toHaveLength(1);
		expect(page?.[0]?.deletedAt).toBeGreaterThan(0);
		expect(store.itemsFor('pdf:0')).toEqual([]);
	});

	it('history does not survive switching documents', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));
		store.addItem('pdf:0', stroke('a'));
		expect(store.canUndo).toBe(true);

		await store.load(pdfFile(vault, 'other/b.pdf'));
		expect(store.canUndo).toBe(false);
		expect(store.canRedo).toBe(false);
	});

	it('undo across separate pages affects only its own page', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));
		store.addItem('pdf:0', stroke('a'));
		store.addItem('pdf:4', stroke('b'));

		store.undo();
		expect(store.itemsFor('pdf:4')).toEqual([]);
		expect(store.itemsFor('pdf:0').map((item) => item.id)).toEqual(['a']);
	});

	it('a frozen sidecar still allows undo, but writes nothing', async () => {
		const { store, vault } = setup();
		vault.writeExternally(SIDECAR, JSON.stringify({ version: 99, pages: {} }));
		await store.load(pdfFile(vault));
		store.addItem('pdf:0', stroke('a'));
		expect(store.undo()).toBe(true);
		await store.flush();
		expect(vault.commits).toBe(0);
	});
});

describe('v1 sidecars are upgraded on disk', () => {
	const V1_SIDECAR = JSON.stringify({
		version: 1,
		pages: {
			'pdf:0': [
				{
					id: 'old',
					tool: 'pen',
					color: '#111',
					width: 2,
					opacity: 1,
					points: [[10, 20, 0.5]],
				},
			],
		},
	});

	it('loads a v1 file and rewrites it at the current version without waiting for an edit', async () => {
		const { store, vault } = setup();
		vault.writeExternally(SIDECAR, V1_SIDECAR);
		await store.load(pdfFile(vault));

		// The migration itself leaves the store dirty, so the upgrade is written.
		await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
		expect(vault.commits).toBe(1);

		const saved: unknown = JSON.parse(vault.files.get(SIDECAR)?.data ?? '{}');
		const doc = saved as {
			version: number;
			pages: Record<string, { type: string; id: string; z: number }[]>;
		};
		expect(doc.version).toBe(INK_DATA_VERSION);
		expect(doc.pages['pdf:0']?.[0]?.type).toBe('stroke');
		expect(doc.pages['pdf:0']?.[0]?.id).toBe('old');
		expect(doc.pages['pdf:0']?.[0]?.z).toBe(0);
	});

	it('the migrated strokes are available immediately', async () => {
		const { store, vault } = setup();
		vault.writeExternally(SIDECAR, V1_SIDECAR);
		await store.load(pdfFile(vault));
		expect(store.itemsFor('pdf:0').map((i) => i.id)).toEqual(['old']);
	});

	it('reopening the upgraded file writes nothing further', async () => {
		const { store, vault } = setup();
		vault.writeExternally(SIDECAR, V1_SIDECAR);
		await store.load(pdfFile(vault));
		await store.flush();
		const afterUpgrade = vault.commits;

		await store.load(pdfFile(vault));
		await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 2);
		await store.flush();
		expect(vault.commits).toBe(afterUpgrade);
	});

	it('a v1 file with nothing in it still upgrades rather than being left behind', async () => {
		const { store, vault } = setup();
		vault.writeExternally(SIDECAR, JSON.stringify({ version: 1, pages: {} }));
		await store.load(pdfFile(vault));
		await store.flush();
		const saved: unknown = JSON.parse(vault.files.get(SIDECAR)?.data ?? '{}');
		expect((saved as { version: number }).version).toBe(INK_DATA_VERSION);
	});

	it('migration does not start a history the user could undo into', async () => {
		const { store, vault } = setup();
		vault.writeExternally(SIDECAR, V1_SIDECAR);
		await store.load(pdfFile(vault));
		expect(store.canUndo).toBe(false);
	});
});

describe('atomic writes', () => {
	it('writes through a temp file and leaves none behind', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));
		store.addItem('pdf:0', stroke('a'));
		await store.flush();

		expect(vault.files.has(SIDECAR)).toBe(true);
		// The temp file is renamed into place, never left lying around.
		expect(vault.files.has(`${SIDECAR}.tmp`)).toBe(false);
		expect(vault.ops.some((op) => op.includes('.tmp'))).toBe(true);
	});

	it('the new contents are complete before anything is moved', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));
		store.addItem('pdf:0', stroke('a'));
		await store.flush();

		const tempWrite = vault.ops.findIndex((op) => op.startsWith('create:') && op.includes('.tmp'));
		const rename = vault.ops.findIndex((op) => op.endsWith(`->${SIDECAR}`));
		expect(tempWrite).toBeGreaterThanOrEqual(0);
		expect(rename).toBeGreaterThan(tempWrite);
	});

	it('keeps the previous version as a .bak', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));
		store.addItem('pdf:0', stroke('first'));
		await store.flush();
		const afterFirst = vault.files.get(SIDECAR)?.data ?? '';

		store.addItem('pdf:0', stroke('second'));
		await store.flush();

		expect(vault.files.get(`${SIDECAR}.bak`)?.data).toBe(afterFirst);
		expect(vault.files.get(SIDECAR)?.data).toContain('second');
	});

	it('keeps only one .bak, however many times it is saved', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));
		for (const id of ['a', 'b', 'c', 'd']) {
			store.addItem('pdf:0', stroke(id));
			await store.flush();
		}
		const backups = [...vault.files.keys()].filter((path) => path.endsWith('.bak'));
		expect(backups).toEqual([`${SIDECAR}.bak`]);
	});

	it('takes the .bak once per open, not on every save', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));
		store.addItem('pdf:0', stroke('first'));
		await store.flush();
		const afterFirst = vault.files.get(SIDECAR)?.data ?? '';
		for (const id of ['second', 'third', 'fourth']) {
			store.addItem('pdf:0', stroke(id));
			await store.flush();
		}
		expect(vault.files.get(`${SIDECAR}.bak`)?.data).toBe(afterFirst);
		expect(vault.files.get(SIDECAR)?.data).toContain('fourth');
		expect(vault.files.has(`${SIDECAR}.tmp`)).toBe(false);

		// Reopening takes a fresh one.
		await store.load(pdfFile(vault));
		const onReopen = vault.files.get(SIDECAR)?.data ?? '';
		store.addItem('pdf:0', stroke('fifth'));
		await store.flush();
		expect(vault.files.get(`${SIDECAR}.bak`)?.data).toBe(onReopen);
	});

	it('the first save makes no .bak, because there was nothing to back up', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));
		store.addItem('pdf:0', stroke('a'));
		await store.flush();
		expect(vault.files.has(`${SIDECAR}.bak`)).toBe(false);
	});
});

describe('external changes are merged, not overwritten', () => {
	/**
	 * A timestamp newer than anything the store will stamp locally.
	 *
	 * The store stamps edits with the real clock, so a merge compares against
	 * epoch milliseconds — a small synthetic number would always lose.
	 */
	const newer = (): number => Date.now() + 60_000;

	/** A sidecar as another device would have written it. */
	function remoteSidecar(id: string, updatedAt: number, deleted = false): string {
		return JSON.stringify({
			version: INK_DATA_VERSION,
			pages: {
				'pdf:0': [
					{
						type: 'stroke',
						id,
						tool: 'pen',
						color: '#222222',
						width: 2,
						opacity: 1,
						rotation: 0,
						z: 0,
						updatedAt,
						...(deleted ? { deletedAt: updatedAt } : {}),
						points: [[5, 5, 0.5]],
					},
				],
			},
		});
	}

	it('folds in a remote addition instead of clobbering it', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));
		store.addItem('pdf:0', stroke('mine'));
		await store.flush();

		// Another device writes the file behind our back.
		vault.writeExternally(SIDECAR, remoteSidecar('theirs', newer()));

		store.addItem('pdf:0', stroke('later'));
		await store.flush();

		const ids = store.itemsFor('pdf:0').map((item) => item.id);
		expect(ids).toContain('theirs');
		expect(ids).toContain('mine');
		expect(ids).toContain('later');
	});

	it('our newer edit survives their older delete', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));
		store.addItem('pdf:0', stroke('shared'));
		await store.flush();

		// Their delete is older than our edit, so the stroke stays.
		vault.writeExternally(SIDECAR, remoteSidecar('shared', 1000, true));
		await store.reconcile();
		expect(store.itemsFor('pdf:0').map((item) => item.id)).toContain('shared');
	});

	it('a remote delete of our item wins when it is newer', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));
		store.addItem('pdf:0', stroke('shared'));
		await store.flush();

		// Their delete happened after our edit, so it wins.
		vault.writeExternally(SIDECAR, remoteSidecar('shared', newer(), true));
		await store.reconcile();

		expect(store.itemsFor('pdf:0').map((item) => item.id)).not.toContain('shared');
	});

	it('reconciling twice does nothing the second time', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));
		store.addItem('pdf:0', stroke('a'));
		await store.flush();
		vault.writeExternally(SIDECAR, remoteSidecar('theirs', newer()));

		await store.reconcile();
		const after = store.version;
		await store.reconcile();
		expect(store.version).toBe(after);
	});

	it('our own write is not mistaken for someone else\'s', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));
		store.addItem('pdf:0', stroke('a'));
		await store.flush();
		const commits = vault.commits;

		// Nothing external happened, so reconciling must not merge or rewrite.
		await store.reconcile();
		await store.flush();
		expect(vault.commits).toBe(commits);
	});

	it('handleExternalChange ignores files that are not our sidecar', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));
		const other = vault.getFileByPath(PDF_PATH);
		expect(other).not.toBeNull();
		if (!other) return;
		// Must not throw, and must not touch our state.
		store.handleExternalChange(other);
		expect(store.itemsFor('pdf:0')).toEqual([]);
	});
});

describe('sync conflict copies', () => {
	function conflictBody(id: string): string {
		return JSON.stringify({
			version: INK_DATA_VERSION,
			pages: {
				'pdf:0': [
					{
						type: 'stroke',
						id,
						tool: 'pen',
						color: '#333333',
						width: 2,
						opacity: 1,
						rotation: 0,
						z: 0,
						updatedAt: 8_000_000,
						points: [[7, 7, 0.5]],
					},
				],
			},
		});
	}

	it('merges a conflict copy on load and removes it', async () => {
		const { store, vault, fileManager } = setup();
		const file = pdfFile(vault);
		vault.writeExternally(SIDECAR, conflictBody('ours'));
		const conflictPath = `${PDF_PATH}.ink (conflict).json`;
		vault.writeExternally(conflictPath, conflictBody('theirs'));

		await store.load(file);

		expect(store.itemsFor('pdf:0').map((item) => item.id).sort()).toEqual([
			'ours',
			'theirs',
		]);
		// Trashed, not deleted: a bad merge has to be recoverable.
		expect(fileManager.trashed).toEqual([conflictPath]);
		expect(vault.files.has(conflictPath)).toBe(false);
	});

	it('merges and removes the numbered copies iCloud Drive leaves', async () => {
		const { store, vault, fileManager } = setup();
		const file = pdfFile(vault);
		vault.writeExternally(SIDECAR, conflictBody('ours'));
		const copies = [
			`${PDF_PATH}.ink 2.json`,
			`${PDF_PATH}.ink.json 3.bak`,
			`${PDF_PATH}.ink.json.json`,
		];
		copies.forEach((path, index) => {
			vault.writeExternally(path, conflictBody(`copy${String(index)}`));
		});

		await store.load(file);

		expect(store.itemsFor('pdf:0').map((item) => item.id).sort()).toEqual([
			'copy0',
			'copy1',
			'copy2',
			'ours',
		]);
		expect([...fileManager.trashed].sort()).toEqual([...copies].sort());
	});

	it('rewrites an indented sidecar compactly on open', async () => {
		const { store, vault } = setup();
		const file = pdfFile(vault);
		vault.writeExternally(
			SIDECAR,
			JSON.stringify(JSON.parse(conflictBody('ours')), null, '\t'),
		);

		await store.load(file);
		await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);

		const written = vault.files.get(SIDECAR)?.data ?? '';
		expect(written).not.toContain('\t');
		expect(written).toContain('"ours"');
	});

	it('writes the merged result back to the sidecar', async () => {
		const { store, vault } = setup();
		const file = pdfFile(vault);
		vault.writeExternally(SIDECAR, conflictBody('ours'));
		vault.writeExternally(`${PDF_PATH}.ink (conflict).json`, conflictBody('theirs'));

		await store.load(file);
		await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);

		const saved: unknown = JSON.parse(vault.files.get(SIDECAR)?.data ?? '{}');
		const ids = (saved as { pages: Record<string, { id: string }[]> }).pages[
			'pdf:0'
		]?.map((item) => item.id);
		expect(ids?.sort()).toEqual(['ours', 'theirs']);
	});

	it('merges several conflict copies at once', async () => {
		const { store, vault, fileManager } = setup();
		const file = pdfFile(vault);
		vault.writeExternally(SIDECAR, conflictBody('ours'));
		vault.writeExternally(`${PDF_PATH}.ink (conflict).json`, conflictBody('a'));
		vault.writeExternally(
			`${PDF_PATH}.ink (conflict 2024-01-02 03.04.05).json`,
			conflictBody('b'),
		);

		await store.load(file);
		expect(store.itemsFor('pdf:0')).toHaveLength(3);
		expect(fileManager.trashed).toHaveLength(2);
	});

	it('leaves an unreadable conflict copy alone rather than losing it', async () => {
		const { store, vault, fileManager } = setup();
		const file = pdfFile(vault);
		vault.writeExternally(SIDECAR, conflictBody('ours'));
		const broken = `${PDF_PATH}.ink (conflict).json`;
		vault.writeExternally(broken, 'not json at all');

		await store.load(file);
		expect(store.itemsFor('pdf:0').map((item) => item.id)).toEqual(['ours']);
		// Kept on disk, so the user can look at it.
		expect(fileManager.trashed).toEqual([]);
		expect(vault.files.has(broken)).toBe(true);
	});

	it('ignores unrelated json beside the sidecar', async () => {
		const { store, vault, fileManager } = setup();
		const file = pdfFile(vault);
		vault.writeExternally(SIDECAR, conflictBody('ours'));
		vault.writeExternally('notes/unrelated.json', conflictBody('nope'));
		vault.writeExternally(`${PDF_PATH}.ink.json.bak`, conflictBody('backup'));

		await store.load(file);
		expect(store.itemsFor('pdf:0').map((item) => item.id)).toEqual(['ours']);
		expect(fileManager.trashed).toEqual([]);
	});
});

describe('recovering an interrupted save', () => {
	function body(id: string, updatedAt = 5000): string {
		return JSON.stringify({
			version: INK_DATA_VERSION,
			pages: {
				'pdf:0': [
					{
						type: 'stroke',
						id,
						tool: 'pen',
						color: '#444444',
						width: 2,
						opacity: 1,
						rotation: 0,
						z: 0,
						updatedAt,
						points: [[1, 2, 0.5]],
					},
				],
			},
		});
	}

	it('recovers from .tmp when the sidecar is missing', async () => {
		const { store, vault } = setup();
		const file = pdfFile(vault);
		// A crash between the two renames: the new contents are in .tmp.
		vault.writeExternally(`${SIDECAR}${TEMP_SUFFIX}`, body('from-tmp'));

		await store.load(file);

		expect(store.itemsFor('pdf:0').map((item) => item.id)).toEqual(['from-tmp']);
		// The temp file is promoted, not left behind.
		expect(vault.files.has(SIDECAR)).toBe(true);
		expect(vault.files.has(`${SIDECAR}${TEMP_SUFFIX}`)).toBe(false);
	});

	it('prefers .tmp over .bak, because it is the newer of the two', async () => {
		const { store, vault } = setup();
		const file = pdfFile(vault);
		vault.writeExternally(`${SIDECAR}${BACKUP_SUFFIX}`, body('older'));
		vault.writeExternally(`${SIDECAR}${TEMP_SUFFIX}`, body('newer'));

		await store.load(file);
		expect(store.itemsFor('pdf:0').map((item) => item.id)).toEqual(['newer']);
	});

	it('falls back to .bak when the temp file is half written', async () => {
		const { store, vault } = setup();
		const file = pdfFile(vault);
		// A truncated temp file is worse than the backup.
		vault.writeExternally(`${SIDECAR}${TEMP_SUFFIX}`, '{"version":3,"pag');
		vault.writeExternally(`${SIDECAR}${BACKUP_SUFFIX}`, body('from-bak'));

		await store.load(file);
		expect(store.itemsFor('pdf:0').map((item) => item.id)).toEqual(['from-bak']);
	});

	it('recovers from .bak alone', async () => {
		const { store, vault } = setup();
		const file = pdfFile(vault);
		vault.writeExternally(`${SIDECAR}${BACKUP_SUFFIX}`, body('from-bak'));
		await store.load(file);
		expect(store.itemsFor('pdf:0').map((item) => item.id)).toEqual(['from-bak']);
	});

	it('loads empty when neither is usable', async () => {
		const { store, vault } = setup();
		const file = pdfFile(vault);
		vault.writeExternally(`${SIDECAR}${TEMP_SUFFIX}`, 'broken');
		vault.writeExternally(`${SIDECAR}${BACKUP_SUFFIX}`, 'also broken');
		await store.load(file);
		expect(store.itemsFor('pdf:0')).toEqual([]);
		expect(store.isFrozen).toBe(false);
	});

	it('does not touch the sidecar when it is present', async () => {
		const { store, vault } = setup();
		const file = pdfFile(vault);
		vault.writeExternally(SIDECAR, body('real'));
		vault.writeExternally(`${SIDECAR}${TEMP_SUFFIX}`, body('stale-tmp'));

		await store.load(file);
		expect(store.itemsFor('pdf:0').map((item) => item.id)).toEqual(['real']);
		// A leftover temp file is left alone rather than promoted over a live file.
		expect(vault.files.has(`${SIDECAR}${TEMP_SUFFIX}`)).toBe(true);
	});
});

describe('our own writes are not treated as external', () => {
	it('a modify event whose content matches our last write is ignored', async () => {
		const { store, vault, loaded } = setup();
		await store.load(pdfFile(vault));
		store.addItem('pdf:0', stroke('a'));
		await store.flush();

		const sidecar = vault.getFileByPath(SIDECAR);
		expect(sidecar).not.toBeNull();
		if (!sidecar) return;
		const before = loaded.count;
		const version = store.version;

		// The vault reports our own write back to us.
		store.handleExternalChange(sidecar);
		await vi.advanceTimersByTimeAsync(0);

		// No merge, so no repaint and no revision bump.
		expect(loaded.count).toBe(before);
		expect(store.version).toBe(version);
	});

	it('the same content at a new mtime is still ignored', async () => {
		const { store, vault, loaded } = setup();
		await store.load(pdfFile(vault));
		store.addItem('pdf:0', stroke('a'));
		await store.flush();

		// A sync client rewriting byte-identical content bumps the mtime only.
		const current = vault.files.get(SIDECAR)?.data ?? '';
		vault.writeExternally(SIDECAR, current);
		const before = loaded.count;

		await store.reconcile();
		expect(loaded.count).toBe(before);
	});

	it('genuinely different content is still merged', async () => {
		const { store, vault, loaded } = setup();
		await store.load(pdfFile(vault));
		store.addItem('pdf:0', stroke('mine'));
		await store.flush();
		const before = loaded.count;

		vault.writeExternally(
			SIDECAR,
			JSON.stringify({
				version: INK_DATA_VERSION,
				pages: {
					'pdf:0': [
						{
							type: 'stroke',
							id: 'theirs',
							tool: 'pen',
							color: '#555555',
							width: 2,
							opacity: 1,
							rotation: 0,
							z: 0,
							updatedAt: Date.now() + 60_000,
							points: [[3, 4, 0.5]],
						},
					],
				},
			}),
		);

		await store.reconcile();
		expect(loaded.count).toBeGreaterThan(before);
		expect(store.itemsFor('pdf:0').map((item) => item.id)).toContain('theirs');
	});

	it('hashContent distinguishes content and matches itself', () => {
		expect(hashContent('a')).toBe(hashContent('a'));
		expect(hashContent('a')).not.toBe(hashContent('b'));
		expect(hashContent('')).toHaveLength(8);
	});
});

describe('tombstones are pruned on save', () => {
	/** A sidecar holding one tombstone of a given age. */
	function tombstoneBody(deletedAt: number): string {
		return JSON.stringify({
			version: INK_DATA_VERSION,
			pages: {
				'pdf:0': [
					{
						type: 'stroke',
						id: 'ancient',
						tool: 'pen',
						color: '#666666',
						width: 2,
						opacity: 1,
						rotation: 0,
						z: 0,
						updatedAt: deletedAt,
						deletedAt,
						points: [[1, 1, 0.5]],
					},
				],
			},
		});
	}

	function savedIds(vault: FakeVault): string[] {
		const saved: unknown = JSON.parse(vault.files.get(SIDECAR)?.data ?? '{}');
		return (
			(saved as { pages: Record<string, { id: string }[]> }).pages['pdf:0'] ?? []
		).map((item) => item.id);
	}

	it('drops a tombstone older than the window', async () => {
		const { store, vault } = setup();
		// Deleted long before the window opens.
		vault.writeExternally(SIDECAR, tombstoneBody(1));
		await store.load(pdfFile(vault));

		store.addItem('pdf:0', stroke('fresh'));
		await store.flush();

		expect(savedIds(vault)).toEqual(['fresh']);
	});

	it('keeps a recent tombstone, so a stale device cannot resurrect it', async () => {
		const { store, vault } = setup();
		vault.writeExternally(SIDECAR, tombstoneBody(Date.now() - 1000));
		await store.load(pdfFile(vault));

		store.addItem('pdf:0', stroke('fresh'));
		await store.flush();

		expect(savedIds(vault).sort()).toEqual(['ancient', 'fresh']);
	});

	it('keeps a tombstone right up to the edge of the window', async () => {
		const { store, vault } = setup();
		vault.writeExternally(
			SIDECAR,
			tombstoneBody(Date.now() - TOMBSTONE_MAX_AGE_MS + 60_000),
		);
		await store.load(pdfFile(vault));
		store.addItem('pdf:0', stroke('fresh'));
		await store.flush();
		expect(savedIds(vault)).toContain('ancient');
	});

	it('never prunes a live item', async () => {
		const { store, vault } = setup();
		await store.load(pdfFile(vault));
		store.addItem('pdf:0', stroke('alive'));
		await store.flush();
		expect(savedIds(vault)).toEqual(['alive']);
	});
});

describe('inserted pages', () => {
	const KEY = insertedPageKey('p1');

	function newPage(over: Partial<InsertedPage> = {}): InsertedPage {
		return {
			id: 'p1',
			afterPdfPage: 0,
			sortKey: 'a0',
			template: 'blank',
			size: { width: 595, height: 842 },
			updatedAt: Date.now(),
			...over,
		};
	}

	async function withPage(): Promise<Harness> {
		const harness = setup();
		await harness.store.load(pdfFile(harness.vault));
		harness.store.insertPage(newPage());
		return harness;
	}

	it('adds a page record', async () => {
		const { store } = await withPage();
		expect(store.insertedPages().map((page) => page.id)).toEqual(['p1']);
	});

	it('undoes and redoes an insertion', async () => {
		const { store } = await withPage();
		expect(store.undo()).toBe(true);
		expect(store.insertedPages()).toEqual([]);
		expect(store.redo()).toBe(true);
		expect(store.insertedPages().map((page) => page.id)).toEqual(['p1']);
	});

	it('changes a template as one undoable step', async () => {
		const { store } = await withPage();
		store.setPageTemplate('p1', 'grid5');
		expect(store.insertedPages()[0]?.template).toBe('grid5');
		expect(store.undo()).toBe(true);
		expect(store.insertedPages()[0]?.template).toBe('blank');
		expect(store.redo()).toBe(true);
		expect(store.insertedPages()[0]?.template).toBe('grid5');
	});

	it('records nothing when the template is already what was asked for', async () => {
		const { store } = await withPage();
		store.undo();
		expect(store.canUndo).toBe(false);
		store.setPageTemplate('p1', 'blank');
		expect(store.canUndo).toBe(false);
	});

	it('ignores a template change for a page that does not exist', async () => {
		const { store } = await withPage();
		store.setPageTemplate('nope', 'dot');
		expect(store.insertedPages()[0]?.template).toBe('blank');
	});

	describe('deleting a page', () => {
		async function withInk(): Promise<Harness> {
			const harness = await withPage();
			harness.store.addItem(KEY, stroke('a'));
			harness.store.addItem(KEY, stroke('b'));
			// Ink elsewhere, which must be left alone.
			harness.store.addItem('pdf:0', stroke('elsewhere'));
			return harness;
		}

		it('tombstones the page and its items together', async () => {
			const { store } = await withInk();
			store.deletePage('p1');
			expect(store.insertedPages()).toEqual([]);
			expect(store.itemsFor(KEY)).toEqual([]);
			// One operation, so one undo brings back both.
			expect(store.canUndo).toBe(true);
		});

		it('leaves other pages untouched', async () => {
			const { store } = await withInk();
			store.deletePage('p1');
			expect(store.itemsFor('pdf:0').map((item) => item.id)).toEqual([
				'elsewhere',
			]);
		});

		it('restores the page and its items with a single undo', async () => {
			const { store } = await withInk();
			store.deletePage('p1');
			expect(store.undo()).toBe(true);
			expect(store.insertedPages().map((page) => page.id)).toEqual(['p1']);
			expect(store.itemsFor(KEY).map((item) => item.id)).toEqual(['a', 'b']);
		});

		it('restores items in their original order', async () => {
			const { store } = await withInk();
			store.deletePage('p1');
			store.undo();
			// Not merely present: in the order they were drawn, so z and paint order
			// survive the round trip.
			expect(store.itemsFor(KEY).map((item) => item.z)).toEqual([0, 1]);
		});

		it('redoes the deletion of both', async () => {
			const { store } = await withInk();
			store.deletePage('p1');
			store.undo();
			expect(store.redo()).toBe(true);
			expect(store.insertedPages()).toEqual([]);
			expect(store.itemsFor(KEY)).toEqual([]);
		});

		it('deletes a page holding nothing', async () => {
			const { store } = await withPage();
			store.deletePage('p1');
			expect(store.insertedPages()).toEqual([]);
			expect(store.undo()).toBe(true);
			expect(store.insertedPages()).toHaveLength(1);
		});

		it('does nothing twice over', async () => {
			const { store } = await withInk();
			store.deletePage('p1');
			const undos = store.canUndo;
			store.deletePage('p1');
			// The second call must not push an empty operation onto the history.
			store.undo();
			expect(undos).toBe(true);
			expect(store.insertedPages().map((page) => page.id)).toEqual(['p1']);
		});

		it('ignores an id that is not a page here', async () => {
			const { store } = await withInk();
			store.deletePage('nope');
			expect(store.insertedPages()).toHaveLength(1);
		});
	});

	describe('persistence', () => {
		it('writes page records to the sidecar', async () => {
			const { store, vault } = await withPage();
			store.addItem(KEY, stroke('a'));
			await store.flush();

			const saved = JSON.parse(
				vault.files.get(SIDECAR)?.data ?? 'null',
			) as InkData;
			expect(saved.version).toBe(INK_DATA_VERSION);
			expect(saved.insertedPages.map((page) => page.id)).toEqual(['p1']);
			expect(saved.pages[KEY]).toHaveLength(1);
		});

		it('reads page records back', async () => {
			const { store, vault } = await withPage();
			await store.flush();

			const reopened = setup();
			reopened.vault.writeExternally(
				SIDECAR,
				vault.files.get(SIDECAR)?.data ?? '',
			);
			await reopened.store.load(pdfFile(reopened.vault));
			expect(reopened.store.insertedPages().map((page) => page.id)).toEqual([
				'p1',
			]);
		});

		it('keeps a page tombstone on disk, so a delete cannot be undone by sync', async () => {
			const { store, vault } = await withPage();
			await store.flush();
			store.deletePage('p1');
			await store.flush();

			const saved = JSON.parse(
				vault.files.get(SIDECAR)?.data ?? 'null',
			) as InkData;
			expect(saved.insertedPages).toHaveLength(1);
			expect(saved.insertedPages[0]?.deletedAt).toBeGreaterThan(0);
		});

		it('merges a page another device inserted', async () => {
			const { store, vault } = await withPage();
			await store.flush();

			// A second page arrives on disk while this one is open.
			const onDisk = JSON.parse(
				vault.files.get(SIDECAR)?.data ?? 'null',
			) as InkData;
			vault.writeExternally(
				SIDECAR,
				JSON.stringify({
					...onDisk,
					insertedPages: [
						...onDisk.insertedPages,
						{ ...newPage({ id: 'p2', sortKey: 'a1' }), updatedAt: Date.now() + 60_000 },
					],
				}),
			);
			await store.reconcile();
			expect(store.insertedPages().map((page) => page.id).sort()).toEqual([
				'p1',
				'p2',
			]);
		});
	});
});
