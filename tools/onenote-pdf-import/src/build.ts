/**
 * A reconstructed canvas as a notebook.
 *
 * A wide canvas stays one wide page, a board, at the canvas's own size. A tall
 * one is paginated into Letter pages by src/core/paginate.ts, exactly as the
 * plugin would split it.
 */

import { FIRST_KEY, keysBetween } from '../../../src/core/fracindex';
import { INK_DATA_VERSION, type InkData, type Item, type PathItem, type TextItem } from '../../../src/core/items';
import { createDocId } from '../../../src/core/new-notebook';
import { LETTER_HEIGHT, LETTER_WIDTH, paginate } from '../../../src/core/paginate';
import { serializePathData } from '../../../src/core/path';
import { BEFORE_FIRST_PAGE, type InsertedPage, createPageId, insertedPageKey } from '../../../src/core/pages';
import { BASELINE_RATIO, LINE_HEIGHT } from '../../../src/core/text-layout';
import type { PageTemplate } from '../../../src/core/templates';
import type { RawPath, RawText } from './extract';
import type { Canvas } from './reconstruct';

export type Layout = 'board' | 'paginated';

/** A board when wider than tall, or much wider than a Letter page. */
export function classify(width: number, height: number): Layout {
	return width > height || width > 1.5 * LETTER_WIDTH ? 'board' : 'paginated';
}

/** A board is ruled; a paginated note keeps OneNote's plain paper. */
export const BOARD_TEMPLATE: PageTemplate = 'grid5';
export const PAGE_TEMPLATE: PageTemplate = 'blank';

export interface BuildOptions {
	readonly now: number;
	/** Injectable for deterministic tests. */
	readonly newId?: () => string;
	readonly docId?: string;
}

export interface Built {
	readonly data: InkData;
	readonly layout: Layout;
	readonly pageCount: number;
	readonly pathCount: number;
	readonly textCount: number;
}

function pathItem(raw: RawPath, id: string, z: number, now: number): PathItem {
	const item: PathItem = {
		type: 'path',
		id,
		color: raw.color,
		opacity: raw.alpha,
		rotation: 0,
		z,
		updatedAt: now,
		d: serializePathData(raw.commands),
	};
	if (raw.paint === 'stroke') item.strokeWidth = raw.lineWidth;
	if (raw.highlight) item.highlight = true;
	return item;
}

/**
 * A text box that draws `raw` where the export drew it: its first baseline sits
 * {@link BASELINE_RATIO} of the font size below the box's top. Wide enough that
 * the run never wraps.
 */
function textItem(raw: RawText, id: string, z: number, now: number): TextItem {
	const h = raw.fontSize * LINE_HEIGHT;
	const top = raw.y + raw.fontSize * BASELINE_RATIO;
	return {
		type: 'text',
		id,
		color: raw.color,
		opacity: 1,
		rotation: 0,
		z,
		updatedAt: now,
		box: { x: raw.x, y: top - h, w: raw.width * 1.1 + raw.fontSize, h },
		text: raw.text,
		fontSize: raw.fontSize,
	};
}

/** Ink first, then text over it, each in the order the export drew it. */
export function canvasItems(canvas: Canvas, now: number, newId: () => string): Item[] {
	const items: Item[] = [];
	for (const raw of canvas.paths) items.push(pathItem(raw, newId(), items.length, now));
	for (const raw of canvas.texts) items.push(textItem(raw, newId(), items.length, now));
	return items;
}

export function buildNotebook(canvas: Canvas, options: BuildOptions): Built {
	const { now } = options;
	const newId = options.newId ?? createPageId;
	const docId = options.docId ?? createDocId();
	const layout = classify(canvas.width, canvas.height);
	const items = canvasItems(canvas, now, newId);

	if (layout === 'board') {
		const page: InsertedPage = {
			id: newId(),
			afterPdfPage: BEFORE_FIRST_PAGE,
			sortKey: FIRST_KEY,
			template: BOARD_TEMPLATE,
			size: { width: canvas.width, height: canvas.height },
			updatedAt: now,
		};
		return {
			data: {
				version: INK_DATA_VERSION,
				pages: items.length > 0 ? { [insertedPageKey(page.id)]: items } : {},
				insertedPages: [page],
				docId,
				layout: 'board',
			},
			layout,
			pageCount: 1,
			pathCount: canvas.paths.length,
			textCount: canvas.texts.length,
		};
	}

	const pagination = paginate(items, { canvasWidth: canvas.width, columns: false });
	// An empty note still gets its one page.
	const count = Math.max(1, pagination.pages.length);
	const keys = keysBetween(null, null, count);
	const insertedPages: InsertedPage[] = [];
	const pages: Record<string, Item[]> = {};
	for (let i = 0; i < count; i++) {
		const page: InsertedPage = {
			id: newId(),
			afterPdfPage: BEFORE_FIRST_PAGE,
			sortKey: keys[i] ?? FIRST_KEY,
			template: PAGE_TEMPLATE,
			size: { width: LETTER_WIDTH, height: LETTER_HEIGHT },
			updatedAt: now,
		};
		insertedPages.push(page);
		const onPage = pagination.pages[i]?.items ?? [];
		if (onPage.length > 0) pages[insertedPageKey(page.id)] = onPage;
	}
	return {
		data: { version: INK_DATA_VERSION, pages, insertedPages, docId },
		layout,
		pageCount: count,
		pathCount: canvas.paths.length,
		textCount: canvas.texts.length,
	};
}
