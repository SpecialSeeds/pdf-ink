/**
 * Turning an imported note's title text into a header, after the fact. Pure.
 *
 * Notebooks imported before headers existed carry OneNote's title and date as
 * text boxes on page 1. This finds them the way the importer now does and
 * replaces them with a header. The text boxes usually live in the base layer,
 * which is never rewritten, so they are hidden by tombstones in the `.inknote`
 * instead, as any edit to a base item is.
 */

import { type BasePages, layerItems } from './base-layer';
import { NO_HEADER_REASONS, type NoHeaderReason, examineTitleHeader } from './header';
import { type InkData, type Item, liveItems, tombstoned } from './items';
import { insertedPageKey, orderPages, pageOrigin } from './pages';

export interface TitleConversion {
	/** The notebook data with the header added and the title text hidden. */
	readonly data: InkData;
	readonly createdAt: number;
	/** How many text boxes the header replaces. */
	readonly removed: number;
}

/** Why a notebook is left as it is. */
export type SkipReason = NoHeaderReason | 'has-header';

export const SKIP_REASONS: Record<SkipReason, string> = {
	...NO_HEADER_REASONS,
	'has-header': 'it has a header already',
};

/**
 * The conversion for a notebook titled `title`, or null when it has a header
 * already or its first page does not open with that title and a date line.
 */
export function convertTitleToHeader(
	data: InkData,
	base: Readonly<BasePages> | undefined,
	title: string,
	now: number,
): TitleConversion | null {
	const checked = checkTitleConversion(data, base, title, now);
	return 'reason' in checked ? null : checked;
}

/** {@link convertTitleToHeader}, saying why a notebook is left alone. */
export function checkTitleConversion(
	data: InkData,
	base: Readonly<BasePages> | undefined,
	title: string,
	now: number,
): TitleConversion | { readonly reason: SkipReason } {
	if (data.header) return { reason: 'has-header' };
	const first = orderPages(0, data.insertedPages)[0];
	if (!first || first.kind !== 'inserted') return { reason: 'no-title-text' };
	const key = insertedPageKey(first.page.id);
	const user = data.pages[key] ?? [];
	const items = liveItems(layerItems(base?.[key], user));
	const top = pageOrigin(first.page).y + first.page.size.height;
	const detected = examineTitleHeader(items, title, top);
	if ('reason' in detected) return detected;

	const gone = new Set(detected.ids);
	const next: Item[] = user.map((item) => (gone.has(item.id) ? tombstoned(item, now) : item));
	// Base items are hidden by a tombstone of their own in the user's layer.
	const inUser = new Set(user.map((item) => item.id));
	for (const item of items) {
		if (gone.has(item.id) && !inUser.has(item.id)) next.push(tombstoned(item, now));
	}
	return {
		data: { ...data, pages: { ...data.pages, [key]: next }, header: { createdAt: detected.createdAt } },
		createdAt: detected.createdAt,
		removed: detected.ids.length,
	};
}
