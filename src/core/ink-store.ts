import type { ItemChange, ItemRef, PageChange } from './history';
import {
	type Clock,
	type DocumentLayout,
	INK_DATA_VERSION,
	type InkData,
	type Item,
	isLive,
	liveItems,
	revived,
	systemClock,
	tombstoned,
	touched,
} from './items';
import { type BaseRef, layerItems } from './base-layer';
import {
	type InsertedPage,
	type PageKey,
	isLivePage,
	livePages,
	revivedPage,
	tombstonedPage,
} from './pages';

/**
 * The surface the ink layer draws from and mutates. Implemented by AnnotationStore,
 * which adds sidecar persistence and undo history on top of {@link InkStore}.
 */
export interface ItemStore {
	/** Bumped on every mutation, so renderers can cache against it. */
	readonly version: number;
	itemsFor(pageKey: PageKey): readonly Item[];
	/** Add an item and record it as one undoable operation. */
	addItem(pageKey: PageKey, item: Item): void;
	/** Remove whole items as one undoable operation. */
	removeItems(refs: readonly ItemRef[]): void;
	/** Replace items wholesale as one undoable operation. */
	transformItems(changes: readonly ItemChange[]): void;
	/** Swap one set of items for another as one undoable operation. */
	replaceItems(removed: readonly ItemRef[], added: readonly ItemRef[]): void;
}

/**
 * In-memory items and page records for one open document, keyed by page key.
 *
 * Deliberately separate from `PageRecord`: records are torn down whenever a page
 * scrolls out of view, and items must outlive that.
 */
export class InkStore {
	private readonly pages = new Map<PageKey, Item[]>();
	/** Inserted page records by id, tombstones included. */
	private readonly inserted = new Map<string, InsertedPage>();
	private revision = 0;
	/** A notebook's identity; see {@link InkData.docId}. */
	private docIdValue: string | undefined;
	/** See {@link InkData.layout}. */
	private layoutValue: DocumentLayout | undefined;
	/** See {@link InkData.base}: what the document says its base layer is. */
	private baseRefValue: BaseRef | undefined;
	/**
	 * The base layer itself, once read: imported items, never edited in place.
	 * `pages` above is the user's layer over it.
	 */
	private readonly base = new Map<PageKey, readonly Item[]>();
	/** The page each base item is on, by id. */
	private readonly baseIds = new Map<string, PageKey>();
	/** Each page's combined layers, rebuilt when the revision moves on. */
	private readonly combined = new Map<PageKey, { revision: number; items: readonly Item[] }>();

	constructor(private readonly now: Clock = systemClock) {}

	get version(): number {
		return this.revision;
	}

	get docId(): string | undefined {
		return this.docIdValue;
	}

	get layout(): DocumentLayout | undefined {
		return this.layoutValue;
	}

	get baseRef(): BaseRef | undefined {
		return this.baseRefValue;
	}

	/** Whether the base layer the document names has been read in. */
	get hasBase(): boolean {
		return this.base.size > 0;
	}

	/** Whether `id` belongs to the base layer. */
	isBaseItem(id: string): boolean {
		return this.baseIds.has(id);
	}

	/** Put the base layer in place. It survives `load`, which replaces only the user's layer. */
	setBase(pages: Readonly<Record<PageKey, readonly Item[]>>): void {
		this.base.clear();
		this.baseIds.clear();
		for (const [key, items] of Object.entries(pages)) {
			if (items.length === 0) continue;
			this.base.set(key, items);
			for (const item of items) this.baseIds.set(item.id, key);
		}
		this.revision += 1;
	}

	/** Give the document an identity, or a new one. Marks the store changed. */
	setDocId(docId: string): void {
		if (docId === this.docIdValue) return;
		this.docIdValue = docId;
		this.revision += 1;
	}

	get isEmpty(): boolean {
		return this.pages.size === 0 && this.inserted.size === 0 && this.base.size === 0;
	}

	/**
	 * The items to draw, hit-test and export: both layers, tombstones excluded.
	 * A user record replaces the base item with its id.
	 */
	itemsFor(pageKey: PageKey): readonly Item[] {
		const user = this.pages.get(pageKey);
		const base = this.base.get(pageKey);
		if (!base) return user ? liveItems(user) : [];
		const cached = this.combined.get(pageKey);
		if (cached?.revision === this.revision) return cached.items;
		const items = liveItems(layerItems(base, user ?? []));
		this.combined.set(pageKey, { revision: this.revision, items });
		return items;
	}

	/** The user's layer, tombstones included. For serialising and merging only. */
	allItemsFor(pageKey: PageKey): readonly Item[] {
		return this.pages.get(pageKey) ?? [];
	}

	/** Every page that holds anything at all, in either layer. */
	pageKeys(): PageKey[] {
		return [...new Set([...this.pages.keys(), ...this.base.keys()])].sort();
	}

	/** A live base item with this id on this page that the user has not replaced. */
	private untouchedBase(pageKey: PageKey, id: string): Item | undefined {
		if (this.baseIds.get(id) !== pageKey) return undefined;
		if (this.pages.get(pageKey)?.some((item) => item.id === id)) return undefined;
		return this.base.get(pageKey)?.find((item) => item.id === id);
	}

	private pushUser(pageKey: PageKey, item: Item): number {
		const existing = this.pages.get(pageKey);
		if (existing) existing.push(item);
		else this.pages.set(pageKey, [item]);
		return (existing?.length ?? 1) - 1;
	}

	/** The z value a new item on this page should take: on top of everything. */
	nextZ(pageKey: PageKey): number {
		let highest = -1;
		for (const item of this.itemsFor(pageKey)) {
			if (item.z > highest) highest = item.z;
		}
		return highest + 1;
	}

	add(pageKey: PageKey, item: Item): void {
		const stamped = touched(item, this.now());
		const existing = this.pages.get(pageKey);
		if (existing) existing.push(stamped);
		else this.pages.set(pageKey, [stamped]);
		this.revision += 1;
	}

	/**
	 * Put an item back at a specific position, restoring list order.
	 *
	 * If a tombstone for that id is already present — which it will be after an
	 * undo — it is revived in place rather than duplicated.
	 */
	insertAt(pageKey: PageKey, index: number, item: Item): void {
		const now = this.now();
		const existing = this.pages.get(pageKey);
		if (!existing) {
			this.pages.set(pageKey, [revived(item, now)]);
			this.revision += 1;
			return;
		}
		const at = existing.findIndex((candidate) => candidate.id === item.id);
		if (at >= 0) existing[at] = revived(item, now);
		else {
			const where = Math.min(Math.max(0, index), existing.length);
			existing.splice(where, 0, revived(item, now));
		}
		this.revision += 1;
	}

	/**
	 * Tombstone an item by id. Returns the index it holds, or -1.
	 *
	 * The item stays in the list with `deletedAt` set rather than being spliced out:
	 * a deletion that left no trace would be undone by another device's stale copy
	 * the next time the two are merged.
	 */
	removeById(pageKey: PageKey, id: string): number {
		// A base item is never touched: its tombstone goes in the user's layer.
		const base = this.untouchedBase(pageKey, id);
		if (base) {
			const at = this.pushUser(pageKey, tombstoned(base, this.now()));
			this.revision += 1;
			return at;
		}
		const existing = this.pages.get(pageKey);
		if (!existing) return -1;
		const at = existing.findIndex(
			(item) => item.id === id && isLive(item),
		);
		if (at < 0) return -1;
		const item = existing[at];
		if (!item) return -1;
		existing[at] = tombstoned(item, this.now());
		this.revision += 1;
		return at;
	}

	/** Swap an item for a new version of itself, in place. */
	replaceById(pageKey: PageKey, item: Item): boolean {
		// Editing a base item is copy on write: the edit joins the user's layer
		// under the same id, and from then on stands in for it.
		if (this.untouchedBase(pageKey, item.id)) {
			this.pushUser(pageKey, touched(item, this.now()));
			this.revision += 1;
			return true;
		}
		const existing = this.pages.get(pageKey);
		if (!existing) return false;
		const at = existing.findIndex((candidate) => candidate.id === item.id);
		if (at < 0) return false;
		existing[at] = touched(item, this.now());
		this.revision += 1;
		return true;
	}

	/** Tombstone the most recent live item on a page. Returns it, if there was one. */
	removeLast(pageKey: PageKey): Item | undefined {
		const live = this.itemsFor(pageKey);
		const last = live[live.length - 1];
		if (!last) return undefined;
		this.removeById(pageKey, last.id);
		return last;
	}

	// --- inserted pages -------------------------------------------------

	/** Live page records. Display order comes from `orderPages`, not this array. */
	insertedPages(): readonly InsertedPage[] {
		return livePages([...this.inserted.values()]);
	}

	/** Everything, tombstones included. For serialising and merging only. */
	allInsertedPages(): readonly InsertedPage[] {
		return [...this.inserted.values()];
	}

	pageById(id: string): InsertedPage | undefined {
		return this.inserted.get(id);
	}

	addPage(page: InsertedPage): void {
		this.inserted.set(page.id, { ...page, updatedAt: this.now() });
		this.revision += 1;
	}

	/**
	 * Put a page record back, reviving its tombstone if one is present — which it
	 * will be after an undo of a deletion.
	 */
	restorePage(page: InsertedPage): void {
		this.inserted.set(page.id, revivedPage(page, this.now()));
		this.revision += 1;
	}

	/** Tombstone a page record. Returns false when it was already gone. */
	removePageById(id: string): boolean {
		const existing = this.inserted.get(id);
		if (!existing || !isLivePage(existing)) return false;
		this.inserted.set(id, tombstonedPage(existing, this.now()));
		this.revision += 1;
		return true;
	}

	/** Swap a page record for a new version of itself — a template or size change. */
	replacePage(page: InsertedPage): boolean {
		if (!this.inserted.has(page.id)) return false;
		this.inserted.set(page.id, { ...page, updatedAt: this.now() });
		this.revision += 1;
		return true;
	}

	/** The before/after pair a page edit should record, or null if nothing changed. */
	pageChangeFor(
		id: string,
		edit: (page: InsertedPage) => InsertedPage,
	): PageChange | null {
		const before = this.inserted.get(id);
		if (!before || !isLivePage(before)) return null;
		const after = edit(before);
		return JSON.stringify(before) === JSON.stringify(after)
			? null
			: { before, after };
	}

	// --- whole-document ---------------------------------------------------

	/** Replace everything with items loaded from a sidecar. */
	load(data: InkData): void {
		this.pages.clear();
		this.inserted.clear();
		for (const [key, items] of Object.entries(data.pages)) {
			if (items.length > 0) this.pages.set(key, [...items]);
		}
		for (const page of data.insertedPages) this.inserted.set(page.id, page);
		this.docIdValue = data.docId;
		this.layoutValue = data.layout;
		this.baseRefValue = data.base;
		this.revision += 1;
	}

	clear(): void {
		this.pages.clear();
		this.inserted.clear();
		this.base.clear();
		this.baseIds.clear();
		this.combined.clear();
		this.docIdValue = undefined;
		this.layoutValue = undefined;
		this.baseRefValue = undefined;
		this.revision += 1;
	}

	/** Serialise to the `<file>.ink.json` schema, tombstones included. */
	toData(): InkData {
		const pages: Record<PageKey, Item[]> = {};
		for (const [key, items] of this.pages) {
			if (items.length > 0) pages[key] = items;
		}
		return {
			version: INK_DATA_VERSION,
			pages,
			insertedPages: [...this.inserted.values()],
			...(this.docIdValue === undefined ? {} : { docId: this.docIdValue }),
			...(this.layoutValue === undefined ? {} : { layout: this.layoutValue }),
			...(this.baseRefValue === undefined ? {} : { base: this.baseRefValue }),
		};
	}
}
