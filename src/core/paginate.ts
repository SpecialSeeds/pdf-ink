/**
 * Splitting one tall canvas of ink into letter pages. Pure.
 *
 * Input is the canvas's items in PDF user space (points, y up), read top to
 * bottom. Output is one item list per page, already mapped into that page's own
 * PDF space, so the exporter can draw it as is.
 *
 * A page break is chosen from the ink, not from the page height: within the
 * bottom 35% of the page the widest empty horizontal band wins, and only when
 * there is none does the break fall on the row with the least ink. Strokes trace
 * their path into that profile; shapes, text boxes and paths fill their bounding box.
 * No item is ever cut; one crossing the break moves whole to the next page.
 *
 * A board is first split into columns, at long vertical divider strokes and at
 * empty vertical gutters, and the columns are paginated left to right.
 */

import type { Bounds } from './hit-test';
import { type Item, type Stroke, isLive } from './items';
import { pathBounds } from './path';
import { scaleAbout, transformItem } from './transform';

export interface PaginateOptions {
	/** Width of the source canvas, so a narrow column keeps its x position. */
	readonly canvasWidth?: number;
	readonly pageWidth?: number;
	readonly pageHeight?: number;
	/** The same on all four sides, in page points. */
	readonly margin?: number;
	/** The share of the page, from the bottom, searched for a break. */
	readonly breakZone?: number;
	/** False keeps the canvas as a single column. */
	readonly columns?: boolean;
	/** Narrowest empty vertical band that separates two columns, in points. */
	readonly minGutter?: number;
	/** Shortest stroke that counts as a column divider, as a share of the ink's height. */
	readonly dividerMinFraction?: number;
}

export const LETTER_WIDTH = 612;
export const LETTER_HEIGHT = 792;

const DEFAULTS = {
	canvasWidth: LETTER_WIDTH,
	pageWidth: LETTER_WIDTH,
	pageHeight: LETTER_HEIGHT,
	margin: 36,
	breakZone: 0.35,
	columns: true,
	minGutter: 36,
	dividerMinFraction: 0.6,
} satisfies Required<PaginateOptions>;

/** A horizontal slice of the canvas that is paginated on its own. */
export interface Column {
	readonly left: number;
	readonly right: number;
	readonly items: Item[];
}

export interface ColumnSplit {
	readonly columns: Column[];
	/** Divider strokes. They separate columns, so no page draws them. */
	readonly dividers: Stroke[];
}

export interface PaginatedPage {
	/** Index into {@link Pagination.columns}. */
	readonly column: number;
	/** The items, in page space. Ids are kept. */
	readonly items: Item[];
	/**
	 * Page points per canvas unit. Below 1 when the column is wider than the
	 * page, or when an item is too tall for one.
	 */
	readonly scale: number;
	/** The canvas y the page's top content edge maps from. */
	readonly canvasTop: number;
}

export interface Pagination {
	readonly pages: PaginatedPage[];
	readonly columns: Column[];
	readonly dividers: Stroke[];
}

/** An item's extent, including a stroke's nib or a shape's outline. */
export function itemExtent(item: Item): Bounds | null {
	if (item.type === 'path') return pathBounds(item);
	if (item.type !== 'stroke') {
		// The box turns about its centre, so take the turned box's bounds.
		const { box } = item;
		const radians = (item.rotation * Math.PI) / 180;
		const cos = Math.abs(Math.cos(radians));
		const sin = Math.abs(Math.sin(radians));
		const w = Math.abs(box.w);
		const h = Math.abs(box.h);
		const pad = item.type === 'shape' ? item.width / 2 : 0;
		const halfW = (w * cos + h * sin) / 2 + pad;
		const halfH = (w * sin + h * cos) / 2 + pad;
		const cx = box.x + box.w / 2;
		const cy = box.y + box.h / 2;
		return { minX: cx - halfW, minY: cy - halfH, maxX: cx + halfW, maxY: cy + halfH };
	}
	const stroke = item;
	const first = stroke.points[0];
	if (!first) return null;
	let minX = first[0];
	let maxX = first[0];
	let minY = first[1];
	let maxY = first[1];
	for (const [x, y] of stroke.points) {
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}
	const half = stroke.width / 2;
	return {
		minX: minX - half,
		minY: minY - half,
		maxX: maxX + half,
		maxY: maxY + half,
	};
}

interface Placed {
	readonly item: Item;
	readonly bounds: Bounds;
}

function place(items: readonly Item[]): Placed[] {
	const placed: Placed[] = [];
	for (const item of items) {
		if (!isLive(item)) continue;
		const bounds = itemExtent(item);
		if (bounds) placed.push({ item, bounds });
	}
	return placed;
}

function unionBounds(items: readonly Placed[]): Bounds | null {
	if (items.length === 0) return null;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const { bounds } of items) {
		minX = Math.min(minX, bounds.minX);
		minY = Math.min(minY, bounds.minY);
		maxX = Math.max(maxX, bounds.maxX);
		maxY = Math.max(maxY, bounds.maxY);
	}
	return { minX, minY, maxX, maxY };
}

/** A run of consecutive empty bins, `[start, end)`. */
interface Run {
	readonly start: number;
	readonly end: number;
}

function emptyRuns(profile: Float64Array, from: number, to: number): Run[] {
	const runs: Run[] = [];
	let start = -1;
	for (let i = from; i < to; i++) {
		if ((profile[i] ?? 0) === 0) {
			if (start < 0) start = i;
		} else if (start >= 0) {
			runs.push({ start, end: i });
			start = -1;
		}
	}
	if (start >= 0) runs.push({ start, end: to });
	return runs;
}

/**
 * How much ink each row holds, top row first. Each stroke segment spreads its
 * area (length plus nib, times nib) evenly over the rows it spans, and a shape
 * or text box spreads its box's area over its bounding box's rows, so a row is
 * zero exactly when no item passes through it.
 */
export function rowInkProfile(
	items: readonly Item[],
	top: number,
	rows: number,
	rowHeight: number,
): Float64Array {
	const profile = new Float64Array(rows);
	const add = (hi: number, lo: number, area: number): void => {
		const first = Math.max(0, Math.floor((top - hi) / rowHeight));
		const last = Math.min(rows - 1, Math.floor((top - lo) / rowHeight));
		if (last < first) return;
		const spanned = Math.max(1, Math.ceil((hi - lo) / rowHeight));
		for (let row = first; row <= last; row++) {
			profile[row] = (profile[row] ?? 0) + area / spanned;
		}
	};
	for (const item of items) {
		if (item.type !== 'stroke') {
			const bounds = itemExtent(item);
			if (!bounds) continue;
			const area = (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY);
			add(bounds.maxY, bounds.minY, Math.max(area, 1e-3));
			continue;
		}
		const half = item.width / 2;
		const points = item.points;
		const segments = Math.max(1, points.length - 1);
		for (let i = 0; i < segments; i++) {
			const a = points[i];
			const b = points[i + 1] ?? a;
			if (!a || !b) continue;
			const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
			const area = (length + item.width) * Math.max(item.width, 1e-3);
			add(Math.max(a[1], b[1]) + half, Math.min(a[1], b[1]) - half, area);
		}
	}
	return profile;
}

/**
 * The canvas y to break at, for a page whose content starts at `top` and holds
 * `rows` rows of `rowHeight`. Searches the bottom `zone` of the page.
 */
export function chooseBreak(
	items: readonly Item[],
	top: number,
	rows: number,
	rowHeight: number,
	zone: number,
): number {
	const profile = rowInkProfile(items, top, rows, rowHeight);
	const from = Math.min(rows - 1, Math.floor(rows * (1 - zone)));

	// Widest empty band; on a tie the lower one, so the page holds more.
	let best: Run | null = null;
	for (const run of emptyRuns(profile, from, rows)) {
		if (!best || run.end - run.start >= best.end - best.start) best = run;
	}
	if (best) return top - ((best.start + best.end) / 2) * rowHeight;

	let least = from;
	for (let row = from; row < rows; row++) {
		if ((profile[row] ?? 0) <= (profile[least] ?? 0)) least = row;
	}
	return top - (least + 0.5) * rowHeight;
}

/**
 * Split a board into columns at long vertical divider strokes and at empty
 * vertical gutters. A divider or gutter only splits when there is ink on both
 * sides of it; an item goes to the column holding its centre.
 */
export function splitColumns(
	items: readonly Item[],
	options: PaginateOptions = {},
): ColumnSplit {
	const opts = { ...DEFAULTS, ...options };
	const placed = place(items);
	const whole: Column = {
		left: 0,
		right: opts.canvasWidth,
		items: placed.map((p) => p.item),
	};
	const all = unionBounds(placed);
	if (!all || !opts.columns) return { columns: [whole], dividers: [] };

	const height = all.maxY - all.minY;
	const hasInkBothSides = (x: number, among: readonly Placed[]): boolean =>
		among.some((p) => p.bounds.maxX < x) && among.some((p) => p.bounds.minX > x);

	const dividerCandidates = placed.filter(({ item, bounds }) => {
		if (item.type !== 'stroke') return false;
		const h = bounds.maxY - bounds.minY;
		const w = bounds.maxX - bounds.minX - item.width;
		return h >= height * opts.dividerMinFraction && w <= h * 0.05;
	});
	const others = placed.filter((p) => !dividerCandidates.includes(p));
	const dividers = dividerCandidates.filter((p) =>
		hasInkBothSides((p.bounds.minX + p.bounds.maxX) / 2, others),
	);
	const content = placed.filter((p) => !dividers.includes(p));

	const cuts: number[] = dividers.map((p) => (p.bounds.minX + p.bounds.maxX) / 2);

	// Gutters: empty vertical bands in the x profile, one point per bin. Long
	// vertical lines are left out, so a lone margin rule is not a column.
	const left = Math.floor(all.minX);
	const bins = Math.max(1, Math.ceil(all.maxX) - left);
	const profile = new Float64Array(bins);
	for (const { bounds } of others) {
		const first = Math.max(0, Math.floor(bounds.minX - left));
		const last = Math.min(bins - 1, Math.floor(bounds.maxX - left));
		for (let i = first; i <= last; i++) profile[i] = 1;
	}
	for (const run of emptyRuns(profile, 0, bins)) {
		if (run.end - run.start < opts.minGutter) continue;
		const x = left + (run.start + run.end) / 2;
		if (!hasInkBothSides(x, others)) continue;
		// A divider usually stands in its own gutter: one cut, not two.
		if (cuts.some((c) => Math.abs(c - x) < (run.end - run.start) / 2 + opts.minGutter))
			continue;
		cuts.push(x);
	}
	cuts.sort((a, b) => a - b);

	const edges = [Math.min(0, all.minX), ...cuts, Math.max(opts.canvasWidth, all.maxX)];
	const columns: Column[] = [];
	for (let i = 0; i + 1 < edges.length; i++) {
		const lo = edges[i] ?? 0;
		const hi = edges[i + 1] ?? lo;
		const last = i + 2 === edges.length;
		const members = content.filter((p) => {
			const cx = (p.bounds.minX + p.bounds.maxX) / 2;
			return cx >= lo && (last ? cx <= hi : cx < hi);
		});
		if (members.length > 0) {
			columns.push({ left: lo, right: hi, items: members.map((p) => p.item) });
		}
	}
	return {
		columns,
		dividers: dividers.map((p) => p.item).filter((item) => item.type === 'stroke'),
	};
}

/**
 * `item` scaled uniformly by `scale` about the canvas origin, then moved by
 * `(dx, dy)`. Stroke and outline widths scale with it; `transformItem` already
 * scales a text box's font size.
 */
function mapItem(item: Item, scale: number, dx: number, dy: number): Item {
	const moved = transformItem(item, { ...scaleAbout(0, 0, scale, scale), dx, dy });
	if (moved.type === 'text') return moved;
	if (moved.type === 'path') {
		return moved.strokeWidth === undefined
			? moved
			: { ...moved, strokeWidth: moved.strokeWidth * scale };
	}
	return { ...moved, width: moved.width * scale };
}

/** Paginate one column, top to bottom. `index` is the column's position. */
function paginateColumn(
	column: Column,
	index: number,
	opts: Required<PaginateOptions>,
): PaginatedPage[] {
	let remaining = place(column.items);
	const ink = unionBounds(remaining);
	if (!ink) return [];

	const contentWidth = opts.pageWidth - 2 * opts.margin;
	const contentHeight = opts.pageHeight - 2 * opts.margin;
	const inkWidth = ink.maxX - ink.minX;
	const columnScale = inkWidth > contentWidth ? contentWidth / inkWidth : 1;

	// Scaled: flush left at the margin. Otherwise keep the x the ink had within
	// its column, nudged inside the margins if it must be.
	let keptShift = 0;
	{
		const lo = ink.minX - column.left;
		const hi = ink.maxX - column.left;
		if (lo < opts.margin) keptShift = opts.margin - lo;
		if (hi + keptShift > opts.pageWidth - opts.margin)
			keptShift = opts.pageWidth - opts.margin - hi;
	}
	const offsetX = (scale: number): number =>
		scale < 1 ? opts.margin - ink.minX * scale : keptShift - column.left;

	const rowHeight = 1 / columnScale;
	const rows = Math.ceil(contentHeight);
	const capacity = contentHeight / columnScale;
	const pages: PaginatedPage[] = [];

	while (remaining.length > 0) {
		const left = unionBounds(remaining);
		if (!left) break;
		const top = left.maxY;

		let taken: Placed[];
		if (top - left.minY <= capacity) {
			taken = remaining;
		} else {
			const inWindow = remaining.filter((p) => p.bounds.maxY > top - capacity);
			const line = chooseBreak(
				inWindow.map((p) => p.item),
				top,
				rows,
				rowHeight,
				opts.breakZone,
			);
			taken = remaining.filter((p) => p.bounds.minY >= line);
			// Nothing ends above the line: an item taller than the page. Keep it
			// whole on this page, with whatever starts beside it.
			if (taken.length === 0) taken = remaining.filter((p) => p.bounds.maxY > line);
		}

		// An item taller than the page shrinks the whole page to fit.
		const takenBounds = unionBounds(taken);
		const takenHeight = takenBounds ? top - takenBounds.minY : 0;
		const scale =
			takenHeight > capacity ? contentHeight / takenHeight : columnScale;

		const dx = offsetX(scale);
		const dy = opts.pageHeight - opts.margin - top * scale;
		pages.push({
			column: index,
			items: taken.map((p) => mapItem(p.item, scale, dx, dy)),
			scale,
			canvasTop: top,
		});
		remaining = remaining.filter((p) => !taken.includes(p));
	}
	return pages;
}

/**
 * Split `items`, drawn on one tall canvas, into pages of `pageWidth` by
 * `pageHeight` with `margin` on every side. Each page's content starts at the
 * top of its first item, so whitespace left above a page break is dropped.
 */
export function paginate(
	items: readonly Item[],
	options: PaginateOptions = {},
): Pagination {
	const opts = { ...DEFAULTS, ...options };
	const { columns, dividers } = splitColumns(items, opts);
	const pages = columns.flatMap((column, index) => paginateColumn(column, index, opts));
	return { pages, columns, dividers };
}
