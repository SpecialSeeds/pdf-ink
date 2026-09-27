import { describe, expect, it } from 'vitest';
import {
	BEFORE_FIRST_PAGE,
	FALLBACK_PAGE_SIZE,
	type InsertedPage,
	type PageSlot,
	comparePages,
	createInsertedPage,
	createPageId,
	indexOfKey,
	insertedPageKey,
	insertionAt,
	isInsertedPageKey,
	isPdfPageKey,
	orderPages,
	parsePageKey,
	pdfPageKey,
	sizeForInsertion,
	slotForKey,
	tombstonedPage,
} from './pages';

const A4 = { width: 595.28, height: 841.89 };

function page(
	id: string,
	afterPdfPage: number,
	sortKey: string,
	extra: Partial<InsertedPage> = {},
): InsertedPage {
	return {
		id,
		afterPdfPage,
		sortKey,
		template: 'blank',
		size: A4,
		updatedAt: 1000,
		...extra,
	};
}

const keys = (order: readonly PageSlot[]): string[] => order.map((s) => s.key);

describe('page keys', () => {
	it('round-trips an original page index', () => {
		expect(pdfPageKey(0)).toBe('pdf:0');
		expect(pdfPageKey(41)).toBe('pdf:41');
		expect(parsePageKey('pdf:41')).toEqual({ kind: 'pdf', pdfIndex: 41 });
	});

	it('round-trips an inserted page id', () => {
		expect(insertedPageKey('abc-123')).toBe('ins:abc-123');
		expect(parsePageKey('ins:abc-123')).toEqual({
			kind: 'inserted',
			id: 'abc-123',
		});
	});

	it('refuses anything that is not a well-formed key', () => {
		// Number() would accept every one of these and alias a real page.
		expect(parsePageKey('pdf:')).toBeNull();
		expect(parsePageKey('pdf:-1')).toBeNull();
		expect(parsePageKey('pdf:1e2')).toBeNull();
		expect(parsePageKey('pdf:1.5')).toBeNull();
		expect(parsePageKey('pdf: 1')).toBeNull();
		expect(parsePageKey('ins:')).toBeNull();
		expect(parsePageKey('3')).toBeNull();
		expect(parsePageKey('')).toBeNull();
	});

	it('tells the two kinds apart', () => {
		expect(isPdfPageKey('pdf:2')).toBe(true);
		expect(isPdfPageKey('ins:x')).toBe(false);
		expect(isInsertedPageKey('ins:x')).toBe(true);
		expect(isInsertedPageKey('pdf:2')).toBe(false);
		expect(isPdfPageKey('nonsense')).toBe(false);
	});
});

describe('createPageId', () => {
	it('is a v4 UUID and does not repeat', () => {
		const ids = new Set<string>();
		for (let i = 0; i < 500; i++) {
			const id = createPageId();
			expect(id).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			);
			ids.add(id);
		}
		expect(ids.size).toBe(500);
	});
});

describe('orderPages', () => {
	it('is just the original pages when nothing is inserted', () => {
		expect(keys(orderPages(3, []))).toEqual(['pdf:0', 'pdf:1', 'pdf:2']);
	});

	it('places an inserted page directly after the page it follows', () => {
		const order = orderPages(3, [page('a', 1, 'a0')]);
		expect(keys(order)).toEqual(['pdf:0', 'pdf:1', 'ins:a', 'pdf:2']);
	});

	it('places a page before the first original page', () => {
		const order = orderPages(2, [page('a', BEFORE_FIRST_PAGE, 'a0')]);
		expect(keys(order)).toEqual(['ins:a', 'pdf:0', 'pdf:1']);
	});

	it('orders several pages in one gap by sort key', () => {
		const order = orderPages(1, [
			page('c', 0, 'a2'),
			page('a', 0, 'a0'),
			page('b', 0, 'a1'),
		]);
		expect(keys(order)).toEqual(['pdf:0', 'ins:a', 'ins:b', 'ins:c']);
	});

	it('numbers display positions consecutively', () => {
		const order = orderPages(2, [page('a', 0, 'a0'), page('b', 1, 'a0')]);
		expect(order.map((slot) => slot.index)).toEqual([0, 1, 2, 3]);
		expect(keys(order)).toEqual(['pdf:0', 'ins:a', 'pdf:1', 'ins:b']);
	});

	it('leaves out tombstoned pages', () => {
		const order = orderPages(2, [
			page('a', 0, 'a0'),
			tombstonedPage(page('b', 0, 'a1'), 2000),
		]);
		expect(keys(order)).toEqual(['pdf:0', 'ins:a', 'pdf:1']);
	});

	it('parks a page whose gap is past the end of a shortened document', () => {
		// The PDF was replaced with a shorter one. Dropping the page would lose the
		// annotations on it, so it lands at the end instead.
		const order = orderPages(2, [page('a', 9, 'a0')]);
		expect(keys(order)).toEqual(['pdf:0', 'pdf:1', 'ins:a']);
	});

	it('clamps a gap below the first page up to the top', () => {
		const order = orderPages(1, [page('a', -7, 'a0')]);
		expect(keys(order)).toEqual(['ins:a', 'pdf:0']);
	});

	it('handles a document with no original pages at all', () => {
		expect(keys(orderPages(0, [page('a', BEFORE_FIRST_PAGE, 'a0')]))).toEqual([
			'ins:a',
		]);
		expect(orderPages(0, [])).toEqual([]);
	});

	it('does not depend on the order the records arrive in', () => {
		const pages = [page('a', 0, 'a0'), page('b', 0, 'a1'), page('c', 1, 'a0')];
		const forwards = keys(orderPages(2, pages));
		const backwards = keys(orderPages(2, [...pages].reverse()));
		expect(backwards).toEqual(forwards);
	});
});

describe('concurrent inserts at the same spot', () => {
	it('keeps both pages, in an order both devices agree on', () => {
		// Two devices insert after page 0 without having seen each other's work, so
		// both compute the same sort key from the same neighbours.
		const order = orderPages(2, []);
		const mine = createInsertedPage(order, 1, 'blank', A4, 1000, 'bbb');
		const theirs = createInsertedPage(order, 1, 'lined', A4, 1001, 'aaa');
		expect(mine.sortKey).toBe(theirs.sortKey);

		// The id tiebreak is what makes the result stable. Without it the order
		// would follow whichever array order each device happened to have.
		const onMine = keys(orderPages(2, [mine, theirs]));
		const onTheirs = keys(orderPages(2, [theirs, mine]));
		expect(onMine).toEqual(['pdf:0', 'ins:aaa', 'ins:bbb', 'pdf:1']);
		expect(onTheirs).toEqual(onMine);
	});

	it('can still insert around a tied pair after the merge', () => {
		const order = orderPages(2, []);
		const mine = createInsertedPage(order, 1, 'blank', A4, 1000, 'bbb');
		const theirs = createInsertedPage(order, 1, 'lined', A4, 1001, 'aaa');
		const merged = orderPages(2, [mine, theirs]);

		// Asking to land between the tied pair has no key to take, so the page goes
		// after the run rather than throwing or scrambling the order.
		const third = createInsertedPage(merged, 2, 'dot', A4, 1002, 'ccc');
		expect(third.sortKey > mine.sortKey).toBe(true);
		expect(keys(orderPages(2, [mine, theirs, third]))).toEqual([
			'pdf:0',
			'ins:aaa',
			'ins:bbb',
			'ins:ccc',
			'pdf:1',
		]);

		// Above and below the pair work exactly as asked.
		const above = createInsertedPage(merged, 0, 'dot', A4, 1003, 'ddd');
		expect(keys(orderPages(2, [mine, theirs, above]))).toEqual([
			'ins:ddd',
			'pdf:0',
			'ins:aaa',
			'ins:bbb',
			'pdf:1',
		]);
	});

	it('keeps inserting between a tied pair and its successor', () => {
		// The repair must not paint itself into a corner: once a page sits above the
		// tied run, the gap between the run and that page has to stay divisible.
		const base = orderPages(1, []);
		const first = createInsertedPage(base, 1, 'blank', A4, 1000, 'bbb');
		const second = createInsertedPage(base, 1, 'blank', A4, 1000, 'aaa');
		let pages = [first, second];
		for (let i = 0; i < 20; i++) {
			const order = orderPages(1, pages);
			pages = [
				...pages,
				createInsertedPage(order, 3, 'blank', A4, 1000, `x${String(i)}`),
			];
			expect(orderPages(1, pages)).toHaveLength(pages.length + 1);
		}
		// Every key after the tied pair is distinct, so order is fully determined.
		const after = pages.filter((p) => p.id.startsWith('x')).map((p) => p.sortKey);
		expect(new Set(after).size).toBe(after.length);
	});
});

describe('comparePages', () => {
	it('sorts by key, then by id', () => {
		expect(comparePages(page('a', 0, 'a0'), page('b', 0, 'a1'))).toBeLessThan(0);
		expect(comparePages(page('b', 0, 'a0'), page('a', 0, 'a0'))).toBeGreaterThan(
			0,
		);
		expect(comparePages(page('a', 0, 'a0'), page('a', 0, 'a0'))).toBe(0);
	});
});

describe('insertionAt', () => {
	it('puts position 0 before the first original page', () => {
		expect(insertionAt(orderPages(2, []), 0).afterPdfPage).toBe(
			BEFORE_FIRST_PAGE,
		);
	});

	it('names the gap after the preceding original page', () => {
		const order = orderPages(3, []);
		expect(insertionAt(order, 1).afterPdfPage).toBe(0);
		expect(insertionAt(order, 2).afterPdfPage).toBe(1);
		expect(insertionAt(order, 3).afterPdfPage).toBe(2);
	});

	it('inherits the gap of a preceding inserted page', () => {
		const order = orderPages(2, [page('a', 0, 'a0')]);
		expect(insertionAt(order, 2).afterPdfPage).toBe(0);
	});

	it('generates a key between the neighbours already in the gap', () => {
		const existing = [page('a', 0, 'a0'), page('b', 0, 'a1')];
		const order = orderPages(1, existing);
		const between = insertionAt(order, 2);
		expect(between.afterPdfPage).toBe(0);
		expect(between.sortKey > 'a0').toBe(true);
		expect(between.sortKey < 'a1').toBe(true);
	});

	it('appends above the gap when the next slot is an original page', () => {
		const order = orderPages(2, [page('a', 0, 'a0')]);
		// Position 2 is between ins:a and pdf:1, so there is no upper bound.
		expect(insertionAt(order, 2).sortKey > 'a0').toBe(true);
	});

	it('clamps positions outside the document', () => {
		const order = orderPages(2, []);
		expect(insertionAt(order, -5).afterPdfPage).toBe(BEFORE_FIRST_PAGE);
		expect(insertionAt(order, 99).afterPdfPage).toBe(1);
	});

	it('produces an order matching where the page was asked to go', () => {
		let pages: InsertedPage[] = [];
		for (const [at, id] of [
			[0, 'top'],
			[2, 'mid'],
			[5, 'end'],
		] as const) {
			const order = orderPages(3, pages);
			pages = [...pages, createInsertedPage(order, at, 'blank', A4, 1000, id)];
		}
		expect(keys(orderPages(3, pages))).toEqual([
			'ins:top',
			'pdf:0',
			'ins:mid',
			'pdf:1',
			'pdf:2',
			'ins:end',
		]);
	});
});

describe('sizeForInsertion', () => {
	const sizes = new Map<string, { width: number; height: number }>([
		['pdf:0', { width: 100, height: 200 }],
		['pdf:1', { width: 300, height: 400 }],
	]);
	const sizeOf = (slot: PageSlot) => sizes.get(slot.key);

	it('copies the previous page', () => {
		const order = orderPages(2, []);
		expect(sizeForInsertion(order, 1, sizeOf)).toEqual({
			width: 100,
			height: 200,
		});
		expect(sizeForInsertion(order, 2, sizeOf)).toEqual({
			width: 300,
			height: 400,
		});
	});

	it('falls back to the next page at the very top', () => {
		expect(sizeForInsertion(orderPages(2, []), 0, sizeOf)).toEqual({
			width: 100,
			height: 200,
		});
	});

	it('falls back to Letter when no neighbour has a usable size', () => {
		expect(sizeForInsertion(orderPages(2, []), 1, () => undefined)).toEqual(
			FALLBACK_PAGE_SIZE,
		);
		expect(sizeForInsertion([], 0, sizeOf)).toEqual(FALLBACK_PAGE_SIZE);
		expect(
			sizeForInsertion(orderPages(1, []), 1, () => ({ width: 0, height: 0 })),
		).toEqual(FALLBACK_PAGE_SIZE);
	});
});

describe('deep links', () => {
	it('resolves pdf:<n> to its shifted position after insertions', () => {
		// A link saved before any page was inserted still points at the same page of
		// the original document, which is the whole reason keys are not indices.
		const before = orderPages(4, []);
		expect(indexOfKey(before, 'pdf:3')).toBe(3);

		const after = orderPages(4, [
			page('a', BEFORE_FIRST_PAGE, 'a0'),
			page('b', 0, 'a0'),
			page('c', 0, 'a1'),
		]);
		expect(indexOfKey(after, 'pdf:3')).toBe(6);
		expect(indexOfKey(after, 'pdf:0')).toBe(1);
		expect(slotForKey(after, 'pdf:3')).toMatchObject({
			kind: 'pdf',
			pdfIndex: 3,
		});
	});

	it('resolves an inserted page by its own key', () => {
		const order = orderPages(2, [page('a', 0, 'a0')]);
		expect(indexOfKey(order, 'ins:a')).toBe(1);
	});

	it('returns null for a page that is not in this document', () => {
		const order = orderPages(2, []);
		expect(indexOfKey(order, 'pdf:9')).toBeNull();
		expect(indexOfKey(order, 'ins:gone')).toBeNull();
		expect(slotForKey(order, 'ins:gone')).toBeUndefined();
	});

	it('still resolves a page whose inserted neighbours were deleted', () => {
		const order = orderPages(4, [
			tombstonedPage(page('a', BEFORE_FIRST_PAGE, 'a0'), 2000),
		]);
		expect(indexOfKey(order, 'pdf:3')).toBe(3);
	});
});
