/**
 * Temporary boards: an infinite canvas to think on, thrown away when its tab
 * closes. Pure.
 *
 * A temporary board is the same document as a board (one inserted page, layout
 * "board"), but it is never a vault file. It lives in a hidden folder at the top
 * of the vault, written through the adapter so it survives the app being killed
 * mid-session, and that folder is removed when the board's tab closes or the
 * app quits. What should be kept is sent to a notebook (see
 * {@link selectionForNotebook}).
 *
 * "Infinite" is done by growing: the one page grows on any side that ink or the
 * view comes near, always by whole multiples of the grid's major spacing, so the
 * grid under existing ink never shifts and a major line never turns minor.
 * Growing left or up moves the page's corner, never an item.
 */

import { type Bounds, itemsBounds } from './hit-test';
import { INK_DATA_VERSION, type InkData, type Item, isLive } from './items';
import { translation, transformItem } from './transform';
import { createDocId } from './new-notebook';
import {
	BEFORE_FIRST_PAGE,
	type InsertedPage,
	type PageSize,
	createInsertedPage,
	createPageId,
	insertedPageKey,
	orderPages,
	pageOrigin,
} from './pages';
import { HEADER_BAND } from './header';
import { NOTEBOOK_PAGE_SIZE, NOTEBOOK_TEMPLATE } from './new-notebook';
import { FIRST_KEY } from './fracindex';
import { MAJOR_EVERY, type PageTemplate, templateSpacing } from './templates';

/** Hidden from the file list, and from Obsidian Sync, by its leading dot. */
export const CANVAS_FOLDER = '.pdf-ink-boards';

/** The folder one temporary board and its pictures live in. */
export function canvasFolder(id: string): string {
	return `${CANVAS_FOLDER}/${id}`;
}

/** The board's ink, inside its folder. */
export function canvasDataPath(id: string): string {
	return `${canvasFolder(id)}/board.inknote`;
}

/** Pictures put on the board, inside its folder. */
export function canvasImagesFolder(id: string): string {
	return `${canvasFolder(id)}/images`;
}

/** Whether a path is inside some temporary board's folder. */
export function isCanvasPath(path: string): boolean {
	return path.startsWith(`${CANVAS_FOLDER}/`);
}

/** A board id is a page-id style UUID; anything else in the folder is not ours. */
export function isCanvasId(value: unknown): value is string {
	return typeof value === 'string' && /^[0-9a-f-]{8,64}$/i.test(value);
}

/** A new temporary board: four Letter pages' worth, as a 5 mm grid. */
export const NEW_CANVAS_SIZE: PageSize = { width: 2448, height: 1584 };
export const CANVAS_TEMPLATE: PageTemplate = 'grid5';

/**
 * The most a side may grow to, in points: far past anything written by hand,
 * and a stop for a canvas flung at its edge for a minute.
 */
export const MAX_CANVAS_SIDE = 60_000;

/** The data of a new temporary board: one ruled page, nothing on it. */
export function newCanvasData(now: number, id = createPageId(), docId = createDocId()): InkData {
	const page: InsertedPage = {
		id,
		afterPdfPage: BEFORE_FIRST_PAGE,
		sortKey: FIRST_KEY,
		template: CANVAS_TEMPLATE,
		size: NEW_CANVAS_SIZE,
		updatedAt: now,
	};
	return {
		version: INK_DATA_VERSION,
		pages: {},
		insertedPages: [page],
		docId,
		layout: 'board',
	};
}

/**
 * The step a canvas grows by: five grid cells, so major lines stay major, or a
 * whole point on a blank page.
 */
export function canvasStep(template: PageTemplate): number {
	const spacing = templateSpacing(template);
	return spacing > 0 ? spacing * MAJOR_EVERY : 1;
}

function wholeSteps(amount: number, step: number): number {
	return Math.ceil(amount / step - 1e-9) * step;
}

/** How a canvas grew, for the view to keep what is on screen where it was. */
export interface CanvasGrowth {
	readonly page: InsertedPage;
	/** Points added on each side. */
	readonly left: number;
	readonly right: number;
	readonly top: number;
	readonly bottom: number;
}

/**
 * The page grown so that `region` (in PDF space) is inside it on every side,
 * or null when it already is. A side that must grow grows by at least
 * `minGrowth` points, rounded up to {@link canvasStep}, and never past
 * {@link MAX_CANVAS_SIDE}.
 */
export function grownCanvasPage(
	page: InsertedPage,
	region: Bounds,
	minGrowth: number,
	now: number,
): CanvasGrowth | null {
	const { width, height } = page.size;
	const origin = pageOrigin(page);
	const step = canvasStep(page.template);
	const grow = (needed: number): number =>
		needed > 0 ? wholeSteps(Math.max(needed, minGrowth), step) : 0;

	let left = grow(origin.x - region.minX);
	let right = grow(region.maxX - (origin.x + width));
	let bottom = grow(origin.y - region.minY);
	let top = grow(region.maxY - (origin.y + height));

	// Over the cap: what room is left, in whole steps, goes to the side that
	// asked for more first.
	const cap = (a: number, b: number, side: number): [number, number] => {
		const room = Math.max(0, Math.floor((MAX_CANVAS_SIDE - side) / step + 1e-9) * step);
		if (a + b <= room) return [a, b];
		const down = (amount: number): number => Math.floor(amount / step + 1e-9) * step;
		if (a >= b) {
			const first = down(Math.min(a, room));
			return [first, down(Math.min(b, room - first))];
		}
		const second = down(Math.min(b, room));
		return [down(Math.min(a, room - second)), second];
	};
	[left, right] = cap(left, right, width);
	[bottom, top] = cap(bottom, top, height);

	if (left === 0 && right === 0 && top === 0 && bottom === 0) return null;
	const nextOrigin = { x: origin.x - left, y: origin.y - bottom };
	const grown: InsertedPage = {
		...page,
		size: { width: width + left + right, height: height + top + bottom },
		updatedAt: now,
	};
	const { origin: _old, ...rest } = grown;
	return {
		page: nextOrigin.x === 0 && nextOrigin.y === 0 ? rest : { ...rest, origin: nextOrigin },
		left,
		right,
		top,
		bottom,
	};
}

/** Clear space kept around ink sent to a notebook page, in points. */
export const NOTEBOOK_MARGIN = 36;

/** A page's worth of ink taken off a board, ready for a notebook. */
export interface NotebookPageInk {
	/** The page size it needs: `base`, enlarged only if the ink would not fit. */
	readonly size: PageSize;
	/** Copies with new ids, moved to the page's top left, in paint order. */
	readonly items: Item[];
}

/**
 * Ink from a board laid on a fresh notebook page of size `base` (its origin at
 * (0, 0)): its top-left corner goes {@link NOTEBOOK_MARGIN} in from the page's,
 * below `topReserve` points kept clear at the top (a title header's band). The
 * page is enlarged, never the ink shrunk, when the ink is bigger than the page.
 *
 * Every copy gets a new id, so sending the same ink twice never makes two items
 * that would merge as one, and keeps its relative paint order. Null when there
 * is no live ink with a size.
 */
export function selectionForNotebook(
	items: readonly Item[],
	base: PageSize,
	topReserve: number,
	nextId: () => string,
	now: number,
): NotebookPageInk | null {
	const live = items.filter(isLive);
	const bounds = itemsBounds(live);
	if (!bounds) return null;

	const inkW = bounds.maxX - bounds.minX;
	const inkH = bounds.maxY - bounds.minY;
	const size: PageSize = {
		width: Math.max(base.width, Math.ceil(inkW + 2 * NOTEBOOK_MARGIN)),
		height: Math.max(base.height, Math.ceil(inkH + 2 * NOTEBOOK_MARGIN + topReserve)),
	};
	const shift = translation(
		NOTEBOOK_MARGIN - bounds.minX,
		size.height - topReserve - NOTEBOOK_MARGIN - bounds.maxY,
	);
	const ordered = live
		.map((item, index) => ({ item, index }))
		.sort((a, b) => a.item.z - b.item.z || a.index - b.index);
	return {
		size,
		items: ordered.map(({ item }, z) =>
			transformItem({ ...item, id: nextId(), z, updatedAt: now }, shift),
		),
	};
}

/**
 * Notebook `data` with one page added at its end holding `items`, laid out by
 * {@link selectionForNotebook}: the size and ruling of its last page (a new
 * notebook's when it has none), enlarged to fit. The first page keeps clear of
 * a title header. Null when there is nothing to send. Nothing already in the
 * notebook changes.
 */
export function withSentPage(
	data: InkData,
	items: readonly Item[],
	nextId: () => string,
	now: number,
	pageId = createPageId(),
): { data: InkData; pageNumber: number } | null {
	const order = orderPages(0, data.insertedPages);
	const lastSlot = order[order.length - 1];
	const last = lastSlot?.kind === 'inserted' ? lastSlot.page : undefined;
	const base = last ? last.size : NOTEBOOK_PAGE_SIZE;
	const template = last ? last.template : NOTEBOOK_TEMPLATE;
	const topReserve = order.length === 0 && data.header ? HEADER_BAND : 0;
	const sent = selectionForNotebook(items, base, topReserve, nextId, now);
	if (!sent) return null;
	const page = createInsertedPage(order, order.length, template, sent.size, now, pageId);
	return {
		data: {
			...data,
			insertedPages: [...data.insertedPages, page],
			pages: { ...data.pages, [insertedPageKey(page.id)]: sent.items },
		},
		pageNumber: order.length + 1,
	};
}
