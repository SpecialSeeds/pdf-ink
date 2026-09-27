import { describe, expect, it } from 'vitest';
import type { ItemRef } from './history';
import type { Item, ShapeItem, StrokeSample, TextItem } from './items';
import { createStroke } from './stroke';
import {
	IDENTITY_TRANSFORM,
	duplicateItems,
	isIdentity,
	mapPoint,
	rotationAbout,
	scaleAbout,
	transformChanges,
	transformItem,
	translation,
	zChanges,
} from './transform';

function stroke(points: StrokeSample[], id = 's'): Item {
	const item = createStroke({ tool: 'pen', color: '#111', width: 2, opacity: 1 }, id);
	item.points.push(...points);
	return item;
}

function shape(id = 'sh', rotation = 0): ShapeItem {
	return {
		type: 'shape',
		id,
		color: '#111',
		opacity: 1,
		rotation,
		z: 0,
		updatedAt: 0,
		kind: 'rect',
		box: { x: 10, y: 20, w: 40, h: 60 },
		width: 2,
		fill: null,
	};
}

function text(id = 'tx'): TextItem {
	return {
		type: 'text',
		id,
		color: '#111',
		opacity: 1,
		rotation: 0,
		z: 0,
		updatedAt: 0,
		box: { x: 0, y: 0, w: 100, h: 20 },
		text: 'hi',
		fontSize: 12,
	};
}

function ref(item: Item, index = 0): ItemRef {
	return { pageKey: 'pdf:0', index, item };
}

function near(a: number, b: number, precision = 6): void {
	expect(a).toBeCloseTo(b, precision);
}

describe('mapPoint', () => {
	it('translates', () => {
		expect(mapPoint(10, 20, translation(5, -5))).toEqual([15, 15]);
	});

	it('scales about a pivot, leaving the pivot fixed', () => {
		const t = scaleAbout(100, 100, 2, 2);
		expect(mapPoint(100, 100, t)).toEqual([100, 100]);
		expect(mapPoint(150, 100, t)).toEqual([200, 100]);
	});

	it('scales each axis independently', () => {
		expect(mapPoint(10, 10, scaleAbout(0, 0, 2, 3))).toEqual([20, 30]);
	});

	it('rotates clockwise in a y-up space', () => {
		// (1, 0) turned 90 degrees clockwise about the origin becomes (0, -1).
		const [x, y] = mapPoint(1, 0, rotationAbout(0, 0, 90));
		near(x, 0);
		near(y, -1);
	});

	it('rotation leaves the pivot fixed', () => {
		const [x, y] = mapPoint(50, 50, rotationAbout(50, 50, 37));
		near(x, 50);
		near(y, 50);
	});

	it('a full turn is the identity', () => {
		const [x, y] = mapPoint(13, 29, rotationAbout(5, 5, 360));
		near(x, 13);
		near(y, 29);
	});

	it('preserves distance from the pivot under rotation', () => {
		const t = rotationAbout(10, 10, 53);
		const [x, y] = mapPoint(40, 10, t);
		near(Math.hypot(x - 10, y - 10), 30);
	});

	it('applies scale, then rotation, then translation', () => {
		const t = { dx: 100, dy: 0, sx: 2, sy: 2, pivotX: 0, pivotY: 0, degrees: 90 };
		// (1,0) -> scale -> (2,0) -> rotate cw -> (0,-2) -> translate -> (100,-2)
		const [x, y] = mapPoint(1, 0, t);
		near(x, 100);
		near(y, -2);
	});
});

describe('isIdentity', () => {
	it('recognises the identity whatever the pivot', () => {
		expect(isIdentity(IDENTITY_TRANSFORM)).toBe(true);
		expect(isIdentity({ ...IDENTITY_TRANSFORM, pivotX: 99, pivotY: 5 })).toBe(true);
	});

	it('rejects any real change', () => {
		expect(isIdentity(translation(1, 0))).toBe(false);
		expect(isIdentity(scaleAbout(0, 0, 2, 1))).toBe(false);
		expect(isIdentity(rotationAbout(0, 0, 1))).toBe(false);
	});
});

describe('transformItem on strokes', () => {
	it('moves every point and leaves pressure alone', () => {
		const moved = transformItem(
			stroke([[0, 0, 0.25], [10, 10, 0.75]]),
			translation(5, 5),
		);
		if (moved.type !== 'stroke') return;
		expect(moved.points).toEqual([[5, 5, 0.25], [15, 15, 0.75]]);
	});

	it('scales points about the pivot', () => {
		const scaled = transformItem(
			stroke([[0, 0, 1], [10, 0, 1]]),
			scaleAbout(0, 0, 3, 3),
		);
		if (scaled.type !== 'stroke') return;
		expect(scaled.points[1]?.[0]).toBe(30);
	});

	it('bakes rotation into the points, leaving the angle at zero', () => {
		const rotated = transformItem(
			stroke([[1, 0, 1]]),
			rotationAbout(0, 0, 90),
		);
		if (rotated.type !== 'stroke') return;
		near(rotated.points[0]?.[0] ?? 1, 0);
		near(rotated.points[0]?.[1] ?? 1, -1);
		// A stroke has no separate angle: its geometry is absolute.
		expect(rotated.rotation).toBe(0);
	});

	it('keeps identity fields: id, colour, width, tool, opacity, z', () => {
		const source = stroke([[0, 0, 1], [1, 1, 1]], 'keep');
		const moved = transformItem(source, translation(3, 4));
		expect(moved.id).toBe('keep');
		expect(moved.color).toBe(source.color);
		expect(moved.z).toBe(source.z);
		if (moved.type !== 'stroke' || source.type !== 'stroke') return;
		expect(moved.width).toBe(source.width);
		expect(moved.tool).toBe(source.tool);
	});

	it('does not mutate the original', () => {
		const source = stroke([[0, 0, 1]]);
		transformItem(source, translation(100, 100));
		if (source.type !== 'stroke') return;
		expect(source.points[0]).toEqual([0, 0, 1]);
	});
});

describe('transformItem on shapes and text', () => {
	it('moves the box', () => {
		const moved = transformItem(shape(), translation(5, -5));
		if (moved.type !== 'shape') return;
		expect(moved.box).toEqual({ x: 15, y: 15, w: 40, h: 60 });
	});

	it('scales the box about the pivot', () => {
		const scaled = transformItem(shape(), scaleAbout(10, 20, 2, 2));
		if (scaled.type !== 'shape') return;
		// Centre was (30, 50); about (10,20) it doubles to (50, 80).
		expect(scaled.box.w).toBe(80);
		expect(scaled.box.h).toBe(120);
		near(scaled.box.x + scaled.box.w / 2, 50);
		near(scaled.box.y + scaled.box.h / 2, 80);
	});

	it('accumulates rotation rather than rotating the box corners', () => {
		const rotated = transformItem(shape('sh', 30), rotationAbout(30, 50, 45));
		if (rotated.type !== 'shape') return;
		expect(rotated.rotation).toBe(75);
		// Rotating about its own centre leaves the box where it was.
		near(rotated.box.x, 10);
		near(rotated.box.y, 20);
		expect(rotated.box.w).toBe(40);
	});

	it('rotating about a distant pivot moves the box centre', () => {
		const rotated = transformItem(shape(), rotationAbout(0, 0, 90));
		if (rotated.type !== 'shape') return;
		// Centre (30,50) turned 90 cw becomes (50,-30).
		near(rotated.box.x + rotated.box.w / 2, 50);
		near(rotated.box.y + rotated.box.h / 2, -30);
	});

	it('treats a text box the same way', () => {
		const moved = transformItem(text(), translation(10, 10));
		if (moved.type !== 'text') return;
		expect(moved.box).toEqual({ x: 10, y: 10, w: 100, h: 20 });
		expect(moved.text).toBe('hi');
		expect(moved.fontSize).toBe(12);
	});
});

describe('transformChanges', () => {
	it('produces one change per item, carrying before and after', () => {
		const refs = [ref(stroke([[0, 0, 1]], 'a'), 0), ref(shape('b'), 1)];
		const changes = transformChanges(refs, translation(5, 5));
		expect(changes).toHaveLength(2);
		expect(changes[0]?.before.id).toBe('a');
		expect(changes[0]?.after.id).toBe('a');
		expect(changes.every((c) => c.pageKey === 'pdf:0')).toBe(true);
	});

	it('produces nothing for an identity transform, so no history is recorded', () => {
		expect(transformChanges([ref(shape())], IDENTITY_TRANSFORM)).toEqual([]);
	});

	it('is empty for an empty selection', () => {
		expect(transformChanges([], translation(1, 1))).toEqual([]);
	});
});

describe('duplicateItems', () => {
	let n = 0;
	const nextId = (): string => `copy-${String(n++)}`;

	it("offsets so the original's bottom-right becomes the copy's top-left", () => {
		// Box (10,20) 40x60: bottom-right is (50, 20), top-left is (10, 80).
		const [copy] = duplicateItems([ref(shape('orig'))], nextId);
		if (!copy || copy.type !== 'shape') return;
		// The copy's top-left must land on the original's bottom-right.
		expect(copy.box.x).toBe(50);
		expect(copy.box.y + copy.box.h).toBe(20);
		expect(copy.box.w).toBe(40);
		expect(copy.box.h).toBe(60);
	});

	it('leaves the copy clear of the original, so a lasso catches only one', () => {
		const original = shape('orig');
		const [copy] = duplicateItems([ref(original)], nextId);
		if (!copy || copy.type !== 'shape') return;
		const right = (b: typeof original.box): number => b.x + b.w;
		const top = (b: typeof original.box): number => b.y + b.h;
		// Touching at a corner only: no overlapping area.
		expect(copy.box.x).toBeGreaterThanOrEqual(right(original.box));
		expect(top(copy.box)).toBeLessThanOrEqual(top(original.box));
	});

	it('gives every copy a fresh id', () => {
		const copies = duplicateItems(
			[ref(shape('a'), 0), ref(shape('b'), 1)],
			nextId,
		);
		const ids = copies.map((c) => c.id);
		expect(new Set(ids).size).toBe(2);
		expect(ids).not.toContain('a');
	});

	it('offsets a multi-item selection by the whole selection box', () => {
		const a = stroke([[0, 0, 1], [10, 0, 1]], 'a');
		const b = stroke([[0, 50, 1], [30, 50, 1]], 'b');
		// Union is x 0..30, y 0..50, so the offset is (+30, -50).
		const copies = duplicateItems([ref(a, 0), ref(b, 1)], nextId);
		const first = copies[0];
		if (!first || first.type !== 'stroke') return;
		expect(first.points[0]).toEqual([30, -50, 1]);
	});

	it('offsets stroke points and leaves the original alone', () => {
		const source = stroke([[0, 0, 1], [20, 0, 1]], 'orig');
		const [copy] = duplicateItems([ref(source)], nextId);
		if (!copy || copy.type !== 'stroke' || source.type !== 'stroke') return;
		// Width 20, height 0: shifted fully to the right.
		expect(copy.points[0]).toEqual([20, 0, 1]);
		expect(source.points[0]).toEqual([0, 0, 1]);
	});

	it('is empty for an empty selection', () => {
		expect(duplicateItems([], nextId)).toEqual([]);
	});
});

describe('zChanges', () => {
	const a = stroke([[0, 0, 1]], 'a');
	const b = stroke([[1, 1, 1]], 'b');
	const c = stroke([[2, 2, 1]], 'c');
	a.z = 0;
	b.z = 1;
	c.z = 2;
	const page = [a, b, c];

	it('brings the selection above everything else', () => {
		const changes = zChanges([ref(a)], page, 'front');
		expect(changes[0]?.after.z).toBeGreaterThan(c.z);
	});

	it('sends the selection below everything else', () => {
		const changes = zChanges([ref(c)], page, 'back');
		expect(changes[0]?.after.z).toBeLessThan(a.z);
	});

	it('keeps the selection in its own relative order', () => {
		const changes = zChanges([ref(c), ref(a)], page, 'front');
		const byId = new Map(changes.map((ch) => [ch.after.id, ch.after.z]));
		// a was under c, and still is.
		expect(byId.get('a')).toBeLessThan(byId.get('c') ?? 0);
	});

	it('changes nothing else about the items', () => {
		const [change] = zChanges([ref(a)], page, 'front');
		if (!change) return;
		expect(change.after.id).toBe('a');
		expect(change.after.color).toBe(a.color);
	});

	it('is empty for an empty selection or an empty page', () => {
		expect(zChanges([], page, 'front')).toEqual([]);
		expect(zChanges([ref(a)], [], 'front')).toEqual([]);
	});
});
