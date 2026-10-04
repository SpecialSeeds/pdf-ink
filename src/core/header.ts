/**
 * A notebook's title header: the page title OneNote draws at the top of a
 * page, with the date beneath it and a rule under both. Pure.
 *
 * The title is never stored. It is always the notebook file's own name, so a
 * rename and the header cannot disagree: what is stored is only when the
 * notebook was created, and optionally how to write that date.
 *
 * The geometry mirrors OneNote's, measured from its exports: the title's
 * baseline 33.5 pt below the top of the page at 20 pt, the date's 17.6 pt
 * lower at 10 pt, both 36 pt in from the left. An imported note's header
 * therefore lands where its title was.
 */

import type { Bounds } from './hit-test';
import { type Item, type TextItem, isLive } from './items';
import { type InsertedPage, pageOrigin } from './pages';
import type { TemplateGeometry } from './templates';

export type HeaderDateFormat = 'onenote' | 'iso';

export const HEADER_DATE_FORMATS: readonly HeaderDateFormat[] = ['onenote', 'iso'];

export function isHeaderDateFormat(value: unknown): value is HeaderDateFormat {
	return value === 'onenote' || value === 'iso';
}

/** What a notebook stores about its header. */
export interface NotebookHeader {
	/** Epoch milliseconds the notebook was created. */
	readonly createdAt: number;
	/** How to write the date; absent follows the plugin setting. */
	readonly dateFormat?: HeaderDateFormat;
}

/** The two lines as drawn. */
export interface HeaderText {
	readonly title: string;
	readonly date: string;
}

export const HEADER_LEFT = 36;
export const HEADER_TITLE_SIZE = 20;
export const HEADER_DATE_SIZE = 10;
/** Below the top of the page, in points. */
export const HEADER_TITLE_BASELINE = 33.5;
export const HEADER_DATE_BASELINE = 51.1;
export const HEADER_RULE = 58;
export const HEADER_RULE_WIDTH = 0.5;
/** The band the header keeps for itself: nothing is ruled above this. */
export const HEADER_BAND = 64;
/** Where content starts on page 1 of a paginated notebook with a header. */
export const HEADER_CONTENT_TOP = 72;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December',
];

function pad(n: number): string {
	return String(n).padStart(2, '0');
}

/**
 * `Saturday, October 3, 2026  2:02 PM` as OneNote writes it, or
 * `2026-10-03 14:02`. Local time, as the user saw it when they wrote.
 */
export function formatHeaderDate(createdAt: number, format: HeaderDateFormat): string {
	const d = new Date(createdAt);
	if (format === 'iso') {
		return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}
	const hour = d.getHours() % 12 === 0 ? 12 : d.getHours() % 12;
	const meridiem = d.getHours() < 12 ? 'AM' : 'PM';
	return `${WEEKDAYS[d.getDay()] ?? ''}, ${MONTHS[d.getMonth()] ?? ''} ${String(d.getDate())}, ${String(d.getFullYear())}  ${String(hour)}:${pad(d.getMinutes())} ${meridiem}`;
}

/** A notebook's title: its file's name without the extension or folders. */
export function titleFromPath(path: string): string {
	const name = path.slice(path.lastIndexOf('/') + 1);
	return name.replace(/\.inknote$/i, '');
}

export function headerText(
	path: string,
	header: NotebookHeader,
	fallbackFormat: HeaderDateFormat,
): HeaderText {
	return {
		title: titleFromPath(path),
		date: formatHeaderDate(header.createdAt, header.dateFormat ?? fallbackFormat),
	};
}

/** Where everything in the header goes on `page`, in PDF space. */
export interface HeaderLayout {
	readonly x: number;
	readonly titleBaseline: number;
	readonly dateBaseline: number;
	readonly ruleY: number;
	readonly ruleX2: number;
	readonly bandBottom: number;
}

export function headerLayout(page: InsertedPage): HeaderLayout {
	const origin = pageOrigin(page);
	const top = origin.y + page.size.height;
	return {
		x: origin.x + HEADER_LEFT,
		titleBaseline: top - HEADER_TITLE_BASELINE,
		dateBaseline: top - HEADER_DATE_BASELINE,
		ruleY: top - HEADER_RULE,
		ruleX2: origin.x + page.size.width - HEADER_LEFT,
		bandBottom: top - HEADER_BAND,
	};
}

/** Where a press edits the title: its line, the width of the page. */
export function headerTitleBox(page: InsertedPage): Bounds {
	const layout = headerLayout(page);
	return {
		minX: layout.x,
		minY: layout.titleBaseline - HEADER_TITLE_SIZE * 0.3,
		maxX: layout.ruleX2,
		maxY: layout.titleBaseline + HEADER_TITLE_SIZE * 0.9,
	};
}

/**
 * The ruling with nothing inside the header's band: horizontal rules and dots
 * above it go, and vertical lines stop at it. The writing area starts below.
 */
export function reserveHeaderBand(geometry: TemplateGeometry, bandBottom: number): TemplateGeometry {
	return {
		...geometry,
		lines: geometry.lines.flatMap((line) => {
			const low = Math.min(line.y1, line.y2);
			const high = Math.max(line.y1, line.y2);
			if (low >= bandBottom) return [];
			if (high <= bandBottom) return [line];
			return [line.y1 > line.y2 ? { ...line, y1: bandBottom } : { ...line, y2: bandBottom }];
		}),
		dots: geometry.dots.filter((dot) => dot.y < bandBottom),
	};
}

/** Lowercase letters and digits only, words single-spaced: how titles are compared. */
export function normalizeTitle(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
}

/**
 * Parse a date line as OneNote or the ISO format writes it, with or without a
 * time, as local time. Null when it is not a date.
 */
export function parseHeaderDate(text: string): number | null {
	const s = text.replace(/\s+/g, ' ').trim();
	const onenote =
		/^(?:[A-Za-z]+, )?([A-Za-z]+) (\d{1,2}), (\d{4})(?: (\d{1,2}):(\d{2}) ?([AaPp][Mm])?)?$/.exec(s);
	if (onenote) {
		const month = MONTHS.findIndex((m) => m.toLowerCase() === (onenote[1] ?? '').toLowerCase());
		if (month < 0) return null;
		let hours = Number(onenote[4] ?? 0);
		const meridiem = onenote[6]?.toUpperCase();
		if (meridiem === 'PM' && hours < 12) hours += 12;
		if (meridiem === 'AM' && hours === 12) hours = 0;
		return checked(Number(onenote[3]), month, Number(onenote[2]), hours, Number(onenote[5] ?? 0));
	}
	const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(s);
	if (iso) {
		return checked(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), Number(iso[4] ?? 0), Number(iso[5] ?? 0));
	}
	return null;
}

/** A local date, or null when its parts roll over (February 30th, 25 o'clock). */
function checked(year: number, month: number, day: number, hours: number, minutes: number): number | null {
	const d = new Date(year, month, day, hours, minutes);
	const same =
		d.getFullYear() === year &&
		d.getMonth() === month &&
		d.getDate() === day &&
		d.getHours() === hours &&
		d.getMinutes() === minutes;
	return same ? d.getTime() : null;
}

/** A text item's top edge, in PDF space. */
function topOf(item: TextItem): number {
	return Math.max(item.box.y, item.box.y + item.box.h);
}

/** How far below the top of the page a title may start and still be the title. */
const TITLE_REGION = 120;
/** How far below the title's top its date line may start. */
const DATE_REGION = 45;

export interface DetectedHeader {
	readonly createdAt: number;
	/** The text items the header replaces: the title, then the date line's runs. */
	readonly ids: readonly string[];
}

/** Why a page has no title to turn into a header. */
export type NoHeaderReason = 'no-title-text' | 'title-mismatch' | 'no-date-line';

export const NO_HEADER_REASONS: Record<NoHeaderReason, string> = {
	'no-title-text': 'no title text at the top of page 1',
	'title-mismatch': "the title doesn't match the file name",
	'no-date-line': 'no date line under the title',
};

/**
 * A page title written as text: the topmost text near the top of the page
 * matching `title`, and directly below it a date line, perhaps in several runs
 * (OneNote writes the date and the time separately). Both are needed: a note
 * that merely begins with its own name is not given a header.
 */
export function detectTitleHeader(
	items: readonly Item[],
	title: string,
	pageTop: number,
): DetectedHeader | null {
	const found = examineTitleHeader(items, title, pageTop);
	return 'reason' in found ? null : found;
}

/** {@link detectTitleHeader}, saying why when there is nothing to detect. */
export function examineTitleHeader(
	items: readonly Item[],
	title: string,
	pageTop: number,
): DetectedHeader | { readonly reason: NoHeaderReason } {
	const texts = items
		.filter((item): item is TextItem => item.type === 'text' && isLive(item))
		.filter((item) => topOf(item) >= pageTop - TITLE_REGION)
		.sort((a, b) => topOf(b) - topOf(a));
	const wanted = normalizeTitle(title);
	const titleItem = texts[0];
	if (!titleItem) return { reason: 'no-title-text' };
	if (wanted.length === 0 || normalizeTitle(titleItem.text) !== wanted) {
		return { reason: 'title-mismatch' };
	}

	const top = topOf(titleItem);
	const line = texts
		.slice(1)
		.filter((item) => topOf(item) < top && topOf(item) >= top - DATE_REGION)
		.sort((a, b) => Math.min(a.box.x, a.box.x + a.box.w) - Math.min(b.box.x, b.box.x + b.box.w));
	// The date line is the first row below the title: runs sharing its top.
	const first = line[0];
	if (!first) return { reason: 'no-date-line' };
	const row = line.filter((item) => Math.abs(topOf(item) - topOf(first)) <= first.fontSize * 0.5);
	const createdAt = parseHeaderDate(row.map((item) => item.text).join(' '));
	if (createdAt === null) return { reason: 'no-date-line' };
	return { createdAt, ids: [titleItem.id, ...row.map((item) => item.id)] };
}

/** Characters a file name in a vault cannot hold. */
const UNUSABLE = /[\\/:*?"<>|#^[\]]/;

export type RenameTarget =
	| { readonly ok: true; readonly path: string }
	| { readonly ok: false; readonly reason: 'unchanged' | 'empty' | 'invalid' | 'exists' };

/** Where a notebook goes when its title is edited to `title`, or why it does not. */
export function renameTargetFor(
	path: string,
	title: string,
	exists: (path: string) => boolean,
): RenameTarget {
	const trimmed = title.trim();
	if (trimmed.length === 0) return { ok: false, reason: 'empty' };
	if (UNUSABLE.test(trimmed) || trimmed.startsWith('.')) return { ok: false, reason: 'invalid' };
	if (trimmed === titleFromPath(path)) return { ok: false, reason: 'unchanged' };
	const folder = path.slice(0, path.lastIndexOf('/') + 1);
	const target = `${folder}${trimmed}.inknote`;
	// A change of case alone is the same file on a case-insensitive disk.
	if (target.toLowerCase() !== path.toLowerCase() && exists(target)) return { ok: false, reason: 'exists' };
	return { ok: true, path: target };
}
