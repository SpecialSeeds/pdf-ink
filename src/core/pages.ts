/**
 * Page identity and page order. Pure.
 *
 * Items used to be filed under a numeric page index, which stops working the
 * moment a page can be inserted: inserting a page before page 3 would silently
 * re-home every annotation after it. Schema 4 files items under a stable string
 * key instead — `pdf:<n>` for a page of the original document, `ins:<uuid>` for an
 * inserted one — so a key means the same page for the life of the document, and
 * display order is derived rather than stored.
 */

import { keyBetween } from './fracindex';
import type { PageTemplate } from './templates';

/** `pdf:<0-based index>` or `ins:<uuid>`. */
export type PageKey = string;

export const PDF_PAGE_PREFIX = 'pdf:';
export const INSERTED_PAGE_PREFIX = 'ins:';

/** `afterPdfPage` for a page that comes before the first original page. */
export const BEFORE_FIRST_PAGE = -1;

/** Falls back to US Letter only when a document has no pages to copy at all. */
export const FALLBACK_PAGE_SIZE: PageSize = { width: 612, height: 792 };

export function pdfPageKey(pdfIndex: number): PageKey {
	return `${PDF_PAGE_PREFIX}${String(pdfIndex)}`;
}

export function insertedPageKey(id: string): PageKey {
	return `${INSERTED_PAGE_PREFIX}${id}`;
}

export type ParsedPageKey =
	| { readonly kind: 'pdf'; readonly pdfIndex: number }
	| { readonly kind: 'inserted'; readonly id: string };

/** Total: an unrecognised key yields null rather than throwing. */
export function parsePageKey(key: string): ParsedPageKey | null {
	if (key.startsWith(PDF_PAGE_PREFIX)) {
		const rest = key.slice(PDF_PAGE_PREFIX.length);
		// Deliberately strict: Number('') is 0 and Number('1e2') is 100, and either
		// would quietly alias a different page.
		if (!/^\d+$/.test(rest)) return null;
		return { kind: 'pdf', pdfIndex: Number(rest) };
	}
	if (key.startsWith(INSERTED_PAGE_PREFIX)) {
		const id = key.slice(INSERTED_PAGE_PREFIX.length);
		return id.length > 0 ? { kind: 'inserted', id } : null;
	}
	return null;
}

export function isPdfPageKey(key: string): boolean {
	return parsePageKey(key)?.kind === 'pdf';
}

export function isInsertedPageKey(key: string): boolean {
	return parsePageKey(key)?.kind === 'inserted';
}

export interface PageSize {
	/** PDF points. */
	readonly width: number;
	readonly height: number;
}

/**
 * A page that is not in the source PDF.
 *
 * Position is stored as "which original page do I follow" plus a fractional sort
 * key, not as an absolute index. That is what makes two devices inserting at the
 * same spot mergeable: both records keep their own key and both pages survive,
 * where absolute indices would collide and one would have to be rewritten.
 */
export interface PageOrigin {
	readonly x: number;
	readonly y: number;
}

/** An inserted page's bottom-left corner, (0, 0) unless it has grown downward. */
export function pageOrigin(page: InsertedPage): PageOrigin {
	return page.origin ?? { x: 0, y: 0 };
}

export interface InsertedPage {
	readonly id: string;
	/** 0-based original page this sits after; {@link BEFORE_FIRST_PAGE} for the top. */
	readonly afterPdfPage: number;
	/** Fractional index, ordering this page among others in the same gap. */
	readonly sortKey: string;
	readonly template: PageTemplate;
	readonly size: PageSize;
	/**
	 * The page's bottom-left corner in PDF user space; (0, 0) when absent. A board
	 * that grows downward lowers its origin instead of moving everything on it, so
	 * no item's stored coordinates ever change because the page grew.
	 */
	readonly origin?: PageOrigin;
	readonly updatedAt: number;
	/** Epoch ms when deleted, or undefined while it lives. A tombstone, as for items. */
	readonly deletedAt?: number;
}

export function isLivePage(page: InsertedPage): boolean {
	return page.deletedAt === undefined || page.deletedAt === 0;
}

export function livePages(pages: readonly InsertedPage[]): InsertedPage[] {
	return pages.filter(isLivePage);
}

/** A copy marked as deleted now. Geometry is kept so an undo can restore it. */
export function tombstonedPage(page: InsertedPage, now: number): InsertedPage {
	return { ...page, updatedAt: now, deletedAt: now };
}

/** A copy brought back to life. */
export function revivedPage(page: InsertedPage, now: number): InsertedPage {
	const next = { ...page, updatedAt: now };
	delete next.deletedAt;
	return next;
}

/**
 * A random id for a new page.
 *
 * Random rather than time-and-counter like stroke ids: page ids are the merge key
 * across devices, and two devices inserting a page in the same millisecond must
 * not produce the same id. `crypto.randomUUID` is not available in every context
 * Obsidian runs in, so this builds a v4-shaped id from `getRandomValues`.
 */
export function createPageId(): string {
	const bytes = new Uint8Array(16);
	// The bare global, deliberately: this module is pure and is unit-tested with no
	// DOM, so it must not reach for a window. `crypto` is present in every context
	// the plugin runs in, but the guard keeps the fallback honest.
	if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
		crypto.getRandomValues(bytes);
	} else {
		for (let i = 0; i < bytes.length; i++) {
			bytes[i] = Math.floor(Math.random() * 256);
		}
	}
	// Version 4, variant 1, so the id is a well-formed UUID and not merely random.
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'));
	return [
		hex.slice(0, 4).join(''),
		hex.slice(4, 6).join(''),
		hex.slice(6, 8).join(''),
		hex.slice(8, 10).join(''),
		hex.slice(10, 16).join(''),
	].join('-');
}

export type PageSlot =
	| {
			readonly kind: 'pdf';
			readonly key: PageKey;
			/** Display position, 0-based. */
			readonly index: number;
			readonly pdfIndex: number;
		}
	| {
			readonly kind: 'inserted';
			readonly key: PageKey;
			readonly index: number;
			readonly page: InsertedPage;
		};

/**
 * Ordering among inserted pages sharing a gap: by sort key, then by id.
 *
 * The id tiebreak is not cosmetic. Two devices inserting into the same gap
 * compute the *same* fractional key, because the algorithm is deterministic in
 * its neighbours — so without a second criterion the order of those two pages
 * would depend on array order and differ between devices.
 */
export function comparePages(a: InsertedPage, b: InsertedPage): number {
	if (a.sortKey !== b.sortKey) return a.sortKey < b.sortKey ? -1 : 1;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The display order of a document's pages.
 *
 * Derived on every call rather than stored: order is a function of the page
 * records, and caching it is how two devices end up disagreeing about it.
 */
export function orderPages(
	pdfPageCount: number,
	inserted: readonly InsertedPage[],
): PageSlot[] {
	const byGap = new Map<number, InsertedPage[]>();
	for (const page of livePages(inserted)) {
		// A record pointing past the end of the document — the PDF was replaced with
		// a shorter one — is parked at the end rather than dropped.
		const gap = Math.min(
			Math.max(BEFORE_FIRST_PAGE, Math.trunc(page.afterPdfPage)),
			pdfPageCount - 1,
		);
		const group = byGap.get(gap);
		if (group) group.push(page);
		else byGap.set(gap, [page]);
	}
	for (const group of byGap.values()) group.sort(comparePages);

	const slots: PageSlot[] = [];
	const pushInserted = (page: InsertedPage): void => {
		slots.push({
			kind: 'inserted',
			key: insertedPageKey(page.id),
			index: slots.length,
			page,
		});
	};

	for (const page of byGap.get(BEFORE_FIRST_PAGE) ?? []) pushInserted(page);
	for (let pdfIndex = 0; pdfIndex < pdfPageCount; pdfIndex++) {
		slots.push({
			kind: 'pdf',
			key: pdfPageKey(pdfIndex),
			index: slots.length,
			pdfIndex,
		});
		for (const page of byGap.get(pdfIndex) ?? []) pushInserted(page);
	}
	return slots;
}

/** The display index of a page key, or null when it is not in this document. */
export function indexOfKey(
	order: readonly PageSlot[],
	key: PageKey,
): number | null {
	for (const slot of order) {
		if (slot.key === key) return slot.index;
	}
	return null;
}

export function slotForKey(
	order: readonly PageSlot[],
	key: PageKey,
): PageSlot | undefined {
	return order.find((slot) => slot.key === key);
}

export interface InsertionPoint {
	readonly afterPdfPage: number;
	readonly sortKey: string;
}

/**
 * Where a page inserted at display position `at` belongs.
 *
 * `at` is the index the new page will occupy, so 0 puts it before everything and
 * `order.length` appends. The gap it lands in is named by the nearest original
 * page at or before it, and its sort key is generated between whatever inserted
 * pages already share that gap.
 */
export function insertionAt(
	order: readonly PageSlot[],
	at: number,
): InsertionPoint {
	const position = Math.min(Math.max(0, Math.trunc(at)), order.length);
	const before = position > 0 ? order[position - 1] : undefined;
	const after = order[position];

	const afterPdfPage =
		before === undefined
			? BEFORE_FIRST_PAGE
			: before.kind === 'pdf'
				? before.pdfIndex
				: before.page.afterPdfPage;

	// Bounds only count when they are inserted pages in the *same* gap. An original
	// page on either side means this is the start or the end of the gap's run.
	const inGap = (slot: PageSlot | undefined): InsertedPage | null =>
		slot !== undefined &&
		slot.kind === 'inserted' &&
		slot.page.afterPdfPage === afterPdfPage
			? slot.page
			: null;

	const lower = inGap(before)?.sortKey ?? null;
	let upper = inGap(after)?.sortKey ?? null;

	/*
	 * Two pages in one gap can share a sort key: that is exactly what happens when
	 * two devices insert at the same spot, and the id tiebreak in comparePages is
	 * what orders them. There is then no key between them, so the new page goes
	 * after the tied run instead — above the next distinct key, if there is one.
	 */
	if (lower !== null && upper !== null && lower >= upper) {
		upper = nextKeyAbove(order, afterPdfPage, lower);
	}

	return { afterPdfPage, sortKey: keyBetween(lower, upper) };
}

/**
 * Inserted page `id` moved to display position `to`: its record with the gap
 * and sort key that put it there, or null when it is not an inserted page or
 * is already there.
 *
 * `to` counts positions in the order after the move, so 0 is before everything
 * and the last position is the end. Only an inserted page moves; original pages
 * keep their order, and the move is just a new place among them. Nothing about
 * the order is stored beyond the page's own gap and key, so a move merges like
 * any other edit to the record.
 */
export function movedPage(
	order: readonly PageSlot[],
	id: string,
	to: number,
	now: number,
): InsertedPage | null {
	const from = order.findIndex((slot) => slot.kind === 'inserted' && slot.page.id === id);
	const slot = order[from];
	if (!slot || slot.kind !== 'inserted') return null;
	const rest = order.filter((_, i) => i !== from);
	const target = Math.min(Math.max(0, Math.trunc(to)), rest.length);
	if (target === from) return null;
	const { afterPdfPage, sortKey } = insertionAt(rest, target);
	return { ...slot.page, afterPdfPage, sortKey, updatedAt: now };
}

/**
 * Where a page dragged from position `from` lands when dropped before or after
 * the page at position `at`, counted the way {@link movedPage} counts: in the
 * order after the move, the page having left its own place first.
 */
export function dropPosition(from: number, at: number, after: boolean): number {
	const to = at + (after ? 1 : 0);
	return from < to ? to - 1 : to;
}

/** The smallest sort key in a gap that is strictly above `key`, if any. */
function nextKeyAbove(
	order: readonly PageSlot[],
	afterPdfPage: number,
	key: string,
): string | null {
	let smallest: string | null = null;
	for (const slot of order) {
		if (slot.kind !== 'inserted') continue;
		if (slot.page.afterPdfPage !== afterPdfPage) continue;
		const candidate = slot.page.sortKey;
		if (candidate <= key) continue;
		if (smallest === null || candidate < smallest) smallest = candidate;
	}
	return smallest;
}

/**
 * The size a page inserted at `at` should take: the previous page's, falling back
 * to the next page's and finally to Letter.
 *
 * Matching the neighbour is what makes an inserted page read as part of the same
 * document rather than as an attachment.
 */
export function sizeForInsertion(
	order: readonly PageSlot[],
	at: number,
	sizeOf: (slot: PageSlot) => PageSize | undefined,
): PageSize {
	const position = Math.min(Math.max(0, Math.trunc(at)), order.length);
	const before = position > 0 ? order[position - 1] : undefined;
	const after = order[position];
	for (const slot of [before, after]) {
		if (!slot) continue;
		const size = sizeOf(slot);
		if (size && size.width > 0 && size.height > 0) return size;
	}
	return FALLBACK_PAGE_SIZE;
}

/** A new page record for display position `at`. */
export function createInsertedPage(
	order: readonly PageSlot[],
	at: number,
	template: PageTemplate,
	size: PageSize,
	now: number,
	id = createPageId(),
): InsertedPage {
	const { afterPdfPage, sortKey } = insertionAt(order, at);
	return { id, afterPdfPage, sortKey, template, size, updatedAt: now };
}
