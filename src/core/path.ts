/**
 * Path items: filled (or stroked) vector outlines. Pure.
 *
 * A path is stored as SVG-style path data, absolute `M`, `L`, `C` and `Z` only,
 * in PDF user space (points, y up). The string form keeps imported handwriting
 * compact on disk; everything else works on the parsed commands, which are the
 * same {@link PathCommand}s shapes produce, so ONE geometry function feeds the
 * canvas renderer and the pdf-lib exporter alike.
 *
 * Parsing is cached per item object. Items are never mutated in place, so an
 * edited path is a new object and is parsed afresh.
 */

import type { Vec2 } from 'perfect-freehand';
import type { Bounds } from './hit-test';
import type { PathItem } from './items';
import type { PathCommand, PathSegment, ShapeGeometry } from './shapes';

/** Decimal places kept when path data is written. A hundredth of a point. */
const DECIMALS = 2;
const FACTOR = 10 ** DECIMALS;

const TOKEN = /[MLCZ]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|\S/g;

/**
 * Parse path data, or null when it is malformed: an unknown or relative command,
 * a missing number, or anything drawn before the first `M`.
 */
export function parsePathData(d: string): PathCommand[] | null {
	// SVG allows commas as separators; they carry no meaning.
	const tokens = d.replace(/,/g, ' ').match(TOKEN) ?? [];
	const commands: PathCommand[] = [];
	let i = 0;
	let moved = false;
	const numbers = (count: number): number[] | null => {
		const out: number[] = [];
		for (let k = 0; k < count; k++) {
			const token = tokens[i + k];
			if (token === undefined) return null;
			const value = Number(token);
			if (!/^[-+.\d]/.test(token) || !Number.isFinite(value)) return null;
			out.push(value);
		}
		i += count;
		return out;
	};
	while (i < tokens.length) {
		const op = tokens[i];
		i += 1;
		if (op === 'Z') {
			if (!moved) return null;
			commands.push({ op: 'close' });
			continue;
		}
		const count = op === 'M' || op === 'L' ? 2 : op === 'C' ? 6 : -1;
		if (count < 0) return null;
		if (op !== 'M' && !moved) return null;
		const n = numbers(count);
		if (!n) return null;
		if (op === 'M') {
			moved = true;
			commands.push({ op: 'move', x: n[0] ?? 0, y: n[1] ?? 0 });
		} else if (op === 'L') {
			commands.push({ op: 'line', x: n[0] ?? 0, y: n[1] ?? 0 });
		} else {
			commands.push({
				op: 'cubic',
				x1: n[0] ?? 0,
				y1: n[1] ?? 0,
				x2: n[2] ?? 0,
				y2: n[3] ?? 0,
				x: n[4] ?? 0,
				y: n[5] ?? 0,
			});
		}
	}
	return commands;
}

function num(value: number): string {
	const rounded = Math.round(value * FACTOR) / FACTOR;
	// -0 would print as "0" anyway; this keeps "-0.00" out.
	return String(rounded === 0 ? 0 : rounded);
}

/** Path data for `commands`, rounded to a hundredth of a point. */
export function serializePathData(commands: readonly PathCommand[]): string {
	const parts: string[] = [];
	for (const c of commands) {
		if (c.op === 'move') parts.push(`M${num(c.x)} ${num(c.y)}`);
		else if (c.op === 'line') parts.push(`L${num(c.x)} ${num(c.y)}`);
		else if (c.op === 'cubic') {
			parts.push(
				`C${num(c.x1)} ${num(c.y1)} ${num(c.x2)} ${num(c.y2)} ${num(c.x)} ${num(c.y)}`,
			);
		} else parts.push('Z');
	}
	return parts.join('');
}

const parsed = new WeakMap<PathItem, readonly PathCommand[]>();

/** The item's commands. Malformed data, which parsing rejects, yields none. */
export function pathCommands(item: PathItem): readonly PathCommand[] {
	const cached = parsed.get(item);
	if (cached) return cached;
	const commands = parsePathData(item.d) ?? [];
	parsed.set(item, commands);
	return commands;
}

/**
 * The ONE geometry function for a path: a single segment, filled unless the
 * path is stroked. The renderer and the exporter both draw exactly this.
 */
export function pathGeometry(item: PathItem): ShapeGeometry {
	const segment: PathSegment = {
		commands: pathCommands(item),
		fill: item.strokeWidth === undefined,
	};
	return { segments: [segment] };
}

/** Every command with its points sent through `map`. */
export function mapPathCommands(
	commands: readonly PathCommand[],
	map: (x: number, y: number) => Vec2,
): PathCommand[] {
	return commands.map((c): PathCommand => {
		if (c.op === 'close') return c;
		const [x, y] = map(c.x, c.y);
		if (c.op === 'move' || c.op === 'line') return { op: c.op, x, y };
		const [x1, y1] = map(c.x1, c.y1);
		const [x2, y2] = map(c.x2, c.y2);
		return { op: 'cubic', x1, y1, x2, y2, x, y };
	});
}

/** A copy of `item` with its points sent through `map`. */
export function mapPath(item: PathItem, map: (x: number, y: number) => Vec2): PathItem {
	return { ...item, d: serializePathData(mapPathCommands(pathCommands(item), map)) };
}

/**
 * The path's bounds, including half a stroked path's width. Control points are
 * included, so this can be a little loose around curves, never tight.
 */
export function pathBounds(item: PathItem): Bounds | null {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	const add = (x: number, y: number): void => {
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	};
	for (const c of pathCommands(item)) {
		if (c.op === 'close') continue;
		add(c.x, c.y);
		if (c.op === 'cubic') {
			add(c.x1, c.y1);
			add(c.x2, c.y2);
		}
	}
	if (minX > maxX) return null;
	const pad = (item.strokeWidth ?? 0) / 2;
	return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

/**
 * The path as polylines, one per subpath, with curves sampled no further apart
 * than `spacing`. A closed subpath ends where it began.
 */
export function flattenPath(
	commands: readonly PathCommand[],
	spacing: number,
): Vec2[][] {
	const step = Math.max(spacing, 0.05);
	const rings: Vec2[][] = [];
	let current: Vec2[] = [];
	const flush = (): void => {
		if (current.length > 0) rings.push(current);
		current = [];
	};
	for (const c of commands) {
		if (c.op === 'move') {
			flush();
			current = [[c.x, c.y]];
		} else if (c.op === 'line') {
			current.push([c.x, c.y]);
		} else if (c.op === 'cubic') {
			const from = current[current.length - 1];
			if (!from) continue;
			const approximate =
				Math.hypot(c.x1 - from[0], c.y1 - from[1]) +
				Math.hypot(c.x2 - c.x1, c.y2 - c.y1) +
				Math.hypot(c.x - c.x2, c.y - c.y2);
			const steps = Math.max(1, Math.ceil(approximate / step));
			for (let k = 1; k <= steps; k++) {
				const t = k / steps;
				const u = 1 - t;
				current.push([
					u * u * u * from[0] + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
					u * u * u * from[1] + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y,
				]);
			}
		} else {
			const first = current[0];
			if (first) current.push([first[0], first[1]]);
		}
	}
	flush();
	return rings;
}

/**
 * Drop line vertices that lie within `tolerance` of the outline without them
 * (Douglas–Peucker, on each run of straight segments). A curve whose control
 * points both lie within `tolerance` of its chord counts as straight. Moves,
 * other curves and closes are kept exactly, as is every run's first and last
 * point, so no point of the outline moves by more than `tolerance`.
 *
 * Imported handwriting is traced far more densely than any screen or printer
 * can show; this is what keeps a note's file a sensible size.
 */
export function simplifyPathCommands(
	commands: readonly PathCommand[],
	tolerance: number,
): PathCommand[] {
	const out: PathCommand[] = [];
	// The current run: the point it starts from, then its line vertices.
	let run: Vec2[] = [];

	const flush = (): void => {
		if (run.length > 1) {
			for (const [x, y] of douglasPeucker(run, tolerance).slice(1)) {
				out.push({ op: 'line', x, y });
			}
		}
		run = [];
	};

	for (const c of commands) {
		const from = run[run.length - 1];
		// A curve this flat is a line; as one it can join the run around it.
		const flat =
			c.op === 'cubic' &&
			from !== undefined &&
			segmentDistance([c.x1, c.y1], from, [c.x, c.y]) <= tolerance &&
			segmentDistance([c.x2, c.y2], from, [c.x, c.y]) <= tolerance;
		if (c.op === 'line' || flat) {
			run.push([c.x, c.y]);
			continue;
		}
		flush();
		out.push(c);
		if (c.op === 'move' || c.op === 'cubic') run = [[c.x, c.y]];
	}
	flush();
	return out;
}

function douglasPeucker(points: readonly Vec2[], tolerance: number): Vec2[] {
	const keep = new Uint8Array(points.length);
	keep[0] = 1;
	keep[points.length - 1] = 1;
	const stack: [number, number][] = [[0, points.length - 1]];
	while (stack.length > 0) {
		const [first, last] = stack.pop() ?? [0, 0];
		const a = points[first];
		const b = points[last];
		if (!a || !b) continue;
		let worst = -1;
		let index = -1;
		for (let i = first + 1; i < last; i++) {
			const p = points[i];
			if (!p) continue;
			const d = segmentDistance(p, a, b);
			if (d > worst) {
				worst = d;
				index = i;
			}
		}
		if (index >= 0 && worst > tolerance) {
			keep[index] = 1;
			stack.push([first, index], [index, last]);
		}
	}
	return points.filter((_, i) => keep[i] === 1);
}

function segmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const lengthSquared = dx * dx + dy * dy;
	if (lengthSquared === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
	const t = Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared));
	return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
