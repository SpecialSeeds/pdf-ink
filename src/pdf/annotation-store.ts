import { type App, type Debouncer, Notice, type TFile, debounce } from 'obsidian';
import { SAVE_DEBOUNCE_MS } from '../constants';
import { INK_DATA_VERSION } from '../core/items';
import {
	InkHistory,
	type InkOperation,
	type ItemChange,
	type ItemRef,
	invert,
	sortForInsert,
} from '../core/history';
import {
	BACKUP_SUFFIX,
	TEMP_SUFFIX,
	hashContent,
	isConflictCopy,
	isIndented,
	isSyncLeftover,
	parseInkData,
	serializeInkData,
	sidecarPathFor,
} from '../core/ink-serialization';
import {
	TOMBSTONE_MAX_AGE_MS,
	mergeInkData,
	pruneTombstones,
} from '../core/merge';
import {
	type InsertedPage,
	insertedPageKey,
	isLivePage,
} from '../core/pages';
import type { PageTemplate } from '../core/templates';
import type { InkData } from '../core/items';
import type { PageKey } from '../core/pages';
import { InkStore, type ItemStore } from '../core/ink-store';
import type { Item } from '../core/items';

/**
 * Strokes for one open PDF, backed by its `<file>.ink.json` sidecar.
 *
 * Writes are debounced so a burst of strokes costs one file write, and flushed on
 * close so nothing is lost. The source PDF is never touched.
 */
export class AnnotationStore implements ItemStore {
	private readonly ink = new InkStore();
	private readonly history = new InkHistory();
	/**
	 * The sidecar's mtime as we last saw it. A mismatch means someone else — a
	 * sync client, or this vault on another device — has written it since.
	 */
	private lastSeenMtime = 0;
	/**
	 * Hash of the last content we wrote or read.
	 *
	 * The vault reports a modify event for our own writes too. Comparing content
	 * rather than mtime means a save never triggers a pointless merge, and a genuine
	 * remote write landing in the same millisecond is still noticed.
	 */
	private lastContentHash = '';
	private file: TFile | null = null;

	/**
	 * Set when the sidecar could not be understood — an unsupported version, or
	 * corrupt JSON. Blocks every write, because overwriting a file we failed to
	 * parse would destroy annotations we simply cannot represent yet.
	 */
	private frozen = false;
	/**
	 * Whether this document's `.bak` has been taken since it was opened.
	 *
	 * The backup is the sidecar as it was when the file was opened, not as it was
	 * half a second ago. Rotating it on every save doubled the file operations a
	 * sync client had to follow, and a backup that tracks every stroke is no
	 * protection against a bad session anyway.
	 */
	private backedUp = false;

	/** Revision last written to disk, so a clean store does no I/O. */
	private savedRevision: number;

	/** Serialises writes so two saves can never interleave on one file. */
	private writing: Promise<void> = Promise.resolve();

	private readonly saveSoon: Debouncer<[], void>;

	constructor(
		private readonly app: App,
		/** Called after anything changes what should be on screen. */
		private readonly onChanged: () => void,
	) {
		this.savedRevision = this.ink.version;
		this.saveSoon = debounce(
			() => {
				void this.save();
			},
			SAVE_DEBOUNCE_MS,
			// Restart the timer on each stroke: save once the user pauses.
			true,
		);
	}

	get version(): number {
		return this.ink.version;
	}

	/** True when the sidecar is present but unusable, so edits are not persisted. */
	get isFrozen(): boolean {
		return this.frozen;
	}

	itemsFor(pageKey: PageKey): readonly Item[] {
		return this.ink.itemsFor(pageKey);
	}

	get canUndo(): boolean {
		return this.history.canUndo;
	}

	get canRedo(): boolean {
		return this.history.canRedo;
	}

	addItem(pageKey: PageKey, item: Item): void {
		// The store owns paint order, so callers need not know the page's z range.
		item.z = this.ink.nextZ(pageKey);
		this.ink.add(pageKey, item);
		this.history.push({
			kind: 'add',
			refs: [
				{
					pageKey,
					index: this.ink.itemsFor(pageKey).length - 1,
					item,
				},
			],
		});
		this.afterMutation();
	}

	removeItems(refs: readonly ItemRef[]): void {
		if (refs.length === 0) return;
		const removed: ItemRef[] = [];
		for (const ref of refs) {
			// Keep the caller's index, which was read before any of this batch was
			// removed. removeById's return value is the position *after* earlier
			// removals have shifted things down, so recording that would scramble
			// list order when the removal is undone.
			if (this.ink.removeById(ref.pageKey, ref.item.id) >= 0) {
				removed.push(ref);
			}
		}
		if (removed.length === 0) return;
		this.history.push({ kind: 'remove', refs: removed });
		this.afterMutation();
	}

	/**
	 * Swap one set of items for another as one undoable step — what a sized erase
	 * commits when it cuts strokes into fragments.
	 */
	replaceItems(removed: readonly ItemRef[], added: readonly ItemRef[]): void {
		if (removed.length === 0 && added.length === 0) return;
		const gone: ItemRef[] = [];
		for (const ref of removed) {
			if (this.ink.removeById(ref.pageKey, ref.item.id) >= 0) gone.push(ref);
		}
		for (const ref of sortForInsert(added)) {
			this.ink.insertAt(ref.pageKey, ref.index, ref.item);
		}
		if (gone.length === 0 && added.length === 0) return;
		this.history.push({ kind: 'replace', removed: gone, added });
		this.afterMutation();
	}

	/**
	 * Replace items wholesale — a move, resize, recolour, or anything else a later
	 * tool needs. The operation carries both states, so the history does not need
	 * to know what changed.
	 */
	transformItems(changes: readonly ItemChange[]): void {
		if (changes.length === 0) return;
		const applied: ItemChange[] = [];
		for (const change of changes) {
			if (this.ink.replaceById(change.pageKey, change.after)) {
				applied.push(change);
			}
		}
		if (applied.length === 0) return;
		this.history.push({ kind: 'transform', changes: applied });
		this.afterMutation();
	}

	// --- pages ----------------------------------------------------------

	/** Live inserted-page records. Display order comes from `orderPages`. */
	insertedPages(): readonly InsertedPage[] {
		return this.ink.insertedPages();
	}

	/** Add an inserted page as one undoable operation. */
	insertPage(page: InsertedPage): void {
		this.ink.addPage(page);
		this.history.push({ kind: 'page-add', pages: [page], refs: [] });
		this.afterMutation();
	}

	/**
	 * Delete an inserted page, tombstoning everything on it in the same operation.
	 *
	 * One operation, not two, so a single undo brings back the page *and* its
	 * annotations. Splitting them would let a user undo once and get an empty page,
	 * which is worse than no undo at all.
	 */
	deletePage(id: string): void {
		const page = this.ink.pageById(id);
		if (!page || !isLivePage(page)) return;

		const pageKey = insertedPageKey(id);
		// Indices are read before anything is removed, exactly as removeItems does,
		// so an undo restores list order rather than a shifted version of it.
		const refs: ItemRef[] = this.ink
			.itemsFor(pageKey)
			.map((item, index) => ({ pageKey, index, item }));

		for (const ref of refs) this.ink.removeById(pageKey, ref.item.id);
		this.ink.removePageById(id);
		this.history.push({ kind: 'page-remove', pages: [page], refs });
		this.afterMutation();
	}

	/** Change an inserted page's ruling as one undoable operation. */
	setPageTemplate(id: string, template: PageTemplate): void {
		const change = this.ink.pageChangeFor(id, (page) => ({ ...page, template }));
		if (!change) return;
		this.ink.replacePage(change.after);
		this.history.push({ kind: 'page-transform', changes: [change] });
		this.afterMutation();
	}

	/** Returns false when there was nothing to undo. */
	undo(): boolean {
		const operation = this.history.undo();
		if (!operation) return false;
		this.apply(invert(operation));
		this.afterMutation();
		return true;
	}

	/** Returns false when there was nothing to redo. */
	redo(): boolean {
		const operation = this.history.redo();
		if (!operation) return false;
		this.apply(operation);
		this.afterMutation();
		return true;
	}

	private apply(operation: InkOperation): void {
		switch (operation.kind) {
			case 'add':
				// Ascending order, or an earlier splice shifts the later positions.
				for (const ref of sortForInsert(operation.refs)) {
					this.ink.insertAt(ref.pageKey, ref.index, ref.item);
				}
				break;
			case 'remove':
				for (const ref of operation.refs) {
					this.ink.removeById(ref.pageKey, ref.item.id);
				}
				break;
			case 'transform':
				for (const change of operation.changes) {
					this.ink.replaceById(change.pageKey, change.after);
				}
				break;
			case 'replace':
				// Remove first, so the insertion indices below still line up.
				for (const ref of operation.removed) {
					this.ink.removeById(ref.pageKey, ref.item.id);
				}
				for (const ref of sortForInsert(operation.added)) {
					this.ink.insertAt(ref.pageKey, ref.index, ref.item);
				}
				break;
			case 'page-add':
				// The page first: its items have nowhere to live until it is back.
				for (const page of operation.pages) this.ink.restorePage(page);
				for (const ref of sortForInsert(operation.refs)) {
					this.ink.insertAt(ref.pageKey, ref.index, ref.item);
				}
				break;
			case 'page-remove':
				for (const ref of operation.refs) {
					this.ink.removeById(ref.pageKey, ref.item.id);
				}
				for (const page of operation.pages) {
					this.ink.removePageById(page.id);
				}
				break;
			case 'page-transform':
				for (const change of operation.changes) {
					this.ink.replacePage(change.after);
				}
				break;
		}
	}

	private afterMutation(): void {
		if (!this.frozen) this.saveSoon();
		this.onChanged();
	}

	/** Read the sidecar for `file`, if there is one. Never throws. */
	async load(file: TFile): Promise<void> {
		this.saveSoon.cancel();
		this.ink.clear();
		this.history.clear();
		this.frozen = false;
		this.backedUp = false;
		this.file = file;
		this.savedRevision = this.ink.version;

		const path = sidecarPathFor(file.path);
		const sidecar =
			this.app.vault.getFileByPath(path) ?? (await this.recover(path));
		// No sidecar yet is the normal case; one is created on the first stroke.
		if (!sidecar) {
			this.lastSeenMtime = 0;
			this.lastContentHash = '';
			return;
		}
		this.lastSeenMtime = sidecar.stat.mtime;

		let raw: string;
		try {
			raw = await this.app.vault.read(sidecar);
		} catch (err) {
			console.error(`pdf-ink: could not read ${path}`, err);
			this.frozen = true;
			new Notice('Could not read saved annotations. Edits will not be saved.');
			return;
		}

		this.lastContentHash = hashContent(raw);

		const result = parseInkData(raw);
		if (!result.ok) {
			this.frozen = true;
			console.error(`pdf-ink: ${result.reason} in ${path}`);
			new Notice(
				result.reason === 'unsupported-version'
					? `These annotations use format version ${String(result.version ?? 0)}, which this version of the plugin cannot read. Edits will not be saved.`
					: 'Saved annotations are unreadable and will be left untouched. Edits will not be saved.',
			);
			return;
		}

		// Fold in anything a sync client left beside the sidecar before loading.
		const merged = await this.absorbConflictCopies(path, result.data);
		this.ink.load(merged.data);
		if (merged.changed) {
			// The conflict copies contributed something, so the sidecar needs
			// rewriting and the store must stay dirty until it is.
			this.saveSoon();
		} else if (result.migrated) {
			// Deliberately leave the store dirty and schedule a write, so a v1
			// sidecar is upgraded on disk rather than re-migrated on every open.
			console.warn(
				`pdf-ink: migrated ${path} from schema version ${String(result.sourceVersion)} to ${String(INK_DATA_VERSION)}`,
			);
			this.saveSoon();
		} else if (isIndented(raw)) {
			// Written by an earlier version in the bulky indented format. Rewrite it
			// once, compact, rather than waiting for the next stroke.
			this.saveSoon();
		} else {
			this.savedRevision = this.ink.version;
		}
		if (result.dropped > 0) {
			console.warn(
				`pdf-ink: skipped ${String(result.dropped)} malformed stroke(s) in ${path}`,
			);
		}
		this.onChanged();
	}

	/** Write immediately if there is anything pending. Safe to call repeatedly. */
	async flush(): Promise<void> {
		this.saveSoon.cancel();
		await this.save();
	}

	/** Forget the document without writing — the PDF is gone. */
	discard(): void {
		this.saveSoon.cancel();
		this.file = null;
		this.ink.clear();
		this.history.clear();
	}

	/**
	 * Recover a sidecar that has gone missing.
	 *
	 * A crash between the two renames of an atomic write can leave the sidecar
	 * absent with the new contents in `.tmp` and the old in `.bak`. The temp file is
	 * tried first because it is newer, but only if it parses — a half-written temp
	 * file is worse than the backup.
	 */
	private async recover(path: string): Promise<TFile | null> {
		const vault = this.app.vault;
		for (const suffix of [TEMP_SUFFIX, BACKUP_SUFFIX]) {
			const candidate = vault.getFileByPath(`${path}${suffix}`);
			if (!candidate) continue;
			try {
				const raw = await vault.read(candidate);
				if (!parseInkData(raw).ok) {
					console.warn(`pdf-ink: ignoring unusable ${candidate.path}`);
					continue;
				}
				await vault.rename(candidate, path);
				const recovered = vault.getFileByPath(path);
				if (recovered) {
					console.warn(`pdf-ink: recovered ${path} from ${suffix}`);
					new Notice('Recovered annotations from an interrupted save.');
					return recovered;
				}
			} catch (err) {
				console.error(`pdf-ink: could not recover from ${candidate.path}`, err);
			}
		}
		return null;
	}

	/**
	 * Write through a temp file, keeping the previous version as `.bak`.
	 *
	 * The vault has no atomic replace, so this is the closest safe sequence: the new
	 * contents are fully written before anything is moved, and the old contents
	 * survive as `.bak`. A crash mid-sequence therefore always leaves either the old
	 * file or the backup intact, never a half-written sidecar.
	 */
	private async writeAtomically(path: string, payload: string): Promise<void> {
		const vault = this.app.vault;
		const tempPath = `${path}${TEMP_SUFFIX}`;
		const backupPath = `${path}${BACKUP_SUFFIX}`;

		const staleTemp = vault.getFileByPath(tempPath);
		if (staleTemp) await vault.modify(staleTemp, payload);
		else await vault.create(tempPath, payload);

		const current = vault.getFileByPath(path);
		if (current && !this.backedUp) {
			const oldBackup = vault.getFileByPath(backupPath);
			// Only one backup is kept, so the previous one goes first.
			if (oldBackup) await vault.delete(oldBackup);
			await vault.rename(current, backupPath);
			this.backedUp = true;
		} else if (current) {
			// The temp file is complete before this, so a crash here still leaves a
			// full copy for recover() to pick up.
			await vault.delete(current);
		}

		const temp = vault.getFileByPath(tempPath);
		if (temp) await vault.rename(temp, path);

		const written = vault.getFileByPath(path);
		// Remember our own write, so it is not mistaken for someone else's.
		if (written) this.lastSeenMtime = written.stat.mtime;
		this.lastContentHash = hashContent(payload);
	}

	private get isDirty(): boolean {
		return this.ink.version !== this.savedRevision;
	}

	/**
	 * Fold the file on disk into memory if it has changed under us.
	 *
	 * Called before every write and whenever the vault reports the sidecar modified,
	 * so a remote edit is merged rather than clobbered.
	 */
	async reconcile(): Promise<void> {
		const file = this.file;
		if (!file || this.frozen) return;
		const path = sidecarPathFor(file.path);
		const sidecar = this.app.vault.getFileByPath(path);
		if (!sidecar || sidecar.stat.mtime === this.lastSeenMtime) return;

		let raw: string;
		try {
			raw = await this.app.vault.read(sidecar);
		} catch (err) {
			console.error(`pdf-ink: could not re-read ${path}`, err);
			return;
		}
		this.lastSeenMtime = sidecar.stat.mtime;

		const hash = hashContent(raw);
		if (hash === this.lastContentHash) {
			// Our own write coming back to us. Nothing to merge.
			return;
		}
		this.lastContentHash = hash;

		const parsed = parseInkData(raw);
		if (!parsed.ok) {
			// Unreadable now, though it was readable before: refuse to overwrite it.
			this.frozen = true;
			console.error(`pdf-ink: ${parsed.reason} in ${path} on re-read`);
			new Notice('The annotation file changed and cannot be read. Edits will not be saved.');
			return;
		}

		const merged = mergeInkData(this.ink.toData(), parsed.data);
		if (!merged.changed) return;
		this.ink.load(merged.data);
		console.warn(
			`pdf-ink: merged external changes to ${path} (+${String(merged.stats.added)} ~${String(merged.stats.updated)} -${String(merged.stats.deleted)})`,
		);
		this.onChanged();
	}

	/** The vault reported our sidecar changed. */
	handleExternalChange(changed: TFile): void {
		const file = this.file;
		if (!file || changed.path !== sidecarPathFor(file.path)) return;
		void this.reconcile();
	}

	/**
	 * Merge and then delete any conflicting copies a sync client has left behind.
	 */
	private async absorbConflictCopies(
		path: string,
		ours: InkData,
	): Promise<{ data: InkData; changed: boolean }> {
		const copies = this.app.vault
			.getFiles()
			.filter(
				(candidate) =>
					isConflictCopy(path, candidate.path) ||
					isSyncLeftover(path, candidate.path),
			);
		if (copies.length === 0) return { data: ours, changed: false };

		let data = ours;
		let changed = false;
		const absorbed: TFile[] = [];
		for (const copy of copies) {
			try {
				const parsed = parseInkData(await this.app.vault.read(copy));
				if (!parsed.ok) {
					console.warn(`pdf-ink: ignoring unreadable conflict copy ${copy.path}`);
					continue;
				}
				const merged = mergeInkData(data, parsed.data);
				data = merged.data;
				changed = changed || merged.changed;
				absorbed.push(copy);
			} catch (err) {
				console.error(`pdf-ink: could not read ${copy.path}`, err);
			}
		}

		// Only remove what was actually merged, and trash rather than delete: this is
		// the user's work, and a wrong merge should be recoverable.
		for (const copy of absorbed) {
			try {
				await this.app.fileManager.trashFile(copy);
			} catch (err) {
				console.error(`pdf-ink: could not remove ${copy.path}`, err);
			}
		}
		if (absorbed.length > 0) {
			new Notice(
				`Merged and cleaned up ${String(absorbed.length)} leftover annotation file(s).`,
			);
		}
		return { data, changed };
	}

	private async save(): Promise<void> {
		if (this.frozen) return;
		const file = this.file;
		if (!file || !this.isDirty) return;

		// A deleted PDF must not have its sidecar resurrected by a pending save.
		if (!this.app.vault.getFileByPath(file.path)) return;

		const revision = this.ink.version;
		const path = sidecarPathFor(file.path);

		this.writing = this.writing.then(async () => {
			try {
				// Merge anything that landed on disk since our last read, so a write
				// never silently discards another device's work.
				await this.reconcile();
				if (this.frozen) return;

				const existing = this.app.vault.getFileByPath(path);
				if (!existing && this.ink.isEmpty) {
					// Nothing to record and nothing on disk: do not litter.
					return;
				}
				// Tombstones cannot be dropped eagerly, but after the window every
				// device has certainly synced and they are just weight.
				const pruned = pruneTombstones(
					this.ink.toData(),
					Date.now(),
					TOMBSTONE_MAX_AGE_MS,
				);
				await this.writeAtomically(path, serializeInkData(pruned));
				// Edits made during the write leave this behind, so the next debounce
				// picks them up.
				this.savedRevision = revision;
			} catch (err) {
				console.error(`pdf-ink: could not save ${path}`, err);
				new Notice('Could not save PDF annotations.');
			}
		});
		await this.writing;
	}
}
