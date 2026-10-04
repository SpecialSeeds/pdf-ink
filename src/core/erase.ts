/**
 * Sized-eraser geometry: resampling, capsule hit testing, and splitting. Pure.
 *
 * Everything here works in PDF user space. The eraser's screen-pixel radius is
 * converted by the caller through the current viewport scale, so a fragment cut at
 * one zoom is identical to the same cut at another.
 */

import { type Bounds, boundsContain, expandBounds, itemBounds } from './hit-test';
import { type Item, type ShapeItem, type Stroke, type StrokeSample, systemClock } from './items';

// Re-exported: these live in hit-test.ts but the eraser is their busiest caller.
export { boundsIntersect, itemBounds, polylineBounds } from './hit-test';
import { type PathSegment, shapeGeometry } from './shapes';
import { flattenPath, pathCommands } from './path';

/** The swept segment between two consecutive pointer samples. */
export interface Capsule {
	readonly x1: number;
	readonly y1: number;
	readonly x2: number;
	readonly y2: number;
}

/** Never resample finer than this, however small the eraser. */
export const MIN_SPACING = 0.25;

export function distanceToSegment(
	px: number,
	py: number,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
): number {
	const dx = x2 - x1;
	const dy = y2 - y1;
	const lengthSquared = dx * dx + dy * dy;
	if (lengthSquared === 0) return Math.hypot(px - x1, py - y1);
	let t = ((px - x1) * dx + (py - y1) * dy) / lengthSquared;
	t = Math.min(1, Math.max(0, t));
	return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * Whether a point lies within `radius` of the swept segment.
 *
 * Testing the segment rather than each sample individually is what stops a fast
 * swipe from stepping straight over a stroke between two pointer events.
 */
export function capsuleContains(
	x: number,
	y: number,
	capsule: Capsule,
	radius: number,
): boolean {
	return (
		distanceToSegment(x, y, capsule.x1, capsule.y1, capsule.x2, capsule.y2) <=
		radius
	);
}

export function capsuleBounds(capsule: Capsule): Bounds {
	return {
		minX: Math.min(capsule.x1, capsule.x2),
		minY: Math.min(capsule.y1, capsule.y2),
		maxX: Math.max(capsule.x1, capsule.x2),
		maxY: Math.max(capsule.y1, capsule.y2),
	};
}

export function polylineLength(points: readonly StrokeSample[]): number {
	let total = 0;
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1];
		const b = points[i];
		if (!a || !b) continue;
		total += Math.hypot(b[0] - a[0], b[1] - a[1]);
	}
	return total;
}

function lerpSample(a: StrokeSample, b: StrokeSample, t: number): StrokeSample {
	return [
		a[0] + (b[0] - a[0]) * t,
		a[1] + (b[1] - a[1]) * t,
		// Pressure is interpolated too, so a resampled stroke keeps its taper.
		a[2] + (b[2] - a[2]) * t,
	];
}

/**
 * Resample a polyline so no gap exceeds `spacing`, interpolating pressure.
 *
 * A freehand stroke drawn fast can have samples far further apart than the eraser
 * is wide; without this, the eraser would pass between two samples and delete
 * nothing. The original first and last points are always kept.
 */
export function resamplePolyline(
	points: readonly StrokeSample[],
	spacing: number,
): StrokeSample[] {
	const first = points[0];
	if (!first) return [];
	const last = points[points.length - 1];
	if (points.length < 2 || spacing <= 0 || !last) return [[...first]];

	const cumulative: number[] = [0];
	let total = 0;
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1];
		const b = points[i];
		if (!a || !b) continue;
		total += Math.hypot(b[0] - a[0], b[1] - a[1]);
		cumulative.push(total);
	}
	if (total === 0) return [[...first]];

	const out: StrokeSample[] = [[...first]];
	let segment = 1;
	for (let distance = spacing; distance < total - 1e-9; distance += spacing) {
		while (segment < cumulative.length && (cumulative[segment] ?? 0) < distance) {
			segment += 1;
		}
		const from = points[segment - 1];
		const to = points[segment];
		const start = cumulative[segment - 1] ?? 0;
		const end = cumulative[segment] ?? start;
		if (!from || !to) continue;
		const t = end === start ? 0 : (distance - start) / (end - start);
		out.push(lerpSample(from, to, t));
	}
	out.push([...last]);
	return out;
}

/** A surviving run of points, and whether each end was produced by a cut. */
export interface Fragment {
	readonly points: StrokeSample[];
	readonly cutStart: boolean;
	readonly cutEnd: boolean;
}

/**
 * Split a polyline into the contiguous runs its keep-mask leaves behind.
 *
 * An end is "cut" when points were removed beyond it, which is what tells the
 * renderer not to taper that end.
 */
export function splitByMask(
	points: readonly StrokeSample[],
	keep: readonly boolean[],
): Fragment[] {
	const fragments: Fragment[] = [];
	let start = -1;
	for (let i = 0; i <= points.length; i++) {
		const inRun = i < points.length && keep[i] === true;
		if (inRun) {
			if (start < 0) start = i;
			continue;
		}
		if (start >= 0) {
			fragments.push({
				points: points.slice(start, i).map((p) => [...p] as StrokeSample),
				cutStart: start > 0,
				cutEnd: i < points.length,
			});
			start = -1;
		}
	}
	return fragments;
}

function sampleCubic(
	from: StrokeSample,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	x: number,
	y: number,
	spacing: number,
): StrokeSample[] {
	// Control-polygon length is a cheap upper bound on the curve's length.
	const approximate =
		Math.hypot(x1 - from[0], y1 - from[1]) +
		Math.hypot(x2 - x1, y2 - y1) +
		Math.hypot(x - x2, y - y2);
	const steps = Math.max(2, Math.ceil(approximate / Math.max(spacing, MIN_SPACING)));
	const out: StrokeSample[] = [];
	for (let i = 1; i <= steps; i++) {
		const t = i / steps;
		const u = 1 - t;
		out.push([
			u * u * u * from[0] + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x,
			u * u * u * from[1] + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y,
			1,
		]);
	}
	return out;
}

function segmentToPolyline(
	segment: PathSegment,
	spacing: number,
): StrokeSample[][] {
	const polylines: StrokeSample[][] = [];
	let current: StrokeSample[] = [];
	let opened: StrokeSample | null = null;

	const flush = (): void => {
		if (current.length >= 2) polylines.push(current);
		current = [];
	};

	for (const command of segment.commands) {
		if (command.op === 'move') {
			flush();
			opened = [command.x, command.y, 1];
			current = [[...opened]];
		} else if (command.op === 'line') {
			current.push([command.x, command.y, 1]);
		} else if (command.op === 'cubic') {
			const from = current[current.length - 1];
			if (!from) continue;
			current.push(
				...sampleCubic(
					from,
					command.x1,
					command.y1,
					command.x2,
					command.y2,
					command.x,
					command.y,
					spacing,
				),
			);
		} else if (opened) {
			// `close` returns to the subpath's start.
			current.push([...opened]);
		}
	}
	flush();
	return polylines;
}

/**
 * Explode a shape into polylines using its own geometry function, so a sized
 * erase cuts exactly the curve that was drawn.
 *
 * Lossy by nature: dash patterns and fills do not survive, and arrowheads become
 * outlines. The fragments are plain pen strokes.
 */
export function shapeToPolylines(
	shape: ShapeItem,
	spacing: number,
): StrokeSample[][] {
	const geometry = shapeGeometry(shape.kind, shape.box, shape.width);
	const polylines: StrokeSample[][] = [];
	for (const segment of geometry.segments) {
		polylines.push(...segmentToPolyline(segment, spacing));
	}
	return polylines;
}

/** The polylines a sized erase operates on, already resampled. */
export function itemToPolylines(item: Item, spacing: number): StrokeSample[][] {
	if (item.type === 'stroke') {
		const resampled = resamplePolyline(item.points, spacing);
		return resampled.length >= 2 ? [resampled] : [];
	}
	if (item.type === 'shape') {
		return shapeToPolylines(item, spacing)
			.map((line) => resamplePolyline(line, spacing))
			.filter((line) => line.length >= 2);
	}
	if (item.type === 'path') {
		// Only to find what the eraser touches: a path is removed whole, never cut,
		// because a cut outline would leave a ragged sliver of fill.
		return flattenPath(pathCommands(item), spacing).map((ring) =>
			resamplePolyline(
				ring.map(([x, y]): StrokeSample => [x, y, 1]),
				spacing,
			),
		);
	}
	// Text boxes are ignored in sized mode.
	return [];
}

/** Whether a sized erase removes this item whole instead of cutting it. */
export function erasesWhole(item: Item): boolean {
	return item.type === 'path';
}

/** The width a fragment of this item inherits. */
export function sourceWidth(item: Item): number {
	if (item.type === 'stroke' || item.type === 'shape') return item.width;
	return 1;
}

/**
 * Build a fragment stroke, or null when it is too small to be worth keeping.
 *
 * Fragments inherit colour, width, opacity and (for strokes) tool, and keep the
 * original's z so paint order is unchanged.
 */
export function fragmentToStroke(
	source: Item,
	fragment: Fragment,
	id: string,
	now = systemClock(),
): Stroke | null {
	if (fragment.points.length < 2) return null;
	const width = sourceWidth(source);
	if (polylineLength(fragment.points) < width) return null;

	return {
		type: 'stroke',
		id,
		tool: source.type === 'stroke' ? source.tool : 'pen',
		color: source.color,
		width,
		opacity: source.opacity,
		rotation: 0,
		z: source.z,
		// A fragment is a brand-new item, created now.
		updatedAt: now,
		points: fragment.points,
		// A cut end is blunt: the renderer must not taper it.
		cutStart: fragment.cutStart,
		cutEnd: fragment.cutEnd,
	};
}

/** Bounds padded by the eraser radius, for the prefilter. */
export function prefilterBounds(item: Item, radius: number): Bounds | null {
	const bounds = itemBounds(item);
	return bounds ? expandBounds(bounds, radius) : null;
}

export function pointInBounds(bounds: Bounds, x: number, y: number): boolean {
	return boundsContain(bounds, x, y);
}
