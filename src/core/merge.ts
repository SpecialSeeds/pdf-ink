/**
 * Item-level merge of two versions of the same sidecar. Pure.
 *
 * Two devices editing one PDF will both write the sidecar. Last-writer-wins on the
 * whole file loses an entire session's work, so this merges by item id instead:
 * every item carries `updatedAt`, the newer edit wins, and a deletion is a tombstone
 * so it can win too rather than being undone by a stale copy.
 */

import {
	INK_DATA_VERSION,
	type InkData,
	type Item,
	isLive,
} from './items';
import {
	type InsertedPage,
	type PageKey,
	isLivePage,
	parsePageKey,
} from './pages';

export interface MergeStats {
	/** Items only the incoming side had. */
	readonly added: number;
	/** Items whose incoming version was newer. */
	readonly updated: number;
	/** Items the incoming side had deleted. */
	readonly deleted: number;
	readonly unchanged: number;
	/** Inserted page records only the incoming side had. */
	readonly pagesAdded: number;
	/** Inserted page records the incoming side had changed or deleted. */
	readonly pagesChanged: number;
}

export interface MergeResult {
	readonly data: InkData;
	readonly stats: MergeStats;
	/** True when the merge differs from `ours`, so it is worth writing back. */
	readonly changed: boolean;
}

interface Located {
	readonly pageKey: PageKey;
	readonly item: Item;
}

function indexById(data: InkData): Map<string, Located> {
	const byId = new Map<string, Located>();
	for (const [pageKey, items] of Object.entries(data.pages)) {
		if (!parsePageKey(pageKey)) continue;
		for (const item of items) {
			const existing = byId.get(item.id);
			// A duplicate id within one file is malformed; keep the newer.
			if (!existing || existing.item.updatedAt <= item.updatedAt) {
				byId.set(item.id, { pageKey, item });
			}
		}
	}
	return byId;
}

/**
 * Which of two versions of the same item survives.
 *
 * Newest `updatedAt` wins. On an exact tie a tombstone wins, so a delete is never
 * silently undone by an edit that happened in the same millisecond — losing a
 * deletion is worse than losing one edit, because the item comes back from the dead.
 */
export function pickWinner(ours: Item, theirs: Item): Item {
	if (ours.updatedAt !== theirs.updatedAt) {
		return ours.updatedAt > theirs.updatedAt ? ours : theirs;
	}
	const oursDead = !isLive(ours);
	const theirsDead = !isLive(theirs);
	if (oursDead !== theirsDead) return oursDead ? ours : theirs;
	// Fully tied: keep ours, so a merge is stable and repeatable.
	return ours;
}

/**
 * Which of two versions of the same page record survives.
 *
 * The same rule as for items, and for the same reason: a deleted page whose
 * tombstone lost a tie would come back, bringing a page the user removed with it.
 */
export function pickWinnerPage(
	ours: InsertedPage,
	theirs: InsertedPage,
): InsertedPage {
	if (ours.updatedAt !== theirs.updatedAt) {
		return ours.updatedAt > theirs.updatedAt ? ours : theirs;
	}
	const oursDead = !isLivePage(ours);
	const theirsDead = !isLivePage(theirs);
	if (oursDead !== theirsDead) return oursDead ? ours : theirs;
	return ours;
}

/**
 * Merge the page records of two sidecars by id.
 *
 * Insert positions are fractional keys rather than indices precisely so that this
 * is a plain union: two devices inserting into the same gap keep both records, and
 * `orderPages` sorts them the same way on both.
 */
function mergePages(
	ours: readonly InsertedPage[],
	theirs: readonly InsertedPage[],
): { pages: InsertedPage[]; added: number; changed: number } {
	const mine = new Map<string, InsertedPage>();
	for (const page of ours) mine.set(page.id, page);

	const merged = new Map<string, InsertedPage>(mine);
	let added = 0;
	let changed = 0;

	for (const page of theirs) {
		const ourSide = mine.get(page.id);
		if (!ourSide) {
			merged.set(page.id, page);
			added += 1;
			continue;
		}
		const winner = pickWinnerPage(ourSide, page);
		merged.set(page.id, winner);
		if (!samePage(winner, ourSide)) changed += 1;
	}

	// Sorted by id so writing a merged file is deterministic. Display order comes
	// from orderPages, never from this array's order.
	const pages = [...merged.values()].sort((a, b) =>
		a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
	);
	return { pages, added, changed };
}

function samePage(a: InsertedPage, b: InsertedPage): boolean {
	return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function sameItem(a: Item, b: Item): boolean {
	return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Merge `theirs` (what is on disk) into `ours` (what is in memory).
 *
 * The result keeps every id from both sides, tombstones included: dropping them
 * here would let the next merge resurrect whatever they deleted.
 */
export function mergeInkData(ours: InkData, theirs: InkData): MergeResult {
	const mine = indexById(ours);
	const yours = indexById(theirs);

	let added = 0;
	let updated = 0;
	let deleted = 0;
	let unchanged = 0;

	const pages: Record<PageKey, Item[]> = {};
	const place = (located: Located): void => {
		const page = pages[located.pageKey];
		if (page) page.push(located.item);
		else pages[located.pageKey] = [located.item];
	};

	for (const [id, theirSide] of yours) {
		const ourSide = mine.get(id);
		if (!ourSide) {
			// Only they have it: a remote add, or a remote delete of something we
			// never saw. Either way the tombstone has to be kept.
			place(theirSide);
			if (isLive(theirSide.item)) added += 1;
			else deleted += 1;
			continue;
		}
		const winner = pickWinner(ourSide.item, theirSide.item);
		const winnerSide = winner === ourSide.item ? ourSide : theirSide;
		place(winnerSide);
		if (sameItem(winner, ourSide.item)) unchanged += 1;
		else if (isLive(winner)) updated += 1;
		else deleted += 1;
	}

	// Anything only we have is ours to keep.
	for (const [id, ourSide] of mine) {
		if (!yours.has(id)) {
			place(ourSide);
			unchanged += 1;
		}
	}

	// Stable order within a page, so writing a merged file is deterministic.
	for (const page of Object.values(pages)) {
		page.sort((a, b) => a.z - b.z || a.id.localeCompare(b.id));
	}

	const pageMerge = mergePages(ours.insertedPages, theirs.insertedPages);

	// Identity is not merged: ours stands, and theirs only fills a gap.
	const docId = ours.docId ?? theirs.docId;
	const data: InkData = {
		version: INK_DATA_VERSION,
		pages,
		insertedPages: pageMerge.pages,
		...(docId === undefined ? {} : { docId }),
	};
	return {
		data,
		stats: {
			added,
			updated,
			deleted,
			unchanged,
			pagesAdded: pageMerge.added,
			pagesChanged: pageMerge.changed,
		},
		changed:
			added > 0 ||
			updated > 0 ||
			deleted > 0 ||
			pageMerge.added > 0 ||
			pageMerge.changed > 0,
	};
}

/** Merge several versions into one, left to right. */
export function mergeAll(versions: readonly InkData[]): MergeResult {
	const first = versions[0];
	if (!first) {
		return {
			data: { version: INK_DATA_VERSION, pages: {}, insertedPages: [] },
			stats: {
				added: 0,
				updated: 0,
				deleted: 0,
				unchanged: 0,
				pagesAdded: 0,
				pagesChanged: 0,
			},
			changed: false,
		};
	}
	let result = mergeInkData(first, first);
	let changed = false;
	for (const next of versions.slice(1)) {
		result = mergeInkData(result.data, next);
		changed = changed || result.changed;
	}
	return { ...result, changed };
}

/**
 * Drop tombstones older than `maxAge`.
 *
 * They cannot be discarded eagerly — a tombstone is the only thing stopping another
 * device's stale copy from resurrecting the item — but after long enough that every
 * device has certainly synced, they are just weight.
 */
export function pruneTombstones(
	data: InkData,
	now: number,
	maxAge: number,
): InkData {
	const pages: Record<PageKey, Item[]> = {};
	for (const [key, items] of Object.entries(data.pages)) {
		const kept = items.filter(
			(item) => isLive(item) || now - (item.deletedAt ?? 0) < maxAge,
		);
		if (kept.length > 0) pages[key] = kept;
	}
	const insertedPages = data.insertedPages.filter(
		(page) => isLivePage(page) || now - (page.deletedAt ?? 0) < maxAge,
	);
	return {
		version: INK_DATA_VERSION,
		pages,
		insertedPages,
		...(data.docId === undefined ? {} : { docId: data.docId }),
	};
}

/**
 * Ninety days: long enough that a device which has been off the whole time would
 * have bigger problems than a resurrected stroke.
 */
export const TOMBSTONE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
