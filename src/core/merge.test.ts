import { describe, expect, it } from 'vitest';
import { INK_DATA_VERSION, type InkData, type Item, isLive } from './items';
import {
	TOMBSTONE_MAX_AGE_MS,
	mergeAll,
	mergeInkData,
	pickWinner,
	pickWinnerPage,
	pruneTombstones,
} from './merge';
import {
	type InsertedPage,
	insertedPageKey,
	isLivePage,
	orderPages,
	pdfPageKey,
	tombstonedPage,
} from './pages';
import { createStroke } from './stroke';

/** A stroke with an explicit timestamp, so merges are deterministic. */
function item(id: string, updatedAt: number, over: Partial<Item> = {}): Item {
	const stroke = createStroke(
		{ tool: 'pen', color: '#111111', width: 2, opacity: 1 },
		id,
		updatedAt,
	);
	stroke.points.push([10, 10, 0.5], [20, 20, 0.5]);
	return { ...stroke, ...over } as Item;
}

function deleted(id: string, at: number): Item {
	return item(id, at, { deletedAt: at });
}

function doc(
	items: Item[],
	page = 0,
	insertedPages: InsertedPage[] = [],
): InkData {
	return {
		version: INK_DATA_VERSION,
		pages: { [pdfPageKey(page)]: items },
		insertedPages,
	};
}

function ids(data: InkData, page = 0): string[] {
	return (data.pages[pdfPageKey(page)] ?? []).map((i) => i.id);
}

function live(data: InkData, page = 0): string[] {
	return (data.pages[pdfPageKey(page)] ?? []).filter(isLive).map((i) => i.id);
}

function find(data: InkData, id: string): Item | undefined {
	return Object.values(data.pages)
		.flat()
		.find((i) => i.id === id);
}

describe('pickWinner', () => {
	it('takes the newer edit', () => {
		expect(pickWinner(item('a', 100), item('a', 200)).updatedAt).toBe(200);
		expect(pickWinner(item('a', 300), item('a', 200)).updatedAt).toBe(300);
	});

	it('a newer edit beats an older delete: the item comes back', () => {
		const winner = pickWinner(deleted('a', 100), item('a', 200));
		expect(isLive(winner)).toBe(true);
	});

	it('a newer delete beats an older edit', () => {
		const winner = pickWinner(item('a', 100), deleted('a', 200));
		expect(isLive(winner)).toBe(false);
	});

	it('on an exact tie the delete wins', () => {
		// Losing an edit is recoverable; an item rising from the dead is not obvious.
		expect(isLive(pickWinner(item('a', 100), deleted('a', 100)))).toBe(false);
		expect(isLive(pickWinner(deleted('a', 100), item('a', 100)))).toBe(false);
	});

	it('is stable when both sides are identical in age and liveness', () => {
		const ours = item('a', 100, { color: '#aaaaaa' });
		expect(pickWinner(ours, item('a', 100, { color: '#bbbbbb' }))).toBe(ours);
	});
});

describe('concurrent add', () => {
	it('keeps both sides additions', () => {
		const merged = mergeInkData(
			doc([item('ours', 100)]),
			doc([item('theirs', 100)]),
		);
		expect(live(merged.data).sort()).toEqual(['ours', 'theirs']);
		expect(merged.stats.added).toBe(1);
		expect(merged.changed).toBe(true);
	});

	it('keeps an addition made on a page the other side never touched', () => {
		const ours: InkData = {
			version: INK_DATA_VERSION,
			pages: { 'pdf:0': [item('a', 100)] },
			insertedPages: [],
		};
		const theirs: InkData = {
			version: INK_DATA_VERSION,
			pages: { 'pdf:5': [item('b', 100)] },
			insertedPages: [],
		};
		const merged = mergeInkData(ours, theirs);
		expect(live(merged.data, 0)).toEqual(['a']);
		expect(live(merged.data, 5)).toEqual(['b']);
	});

	it('merging a document with itself changes nothing', () => {
		const ours = doc([item('a', 100), item('b', 200)]);
		const merged = mergeInkData(ours, ours);
		expect(merged.changed).toBe(false);
		expect(live(merged.data).sort()).toEqual(['a', 'b']);
	});
});

describe('concurrent edit', () => {
	it('the newer edit wins', () => {
		const merged = mergeInkData(
			doc([item('a', 100, { color: '#oldold' })]),
			doc([item('a', 200, { color: '#newnew' })]),
		);
		expect(find(merged.data, 'a')?.color).toBe('#newnew');
		expect(merged.stats.updated).toBe(1);
	});

	it('our newer edit is kept over their older one', () => {
		const merged = mergeInkData(
			doc([item('a', 300, { color: '#ours00' })]),
			doc([item('a', 200, { color: '#theirs' })]),
		);
		expect(find(merged.data, 'a')?.color).toBe('#ours00');
		expect(merged.changed).toBe(false);
	});

	it('never duplicates an item edited on both sides', () => {
		const merged = mergeInkData(doc([item('a', 100)]), doc([item('a', 200)]));
		expect(ids(merged.data)).toEqual(['a']);
	});

	it('an item moved to another page lands on the winner page', () => {
		const ours = doc([item('a', 100)], 0);
		const theirs = doc([item('a', 200)], 3);
		const merged = mergeInkData(ours, theirs);
		expect(live(merged.data, 3)).toEqual(['a']);
		expect(live(merged.data, 0)).toEqual([]);
	});
});

describe('concurrent delete', () => {
	it('their delete removes what we still had', () => {
		const merged = mergeInkData(doc([item('a', 100)]), doc([deleted('a', 200)]));
		expect(live(merged.data)).toEqual([]);
		// The tombstone is kept, or the next merge would resurrect it.
		expect(ids(merged.data)).toEqual(['a']);
		expect(merged.stats.deleted).toBe(1);
	});

	it('our delete survives their stale copy', () => {
		const merged = mergeInkData(doc([deleted('a', 200)]), doc([item('a', 100)]));
		expect(live(merged.data)).toEqual([]);
		expect(merged.changed).toBe(false);
	});

	it('a delete we never saw arrives as a tombstone, not as an addition', () => {
		const merged = mergeInkData(doc([]), doc([deleted('gone', 200)]));
		expect(live(merged.data)).toEqual([]);
		expect(ids(merged.data)).toEqual(['gone']);
		expect(merged.stats.added).toBe(0);
		expect(merged.stats.deleted).toBe(1);
	});

	it('both sides deleting the same item agree', () => {
		const merged = mergeInkData(doc([deleted('a', 100)]), doc([deleted('a', 100)]));
		expect(live(merged.data)).toEqual([]);
		expect(merged.changed).toBe(false);
	});

	it('re-drawing after a remote delete keeps the redraw', () => {
		// They deleted it at t=100; we edited it at t=200, so ours is newer.
		const merged = mergeInkData(doc([item('a', 200)]), doc([deleted('a', 100)]));
		expect(live(merged.data)).toEqual(['a']);
	});
});

describe('all three at once', () => {
	it('resolves an add, an edit and a delete in one merge', () => {
		const ours = doc([
			item('kept', 100),
			item('edited', 100, { color: '#oldold' }),
			item('doomed', 100),
			item('ours', 150),
		]);
		const theirs = doc([
			item('kept', 100),
			item('edited', 200, { color: '#newnew' }),
			deleted('doomed', 200),
			item('theirs', 150),
		]);

		const merged = mergeInkData(ours, theirs);
		expect(live(merged.data).sort()).toEqual([
			'edited',
			'kept',
			'ours',
			'theirs',
		]);
		expect(find(merged.data, 'edited')?.color).toBe('#newnew');
		expect(isLive(find(merged.data, 'doomed') as Item)).toBe(false);
		expect(merged.stats).toEqual({
			added: 1,
			updated: 1,
			deleted: 1,
			unchanged: 2,
			pagesAdded: 0,
			pagesChanged: 0,
		});
	});

	it('is order independent for the live outcome', () => {
		const ours = doc([item('a', 100), item('b', 300)]);
		const theirs = doc([item('a', 200), deleted('b', 200)]);
		const forward = mergeInkData(ours, theirs);
		const backward = mergeInkData(theirs, ours);
		expect(live(forward.data).sort()).toEqual(live(backward.data).sort());
		expect(find(forward.data, 'a')?.updatedAt).toBe(
			find(backward.data, 'a')?.updatedAt,
		);
	});

	it('is idempotent: merging the result again changes nothing', () => {
		const ours = doc([item('a', 100), item('c', 100)]);
		const theirs = doc([item('a', 200), deleted('c', 300), item('b', 100)]);
		const once = mergeInkData(ours, theirs);
		const twice = mergeInkData(once.data, theirs);
		expect(twice.changed).toBe(false);
		expect(ids(twice.data).sort()).toEqual(ids(once.data).sort());
	});

	it('always writes the current schema version', () => {
		const merged = mergeInkData(
			{ version: 2, pages: { 'pdf:0': [item('a', 100)] }, insertedPages: [] },
			{ version: 2, pages: {}, insertedPages: [] },
		);
		expect(merged.data.version).toBe(INK_DATA_VERSION);
	});
});

describe('mergeAll', () => {
	it('folds several conflicting copies together', () => {
		const merged = mergeAll([
			doc([item('a', 100)]),
			doc([item('b', 100)]),
			doc([item('c', 100), deleted('a', 200)]),
		]);
		expect(live(merged.data).sort()).toEqual(['b', 'c']);
		expect(merged.changed).toBe(true);
	});

	it('handles one version and none', () => {
		expect(live(mergeAll([doc([item('a', 100)])]).data)).toEqual(['a']);
		expect(mergeAll([]).data.pages).toEqual({});
	});
});

describe('pruneTombstones', () => {
	it('keeps recent tombstones, because a stale device may still resurrect them', () => {
		const now = 1_000_000;
		const pruned = pruneTombstones(
			doc([deleted('recent', now - 1000)]),
			now,
			TOMBSTONE_MAX_AGE_MS,
		);
		expect(ids(pruned)).toEqual(['recent']);
	});

	it('drops tombstones older than the window', () => {
		const now = TOMBSTONE_MAX_AGE_MS * 3;
		const pruned = pruneTombstones(
			doc([deleted('ancient', 1), item('alive', now)]),
			now,
			TOMBSTONE_MAX_AGE_MS,
		);
		expect(ids(pruned)).toEqual(['alive']);
	});

	it('never drops a live item', () => {
		const pruned = pruneTombstones(doc([item('a', 0)]), 10 ** 12, 1);
		expect(ids(pruned)).toEqual(['a']);
	});
});

describe('page records merge by id, like items', () => {
	function page(
		id: string,
		updatedAt: number,
		extra: Partial<InsertedPage> = {},
	): InsertedPage {
		return {
			id,
			afterPdfPage: 0,
			sortKey: 'a0',
			template: 'blank',
			size: { width: 595, height: 842 },
			updatedAt,
			...extra,
		};
	}

	function pageDoc(pages: InsertedPage[]): InkData {
		return { version: INK_DATA_VERSION, pages: {}, insertedPages: pages };
	}

	const pageIds = (data: InkData): string[] =>
		data.insertedPages.map((p) => p.id).sort();

	it('keeps both pages when two devices insert at the same spot', () => {
		/*
		 * The point of the whole scheme. Neither device has seen the other, so both
		 * computed the same sort key from the same neighbours — and both pages have
		 * to survive, in an order the two devices agree on.
		 */
		const mine = page('bbb', 100, { sortKey: 'a1' });
		const theirs = page('aaa', 100, { sortKey: 'a1' });

		const merged = mergeInkData(pageDoc([mine]), pageDoc([theirs]));
		expect(pageIds(merged.data)).toEqual(['aaa', 'bbb']);
		expect(merged.stats.pagesAdded).toBe(1);
		expect(merged.changed).toBe(true);

		// And the same result whichever side does the merging.
		const reversed = mergeInkData(pageDoc([theirs]), pageDoc([mine]));
		expect(pageIds(reversed.data)).toEqual(['aaa', 'bbb']);
		expect(reversed.data.insertedPages).toEqual(merged.data.insertedPages);
	});

	it('orders the two survivors identically on both devices', () => {
		const mine = page('bbb', 100, { sortKey: 'a1' });
		const theirs = page('aaa', 101, { sortKey: 'a1' });
		const merged = mergeInkData(pageDoc([mine]), pageDoc([theirs]));
		// Tied sort keys, so comparePages falls back to the id — which is stable
		// across devices in a way that array order is not.
		expect(
			orderPages(1, merged.data.insertedPages).map((slot) => slot.key),
		).toEqual(['pdf:0', 'ins:aaa', 'ins:bbb']);
	});

	it('takes the newer template change', () => {
		const merged = mergeInkData(
			pageDoc([page('a', 100, { template: 'blank' })]),
			pageDoc([page('a', 200, { template: 'grid5' })]),
		);
		expect(merged.data.insertedPages[0]?.template).toBe('grid5');
		expect(merged.stats.pagesChanged).toBe(1);
		expect(merged.stats.pagesAdded).toBe(0);
	});

	it('keeps our newer template change over their older one', () => {
		const merged = mergeInkData(
			pageDoc([page('a', 300, { template: 'dot' })]),
			pageDoc([page('a', 200, { template: 'grid5' })]),
		);
		expect(merged.data.insertedPages[0]?.template).toBe('dot');
		expect(merged.changed).toBe(false);
	});

	it('a remote delete of a page wins over our older edit', () => {
		const merged = mergeInkData(
			pageDoc([page('a', 100, { template: 'lined' })]),
			pageDoc([tombstonedPage(page('a', 100), 200)]),
		);
		const survivor = merged.data.insertedPages[0];
		expect(survivor).toBeDefined();
		expect(isLivePage(survivor as InsertedPage)).toBe(false);
		// Gone from the display order, but still on record, so a stale copy of the
		// page cannot bring it back on the next merge.
		expect(orderPages(1, merged.data.insertedPages)).toHaveLength(1);
	});

	it('a page deleted in the same millisecond as an edit stays deleted', () => {
		expect(
			isLivePage(pickWinnerPage(page('a', 100), tombstonedPage(page('a', 90), 100))),
		).toBe(false);
		expect(
			isLivePage(pickWinnerPage(tombstonedPage(page('a', 90), 100), page('a', 100))),
		).toBe(false);
	});

	it('re-adding a page after a remote delete keeps the page', () => {
		const merged = mergeInkData(
			pageDoc([page('a', 300)]),
			pageDoc([tombstonedPage(page('a', 100), 200)]),
		);
		const survivor = merged.data.insertedPages[0];
		expect(isLivePage(survivor as InsertedPage)).toBe(true);
	});

	it('merges a page and the items on it in one pass', () => {
		const ours: InkData = {
			version: INK_DATA_VERSION,
			pages: { [insertedPageKey('a')]: [item('mine', 100)] },
			insertedPages: [page('a', 100)],
		};
		const theirs: InkData = {
			version: INK_DATA_VERSION,
			pages: { [insertedPageKey('a')]: [item('theirs', 100)] },
			insertedPages: [page('a', 100)],
		};
		const merged = mergeInkData(ours, theirs);
		expect(
			(merged.data.pages[insertedPageKey('a')] ?? []).map((i) => i.id).sort(),
		).toEqual(['mine', 'theirs']);
		expect(merged.data.insertedPages).toHaveLength(1);
	});

	it('writes page records in a deterministic order', () => {
		const pages = [page('c', 100), page('a', 100), page('b', 100)];
		const merged = mergeInkData(pageDoc(pages), pageDoc([...pages].reverse()));
		expect(merged.data.insertedPages.map((p) => p.id)).toEqual(['a', 'b', 'c']);
	});

	it('reports no page changes when neither side has any', () => {
		const merged = mergeInkData(doc([item('a', 100)]), doc([item('a', 100)]));
		expect(merged.stats.pagesAdded).toBe(0);
		expect(merged.stats.pagesChanged).toBe(0);
		expect(merged.data.insertedPages).toEqual([]);
	});

	it('prunes page tombstones past the window, and keeps recent ones', () => {
		const now = 1_000_000_000;
		const data = pageDoc([
			tombstonedPage(page('ancient', 0), now - TOMBSTONE_MAX_AGE_MS - 1),
			tombstonedPage(page('recent', 0), now - 1000),
			page('alive', now),
		]);
		const pruned = pruneTombstones(data, now, TOMBSTONE_MAX_AGE_MS);
		expect(pruned.insertedPages.map((p) => p.id).sort()).toEqual([
			'alive',
			'recent',
		]);
	});
});
