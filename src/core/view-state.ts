import { type PageKey, parsePageKey, pdfPageKey } from './pages';
import { type ThemeName, isThemeName } from './theme';
import type { ZoomMode } from '../types/view';

/** What a saved workspace can tell us about how to reopen a PDF. */
export interface RestoredInkState {
	readonly zoomMode: ZoomMode | null;
	/**
	 * The page to reopen at, as a page key, or null when absent or unusable.
	 *
	 * A key rather than a position: once a page can be inserted, position 3 is not
	 * the page the user was reading, and a link to it would silently drift.
	 */
	readonly pageKey: PageKey | null;
	/** The page theme this tab was showing, or null to follow Obsidian's. */
	readonly theme: ThemeName | null;
}

const EMPTY: RestoredInkState = { zoomMode: null, pageKey: null, theme: null };

/**
 * Parse the keys this view adds to its workspace state.
 *
 * Pure and total: anything unrecognised yields nulls, so a hand-edited or
 * older `workspace.json` degrades to the defaults rather than throwing.
 */
export function readInkViewState(state: unknown): RestoredInkState {
	if (state === null || typeof state !== 'object') return EMPTY;
	const raw = state as Record<string, unknown>;

	let zoomMode: ZoomMode | null = null;
	const kind = raw['zoomMode'];
	const zoom = raw['zoom'];
	if (kind === 'fit-width') {
		zoomMode = { kind: 'fit-width' };
	} else if (kind === 'fit-page') {
		zoomMode = { kind: 'fit-page' };
	} else if (kind === 'fit-height') {
		zoomMode = { kind: 'fit-height' };
	} else if (
		kind === 'fixed' &&
		typeof zoom === 'number' &&
		Number.isFinite(zoom) &&
		zoom > 0
	) {
		zoomMode = { kind: 'fixed', zoom };
	}

	let pageKey: PageKey | null = null;
	const key = raw['pageKey'];
	if (typeof key === 'string' && parsePageKey(key)) {
		pageKey = key;
	} else {
		// A workspace saved before pages could be inserted only recorded a number,
		// and back then the display position *was* the original page index.
		const page = raw['page'];
		if (typeof page === 'number' && Number.isInteger(page) && page >= 1) {
			pageKey = pdfPageKey(page - 1);
		}
	}

	const theme = isThemeName(raw['theme']) ? raw['theme'] : null;

	return { zoomMode, pageKey, theme };
}

/**
 * The keys this view contributes to `getState()`.
 *
 * `page` is written alongside `pageKey` even though it is never the authority:
 * it is what makes a hand-read `workspace.json` legible, and it is what an older
 * build of the plugin would fall back to.
 */
export function writeInkViewState(
	mode: ZoomMode,
	zoom: number,
	pageNumber: number,
	pageKey: PageKey | null,
	theme: ThemeName | null = null,
): Record<string, unknown> {
	return {
		zoomMode: mode.kind,
		zoom,
		page: pageNumber,
		...(pageKey === null ? {} : { pageKey }),
		...(theme === null ? {} : { theme }),
	};
}
