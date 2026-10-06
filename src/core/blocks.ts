/**
 * Blocks: a page's content cut into paragraph-sized pieces. Pure.
 *
 * A block is what a transcript line points back to, so a search hit can open
 * the handwriting itself. Items join a block when they sit on the same line
 * close together (letters and words), or when one line sits just below
 * another and they overlap side to side (lines of a paragraph). How close
 * counts is scaled by the page's own line height, and loosened or tightened
 * until the page has between 5 and 20 blocks where it can.
 *
 * Ids are B1, B2, … in reading order: top to bottom by rows, then left to right
 * within a row. Everything is in PDF user space (y up).
 */

import { itemBounds, type Bounds } from './hit-test';
import { type Item, isLive } from './items';

export interface Block {
	/** `B1`, `B2`, … in reading order. */
	readonly id: string;
	readonly bounds: Bounds;
	/** The items it groups, by id. */
	readonly itemIds: readonly string[];
}

/** `[x, y, w, h]` in PDF space: x, y the bottom-left corner. */
export type BlockBox = readonly [number, number, number, number];

export const MIN_BLOCKS = 5;
export const MAX_BLOCKS = 20;

/** A Letter page's area, in square points: what 5 to 20 blocks is a target for. */
const LETTER_AREA = 612 * 792;

/** How many blocks a page should have: 5 to 20, more for a page larger than Letter. */
export interface BlockTarget {
	readonly min: number;
	readonly max: number;
}

/**
 * The block target for a page `width` by `height` points: 5 to 20 per Letter
 * page's worth of area, so a board the size of twenty pages is not crushed
 * into twenty blocks. A smaller page keeps the Letter target.
 */
export function blockTargetFor(width: number, height: number): BlockTarget {
	const pages = Math.max(1, (width * height) / LETTER_AREA);
	return { min: Math.round(MIN_BLOCKS * pages), max: Math.round(MAX_BLOCKS * pages) };
}

/** Multiples of the base distances tried to loosen a page cut too finely. */
const LOOSER = [1.5, 2, 3, 4, 6, 8, 12, 16];
/** ...and to tighten one cut too coarsely. */
const TIGHTER = [0.75, 0.5, 0.35];
/** Past this many clusters, joining them pair by pair costs too much. */
const MAX_TO_JOIN = 400;

interface Placed {
	readonly id: string;
	readonly b: Bounds;
}

/** An item's extent, with a stroke's or outline's width included. */
function extent(item: Item): Bounds | null {
	const b = itemBounds(item);
	if (!b) return null;
	const pad = item.type === 'stroke' || item.type === 'shape' ? item.width / 2 : 0;
	return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
}

/**
 * The page's typical line height: the median height of its items, which for
 * handwriting is about a letter's height, held to a sensible range.
 */
export function typicalLineHeight(bounds: readonly Bounds[]): number {
	if (bounds.length === 0) return 12;
	const heights = bounds.map((b) => b.maxY - b.minY).sort((a, b) => a - b);
	const median = heights[Math.floor(heights.length / 2)] ?? 12;
	return Math.min(48, Math.max(4, median));
}

function overlapX(a: Bounds, b: Bounds): boolean {
	return a.minX <= b.maxX && b.minX <= a.maxX;
}

function overlapY(a: Bounds, b: Bounds): boolean {
	return a.minY <= b.maxY && b.minY <= a.maxY;
}

function gapY(a: Bounds, b: Bounds): number {
	return Math.max(0, Math.max(a.minY, b.minY) - Math.min(a.maxY, b.maxY));
}

function gapX(a: Bounds, b: Bounds): number {
	return Math.max(0, Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX));
}

function union(a: Bounds, b: Bounds): Bounds {
	return {
		minX: Math.min(a.minX, b.minX),
		minY: Math.min(a.minY, b.minY),
		maxX: Math.max(a.maxX, b.maxX),
		maxY: Math.max(a.maxY, b.maxY),
	};
}

class Groups {
	private readonly parent: number[];
	constructor(n: number) {
		this.parent = Array.from({ length: n }, (_, i) => i);
	}
	find(i: number): number {
		let root = i;
		while (this.parent[root] !== root) root = this.parent[root] ?? root;
		// Path compression.
		let at = i;
		while (this.parent[at] !== root) {
			const next = this.parent[at] ?? root;
			this.parent[at] = root;
			at = next;
		}
		return root;
	}
	join(a: number, b: number): void {
		const ra = this.find(a);
		const rb = this.find(b);
		if (ra !== rb) this.parent[rb] = ra;
	}
}

/** Clusters at one scale of the base distances: groups of indices into `items`. */
function cluster(items: readonly Placed[], lineHeight: number, scale: number): number[][] {
	const vReach = 1.5 * lineHeight * scale;
	// Words on a line are further apart than lines are: join across wider gaps
	// when the two already share a line.
	const hReach = 4 * lineHeight * scale;
	const groups = new Groups(items.length);
	// Sweep from the top down: an item only needs comparing with those whose
	// vertical range comes within reach of its own.
	const order = items.map((_, i) => i).sort((a, b) => (items[b]?.b.maxY ?? 0) - (items[a]?.b.maxY ?? 0));
	for (let p = 0; p < order.length; p++) {
		const i = order[p] ?? 0;
		const a = items[i]?.b;
		if (!a) continue;
		for (let q = p + 1; q < order.length; q++) {
			const j = order[q] ?? 0;
			const b = items[j]?.b;
			if (!b) continue;
			// Sorted by top: once a top is too far below this item's bottom, so is every later one.
			if (a.minY - b.maxY > vReach) break;
			const sameLine = overlapY(a, b) && gapX(a, b) <= hReach;
			const nextLine = gapY(a, b) <= vReach && overlapX(a, b);
			if (sameLine || nextLine) groups.join(i, j);
		}
	}
	const byRoot = new Map<number, number[]>();
	items.forEach((_, i) => {
		const root = groups.find(i);
		const list = byRoot.get(root) ?? [];
		list.push(i);
		byRoot.set(root, list);
	});
	return mergeOverlapping([...byRoot.values()], items);
}

/** Groups whose boxes overlap become one: blocks never overlap each other. */
function mergeOverlapping(groups: number[][], items: readonly Placed[]): number[][] {
	let current = groups.map((members) => ({
		members,
		b: members.map((i) => items[i]?.b).reduce<Bounds | null>((acc, b) => (b ? (acc ? union(acc, b) : b) : acc), null),
	}));
	let merged = true;
	while (merged) {
		merged = false;
		outer: for (let i = 0; i < current.length; i++) {
			for (let j = i + 1; j < current.length; j++) {
				const a = current[i];
				const b = current[j];
				if (!a?.b || !b?.b) continue;
				if (overlapX(a.b, b.b) && overlapY(a.b, b.b)) {
					current[i] = { members: [...a.members, ...b.members], b: union(a.b, b.b) };
					current.splice(j, 1);
					merged = true;
					break outer;
				}
			}
		}
	}
	return current.map((g) => g.members);
}

function boundsOf(members: readonly number[], items: readonly Placed[]): Bounds {
	return members
		.map((i) => items[i]?.b)
		.reduce<Bounds>((acc, b) => (b ? union(acc, b) : acc), {
			minX: Infinity,
			minY: Infinity,
			maxX: -Infinity,
			maxY: -Infinity,
		});
}

/**
 * Clusters numbering 5 to 20 where the page allows. Too few, and the distances
 * are tightened. Too many, and they are loosened while that still leaves
 * enough; past that point (a page of evenly spaced lines joins all at once),
 * the two nearest clusters are joined, same column first, until 20 remain.
 */
function targetCount(items: readonly Placed[], lineHeight: number, target: BlockTarget): number[][] {
	let groups = cluster(items, lineHeight, 1);
	if (groups.length < target.min) {
		for (const scale of TIGHTER) {
			const tighter = cluster(items, lineHeight, scale);
			if (tighter.length > groups.length) groups = tighter;
			if (groups.length >= target.min) break;
		}
		// Tightening can overshoot the other way on a dense page.
		return groups.length > target.max ? joinNearest(groups, items, target.max) : groups;
	}
	if (groups.length <= target.max) return groups;
	for (const scale of LOOSER) {
		const looser = cluster(items, lineHeight, scale);
		if (looser.length < target.min) break;
		groups = looser;
		if (groups.length <= target.max) return groups;
		if (groups.length <= Math.max(MAX_TO_JOIN, target.max * 2)) break;
	}
	return joinNearest(groups, items, target.max);
}

/** How far apart two boxes are, counting a different column as further. */
function distance(a: Bounds, b: Bounds): number {
	return overlapX(a, b) ? gapY(a, b) : gapY(a, b) + gapX(a, b) * 2;
}

/** Join the nearest pair of clusters, again and again, until `target` remain. */
function joinNearest(groups: number[][], items: readonly Placed[], target: number): number[][] {
	let current = groups.map((members) => ({ members, b: boundsOf(members, items) }));
	while (current.length > target) {
		let bestI = 0;
		let bestJ = 1;
		let best = Infinity;
		for (let i = 0; i < current.length; i++) {
			for (let j = i + 1; j < current.length; j++) {
				const a = current[i];
				const b = current[j];
				if (!a || !b) continue;
				const d = distance(a.b, b.b);
				if (d < best) {
					best = d;
					bestI = i;
					bestJ = j;
				}
			}
		}
		const a = current[bestI];
		const b = current[bestJ];
		if (!a || !b) break;
		current[bestI] = { members: [...a.members, ...b.members], b: union(a.b, b.b) };
		current.splice(bestJ, 1);
		// A join can make a box reach over another: keep blocks apart.
		current = mergeOverlapping(
			current.map((g) => g.members),
			items,
		).map((members) => ({ members, b: boundsOf(members, items) }));
	}
	return current.map((g) => g.members);
}

/**
 * Order blocks as a page is read: rows from the top, each row left to right.
 *
 * A block joins a row when its top is close to the top of the row's first
 * block, closeness measured against the shorter of the two. Measuring against
 * the row's whole span instead let a tall diagram swallow every line beside it
 * into one row, and number a line below another before it.
 */
function readingOrder(boxes: readonly Bounds[]): number[] {
	const byTop = boxes.map((_, i) => i).sort((a, b) => (boxes[b]?.maxY ?? 0) - (boxes[a]?.maxY ?? 0));
	const rows: { first: Bounds; members: number[] }[] = [];
	for (const i of byTop) {
		const b = boxes[i];
		if (!b) continue;
		const row = rows[rows.length - 1];
		if (row) {
			const shorter = Math.min(row.first.maxY - row.first.minY, b.maxY - b.minY);
			if (row.first.maxY - b.maxY <= shorter / 2) {
				row.members.push(i);
				continue;
			}
		}
		rows.push({ first: b, members: [i] });
	}
	return rows.flatMap((row) =>
		row.members.sort((a, b) => (boxes[a]?.minX ?? 0) - (boxes[b]?.minX ?? 0)),
	);
}

/**
 * A page's live items as blocks, in reading order. Deterministic: the same
 * items always give the same blocks and ids, so a transcript's block ids keep
 * pointing at the same handwriting until the page is edited.
 */
export function segmentBlocks(
	items: readonly Item[],
	target: BlockTarget = { min: MIN_BLOCKS, max: MAX_BLOCKS },
): Block[] {
	const placed: Placed[] = [];
	for (const item of items) {
		if (!isLive(item)) continue;
		const b = extent(item);
		if (b) placed.push({ id: item.id, b });
	}
	if (placed.length === 0) return [];
	// The same items in any order give the same blocks: B7 has to mean the same
	// handwriting to the render, the transcript and a lookup.
	placed.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const lineHeight = typicalLineHeight(placed.map((p) => p.b));

	const groups = targetCount(placed, lineHeight, target);

	const boxes = groups.map((members) =>
		members.map((i) => placed[i]?.b).reduce<Bounds>(
			(acc, b) => (b ? union(acc, b) : acc),
			{ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
		),
	);
	return readingOrder(boxes).map((g, n) => ({
		id: `B${String(n + 1)}`,
		bounds: boxes[g] ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 },
		itemIds: (groups[g] ?? []).map((i) => placed[i]?.id ?? '').sort(),
	}));
}

/**
 * A page's blocks, with the target its size calls for. Every caller goes
 * through this, so the render, the transcript's boxes and a lookup agree on
 * what B7 is.
 */
export function segmentPage(items: readonly Item[], width: number, height: number): Block[] {
	return segmentBlocks(items, blockTargetFor(width, height));
}

/** A block's bounds as stored: `[x, y, w, h]`, rounded to a tenth of a point. */
export function blockBox(bounds: Bounds): BlockBox {
	const r = (v: number): number => Math.round(v * 10) / 10;
	return [r(bounds.minX), r(bounds.minY), r(bounds.maxX - bounds.minX), r(bounds.maxY - bounds.minY)];
}
