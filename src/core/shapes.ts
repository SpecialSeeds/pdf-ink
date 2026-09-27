/**
 * Shape geometry. Pure — no DOM, no pdf.js, no Obsidian.
 *
 * Every shape kind has exactly ONE geometry function here, returning path commands
 * in PDF user space (points, y UP). The canvas renderer and the pdf-lib exporter
 * both consume these, so a shape can never drift between screen and export.
 *
 * A `Box` is the drag rectangle: `(x, y)` is where the drag started and `w`/`h` are
 * signed deltas, so a shape dragged up-left is described as faithfully as one
 * dragged down-right.
 */

import type { Box, ShapeKind } from './items';

export type PathCommand =
	| { readonly op: 'move'; readonly x: number; readonly y: number }
	| { readonly op: 'line'; readonly x: number; readonly y: number }
	| {
			readonly op: 'cubic';
			readonly x1: number;
			readonly y1: number;
			readonly x2: number;
			readonly y2: number;
			readonly x: number;
			readonly y: number;
		}
	| { readonly op: 'close' };

export interface PathSegment {
	readonly commands: readonly PathCommand[];
	/** Filled rather than stroked. Arrowheads are the only filled parts. */
	readonly fill?: boolean;
	/** Dash pattern in PDF points; negative 3D axes are the only dashed parts. */
	readonly dash?: readonly [number, number];
}

export interface ShapeGeometry {
	readonly segments: readonly PathSegment[];
}

export type ShapeGeometryFn = (box: Box, width: number) => ShapeGeometry;

/** Arrowhead length as a multiple of stroke width. */
export const ARROW_LENGTH = 6;
/** Arrowhead half-width as a multiple of stroke width. */
export const ARROW_HALF_WIDTH = 2.2;
/** Dash on/off lengths as multiples of stroke width. */
export const DASH_PATTERN: readonly [number, number] = [3, 2.5];

/**
 * How long the out-of-page axis is, relative to the in-plane axis it is measured
 * against.
 *
 * Textbook cabinet projection uses 0.5. That reads as stunted next to full-length
 * y and z axes, so this is deliberately longer.
 */
export const AXIS_FORESHORTENING = 0.75;
/** The out-of-page axis sits at 45 degrees. */
export const CABINET_ANGLE = Math.PI / 4;

/** Bezier circle constant: 4/3 * (sqrt(2) - 1). */
const KAPPA = 0.5522847498307936;

function move(x: number, y: number): PathCommand {
	return { op: 'move', x, y };
}

function line(x: number, y: number): PathCommand {
	return { op: 'line', x, y };
}

/** The box with positive width and height, for shapes that have no direction. */
export function normalizeBox(box: Box): Box {
	return {
		x: box.w < 0 ? box.x + box.w : box.x,
		y: box.h < 0 ? box.y + box.h : box.y,
		w: Math.abs(box.w),
		h: Math.abs(box.h),
	};
}

/** A filled triangular head at `tip`, pointing away from `from`. */
function arrowHead(
	tipX: number,
	tipY: number,
	fromX: number,
	fromY: number,
	width: number,
): PathSegment | null {
	const dx = tipX - fromX;
	const dy = tipY - fromY;
	const length = Math.hypot(dx, dy);
	if (length === 0) return null;

	const ux = dx / length;
	const uy = dy / length;
	// Never longer than the line it caps, or a short arrow inverts itself.
	const head = Math.min(width * ARROW_LENGTH, length);
	const half = width * ARROW_HALF_WIDTH;
	const baseX = tipX - ux * head;
	const baseY = tipY - uy * head;
	// Perpendicular to the direction of travel.
	const px = -uy;
	const py = ux;

	return {
		fill: true,
		commands: [
			move(tipX, tipY),
			line(baseX + px * half, baseY + py * half),
			line(baseX - px * half, baseY - py * half),
			{ op: 'close' },
		],
	};
}

function strokeSegment(
	commands: readonly PathCommand[],
	width: number,
	dashed: boolean,
): PathSegment {
	return dashed
		? {
				commands,
				dash: [DASH_PATTERN[0] * width, DASH_PATTERN[1] * width],
			}
		: { commands };
}

// --- individual kinds ------------------------------------------------------

export const lineGeometry: ShapeGeometryFn = (box, width) => {
	const commands = [
		move(box.x, box.y),
		line(box.x + box.w, box.y + box.h),
	];
	return { segments: [strokeSegment(commands, width, false)] };
};

export const arrowGeometry: ShapeGeometryFn = (box, width) => {
	const tipX = box.x + box.w;
	const tipY = box.y + box.h;
	const segments: PathSegment[] = [
		strokeSegment([move(box.x, box.y), line(tipX, tipY)], width, false),
	];
	const head = arrowHead(tipX, tipY, box.x, box.y, width);
	if (head) segments.push(head);
	return { segments };
};

export const rectGeometry: ShapeGeometryFn = (box, width) => {
	const b = normalizeBox(box);
	const commands = [
		move(b.x, b.y),
		line(b.x + b.w, b.y),
		line(b.x + b.w, b.y + b.h),
		line(b.x, b.y + b.h),
		{ op: 'close' } as PathCommand,
	];
	return { segments: [strokeSegment(commands, width, false)] };
};

export const ellipseGeometry: ShapeGeometryFn = (box, width) => {
	const b = normalizeBox(box);
	const rx = b.w / 2;
	const ry = b.h / 2;
	const cx = b.x + rx;
	const cy = b.y + ry;
	const ox = rx * KAPPA;
	const oy = ry * KAPPA;

	// Four cubics, starting at the rightmost point and running counterclockwise.
	const commands: PathCommand[] = [
		move(cx + rx, cy),
		{ op: 'cubic', x1: cx + rx, y1: cy + oy, x2: cx + ox, y2: cy + ry, x: cx, y: cy + ry },
		{ op: 'cubic', x1: cx - ox, y1: cy + ry, x2: cx - rx, y2: cy + oy, x: cx - rx, y: cy },
		{ op: 'cubic', x1: cx - rx, y1: cy - oy, x2: cx - ox, y2: cy - ry, x: cx, y: cy - ry },
		{ op: 'cubic', x1: cx + ox, y1: cy - ry, x2: cx + rx, y2: cy - oy, x: cx + rx, y: cy },
		{ op: 'close' },
	];
	return { segments: [strokeSegment(commands, width, false)] };
};

/** The height an equilateral triangle of this side length must have. */
export function equilateralHeight(side: number): number {
	return (Math.sqrt(3) / 2) * Math.abs(side);
}

export const triangleGeometry: ShapeGeometryFn = (box, width) => {
	// The height is always derived, never read from the box: an equilateral
	// triangle has only one degree of freedom.
	const side = box.w;
	const height = equilateralHeight(side);
	const direction = box.h < 0 ? -1 : 1;
	const apexX = box.x + side / 2;
	const apexY = box.y + direction * height;

	const commands = [
		move(box.x, box.y),
		line(box.x + side, box.y),
		line(apexX, apexY),
		{ op: 'close' } as PathCommand,
	];
	return { segments: [strokeSegment(commands, width, false)] };
};

interface AxesOptions {
	/** Where the origin sits within the box, as a fraction of each side. */
	readonly originFraction: number;
	readonly threeD: boolean;
	/** Arrowheads on the negative ends of the 2D axes too. */
	readonly arrowBothEnds: boolean;
}

function axesGeometry(
	box: Box,
	width: number,
	options: AxesOptions,
): ShapeGeometry {
	const b = normalizeBox(box);
	const f = options.originFraction;
	const ox = b.x + b.w * f;
	const oy = b.y + b.h * f;

	const left = b.x;
	const right = b.x + b.w;
	const bottom = b.y;
	const top = b.y + b.h;

	const segments: PathSegment[] = [];
	const heads: PathSegment[] = [];

	// In 3D the negative half-axes are dashed; in 2D everything is solid.
	const negativeDashed = options.threeD;

	// X axis.
	segments.push(strokeSegment([move(ox, oy), line(right, oy)], width, false));
	segments.push(
		strokeSegment([move(ox, oy), line(left, oy)], width, negativeDashed),
	);
	// Y axis.
	segments.push(strokeSegment([move(ox, oy), line(ox, top)], width, false));
	segments.push(
		strokeSegment([move(ox, oy), line(ox, bottom)], width, negativeDashed),
	);

	// Positive ends always get an arrowhead.
	pushHead(heads, right, oy, ox, oy, width);
	pushHead(heads, ox, top, ox, oy, width);
	if (options.arrowBothEnds) {
		pushHead(heads, left, oy, ox, oy, width);
		pushHead(heads, ox, bottom, ox, oy, width);
	}

	if (options.threeD) {
		/*
		 * Right-handed axes, drawn the way physics and engineering diagrams are:
		 * y to the right, z up, and x out of the page toward the viewer. On paper
		 * "toward the viewer" is down-left, so the POSITIVE x half-axis — the solid,
		 * arrow-tipped one — points down-left, and the negative half (into the page)
		 * is the dashed one going up-right.
		 *
		 * Check: with screen right = e1, up = e2 and out-of-page = e3, this is
		 * x = e3, y = e1, z = e2, and x cross y = e3 cross e1 = e2 = z.
		 *
		 * Cabinet projection: 45 degrees, foreshortened by half. Each half-axis is
		 * limited by the room it actually has, exactly as x and y are.
		 */
		const unitX = -Math.cos(CABINET_ANGLE);
		const unitY = -Math.sin(CABINET_ANGLE);
		const outward = Math.min(ox - left, oy - bottom) * AXIS_FORESHORTENING;
		const inward = Math.min(right - ox, top - oy) * AXIS_FORESHORTENING;

		const outX = ox + unitX * outward;
		const outY = oy + unitY * outward;
		segments.push(strokeSegment([move(ox, oy), line(outX, outY)], width, false));
		segments.push(
			strokeSegment(
				[move(ox, oy), line(ox - unitX * inward, oy - unitY * inward)],
				width,
				true,
			),
		);
		pushHead(heads, outX, outY, ox, oy, width);
	}

	// Heads last, so they paint over the line ends.
	return { segments: [...segments, ...heads] };
}

function pushHead(
	into: PathSegment[],
	tipX: number,
	tipY: number,
	fromX: number,
	fromY: number,
	width: number,
): void {
	const head = arrowHead(tipX, tipY, fromX, fromY, width);
	if (head) into.push(head);
}

export const axes2dQuarterGeometry: ShapeGeometryFn = (box, width) =>
	axesGeometry(box, width, {
		originFraction: 0.25,
		threeD: false,
		arrowBothEnds: false,
	});

export const axes2dCentreGeometry: ShapeGeometryFn = (box, width) =>
	axesGeometry(box, width, {
		originFraction: 0.5,
		threeD: false,
		// The centred variant shows all four quadrants, so every end is an end.
		arrowBothEnds: true,
	});

export const axes3dCentreGeometry: ShapeGeometryFn = (box, width) =>
	axesGeometry(box, width, {
		originFraction: 0.5,
		threeD: true,
		arrowBothEnds: false,
	});

/** The one geometry function per shape kind. */
export const SHAPE_GEOMETRY: Record<ShapeKind, ShapeGeometryFn> = {
	line: lineGeometry,
	arrow: arrowGeometry,
	rect: rectGeometry,
	ellipse: ellipseGeometry,
	triangle: triangleGeometry,
	axes2d_q: axes2dQuarterGeometry,
	axes2d_c: axes2dCentreGeometry,
	axes3d_c: axes3dCentreGeometry,
};

export function shapeGeometry(
	kind: ShapeKind,
	box: Box,
	width: number,
): ShapeGeometry {
	return SHAPE_GEOMETRY[kind](box, width);
}

/** Where the origin sits for an axes kind, or null for other shapes. */
export function originFractionFor(kind: ShapeKind): number | null {
	switch (kind) {
		case 'axes2d_q':
			return 0.25;
		case 'axes2d_c':
		case 'axes3d_c':
			return 0.5;
		default:
			return null;
	}
}

// --- drag constraints ------------------------------------------------------

/** Angle snap for line and arrow while Shift is held. */
export const SNAP_DEGREES = 15;

/**
 * Apply the Shift constraint for a kind, plus any constraint the kind always has.
 *
 * The triangle's height lock is unconditional; everything else applies only while
 * Shift is held.
 */
export function constrainShapeBox(
	kind: ShapeKind,
	box: Box,
	shift: boolean,
): Box {
	if (kind === 'triangle') {
		// Always equilateral, Shift or not.
		const direction = box.h < 0 ? -1 : 1;
		return { ...box, h: direction * equilateralHeight(box.w) };
	}

	if (!shift) return box;

	if (kind === 'line' || kind === 'arrow') return snapToAngle(box, SNAP_DEGREES);

	// Everything else becomes square: a square box makes an ellipse a circle and
	// axes evenly scaled.
	const size = Math.min(Math.abs(box.w), Math.abs(box.h));
	return {
		...box,
		w: Math.sign(box.w || 1) * size,
		h: Math.sign(box.h || 1) * size,
	};
}

/** Rotate the drag vector to the nearest multiple of `stepDegrees`, keeping length. */
export function snapToAngle(box: Box, stepDegrees: number): Box {
	const length = Math.hypot(box.w, box.h);
	if (length === 0) return box;
	const step = (stepDegrees * Math.PI) / 180;
	const snapped = Math.round(Math.atan2(box.h, box.w) / step) * step;
	return {
		...box,
		w: Math.cos(snapped) * length,
		h: Math.sin(snapped) * length,
	};
}
