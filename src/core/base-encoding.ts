/**
 * The compact form of a path inside a base file. Pure.
 *
 * A path's data as text spends a dozen characters on every coordinate. In a base
 * file each path instead carries its commands as one letter apiece and its
 * coordinates as integers in tenths of a point, every one stored as the change
 * from the coordinate before it on the same axis. Handwriting moves in small
 * steps, so most of those numbers are one or two digits, and gzip does the rest.
 *
 * A tenth of a point is 0.035 mm: finer than the importer's own simplification,
 * and far finer than any pen.
 */

import type { PathItem } from './items';
import { parsePathData, serializePathData } from './path';
import type { PathCommand } from './shapes';

/** Coordinates are stored in units of 1 / UNITS_PER_POINT of a point. */
export const UNITS_PER_POINT = 10;

/** A path item in a base file: `d` replaced by `o` and `n`. */
export interface PackedPath extends Omit<PathItem, 'd'> {
	/** One letter per command: M, L, C or Z. */
	readonly o: string;
	/** Every coordinate, x then y, as deltas in tenths of a point. */
	readonly n: number[];
}

export function packPath(item: PathItem): PackedPath {
	const commands = parsePathData(item.d) ?? [];
	let ops = '';
	const n: number[] = [];
	let lastX = 0;
	let lastY = 0;
	const push = (x: number, y: number): void => {
		const qx = Math.round(x * UNITS_PER_POINT);
		const qy = Math.round(y * UNITS_PER_POINT);
		n.push(qx - lastX, qy - lastY);
		lastX = qx;
		lastY = qy;
	};
	for (const c of commands) {
		if (c.op === 'close') {
			ops += 'Z';
			continue;
		}
		if (c.op === 'cubic') {
			ops += 'C';
			push(c.x1, c.y1);
			push(c.x2, c.y2);
		} else {
			ops += c.op === 'move' ? 'M' : 'L';
		}
		push(c.x, c.y);
	}
	const { d: _omitted, ...rest } = item;
	return { ...rest, o: ops, n };
}

/** The path back, or null when its letters and numbers do not agree. */
export function unpackPath(packed: PackedPath): PathItem | null {
	const commands: PathCommand[] = [];
	let i = 0;
	let x = 0;
	let y = 0;
	const next = (): [number, number] | null => {
		const dx = packed.n[i];
		const dy = packed.n[i + 1];
		if (!Number.isInteger(dx) || !Number.isInteger(dy)) return null;
		i += 2;
		x += dx ?? 0;
		y += dy ?? 0;
		return [x / UNITS_PER_POINT, y / UNITS_PER_POINT];
	};
	for (const op of packed.o) {
		if (op === 'Z') {
			commands.push({ op: 'close' });
		} else if (op === 'C') {
			const a = next();
			const b = next();
			const c = next();
			if (!a || !b || !c) return null;
			commands.push({ op: 'cubic', x1: a[0], y1: a[1], x2: b[0], y2: b[1], x: c[0], y: c[1] });
		} else if (op === 'M' || op === 'L') {
			const p = next();
			if (!p) return null;
			commands.push({ op: op === 'M' ? 'move' : 'line', x: p[0], y: p[1] });
		} else {
			return null;
		}
	}
	if (i !== packed.n.length) return null;
	const { o: _ops, n: _numbers, ...rest } = packed;
	return { ...rest, d: serializePathData(commands) };
}

/** Whether a base record is a packed path rather than an ordinary item. */
export function isPackedPath(value: unknown): value is PackedPath {
	if (value === null || typeof value !== 'object') return false;
	const raw = value as Record<string, unknown>;
	return raw['type'] === 'path' && typeof raw['o'] === 'string' && Array.isArray(raw['n']);
}
