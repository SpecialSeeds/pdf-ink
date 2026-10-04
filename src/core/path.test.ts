import { describe, expect, it } from 'vitest';
import { SizedEraseSession, isErasable } from './erase-session';
import { hitTestShape, itemBounds, itemHitShape } from './hit-test';
import { parseInkData, serializeInkData } from './ink-serialization';
import { INK_DATA_VERSION, type PathItem } from './items';
import { selectsItem } from './lasso';
import { paginate } from './paginate';
import {
	flattenPath,
	mapPath,
	parsePathData,
	pathBounds,
	pathCommands,
	pathGeometry,
	serializePathData,
	simplifyPathCommands,
} from './path';
import { recolorChanges } from './selection';
import { DEFAULT_PAGE_THEMES, renderColor } from './theme';
import { rotationAbout, transformItem, translation } from './transform';

/** A filled 10 x 10 square with its lower-left corner at (x, y). */
function square(x = 100, y = 100, over: Partial<PathItem> = {}): PathItem {
	return {
		type: 'path',
		id: 'p1',
		color: '#000000',
		opacity: 1,
		rotation: 0,
		z: 0,
		updatedAt: 0,
		d: `M${x} ${y}L${x + 10} ${y}L${x + 10} ${y + 10}L${x} ${y + 10}Z`,
		...over,
	};
}

describe('path data', () => {
	it('parses M, L, C and Z', () => {
		expect(parsePathData('M1 2L3 4C5 6 7 8 9 10Z')).toEqual([
			{ op: 'move', x: 1, y: 2 },
			{ op: 'line', x: 3, y: 4 },
			{ op: 'cubic', x1: 5, y1: 6, x2: 7, y2: 8, x: 9, y: 10 },
			{ op: 'close' },
		]);
	});

	it('reads separators, signs, decimals and exponents', () => {
		expect(parsePathData('M -1.5,.25 L1e2 -3E-1')).toEqual([
			{ op: 'move', x: -1.5, y: 0.25 },
			{ op: 'line', x: 100, y: -0.3 },
		]);
	});

	it('rejects relative commands, missing numbers and drawing before a move', () => {
		expect(parsePathData('m1 2')).toBeNull();
		expect(parsePathData('M1 2Q3 4 5 6')).toBeNull();
		expect(parsePathData('M1')).toBeNull();
		expect(parsePathData('L1 2')).toBeNull();
		expect(parsePathData('Z')).toBeNull();
		expect(parsePathData('M1 2 L x 3')).toBeNull();
	});

	it('round-trips through serialisation at a hundredth of a point', () => {
		const commands = parsePathData('M1.234 5.678C1 2 3 4 5.001 -6.999Z') ?? [];
		const d = serializePathData(commands);
		expect(d).toBe('M1.23 5.68C1 2 3 4 5 -7Z');
		expect(parsePathData(d)).toEqual([
			{ op: 'move', x: 1.23, y: 5.68 },
			{ op: 'cubic', x1: 1, y1: 2, x2: 3, y2: 4, x: 5, y: -7 },
			{ op: 'close' },
		]);
	});
});

describe('path geometry', () => {
	it('is one filled segment, or one stroked segment for an outline path', () => {
		const filled = pathGeometry(square());
		expect(filled.segments).toHaveLength(1);
		expect(filled.segments[0]?.fill).toBe(true);
		expect(filled.segments[0]?.commands).toEqual(pathCommands(square()));
		expect(pathGeometry(square(0, 0, { strokeWidth: 2 })).segments[0]?.fill).toBe(false);
	});

	it('bounds the outline, padded by half a stroke', () => {
		expect(pathBounds(square())).toEqual({ minX: 100, minY: 100, maxX: 110, maxY: 110 });
		expect(itemBounds(square(0, 0, { strokeWidth: 4 }))).toEqual({
			minX: -2,
			minY: -2,
			maxX: 12,
			maxY: 12,
		});
	});

	it('flattens curves into closely spaced points that stay on the curve', () => {
		const rings = flattenPath(parsePathData('M0 0C0 10 10 10 10 0Z') ?? [], 0.5);
		expect(rings).toHaveLength(1);
		const ring = rings[0] ?? [];
		expect(ring.length).toBeGreaterThan(20);
		expect(ring[ring.length - 1]).toEqual([0, 0]);
		// The curve's apex is at t = 0.5: (5, 7.5).
		const top = Math.max(...ring.map(([, y]) => y));
		expect(top).toBeCloseTo(7.5, 1);
	});

	it('maps every point, control points included', () => {
		const moved = mapPath(
			{ ...square(), d: 'M0 0C1 2 3 4 5 6Z' },
			(x, y) => [x + 10, y * 2],
		);
		expect(moved.d).toBe('M10 0C11 4 13 8 15 12Z');
	});
});

describe('path items in the sidecar', () => {
	it('round-trip with their optional fields', () => {
		const items: PathItem[] = [
			square(),
			square(0, 0, { id: 'p2', strokeWidth: 1.5, highlight: true, opacity: 0.4 }),
		];
		const text = serializeInkData({
			version: INK_DATA_VERSION,
			pages: { 'ins:a': items },
			insertedPages: [],
		});
		const result = parseInkData(text);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.dropped).toBe(0);
		expect(result.data.pages['ins:a']).toEqual(items);
	});

	it('drops a path whose data does not parse, and keeps the rest', () => {
		const result = parseInkData(
			JSON.stringify({
				version: 5,
				pages: {
					'pdf:0': [
						square(),
						{ ...square(), id: 'bad', d: 'M1 2 q3 4 5 6' },
						{ ...square(), id: 'empty', d: '' },
					],
				},
				insertedPages: [],
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.dropped).toBe(2);
		expect(result.data.pages['pdf:0']?.map((i) => i.id)).toEqual(['p1']);
	});
});

describe('editing paths', () => {
	it('moves under a lasso transform', () => {
		const moved = transformItem(square(), translation(5, -5));
		expect(moved.type === 'path' && moved.d).toBe('M105 95L115 95L115 105L105 105Z');
	});

	it('bakes a rotation into its points and keeps rotation 0', () => {
		const turned = transformItem(square(0, 0), rotationAbout(0, 0, 90));
		expect(turned.rotation).toBe(0);
		// Clockwise in y-up space: (10, 0) goes to (0, -10).
		expect(turned.type === 'path' && pathCommands(turned)[1]).toEqual({
			op: 'line',
			x: 0,
			y: -10,
		});
	});

	it('recolours like any other item', () => {
		const [change] = recolorChanges([{ pageKey: 'pdf:0', index: 0, item: square() }], '#e71225');
		expect(change?.after.color).toBe('#e71225');
		expect(change?.after.type === 'path' && change.after.d).toBe(square().d);
	});

	it('is selected by a lasso enclosing most of it', () => {
		const loop: [number, number][] = [
			[95, 95],
			[115, 95],
			[115, 115],
			[95, 115],
		];
		expect(selectsItem(square(), loop)).toBe(true);
		expect(selectsItem(square(300, 300), loop)).toBe(false);
	});

	it('maps its base ink through the page theme, like a stroke', () => {
		expect(renderColor(square().color, DEFAULT_PAGE_THEMES.dark)).toBe('#ffffff');
		expect(renderColor('#e71225', DEFAULT_PAGE_THEMES.dark)).toBe('#e71225');
	});
});

describe('erasing paths', () => {
	it('the stroke eraser hits a filled path inside it and near its edge', () => {
		const shape = itemHitShape(square());
		expect(shape).not.toBeNull();
		if (!shape) return;
		expect(hitTestShape(shape, 105, 105, 0.5)).toBe(true);
		expect(hitTestShape(shape, 111, 105, 1.5)).toBe(true);
		expect(hitTestShape(shape, 120, 105, 1.5)).toBe(false);
	});

	it('the stroke eraser hits a stroked path on its line, not in its middle', () => {
		const shape = itemHitShape(square(100, 100, { strokeWidth: 2 }));
		if (!shape) throw new Error('no hit shape');
		// Half the 2 pt width plus the 0.2 pt radius reaches 1.2 pt from the line.
		expect(hitTestShape(shape, 101.1, 105, 0.2)).toBe(true);
		expect(hitTestShape(shape, 101.5, 105, 0.2)).toBe(false);
		expect(hitTestShape(shape, 105, 105, 0.2)).toBe(false);
	});

	it('the sized eraser removes a touched path whole and leaves no fragments', () => {
		const ref = { pageKey: 'pdf:0', index: 0, item: square() };
		expect(isErasable(ref.item)).toBe(true);
		const session = new SizedEraseSession(1);
		// Clip one corner only.
		expect(session.sample(100, 100, [ref])).toBe(true);
		let next = 0;
		const nextId = (): string => `f${String((next += 1))}`;
		expect(session.preview(nextId)).toEqual([]);
		const commit = session.commit(nextId);
		expect(commit.removed.map((r) => r.item.id)).toEqual(['p1']);
		expect(commit.added).toEqual([]);
	});

	it('the sized eraser leaves an untouched path alone', () => {
		const session = new SizedEraseSession(1);
		session.sample(200, 200, [{ pageKey: 'pdf:0', index: 0, item: square() }]);
		expect(session.isEmpty).toBe(true);
	});
});

describe('paginating paths', () => {
	it('moves and scales a path, and its outline width, with the page', () => {
		const wide: PathItem = {
			...square(),
			id: 'wide',
			d: 'M0 500L1224 500L1224 510L0 510Z',
			strokeWidth: 2,
		};
		const result = paginate([wide], { canvasWidth: 1224, columns: false });
		const page = result.pages[0];
		const mapped = page?.items[0];
		expect(mapped?.type).toBe('path');
		if (mapped?.type !== 'path' || !page) return;
		expect(mapped.strokeWidth).toBeCloseTo(2 * page.scale, 6);
		const bounds = pathBounds(mapped);
		expect(bounds?.minX).toBeGreaterThanOrEqual(36 - 0.01);
		expect(bounds?.maxX).toBeLessThanOrEqual(576 + 0.01);
	});
});

describe('simplifyPathCommands', () => {
	/** Distance from a point to the nearest edge of the flattened outline. */
	function distanceToOutline(x: number, y: number, rings: [number, number][][]): number {
		let best = Infinity;
		for (const ring of rings) {
			for (let i = 1; i < ring.length; i++) {
				const [ax = 0, ay = 0] = ring[i - 1] ?? [];
				const [bx = 0, by = 0] = ring[i] ?? [];
				const dx = bx - ax;
				const dy = by - ay;
				const t = dx === 0 && dy === 0 ? 0 : Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
				best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
			}
		}
		return best;
	}

	it('drops vertices that add nothing, and keeps corners', () => {
		const commands = parsePathData('M0 0L1 0.001L2 0L3 0.002L10 0L10 10L0 10Z') ?? [];
		expect(serializePathData(simplifyPathCommands(commands, 0.05))).toBe('M0 0L10 0L10 10L0 10Z');
	});

	it('keeps every original vertex within the tolerance of the result', () => {
		// A zig-zag traced densely around a circle, like an imported outline.
		const points: [number, number][] = [];
		for (let i = 0; i <= 400; i++) {
			const a = (i / 400) * Math.PI * 2;
			const wobble = i % 2 === 0 ? 0.01 : -0.01;
			points.push([50 + (20 + wobble) * Math.cos(a), 50 + (20 + wobble) * Math.sin(a)]);
		}
		const d = `M${points.map(([x, y]) => `${String(x)} ${String(y)}`).join('L')}Z`;
		const original = parsePathData(d) ?? [];
		const simplified = simplifyPathCommands(original, 0.1);
		expect(simplified.length).toBeLessThan(original.length / 4);
		const rings = flattenPath(simplified, 0.5);
		for (const [x, y] of points) expect(distanceToOutline(x, y, rings)).toBeLessThanOrEqual(0.1 + 1e-9);
	});

	it('keeps real curves exactly, and straightens only flat ones', () => {
		const commands = parsePathData('M0 0C0 10 10 10 10 0C11 0.01 12 -0.01 13 0L20 0Z') ?? [];
		const simplified = simplifyPathCommands(commands, 0.05);
		expect(simplified[1]).toEqual({ op: 'cubic', x1: 0, y1: 10, x2: 10, y2: 10, x: 10, y: 0 });
		expect(serializePathData(simplified)).toBe('M0 0C0 10 10 10 10 0L20 0Z');
	});

	it('changes nothing at tolerance 0 beyond exact duplicates in a line', () => {
		const commands = parsePathData('M0 0L1 1L2 3L0 0Z') ?? [];
		expect(simplifyPathCommands(commands, 0)).toEqual(commands);
	});
});
