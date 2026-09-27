/**
 * One sized-erase gesture, accumulated sample by sample. Pure.
 *
 * Each item is exploded and resampled once, then every new capsule only tests the
 * points still alive — so a long swipe costs O(points) per sample rather than
 * re-testing the whole path against the whole gesture.
 */

import {
	type Capsule,
	MIN_SPACING,
	boundsIntersect,
	capsuleBounds,
	capsuleContains,
	fragmentToStroke,
	itemToPolylines,
	prefilterBounds,
	splitByMask,
} from './erase';
import type { ItemRef } from './history';
import type { Item, Stroke, StrokeSample } from './items';
import type { Bounds } from './hit-test';

interface Tracked {
	readonly ref: ItemRef;
	readonly polylines: StrokeSample[][];
	/** Parallel keep-masks; a point flips to false once and stays there. */
	readonly keep: boolean[][];
	/** Item bounds already padded by the eraser radius. */
	readonly bounds: Bounds;
	hit: boolean;
}

/** What to commit when the gesture ends. */
export interface EraseCommit {
	/** Originals that lost at least one point. */
	readonly removed: ItemRef[];
	/** Their surviving fragments, at the originals' positions. */
	readonly added: ItemRef[];
}

export class SizedEraseSession {
	/** Resample spacing, per the spec: no coarser than half the radius. */
	readonly spacing: number;

	private readonly tracked = new Map<string, Tracked>();
	private previous: [number, number] | null = null;

	constructor(
		/** In PDF units, already converted from screen pixels by the caller. */
		readonly radius: number,
	) {
		this.spacing = Math.max(radius / 2, MIN_SPACING);
	}

	/**
	 * Feed one pointer sample. Returns true when something was newly erased, so
	 * the caller only repaints on a real change.
	 */
	sample(x: number, y: number, candidates: readonly ItemRef[]): boolean {
		// The first sample sweeps a zero-length capsule, which is still a disc.
		const from = this.previous ?? [x, y];
		this.previous = [x, y];
		const capsule: Capsule = { x1: from[0], y1: from[1], x2: x, y2: y };
		const sweep = capsuleBounds(capsule);

		let changed = false;
		for (const ref of candidates) {
			const tracked = this.track(ref);
			if (!tracked) continue;
			// Prefilter: the item's box, padded by the radius, against the sweep.
			if (!boundsIntersect(sweep, tracked.bounds)) continue;
			if (this.cut(tracked, capsule)) changed = true;
		}
		return changed;
	}

	get isEmpty(): boolean {
		for (const tracked of this.tracked.values()) {
			if (tracked.hit) return false;
		}
		return true;
	}

	/** Ids of items that have lost points, so the caller can hide the originals. */
	hitIds(): Set<string> {
		const ids = new Set<string>();
		for (const [id, tracked] of this.tracked) {
			if (tracked.hit) ids.add(id);
		}
		return ids;
	}

	/** Surviving fragments of every hit item, for the live preview. */
	preview(nextId: () => string): Stroke[] {
		const out: Stroke[] = [];
		for (const tracked of this.tracked.values()) {
			if (!tracked.hit) continue;
			out.push(...this.fragments(tracked, nextId));
		}
		return out;
	}

	/** Originals to remove and fragments to add, as one operation. */
	commit(nextId: () => string): EraseCommit {
		const removed: ItemRef[] = [];
		const added: ItemRef[] = [];
		for (const tracked of this.tracked.values()) {
			if (!tracked.hit) continue;
			removed.push(tracked.ref);
			for (const fragment of this.fragments(tracked, nextId)) {
				// Fragments take the original's slot. Paint order comes from z,
				// which they inherit, so the array position is only a hint.
				added.push({
					pageKey: tracked.ref.pageKey,
					index: tracked.ref.index,
					item: fragment,
				});
			}
		}
		return { removed, added };
	}

	private track(ref: ItemRef): Tracked | null {
		const existing = this.tracked.get(ref.item.id);
		if (existing) return existing;

		// Text boxes are ignored in sized mode, and itemToPolylines returns none.
		const polylines = itemToPolylines(ref.item, this.spacing);
		if (polylines.length === 0) return null;
		const bounds = prefilterBounds(ref.item, this.radius);
		if (!bounds) return null;

		const tracked: Tracked = {
			ref,
			polylines,
			keep: polylines.map((line) => line.map(() => true)),
			bounds,
			hit: false,
		};
		this.tracked.set(ref.item.id, tracked);
		return tracked;
	}

	private cut(tracked: Tracked, capsule: Capsule): boolean {
		let changed = false;
		tracked.polylines.forEach((line, index) => {
			const mask = tracked.keep[index];
			if (!mask) return;
			for (let i = 0; i < line.length; i++) {
				if (mask[i] !== true) continue;
				const point = line[i];
				if (!point) continue;
				if (capsuleContains(point[0], point[1], capsule, this.radius)) {
					mask[i] = false;
					tracked.hit = true;
					changed = true;
				}
			}
		});
		return changed;
	}

	private fragments(tracked: Tracked, nextId: () => string): Stroke[] {
		const out: Stroke[] = [];
		tracked.polylines.forEach((line, index) => {
			const mask = tracked.keep[index];
			if (!mask) return;
			for (const fragment of splitByMask(line, mask)) {
				const built = fragmentToStroke(tracked.ref.item, fragment, nextId());
				if (built) out.push(built);
			}
		});
		return out;
	}
}

/** Screen pixels to PDF units, through the current viewport scale. */
export function radiusToPdf(radiusPx: number, scale: number): number {
	return scale > 0 ? radiusPx / scale : radiusPx;
}

/** Items a sized erase can act on. Text is excluded. */
export function isErasable(item: Item): boolean {
	return item.type === 'stroke' || item.type === 'shape';
}
