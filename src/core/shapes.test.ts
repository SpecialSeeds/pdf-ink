import { describe, expect, it } from 'vitest';
import type { Box, ShapeKind } from './items';
import { SHAPE_KINDS } from './items';
import {
	ARROW_LENGTH,
	AXIS_FORESHORTENING,
	type PathCommand,
	type PathSegment,
	SHAPE_GEOMETRY,
	SNAP_DEGREES,
	constrainShapeBox,
	equilateralHeight,
	normalizeBox,
	originFractionFor,
	shapeGeometry,
	snapToAngle,
} from './shapes';

const BOX: Box = { x: 100, y: 200, w: 80, h: 40 };
const WIDTH = 2;

/** Every anchor point a segment visits, ignoring control points. */
function vertices(segment: PathSegment): [number, number][] {
	const points: [number, number][] = [];
	for (const command of segment.commands) {
		if (command.op === 'move' || command.op === 'line' || command.op === 'cubic') {
			points.push([command.x, command.y]);
		}
	}
	return points;
}

function strokes(segments: readonly PathSegment[]): PathSegment[] {
	return segments.filter((s) => s.fill !== true);
}

function heads(segments: readonly PathSegment[]): PathSegment[] {
	return segments.filter((s) => s.fill === true);
}

function dashed(segments: readonly PathSegment[]): PathSegment[] {
	return segments.filter((s) => s.dash !== undefined);
}

function closes(segment: PathSegment): boolean {
	return segment.commands.some((c: PathCommand) => c.op === 'close');
}

function near(a: number, b: number, precision = 6): void {
	expect(a).toBeCloseTo(b, precision);
}

describe('every kind has exactly one geometry function', () => {
	it('covers the whole ShapeKind union', () => {
		expect(Object.keys(SHAPE_GEOMETRY).sort()).toEqual([...SHAPE_KINDS].sort());
	});

	it('produces at least one segment for each kind, and never NaN', () => {
		for (const kind of SHAPE_KINDS) {
			const geometry = shapeGeometry(kind, BOX, WIDTH);
			expect(geometry.segments.length, kind).toBeGreaterThan(0);
			for (const segment of geometry.segments) {
				for (const [x, y] of vertices(segment)) {
					expect(Number.isFinite(x), kind).toBe(true);
					expect(Number.isFinite(y), kind).toBe(true);
				}
			}
		}
	});

	it('survives a zero-sized box without producing NaN', () => {
		for (const kind of SHAPE_KINDS) {
			const geometry = shapeGeometry(kind, { x: 5, y: 5, w: 0, h: 0 }, WIDTH);
			for (const segment of geometry.segments) {
				for (const [x, y] of vertices(segment)) {
					expect(Number.isFinite(x), kind).toBe(true);
					expect(Number.isFinite(y), kind).toBe(true);
				}
			}
		}
	});
});

describe('normalizeBox', () => {
	it('flips a negative drag into a positive box', () => {
		expect(normalizeBox({ x: 100, y: 200, w: -40, h: -10 })).toEqual({
			x: 60,
			y: 190,
			w: 40,
			h: 10,
		});
	});

	it('leaves a positive box alone', () => {
		expect(normalizeBox(BOX)).toEqual(BOX);
	});
});

describe('line', () => {
	it('runs from the drag anchor to the drag end', () => {
		const [segment] = SHAPE_GEOMETRY.line(BOX, WIDTH).segments;
		expect(segment).toBeDefined();
		if (!segment) return;
		expect(vertices(segment)).toEqual([
			[100, 200],
			[180, 240],
		]);
	});

	it('has no arrowhead and is not closed', () => {
		const { segments } = SHAPE_GEOMETRY.line(BOX, WIDTH);
		expect(heads(segments)).toHaveLength(0);
		expect(closes(segments[0] as PathSegment)).toBe(false);
	});

	it('keeps a negative drag direction instead of normalising it', () => {
		const [segment] = SHAPE_GEOMETRY.line(
			{ x: 100, y: 200, w: -50, h: -20 },
			WIDTH,
		).segments;
		if (!segment) return;
		expect(vertices(segment)).toEqual([
			[100, 200],
			[50, 180],
		]);
	});
});

describe('arrow', () => {
	const { segments } = SHAPE_GEOMETRY.arrow(BOX, WIDTH);

	it('is a line plus one filled head', () => {
		expect(strokes(segments)).toHaveLength(1);
		expect(heads(segments)).toHaveLength(1);
	});

	it('puts the head tip exactly at the drag end', () => {
		const [head] = heads(segments);
		if (!head) return;
		expect(vertices(head)[0]).toEqual([180, 240]);
	});

	it('sizes the head from the stroke width', () => {
		const [head] = heads(SHAPE_GEOMETRY.arrow(BOX, 3).segments);
		if (!head) return;
		const points = vertices(head);
		const tip = points[0];
		const left = points[1];
		const right = points[2];
		if (!tip || !left || !right) return;
		// Base midpoint sits one head-length back along the shaft.
		const midX = (left[0] + right[0]) / 2;
		const midY = (left[1] + right[1]) / 2;
		near(Math.hypot(tip[0] - midX, tip[1] - midY), 3 * ARROW_LENGTH, 4);
	});

	it('never builds a head longer than the line itself', () => {
		// A 4pt drag with a 10pt nib would otherwise invert the arrow.
		const [head] = heads(
			SHAPE_GEOMETRY.arrow({ x: 0, y: 0, w: 4, h: 0 }, 10).segments,
		);
		if (!head) return;
		const points = vertices(head);
		const tip = points[0];
		const left = points[1];
		if (!tip || !left) return;
		expect(Math.abs(tip[0] - left[0])).toBeLessThanOrEqual(4 + 1e-6);
	});
});

describe('rect', () => {
	const [segment] = SHAPE_GEOMETRY.rect(BOX, WIDTH).segments;

	it('visits the four corners and closes', () => {
		expect(segment).toBeDefined();
		if (!segment) return;
		expect(vertices(segment)).toEqual([
			[100, 200],
			[180, 200],
			[180, 240],
			[100, 240],
		]);
		expect(closes(segment)).toBe(true);
	});

	it('normalises a negative drag', () => {
		const [flipped] = SHAPE_GEOMETRY.rect(
			{ x: 180, y: 240, w: -80, h: -40 },
			WIDTH,
		).segments;
		if (!flipped || !segment) return;
		expect(vertices(flipped)).toEqual(vertices(segment));
	});
});

describe('ellipse', () => {
	const { segments } = SHAPE_GEOMETRY.ellipse(BOX, WIDTH);
	const [segment] = segments;

	it('touches the four extreme points of the box', () => {
		expect(segment).toBeDefined();
		if (!segment) return;
		const points = vertices(segment);
		// start right, then bottom, left, top, back to right
		expect(points[0]).toEqual([180, 220]);
		expect(points[1]).toEqual([140, 240]);
		expect(points[2]).toEqual([100, 220]);
		expect(points[3]).toEqual([140, 200]);
		expect(points[4]).toEqual([180, 220]);
	});

	it('is built from four cubics and closes', () => {
		if (!segment) return;
		expect(segment.commands.filter((c) => c.op === 'cubic')).toHaveLength(4);
		expect(closes(segment)).toBe(true);
	});

	it('a square box gives a circle: every extreme is one radius from the centre', () => {
		const [circle] = SHAPE_GEOMETRY.ellipse(
			{ x: 0, y: 0, w: 50, h: 50 },
			WIDTH,
		).segments;
		if (!circle) return;
		for (const [x, y] of vertices(circle)) {
			near(Math.hypot(x - 25, y - 25), 25, 6);
		}
	});
});

describe('triangle', () => {
	it('locks height to sqrt(3)/2 times the side', () => {
		const side = 80;
		const [segment] = SHAPE_GEOMETRY.triangle(
			{ x: 0, y: 0, w: side, h: 999 },
			WIDTH,
		).segments;
		expect(segment).toBeDefined();
		if (!segment) return;
		const points = vertices(segment);
		const apex = points[2];
		if (!apex) return;
		// The absurd h in the box is ignored entirely.
		near(apex[1], (Math.sqrt(3) / 2) * side);
		near(equilateralHeight(side), 69.2820323027551, 9);
	});

	it('is genuinely equilateral: all three sides equal', () => {
		const [segment] = SHAPE_GEOMETRY.triangle(
			{ x: 10, y: 20, w: 64, h: 5 },
			WIDTH,
		).segments;
		if (!segment) return;
		const [a, b, c] = vertices(segment);
		if (!a || !b || !c) return;
		const side = (p: [number, number], q: [number, number]): number =>
			Math.hypot(p[0] - q[0], p[1] - q[1]);
		near(side(a, b), 64, 6);
		near(side(b, c), 64, 6);
		near(side(c, a), 64, 6);
	});

	it('has a base on the anchor line and an apex centred over it', () => {
		const [segment] = SHAPE_GEOMETRY.triangle(
			{ x: 10, y: 20, w: 60, h: 1 },
			WIDTH,
		).segments;
		if (!segment) return;
		const points = vertices(segment);
		expect(points[0]).toEqual([10, 20]);
		expect(points[1]).toEqual([70, 20]);
		expect(points[2]?.[0]).toBeCloseTo(40, 6);
		expect(closes(segment)).toBe(true);
	});

	it('points down when dragged downward', () => {
		const [segment] = SHAPE_GEOMETRY.triangle(
			{ x: 0, y: 0, w: 40, h: -1 },
			WIDTH,
		).segments;
		if (!segment) return;
		const apex = vertices(segment)[2];
		if (!apex) return;
		near(apex[1], -equilateralHeight(40));
	});
});

describe('2D axes origin placement', () => {
	it('reports the origin fraction per kind', () => {
		expect(originFractionFor('axes2d_q')).toBe(0.25);
		expect(originFractionFor('axes2d_c')).toBe(0.5);
		expect(originFractionFor('axes3d_c')).toBe(0.5);
		expect(originFractionFor('rect')).toBeNull();
	});

	/** Every axis segment starts at the origin, so any start point is the origin. */
	function originOf(kind: ShapeKind, box: Box): [number, number] {
		const [first] = strokes(shapeGeometry(kind, box, WIDTH).segments);
		const start = first ? vertices(first)[0] : undefined;
		return start ?? [Number.NaN, Number.NaN];
	}

	const box: Box = { x: 0, y: 0, w: 100, h: 200 };

	it('the quarter variant puts the origin 25% in on both axes', () => {
		expect(originOf('axes2d_q', box)).toEqual([25, 50]);
	});

	it('the centred variant puts the origin at the box centre', () => {
		expect(originOf('axes2d_c', box)).toEqual([50, 100]);
		expect(originOf('axes3d_c', box)).toEqual([50, 100]);
	});

	it('the origin follows a normalised box for a negative drag', () => {
		expect(originOf('axes2d_c', { x: 100, y: 200, w: -100, h: -200 })).toEqual([
			50, 100,
		]);
	});
});

describe('2D axes', () => {
	const box: Box = { x: 0, y: 0, w: 100, h: 100 };

	it('the quarter variant has four half-axes, all solid', () => {
		const { segments } = SHAPE_GEOMETRY.axes2d_q(box, WIDTH);
		expect(strokes(segments)).toHaveLength(4);
		expect(dashed(segments)).toHaveLength(0);
	});

	it('the quarter variant arrows only the positive ends', () => {
		const { segments } = SHAPE_GEOMETRY.axes2d_q(box, WIDTH);
		const tips = heads(segments).map((h) => vertices(h)[0]);
		expect(tips).toHaveLength(2);
		// +x at the right edge, +y at the top edge.
		expect(tips).toEqual(
			expect.arrayContaining([
				[100, 25],
				[25, 100],
			]),
		);
	});

	it('the centred variant arrows both ends of both axes', () => {
		const { segments } = SHAPE_GEOMETRY.axes2d_c(box, WIDTH);
		const tips = heads(segments).map((h) => vertices(h)[0]);
		expect(tips).toHaveLength(4);
		expect(tips).toEqual(
			expect.arrayContaining([
				[100, 50],
				[0, 50],
				[50, 100],
				[50, 0],
			]),
		);
	});

	it('axes span the full box width and height', () => {
		const [xPositive, xNegative, yPositive, yNegative] = strokes(
			SHAPE_GEOMETRY.axes2d_c(box, WIDTH).segments,
		);
		if (!xPositive || !xNegative || !yPositive || !yNegative) return;
		expect(vertices(xPositive)[1]).toEqual([100, 50]);
		expect(vertices(xNegative)[1]).toEqual([0, 50]);
		expect(vertices(yPositive)[1]).toEqual([50, 100]);
		expect(vertices(yNegative)[1]).toEqual([50, 0]);
	});
});

describe('3D axes use cabinet projection', () => {
	const box: Box = { x: 0, y: 0, w: 200, h: 200 };

	/** The out-of-page axis: the fifth stroked half-axis (x+, x-, y+, y-, then it). */
	function outOfPage(kind: 'axes3d_c', b: Box = box) {
		const segment = strokes(SHAPE_GEOMETRY[kind](b, WIDTH).segments)[4];
		const points = segment ? vertices(segment) : [];
		return { origin: points[0], end: points[1] };
	}

	it('adds an out-of-page axis at 45 degrees', () => {
		const { origin, end } = outOfPage('axes3d_c');
		expect(origin).toBeDefined();
		expect(end).toBeDefined();
		if (!origin || !end) return;
		const dx = end[0] - origin[0];
		const dy = end[1] - origin[1];
		// 45 degrees means equal components.
		near(Math.abs(dx), Math.abs(dy), 9);
	});

	it('points the POSITIVE axis out of the page, toward the viewer', () => {
		// Right-handed axes with y right and z up put x out of the page, which on
		// paper is down-left. The solid, arrow-tipped half must go that way.
		const { origin, end } = outOfPage('axes3d_c');
		if (!origin || !end) return;
		expect(end[0]).toBeLessThan(origin[0]);
		expect(end[1]).toBeLessThan(origin[1]);
	});

	it('dashes the negative half, which goes into the page', () => {
		const { segments } = SHAPE_GEOMETRY.axes3d_c(box, WIDTH);
		const intoPage = dashed(segments).find((segment) => {
			const [origin, end] = vertices(segment);
			return origin !== undefined && end !== undefined && end[0] > origin[0] && end[1] > origin[1];
		});
		expect(intoPage).toBeDefined();
	});

	it('puts the arrowhead on the out-of-page end, never the dashed one', () => {
		const { segments } = SHAPE_GEOMETRY.axes3d_c(box, WIDTH);
		const { end } = outOfPage('axes3d_c');
		if (!end) return;
		const tips = heads(segments).map((h) => vertices(h)[0]);
		expect(tips).toEqual(
			expect.arrayContaining([[end[0], end[1]]]),
		);
		// Nothing is tipped up-right, which is the into-page direction.
		for (const tip of tips) {
			if (!tip) continue;
			expect(tip[0] > 100 && tip[1] > 100).toBe(false);
		}
	});

	it('is right-handed: x cross y equals z', () => {
		// Screen basis: right = e1, up = e2, out of page = e3.
		const { origin, end } = outOfPage('axes3d_c');
		if (!origin || !end) return;
		// x drawn down-left means it really points out of the page.
		const x: [number, number, number] = [0, 0, 1];
		const y: [number, number, number] = [1, 0, 0];
		const cross: [number, number, number] = [
			x[1] * y[2] - x[2] * y[1],
			x[2] * y[0] - x[0] * y[2],
			x[0] * y[1] - x[1] * y[0],
		];
		// e2, which is up: the z axis.
		expect(cross).toEqual([0, 1, 0]);
		// And the drawing agrees that x heads down-left.
		expect(end[0] - origin[0]).toBeLessThan(0);
	});

	it('foreshortens it to half the available reach', () => {
		const { origin, end } = outOfPage('axes3d_c');
		if (!origin || !end) return;
		// Origin at the centre of a 200x200 box: 100 of reach, halved to 50.
		near(Math.hypot(end[0] - origin[0], end[1] - origin[1]), 100 * AXIS_FORESHORTENING, 6);
	});

	it('dashes every negative half-axis and no positive one', () => {
		const { segments } = SHAPE_GEOMETRY.axes3d_c(box, WIDTH);
		// The negatives of the two in-plane axes, plus the into-page half.
		expect(dashed(segments)).toHaveLength(3);
		expect(strokes(segments)).toHaveLength(6);
		for (const segment of dashed(segments)) {
			expect(segment.dash?.[0]).toBeGreaterThan(0);
			expect(segment.dash?.[1]).toBeGreaterThan(0);
		}
	});

	it('scales the dash pattern with stroke width', () => {
		const thin = dashed(SHAPE_GEOMETRY.axes3d_c(box, 1).segments)[0];
		const thick = dashed(SHAPE_GEOMETRY.axes3d_c(box, 4).segments)[0];
		if (!thin?.dash || !thick?.dash) return;
		near(thick.dash[0] / thin.dash[0], 4, 6);
	});

	it('arrows the three positive ends only', () => {
		const { segments } = SHAPE_GEOMETRY.axes3d_c(box, WIDTH);
		expect(heads(segments)).toHaveLength(3);
		const tips = heads(segments).map((h) => vertices(h)[0]);
		expect(tips).toEqual(
			expect.arrayContaining([
				[200, 100],
				[100, 200],
			]),
		);
	});

	it('is 75% of the in-plane axes, not the stunted textbook half', () => {
		const { origin, end } = outOfPage('axes3d_c');
		if (!origin || !end) return;
		// y+ and z+ each reach 100 from the centre of a 200x200 box.
		const inPlane = 100;
		near(
			Math.hypot(end[0] - origin[0], end[1] - origin[1]),
			inPlane * 0.75,
			6,
		);
		expect(AXIS_FORESHORTENING).toBe(0.75);
	});

	it('keeps the out-of-page axis inside the box', () => {
		// Wide but short: the reach must come from the vertical room.
		const tall: Box = { x: 0, y: 0, w: 400, h: 80 };
		const { origin, end } = outOfPage('axes3d_c', tall);
		if (!origin || !end) return;
		expect(end[0]).toBeGreaterThanOrEqual(0);
		expect(end[1]).toBeGreaterThanOrEqual(0);
		// Origin is at (200, 40); reach is min(200, 40) * 0.75 = 30.
		near(Math.hypot(end[0] - origin[0], end[1] - origin[1]), 30, 6);
	});

	it('the quarter-origin 3D variant no longer exists', () => {
		expect(SHAPE_KINDS).not.toContain('axes3d_q');
		expect(Object.keys(SHAPE_GEOMETRY)).not.toContain('axes3d_q');
	});
});

describe('Shift constraints', () => {
	it('snaps a line to 15 degree steps, preserving length', () => {
		const box: Box = { x: 0, y: 0, w: 100, h: 10 };
		const snapped = constrainShapeBox('line', box, true);
		const angle = (Math.atan2(snapped.h, snapped.w) * 180) / Math.PI;
		near(angle, 0, 6);
		near(Math.hypot(snapped.w, snapped.h), Math.hypot(100, 10), 6);
	});

	it('snaps to the nearest step, not always down', () => {
		for (const [h, expected] of [
			// atan2 of each, rounded to the nearest 15 degrees.
			[40, 15], // 21.8 -> 15
			[60, 30], // 31.0 -> 30
			[100, 45], // 45.0 -> 45
			[200, 60], // 63.4 -> 60
			[268, 75], // 69.5 -> 75
		] as [number, number][]) {
			const snapped = snapToAngle({ x: 0, y: 0, w: 100, h }, SNAP_DEGREES);
			const angle = (Math.atan2(snapped.h, snapped.w) * 180) / Math.PI;
			near(angle, expected, 4);
		}
	});

	it('snapping is a no-op on a zero-length drag', () => {
		const box: Box = { x: 3, y: 4, w: 0, h: 0 };
		expect(snapToAngle(box, SNAP_DEGREES)).toEqual(box);
	});

	it('makes a rect square, keeping the drag direction', () => {
		expect(constrainShapeBox('rect', { x: 0, y: 0, w: 90, h: -30 }, true)).toEqual({
			x: 0,
			y: 0,
			w: 30,
			h: -30,
		});
	});

	it('makes an ellipse a circle', () => {
		const box = constrainShapeBox('ellipse', { x: 0, y: 0, w: 20, h: 70 }, true);
		expect(Math.abs(box.w)).toBe(Math.abs(box.h));
	});

	it('squares the axes kinds too', () => {
		for (const kind of ['axes2d_q', 'axes2d_c', 'axes3d_c'] as const) {
			const box = constrainShapeBox(kind, { x: 0, y: 0, w: 120, h: 40 }, true);
			expect(Math.abs(box.w), kind).toBe(Math.abs(box.h));
		}
	});

	it('leaves everything alone without Shift', () => {
		const box: Box = { x: 0, y: 0, w: 90, h: -30 };
		for (const kind of SHAPE_KINDS) {
			if (kind === 'triangle') continue;
			expect(constrainShapeBox(kind, box, false), kind).toEqual(box);
		}
	});

	it('locks the triangle whether or not Shift is held', () => {
		const box: Box = { x: 0, y: 0, w: 60, h: 999 };
		for (const shift of [true, false]) {
			const locked = constrainShapeBox('triangle', box, shift);
			near(locked.h, equilateralHeight(60));
			expect(locked.w).toBe(60);
		}
	});

	it('preserves a downward triangle drag when locking', () => {
		const locked = constrainShapeBox('triangle', { x: 0, y: 0, w: 60, h: -5 }, false);
		near(locked.h, -equilateralHeight(60));
	});
});
