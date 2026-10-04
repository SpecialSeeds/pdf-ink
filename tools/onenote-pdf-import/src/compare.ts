/**
 * Comparing two canvases of the same note, path by path: the Mac export
 * reconstructed against the iOS export, which is the ground truth.
 *
 * Both are aligned by their ink's bounding boxes (a translation; both are in
 * points already). Every candidate path is then paired with a reference path:
 * exactly where the commands are the same, by outline where the candidate traced
 * a stroke with other points. A candidate path that pairs with nothing is extra:
 * reconstruction got it wrong. A reference path left over is missing from the
 * candidate: the export dropped it. Nothing is quietly ignored.
 */

import type { Vec2 } from 'perfect-freehand';
import { type Bounds, distanceToPolyline } from '../../../src/core/hit-test';
import { flattenPath } from '../../../src/core/path';
import type { RawPath } from './extract';
import { type Canvas, pathNumbers } from './reconstruct';

export interface Unmatched {
	readonly side: 'reference' | 'candidate';
	readonly index: number;
	readonly color: string;
	readonly paint: RawPath['paint'];
	readonly commands: number;
	readonly bounds: Bounds;
	/** Outline distance to the closest same-coloured path on the other side. */
	readonly nearest: number | null;
}

/** A path the candidate traced with different points, but in the same place. */
export interface Retraced {
	readonly reference: number;
	readonly candidate: number;
	readonly referenceCommands: number;
	readonly candidateCommands: number;
	/** Hausdorff distance between the two outlines, in points. */
	readonly distance: number;
}

export interface Comparison {
	readonly referenceCount: number;
	readonly candidateCount: number;
	/** Added to the candidate to align it with the reference. */
	readonly shift: [number, number];
	/** Pairs with the same commands, every point within the tolerance. */
	readonly matched: number;
	/** Largest point distance among those pairs, in points. */
	readonly worstMatched: number;
	/** Candidate paths that simplify a reference path: fewer points, same place. */
	readonly retraced: Retraced[];
	/** Candidate paths matching nothing: what reconstruction got wrong or invented. */
	readonly extra: Unmatched[];
	/** Reference paths the candidate does not have at all. */
	readonly missing: Unmatched[];
}

export function inkBounds(paths: readonly RawPath[]): Bounds | null {
	let out: Bounds | null = null;
	for (const { bounds: b } of paths) {
		out = out
			? {
					minX: Math.min(out.minX, b.minX),
					minY: Math.min(out.minY, b.minY),
					maxX: Math.max(out.maxX, b.maxX),
					maxY: Math.max(out.maxY, b.maxY),
				}
			: b;
	}
	return out;
}

function key(path: RawPath): string {
	return `${path.paint}|${path.color}|${path.commands.map((c) => c.op[0]).join('')}`;
}

/** The largest distance between corresponding points, after `shift`. */
function distance(a: readonly number[], b: readonly number[], shift: [number, number]): number {
	let worst = 0;
	for (let i = 0; i + 1 < a.length; i += 2) {
		const dx = (a[i] ?? 0) - ((b[i] ?? 0) + shift[0]);
		const dy = (a[i + 1] ?? 0) - ((b[i + 1] ?? 0) + shift[1]);
		worst = Math.max(worst, Math.hypot(dx, dy));
	}
	return worst;
}

/** The path's outline as polylines, sampled every half point, shifted. */
function outline(path: RawPath, shift: [number, number]): Vec2[][] {
	return flattenPath(path.commands, 0.5).map((ring) =>
		ring.map(([x, y]): Vec2 => [x + shift[0], y + shift[1]]),
	);
}

function directed(from: readonly Vec2[][], to: readonly Vec2[][], limit: number): number {
	let worst = 0;
	for (const ring of from) {
		for (const [x, y] of ring) {
			let best = Infinity;
			for (const other of to) {
				best = Math.min(best, distanceToPolyline(x, y, other));
				if (best <= worst) break;
			}
			worst = Math.max(worst, best);
			// Already too far: the exact figure no longer matters.
			if (worst > limit) return worst;
		}
	}
	return worst;
}

/** The Hausdorff distance between two outlines, or something above `limit`. */
export function outlineDistance(a: readonly Vec2[][], b: readonly Vec2[][], limit = Infinity): number {
	const ab = directed(a, b, limit);
	if (ab > limit) return ab;
	return Math.max(ab, directed(b, a, limit));
}

function overlaps(a: Bounds, b: Bounds, slack: number): boolean {
	return a.minX - slack <= b.maxX && b.minX - slack <= a.maxX && a.minY - slack <= b.maxY && b.minY - slack <= a.maxY;
}

function describePath(path: RawPath, side: Unmatched['side'], index: number, nearest: number | null): Unmatched {
	return {
		side,
		index,
		color: path.color,
		paint: path.paint,
		commands: path.commands.length,
		bounds: path.bounds,
		nearest,
	};
}

/**
 * Pair every candidate path with a reference path. First exactly: the same
 * commands, every point within `tolerance`. Then, for what is left, as a
 * simplification: the same colour, fewer points, and outlines within
 * `retraceTolerance` of each other (Hausdorff), which is how the Mac export
 * retraces some strokes. A retraced outline cannot match point for point, so it
 * needs the looser bound; each one is reported with its distance.
 */
export function compareCanvases(
	reference: Canvas,
	candidate: Canvas,
	tolerance: number,
	retraceTolerance = 2 * tolerance,
): Comparison {
	const ra = inkBounds(reference.paths);
	const ca = inkBounds(candidate.paths);
	const shift: [number, number] =
		ra && ca ? [ra.minX - ca.minX, ra.maxY - ca.maxY] : [0, 0];

	// Group the reference by shape, so each candidate only searches its peers.
	const groups = new Map<string, { index: number; numbers: number[] }[]>();
	reference.paths.forEach((path, index) => {
		const list = groups.get(key(path)) ?? [];
		list.push({ index, numbers: pathNumbers(path.commands) });
		groups.set(key(path), list);
	});
	const used = new Set<number>();

	let matched = 0;
	let worstMatched = 0;
	const leftover: number[] = [];
	candidate.paths.forEach((path, index) => {
		const numbers = pathNumbers(path.commands);
		let best: { index: number; d: number } | null = null;
		for (const entry of groups.get(key(path)) ?? []) {
			if (used.has(entry.index)) continue;
			const d = distance(entry.numbers, numbers, shift);
			if (!best || d < best.d) best = { index: entry.index, d };
		}
		if (best && best.d <= tolerance) {
			used.add(best.index);
			matched += 1;
			worstMatched = Math.max(worstMatched, best.d);
		} else {
			leftover.push(index);
		}
	});

	const retraced: Retraced[] = [];
	const extra: Unmatched[] = [];
	for (const index of leftover) {
		const path = candidate.paths[index];
		if (!path) continue;
		const shape = outline(path, shift);
		const moved: Bounds = {
			minX: path.bounds.minX + shift[0],
			minY: path.bounds.minY + shift[1],
			maxX: path.bounds.maxX + shift[0],
			maxY: path.bounds.maxY + shift[1],
		};
		let best: { index: number; d: number } | null = null;
		reference.paths.forEach((other, otherIndex) => {
			if (used.has(otherIndex)) return;
			if (other.color !== path.color || other.paint !== path.paint) return;
			// A simplification has fewer points than what it simplifies.
			if (other.commands.length <= path.commands.length) return;
			if (!overlaps(other.bounds, moved, retraceTolerance)) return;
			const d = outlineDistance(outline(other, [0, 0]), shape, best ? Math.min(best.d, retraceTolerance * 2) : retraceTolerance * 2);
			if (!best || d < best.d) best = { index: otherIndex, d };
		});
		const found = best as { index: number; d: number } | null;
		if (found && found.d <= retraceTolerance) {
			used.add(found.index);
			retraced.push({
				reference: found.index,
				candidate: index,
				referenceCommands: reference.paths[found.index]?.commands.length ?? 0,
				candidateCommands: path.commands.length,
				distance: found.d,
			});
		} else {
			extra.push(describePath(path, 'candidate', index, found?.d ?? null));
		}
	}

	const missing: Unmatched[] = [];
	reference.paths.forEach((path, index) => {
		if (!used.has(index)) missing.push(describePath(path, 'reference', index, null));
	});

	return {
		referenceCount: reference.paths.length,
		candidateCount: candidate.paths.length,
		shift,
		matched,
		worstMatched,
		retraced,
		extra,
		missing,
	};
}

/** A human-readable account of the comparison: everything not matched exactly. */
export function describeComparison(c: Comparison): string {
	const lines = [
		`reference ${String(c.referenceCount)} paths, candidate ${String(c.candidateCount)}; ` +
			`${String(c.matched)} identical (worst ${c.worstMatched.toFixed(3)} pt), ` +
			`${String(c.retraced.length)} retraced, ${String(c.extra.length)} extra, ${String(c.missing.length)} missing, ` +
			`after shifting the candidate by (${c.shift[0].toFixed(2)}, ${c.shift[1].toFixed(2)}) pt`,
	];
	const where = (b: Bounds): string =>
		`x ${b.minX.toFixed(1)}..${b.maxX.toFixed(1)} y ${b.minY.toFixed(1)}..${b.maxY.toFixed(1)}`;
	for (const r of c.retraced) {
		lines.push(
			`  retraced: reference #${String(r.reference)} (${String(r.referenceCommands)} commands) as candidate ` +
				`#${String(r.candidate)} (${String(r.candidateCommands)} commands), outlines ${r.distance.toFixed(3)} pt apart`,
		);
	}
	for (const u of [...c.extra, ...c.missing]) {
		lines.push(
			`  ${u.side === 'candidate' ? 'extra in candidate' : 'missing from candidate'} #${String(u.index)}: ` +
				`${u.paint} ${u.color}, ${String(u.commands)} commands, ${where(u.bounds)}` +
				(u.nearest === null ? '' : `, nearest outline ${u.nearest.toFixed(3)} pt away`),
		);
	}
	return lines.join('\n');
}
