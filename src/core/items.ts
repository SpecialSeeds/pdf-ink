/**
 * The annotation data model, schema version 5. Pure.
 *
 * Every coordinate here is in PDF user space (points, y up), per the project
 * invariant, which is what lets items survive zoom, rotation and re-rendering.
 *
 * Version 2 replaced v1's stroke-only list with a discriminated union. Version 3
 * adds `updatedAt` and a `deletedAt` tombstone to every item, so two devices editing
 * the same sidecar can be merged item by item instead of one overwriting the other.
 * Deletion is a tombstone rather than a splice, because a removed item that simply
 * vanished would be silently resurrected by the other side's older copy.
 *
 * Version 4 files items under a string {@link PageKey} rather than a page index,
 * and adds the records for pages that are not in the source PDF. An index cannot
 * survive an insertion — putting a page before page 3 would re-home every
 * annotation after it — so the key is the page's identity instead of its position.
 *
 * Version 5 adds the `path` item: a vector outline, such as ink imported from
 * another app, drawn exactly as stored rather than through the pen's outline.
 * A v4 file needs no rewriting to be read as v5; only its version changes.
 */

export const INK_DATA_VERSION = 5;

/** The oldest schema this build can read and migrate. */
export const OLDEST_SUPPORTED_VERSION = 1;

import type { BaseRef } from './base-layer';
import type { InsertedPage, PageKey } from './pages';

/** Axis-aligned box in PDF user space. */
export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface ItemBase {
	id: string;
	color: string;
	opacity: number;
	/**
	 * Degrees, clockwise, about the item's own centre. Degrees rather than
	 * radians to match PDF's own `/Rotate`, and because it reads better in JSON.
	 * Strokes are baked in PDF space and so are always 0.
	 */
	rotation: number;
	/** Paint order within a page: lower draws first. */
	z: number;
	/** Epoch milliseconds of the last edit. Decides who wins a merge. */
	updatedAt: number;
	/**
	 * Epoch milliseconds when this item was deleted, or undefined while it lives.
	 *
	 * A tombstone rather than a removal: a deletion has to be representable, or a
	 * stale copy from another device would bring the item back.
	 */
	deletedAt?: number;
}

export type InkTool = 'pen' | 'highlighter';

/** `[x, y, pressure]` in PDF user space; pressure in (0, 1]. */
export type StrokeSample = [number, number, number];

export interface Stroke extends ItemBase {
	type: 'stroke';
	tool: InkTool;
	/** Nib diameter in PDF points, so it scales with the page. */
	width: number;
	points: StrokeSample[];
	/**
	 * True when this end was produced by a sized erase rather than by lifting the
	 * pen, in which case it must be drawn blunt instead of tapered. Optional and
	 * additive: a file without them reads as an uncut stroke.
	 */
	cutStart?: boolean;
	cutEnd?: boolean;
}

export type ShapeKind =
	| 'line'
	| 'arrow'
	| 'rect'
	| 'ellipse'
	| 'triangle'
	| 'axes2d_q'
	| 'axes2d_c'
	| 'axes3d_c';

export const SHAPE_KINDS: readonly ShapeKind[] = [
	'line',
	'arrow',
	'rect',
	'ellipse',
	'triangle',
	'axes2d_q',
	'axes2d_c',
	'axes3d_c',
];

export interface ShapeItem extends ItemBase {
	type: 'shape';
	kind: ShapeKind;
	box: Box;
	/** Outline width in PDF points. */
	width: number;
	fill: string | null;
}

export interface TextItem extends ItemBase {
	type: 'text';
	box: Box;
	text: string;
	/** In PDF points. */
	fontSize: number;
}

/**
 * A vector outline in PDF user space, filled with `color` at `opacity`.
 *
 * Its geometry is final: unlike a stroke, nothing is generated from it, so it
 * looks exactly as it did in the app it came from.
 */
export interface PathItem extends ItemBase {
	type: 'path';
	/**
	 * SVG-style path data in PDF user space: absolute `M`, `L`, `C` and `Z`
	 * only. Parsed through src/core/path.ts, never by hand.
	 */
	d: string;
	/** Drawn as an outline of this width, in PDF points, instead of filled. */
	strokeWidth?: number;
	/** Highlighter ink: drawn on the highlight layer and blended like one. */
	highlight?: boolean;
}

export type Item = Stroke | ShapeItem | TextItem | PathItem;
export type ItemType = Item['type'];

export const ITEM_TYPES: readonly ItemType[] = ['stroke', 'shape', 'text', 'path'];

/** The `<file>.ink.json` shape. Page keys are {@link PageKey}, never indices. */
export interface InkData {
	readonly version: number;
	/** Items per page, keyed by page key. */
	readonly pages: Record<PageKey, Item[]>;
	/** Records for pages that are not in the source PDF. Tombstones included. */
	readonly insertedPages: readonly InsertedPage[];
	/**
	 * A notebook's identity, a UUID, so a sync client's numbered copy
	 * (`Notes 2.inknote`) can be told from a notebook that merely has a similar
	 * name. Absent from PDF sidecars, which are identified by their PDF.
	 */
	readonly docId?: string;
	/**
	 * `"board"` for a notebook that is one wide canvas rather than a stack of
	 * pages: its page grows as it is written on, and it never appends another.
	 * Absent for an ordinary notebook and for every PDF sidecar.
	 */
	readonly layout?: DocumentLayout;
	/**
	 * The notebook's base layer: imported ink kept in a sibling file and named
	 * here by content hash. See src/core/base-layer.ts.
	 */
	readonly base?: BaseRef;
}

export type DocumentLayout = 'board';

/** Epoch milliseconds. Injectable so tests and merges are deterministic. */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

export function isLive(item: Item): boolean {
	return item.deletedAt === undefined || item.deletedAt === 0;
}

export function isDeleted(item: Item): boolean {
	return !isLive(item);
}

/** Only the items that should be drawn, hit-tested or exported. */
export function liveItems(items: readonly Item[]): Item[] {
	return items.filter(isLive);
}

/** A copy marked as edited now. */
export function touched<T extends Item>(item: T, now: number): T {
	return { ...item, updatedAt: now };
}

/** A copy marked as deleted now. Geometry is kept so an undo can restore it. */
export function tombstoned<T extends Item>(item: T, now: number): T {
	return { ...item, updatedAt: now, deletedAt: now };
}

/** A copy brought back to life. */
export function revived<T extends Item>(item: T, now: number): T {
	const next = { ...item, updatedAt: now };
	delete next.deletedAt;
	return next;
}

export function isStroke(item: Item): item is Stroke {
	return item.type === 'stroke';
}

export function isShape(item: Item): item is ShapeItem {
	return item.type === 'shape';
}

export function isText(item: Item): item is TextItem {
	return item.type === 'text';
}

export function isPath(item: Item): item is PathItem {
	return item.type === 'path';
}

export function isShapeKind(value: unknown): value is ShapeKind {
	return (
		typeof value === 'string' && SHAPE_KINDS.includes(value as ShapeKind)
	);
}

/** Live items in paint order. Stable, so equal z keeps insertion order. */
export function inZOrder(items: readonly Item[]): Item[] {
	return liveItems(items).sort((a, b) => a.z - b.z);
}

export function emptyInkData(): InkData {
	return { version: INK_DATA_VERSION, pages: {}, insertedPages: [] };
}
