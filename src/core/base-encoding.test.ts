import { describe, expect, it } from 'vitest';
import { UNITS_PER_POINT, isPackedPath, packPath, unpackPath } from './base-encoding';
import { BASE_FORMAT, decodeBase, encodeBase } from './base-layer';
import type { PathItem } from './items';
import { parsePathData } from './path';

function path(d: string, over: Partial<PathItem> = {}): PathItem {
	return {
		type: 'path',
		id: 'p',
		color: '#e71225',
		opacity: 0.5,
		rotation: 0,
		z: 3,
		updatedAt: 7,
		d,
		...over,
	};
}

/** Every coordinate of path data, in order. */
function numbers(d: string): number[] {
	return (parsePathData(d) ?? []).flatMap((c) =>
		c.op === 'close' ? [] : c.op === 'cubic' ? [c.x1, c.y1, c.x2, c.y2, c.x, c.y] : [c.x, c.y],
	);
}

describe('packed paths', () => {
	it('store commands as letters and coordinates as deltas in tenths of a point', () => {
		const packed = packPath(path('M10 20L10.5 20.3C11 21 12 22 13 23Z'));
		expect(packed.o).toBe('MLCZ');
		expect(packed.n).toEqual([100, 200, 5, 3, 5, 7, 10, 10, 10, 10]);
		expect('d' in packed).toBe(false);
		expect(packed).toMatchObject({ id: 'p', color: '#e71225', opacity: 0.5, z: 3, updatedAt: 7 });
		expect(isPackedPath(packed)).toBe(true);
	});

	it('round-trip to within half a tenth of a point, without drift', () => {
		// A long wiggle, so any error carried from one delta to the next would grow.
		const points: string[] = [];
		for (let i = 0; i < 2000; i++) points.push(`${String(1000 + i * 0.137)} ${String(500 + Math.sin(i / 7) * 23.456)}`);
		const original = path(`M${points.join('L')}Z`);
		const back = unpackPath(packPath(original));
		if (!back) throw new Error('did not unpack');
		const a = numbers(original.d);
		const b = numbers(back.d);
		expect(b).toHaveLength(a.length);
		a.forEach((v, i) => {
			expect(Math.abs(v - (b[i] ?? NaN))).toBeLessThanOrEqual(0.5 / UNITS_PER_POINT + 1e-9);
		});
	});

	it('refuse letters and numbers that disagree', () => {
		const packed = packPath(path('M1 2L3 4Z'));
		expect(unpackPath({ ...packed, n: packed.n.slice(0, 3) })).toBeNull();
		expect(unpackPath({ ...packed, n: [...packed.n, 1, 1] })).toBeNull();
		expect(unpackPath({ ...packed, o: 'MQZ' })).toBeNull();
		expect(unpackPath({ ...packed, n: [1.5, 2, 3, 4] })).toBeNull();
	});
});

describe('base files with packed paths', () => {
	it('pack every path, and read back as path data', () => {
		const items = [path('M0 0L10 0L10 10Z', { id: 'a', strokeWidth: 2, highlight: true })];
		const text = encodeBase({ 'ins:x': items });
		expect(text).not.toContain('"d"');
		expect(decodeBase(text)).toEqual({ 'ins:x': items });
	});

	it('still read a version 1 file, whose paths are path data', () => {
		const items = [path('M0 0L10 0L10 10Z')];
		expect(decodeBase(JSON.stringify({ format: BASE_FORMAT, version: 1, pages: { 'ins:x': items } }))).toEqual({
			'ins:x': items,
		});
	});

	it('drop a packed path that does not unpack, and keep the rest', () => {
		const good = packPath(path('M0 0L1 1Z', { id: 'good' }));
		const bad = { ...packPath(path('M0 0L1 1Z', { id: 'bad' })), o: 'MX' };
		const text = JSON.stringify({ format: BASE_FORMAT, version: 2, pages: { 'ins:x': [good, bad] } });
		expect(decodeBase(text)?.['ins:x']?.map((i) => i.id)).toEqual(['good']);
	});
});
