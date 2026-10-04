/**
 * Boards: a notebook that is one wide page rather than a stack of them. Pure.
 *
 * A board never appends a page. It grows instead: ink committed near its right
 * or bottom edge widens or lengthens the one page, in the same undo step as the
 * ink. Growing down lowers the page's origin, so nothing already on the board
 * moves in stored coordinates, and growth comes in whole multiples of the
 * ruling's spacing, so the ruling under existing ink does not shift either.
 */

import type { Bounds } from './hit-test';
import { INK_DATA_VERSION, type InkData } from './items';
import { createDocId } from './new-notebook';
import {
	BEFORE_FIRST_PAGE,
	type InsertedPage,
	type PageSize,
	createPageId,
	pageOrigin,
} from './pages';
import { FIRST_KEY } from './fracindex';
import { type PageTemplate, templateSpacing } from './templates';

/** Ink this close to the right or bottom edge, as a share of that side, grows the board. */
export const BOARD_EDGE_ZONE = 0.1;

/** Each growth adds at least this share of the side it grows. */
export const BOARD_GROWTH = 0.25;

/** A new board: two Letter pages side by side, ruled as a 5 mm grid. */
export const NEW_BOARD_SIZE: PageSize = { width: 1224, height: 792 };
export const BOARD_TEMPLATE: PageTemplate = 'grid5';

/** `amount` rounded up to a whole number of `step`s; any amount when step is 0. */
function wholeSteps(amount: number, step: number): number {
	return step > 0 ? Math.ceil(amount / step - 1e-9) * step : amount;
}

/**
 * The page record a board should have after `ink` was committed on `page`, or
 * null when the ink is clear of the right and bottom edges.
 *
 * Grows by {@link BOARD_GROWTH} of the side at least, and further if that would
 * still leave the ink inside the edge zone, so one stroke never needs two
 * growths. The left and top edges never move: a board is written from its top
 * left, as a page is.
 */
export function grownBoardPage(page: InsertedPage, ink: Bounds, now: number): InsertedPage | null {
	const { width, height } = page.size;
	const origin = pageOrigin(page);
	const step = templateSpacing(page.template);

	const right = origin.x + width;
	const reachRight = ink.maxX - (right - width * BOARD_EDGE_ZONE);
	let nextWidth = width;
	if (reachRight > 0) {
		// Solve for the width whose edge zone the ink just clears.
		const needed = (ink.maxX - origin.x) / (1 - BOARD_EDGE_ZONE) - width;
		nextWidth = width + wholeSteps(Math.max(width * BOARD_GROWTH, needed), step);
	}

	const top = origin.y + height;
	const reachBottom = origin.y + height * BOARD_EDGE_ZONE - ink.minY;
	let nextHeight = height;
	if (reachBottom > 0) {
		const needed = (top - ink.minY) / (1 - BOARD_EDGE_ZONE) - height;
		nextHeight = height + wholeSteps(Math.max(height * BOARD_GROWTH, needed), step);
	}

	if (nextWidth === width && nextHeight === height) return null;
	// The top stays put, so the extra height goes below the old bottom.
	const nextOrigin = { x: origin.x, y: top - nextHeight };
	const grown: InsertedPage = {
		...page,
		size: { width: nextWidth, height: nextHeight },
		updatedAt: now,
	};
	return nextOrigin.x === 0 && nextOrigin.y === 0
		? withoutOrigin(grown)
		: { ...grown, origin: nextOrigin };
}

function withoutOrigin(page: InsertedPage): InsertedPage {
	const copy = { ...page };
	delete (copy as { origin?: unknown }).origin;
	return copy;
}

/** The data of a new board: one wide ruled page, nothing on it, its own identity. */
export function newBoardData(now: number, id = createPageId(), docId = createDocId()): InkData {
	const page: InsertedPage = {
		id,
		afterPdfPage: BEFORE_FIRST_PAGE,
		sortKey: FIRST_KEY,
		template: BOARD_TEMPLATE,
		size: NEW_BOARD_SIZE,
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
