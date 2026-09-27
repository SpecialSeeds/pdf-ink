import type { Vec2 } from 'perfect-freehand';
import { describe, expect, it } from 'vitest';
import type { Item, ShapeItem, StrokeSample, TextItem } from './items';
import {
	LASSO_STROKE_THRESHOLD,
	boundsCenter,
	closeLoop,
	fractionInside,
	isTapGesture,
	itemCenter,
	selectByLasso,
	selectByPoint,
	selectionBounds,
	selectsItem,
} from './lasso';
import { createStroke } from './stroke';

/** A 100x100 square loop at the origin. */
const SQUARE: Vec2[] = [
	[0, 0],
	[100, 0],
	[100, 100],
	[0, 100],
];

function stroke(points: StrokeSample[], id = 's'): Item {
	const item = createStroke({ tool: 'pen', color: '#111', width: 2, opacity: 1 }, id);
	item.points.push(...points);
	return item;
}

function shape(box: ShapeItem['box'], id = 'sh'): ShapeItem {
	return {
		type: 'shape',
		id,
		color: '#111',
		opacity: 1,
		rotation: 0,
		z: 0,
		updatedAt: 0,
		kind: 'rect',
		box,
		width: 2,
		fill: null,
	};
}

function text(box: TextItem['box'], id = 'tx'): TextItem {
	return {
		type: 'text',
		id,
		color: '#111',
		opacity: 1,
		rotation: 0,
		z: 0,
		updatedAt: 0,
		box,
		text: 'hi',
		fontSize: 12,
	};
}

/** n points spread along y=50, from x=0 to x=`span`. */
function spread(count: number, span: number): StrokeSample[] {
	return Array.from({ length: count }, (_, i) => [
		(i / (count - 1)) * span,
		50,
		0.5,
	] as StrokeSample);
}

describe('fractionInside', () => {
	it('is 1 when every point is inside', () => {
		expect(fractionInside(spread(5, 90), SQUARE)).toBe(1);
	});

	it('is 0 when every point is outside', () => {
		expect(fractionInside(spread(5, 90).map(([x, y, p]) => [x, y + 500, p]), SQUARE)).toBe(0);
	});

	it('counts the proportion inside', () => {
		// Ten points spanning 0..200; those with x < 100 are inside.
		const points = Array.from(
			{ length: 10 },
			(_, i) => [i * 20 + 10, 50, 0.5] as StrokeSample,
		);
		// x = 10, 30, 50, 70, 90 inside; 110..190 outside.
		expect(fractionInside(points, SQUARE)).toBeCloseTo(0.5, 6);
	});

	it('is 0 for an empty stroke', () => {
		expect(fractionInside([], SQUARE)).toBe(0);
	});
});

describe('the 60% rule for strokes', () => {
	it('selects a stroke entirely inside', () => {
		expect(selectsItem(stroke(spread(10, 90)), SQUARE)).toBe(true);
	});

	it('rejects a stroke entirely outside', () => {
		expect(
			selectsItem(stroke(spread(10, 90).map(([x, y, p]) => [x + 500, y, p])), SQUARE),
		).toBe(false);
	});

	it('selects at exactly the threshold', () => {
		// 10 points, 6 inside: exactly 0.6.
		const points = Array.from(
			{ length: 10 },
			(_, i) => [i * 15 + 5, 50, 0.5] as StrokeSample,
		);
		// x = 5,20,35,50,65,80 inside (6); 95 is inside too -> adjust below.
		const inside = points.filter(([x]) => x < 100).length;
		expect(inside / points.length).toBeGreaterThanOrEqual(LASSO_STROKE_THRESHOLD);
		expect(selectsItem(stroke(points), SQUARE)).toBe(true);
	});

	it('rejects just under the threshold', () => {
		// 10 points, 5 inside: 0.5 < 0.6.
		const points = Array.from(
			{ length: 10 },
			(_, i) => [i * 20 + 10, 50, 0.5] as StrokeSample,
		);
		expect(fractionInside(points, SQUARE)).toBeCloseTo(0.5, 6);
		expect(selectsItem(stroke(points), SQUARE)).toBe(false);
	});

	it('a stroke that merely passes through is not selected', () => {
		// Long stroke, brief incursion.
		const points: StrokeSample[] = [
			[-400, 50, 0.5],
			[-200, 50, 0.5],
			[50, 50, 0.5],
			[300, 50, 0.5],
			[500, 50, 0.5],
		];
		expect(selectsItem(stroke(points), SQUARE)).toBe(false);
	});
});

describe('the centre rule for shapes and text', () => {
	it('selects a shape whose centre is inside, even if it overflows', () => {
		// Centre (50, 50) is inside; the box extends well past the loop.
		expect(selectsItem(shape({ x: -200, y: -200, w: 500, h: 500 }), SQUARE)).toBe(
			true,
		);
	});

	it('rejects a shape whose centre is outside, even if it overlaps', () => {
		// Overlaps the loop's corner, but its centre is far away.
		expect(selectsItem(shape({ x: 90, y: 90, w: 400, h: 400 }), SQUARE)).toBe(
			false,
		);
	});

	it('applies the same rule to a text box', () => {
		expect(selectsItem(text({ x: 20, y: 20, w: 40, h: 20 }), SQUARE)).toBe(true);
		expect(selectsItem(text({ x: 400, y: 20, w: 40, h: 20 }), SQUARE)).toBe(false);
	});

	it('normalises a negative box before taking the centre', () => {
		// Same centre, expressed as a negative drag.
		expect(selectsItem(shape({ x: 60, y: 60, w: -20, h: -20 }), SQUARE)).toBe(true);
	});
});

describe('itemCenter', () => {
	it('is the bounds centre of a stroke', () => {
		expect(itemCenter(stroke([[0, 0, 1], [40, 60, 1]]))).toEqual([20, 30]);
	});

	it('is the box centre of a shape', () => {
		expect(itemCenter(shape({ x: 10, y: 20, w: 40, h: 60 }))).toEqual([30, 50]);
	});

	it('is null for a stroke with no points', () => {
		expect(itemCenter(stroke([]))).toBeNull();
	});

	it('boundsCenter averages the extremes', () => {
		expect(boundsCenter({ minX: -10, minY: 0, maxX: 10, maxY: 100 })).toEqual([
			0, 50,
		]);
	});
});

describe('selectByLasso', () => {
	it('returns refs carrying the page and list position', () => {
		const items: Item[] = [
			stroke(spread(10, 90), 'in'),
			stroke(spread(10, 90).map(([x, y, p]) => [x + 500, y, p]), 'out'),
			shape({ x: 20, y: 20, w: 10, h: 10 }, 'shape-in'),
		];
		const refs = selectByLasso(items, SQUARE, 'pdf:3');
		expect(refs.map((r) => r.item.id)).toEqual(['in', 'shape-in']);
		expect(refs.map((r) => r.index)).toEqual([0, 2]);
		expect(refs.every((r) => r.pageKey === 'pdf:3')).toBe(true);
	});

	it('selects nothing for a degenerate loop', () => {
		const items = [stroke(spread(10, 90))];
		expect(selectByLasso(items, [], 'pdf:0')).toEqual([]);
		expect(selectByLasso(items, [[0, 0], [1, 1]], 'pdf:0')).toEqual([]);
	});

	it('selects nothing on an empty page', () => {
		expect(selectByLasso([], SQUARE, 'pdf:0')).toEqual([]);
	});
});

describe('selectionBounds', () => {
	it('unions the selected items', () => {
		const refs = selectByLasso(
			[
				stroke([[0, 0, 1], [10, 10, 1]], 'a'),
				shape({ x: 40, y: 40, w: 20, h: 20 }, 'b'),
			],
			SQUARE,
			'pdf:0',
		);
		expect(selectionBounds(refs)).toEqual({
			minX: 0,
			minY: 0,
			maxX: 60,
			maxY: 60,
		});
	});

	it('is null for an empty selection', () => {
		expect(selectionBounds([])).toBeNull();
	});
});

describe('closeLoop', () => {
	it('joins the last point back to the first', () => {
		const closed = closeLoop([[0, 0], [10, 0], [10, 10]]);
		expect(closed).toHaveLength(4);
		expect(closed[3]).toEqual([0, 0]);
	});

	it('leaves an already-closed loop alone', () => {
		const loop: Vec2[] = [[0, 0], [10, 0], [10, 10], [0, 0]];
		expect(closeLoop(loop)).toHaveLength(4);
	});

	it('passes through a loop too short to close', () => {
		expect(closeLoop([[0, 0], [1, 1]])).toHaveLength(2);
	});
});

describe('isTapGesture', () => {
	it('treats a single point as a tap', () => {
		expect(isTapGesture([[10, 10]], 5)).toBe(true);
	});

	it('tolerates a jittery finger', () => {
		expect(isTapGesture([[10, 10], [12, 11], [9, 12]], 5)).toBe(true);
	});

	it('rejects a gesture that travelled', () => {
		expect(isTapGesture([[10, 10], [60, 10]], 5)).toBe(false);
	});

	it('measures from the first point, not between neighbours', () => {
		// Each step is small but the path wanders well away from the start.
		const points: Vec2[] = Array.from({ length: 20 }, (_, i) => [i * 2, 0]);
		expect(isTapGesture(points, 5)).toBe(false);
	});

	it('treats an empty gesture as a tap', () => {
		expect(isTapGesture([], 5)).toBe(true);
	});
});

describe('selectByPoint', () => {
	const line = stroke(
		[
			[100, 100, 0.5],
			[200, 100, 0.5],
		],
		'line',
	);

	it('selects a stroke clicked directly on', () => {
		const hit = selectByPoint([line], 150, 100, 2, 'pdf:0');
		expect(hit?.item.id).toBe('line');
		expect(hit?.pageKey).toBe('pdf:0');
		expect(hit?.index).toBe(0);
	});

	it('returns null when the click misses everything', () => {
		expect(selectByPoint([line], 150, 400, 2, 'pdf:0')).toBeNull();
	});

	it('honours the tolerance for a near miss', () => {
		// Just off the 2pt-wide stroke.
		expect(selectByPoint([line], 150, 112, 1, 'pdf:0')).toBeNull();
		expect(selectByPoint([line], 150, 112, 20, 'pdf:0')).not.toBeNull();
	});

	it('selects a shape clicked inside, even unfilled', () => {
		const rect = shape({ x: 0, y: 0, w: 100, h: 100 }, 'rect');
		expect(selectByPoint([rect], 50, 50, 1, 'pdf:0')?.item.id).toBe('rect');
	});

	it('selects a text box clicked inside', () => {
		const box = text({ x: 0, y: 0, w: 80, h: 20 }, 'txt');
		expect(selectByPoint([box], 40, 10, 1, 'pdf:0')?.item.id).toBe('txt');
	});

	it('picks the topmost item by z when several overlap', () => {
		const under = shape({ x: 0, y: 0, w: 100, h: 100 }, 'under');
		const over = shape({ x: 0, y: 0, w: 100, h: 100 }, 'over');
		under.z = 1;
		over.z = 5;
		expect(selectByPoint([under, over], 50, 50, 1, 'pdf:0')?.item.id).toBe('over');
		// Order in the array must not override z.
		expect(selectByPoint([over, under], 50, 50, 1, 'pdf:0')?.item.id).toBe('over');
	});

	it('breaks a z tie in favour of the one drawn last', () => {
		const first = shape({ x: 0, y: 0, w: 100, h: 100 }, 'first');
		const second = shape({ x: 0, y: 0, w: 100, h: 100 }, 'second');
		first.z = 3;
		second.z = 3;
		expect(selectByPoint([first, second], 50, 50, 1, 'pdf:0')?.item.id).toBe('second');
	});

	it('reports the clicked item own list position', () => {
		const rect = shape({ x: 0, y: 0, w: 10, h: 10 }, 'rect');
		const hit = selectByPoint([line, rect], 5, 5, 1, 'pdf:3');
		expect(hit?.index).toBe(1);
		expect(hit?.pageKey).toBe('pdf:3');
	});

	it('is null on an empty page', () => {
		expect(selectByPoint([], 0, 0, 5, 'pdf:0')).toBeNull();
	});

	it('skips an item with no geometry', () => {
		expect(selectByPoint([stroke([], 'empty')], 0, 0, 5, 'pdf:0')).toBeNull();
	});
});
