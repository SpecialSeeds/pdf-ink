import { describe, expect, it } from 'vitest';
import {
	isNotebookLeftover,
	isSyncLeftover,
	isSidecarPath,
	parseInkData,
	serializeInkData,
	sidecarPathFor,
} from './ink-serialization';
import { InkStore } from './ink-store';
import { pdfPageKey } from './pages';
import {
	INK_DATA_VERSION,
	type InkData,
	type Stroke,
	isStroke,
} from './items';
import { DEFAULT_PEN, createStroke } from './stroke';

/** Narrow a parsed item to a stroke, so tests can read stroke-only fields. */
function strokeAt(data: InkData, page: number, index = 0): Stroke | undefined {
	const item = data.pages[pdfPageKey(page)]?.[index];
	return item && isStroke(item) ? item : undefined;
}

/** A version 1 stroke: no `type`, `rotation` or `z`. */
function v1Stroke(id = 'a'): Record<string, unknown> {
	return {
		id,
		tool: 'pen',
		color: '#111111',
		width: 2,
		opacity: 1,
		points: [
			[100, 200, 0.5],
			[110, 210, 0.7],
		],
	};
}

/** A version 2 stroke item: typed, but with no timestamps. */
function v2Stroke(id = 'a'): Record<string, unknown> {
	return { ...v1Stroke(id), type: 'stroke', rotation: 0, z: 0 };
}

/** A current-version stroke item. */
function validStroke(id = 'a'): Record<string, unknown> {
	return { ...v2Stroke(id), updatedAt: 1000 };
}

function v1Doc(pages: Record<string, unknown>): string {
	return JSON.stringify({ version: 1, pages });
}

function doc(pages: Record<string, unknown>, version: unknown = INK_DATA_VERSION): string {
	return JSON.stringify({ version, pages });
}

describe('sidecarPathFor', () => {
	it('sits beside the PDF and keeps the full filename', () => {
		expect(sidecarPathFor('notes/paper.pdf')).toBe('notes/paper.pdf.ink.json');
		expect(sidecarPathFor('paper.pdf')).toBe('paper.pdf.ink.json');
	});

	it('cannot collide between two files sharing a basename', () => {
		// Stripping the extension would map both of these to `a.ink.json`.
		expect(sidecarPathFor('a.pdf')).not.toBe(sidecarPathFor('a.png'));
	});

	it('handles names containing dots and spaces', () => {
		expect(sidecarPathFor('a/Due 8-27 (v1.2).pdf')).toBe(
			'a/Due 8-27 (v1.2).pdf.ink.json',
		);
	});

	it('recognises its own paths', () => {
		expect(isSidecarPath(sidecarPathFor('x.pdf'))).toBe(true);
		expect(isSidecarPath('x.pdf')).toBe(false);
	});
});

describe('schema version validation', () => {
	it('accepts the current version', () => {
		const result = parseInkData(doc({ '0': [validStroke()] }));
		expect(result.ok).toBe(true);
	});

	it('rejects a newer version and reports it', () => {
		const result = parseInkData(doc({}, 6));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('unsupported-version');
		expect(result.version).toBe(6);
	});

	it('rejects a version below the oldest it can migrate', () => {
		const result = parseInkData(doc({}, 0));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('unsupported-version');
	});

	it('reports version 5 as current, needing no migration', () => {
		const result = parseInkData(doc({ 'pdf:0': [validStroke()] }, 5));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.sourceVersion).toBe(5);
		expect(result.migrated).toBe(false);
	});

	it('migrates a version 4 file to version 5 with its items intact', () => {
		const stroke = validStroke();
		const result = parseInkData(
			JSON.stringify({
				version: 4,
				pages: { 'pdf:0': [stroke] },
				insertedPages: [],
				docId: 'doc-1',
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.sourceVersion).toBe(4);
		expect(result.migrated).toBe(true);
		expect(result.data.version).toBe(5);
		expect(result.data.docId).toBe('doc-1');
		expect(result.data.pages['pdf:0']).toEqual([
			expect.objectContaining({ id: stroke.id, type: 'stroke', points: stroke.points }),
		]);
		expect((JSON.parse(serializeInkData(result.data)) as { version: number }).version).toBe(5);
	});

	it('migrates a version 2 file', () => {
		const result = parseInkData(
			JSON.stringify({ version: 2, pages: { 'pdf:0': [v2Stroke()] } }),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.sourceVersion).toBe(2);
		expect(result.migrated).toBe(true);
		// Stamped with 0, so any real edit from another device beats it.
		expect(strokeAt(result.data, 0)?.updatedAt).toBe(0);
	});

	it('rejects a missing or non-numeric version', () => {
		// Built as literal JSON rather than through the helper, so an absent
		// version really is absent instead of picking up a default.
		const cases = [
			JSON.stringify({ pages: {} }),
			JSON.stringify({ version: null, pages: {} }),
			JSON.stringify({ version: '1', pages: {} }),
			JSON.stringify({ version: {}, pages: {} }),
			JSON.stringify({ version: [1], pages: {} }),
			// JSON.stringify turns a NaN version into null.
			JSON.stringify({ version: Number.NaN, pages: {} }),
		];
		for (const raw of cases) {
			const result = parseInkData(raw);
			expect(result.ok, raw).toBe(false);
			if (!result.ok) expect(result.reason).toBe('unsupported-version');
		}
	});

	it('still accepts version 1, which it migrates', () => {
		expect(parseInkData(JSON.stringify({ version: 1, pages: {} })).ok).toBe(true);
	});

	it('rejects malformed JSON without throwing', () => {
		for (const raw of ['', '{', 'not json', '[1,2,3]', 'null', '"a"']) {
			const result = parseInkData(raw);
			expect(result.ok).toBe(false);
		}
		expect(parseInkData('{').ok).toBe(false);
	});

	it('distinguishes bad JSON from a non-object document', () => {
		expect(parseInkData('nope')).toMatchObject({ reason: 'invalid-json' });
		expect(parseInkData('[]')).toMatchObject({ reason: 'not-an-object' });
	});
});

describe('stroke validation is lenient per stroke', () => {
	it('keeps good strokes and drops bad ones', () => {
		const result = parseInkData(
			doc({
				'0': [
					validStroke('good-1'),
					{ ...validStroke('no-tool'), tool: 'crayon' },
					{ ...validStroke('bad-width'), width: 0 },
					{ ...validStroke('bad-opacity'), opacity: 5 },
					{ ...validStroke('no-id'), id: '' },
					{ ...validStroke('no-points'), points: [] },
					'not an object',
					null,
					validStroke('good-2'),
				],
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.pages['pdf:0']?.map((s) => s.id)).toEqual(['good-1', 'good-2']);
		expect(result.dropped).toBe(7);
	});

	it('accepts highlighter as a tool', () => {
		const result = parseInkData(
			doc({ '0': [{ ...validStroke(), tool: 'highlighter' }] }),
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(strokeAt(result.data, 0)?.tool).toBe('highlighter');
	});

	it('drops non-numeric samples but keeps the rest of the stroke', () => {
		const result = parseInkData(
			doc({
				'0': [
					{
						...validStroke(),
						points: [[1, 2, 0.5], ['a', 2, 0.5], [3, null], [5, 6, 0.9]],
					},
				],
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(strokeAt(result.data, 0)?.points).toEqual([
			[1, 2, 0.5],
			[5, 6, 0.9],
		]);
	});

	it('supplies a default pressure when it is missing or zero', () => {
		const result = parseInkData(
			doc({ '0': [{ ...validStroke(), points: [[1, 2], [3, 4, 0]] }] }),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(strokeAt(result.data, 0)?.points).toEqual([
			[1, 2, 0.5],
			[3, 4, 0.5],
		]);
	});

	it('clamps pressure above 1', () => {
		const result = parseInkData(
			doc({ '0': [{ ...validStroke(), points: [[1, 2, 9]] }] }),
		);
		if (result.ok) expect(strokeAt(result.data, 0)?.points[0]?.[2]).toBe(1);
	});

	it('drops pages whose key names no page at all', () => {
		const result = parseInkData(
			doc({
				'0': [validStroke('keep')],
				'-1': [validStroke('neg')],
				'x': [validStroke('nan')],
				'1.5': [validStroke('frac')],
				'pdf:': [validStroke('bare')],
				'ins:': [validStroke('anon')],
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// The bare index is a pre-v4 key and migrates; the rest name nothing.
		expect(Object.keys(result.data.pages)).toEqual(['pdf:0']);
		expect(result.dropped).toBe(5);
	});

	it('tolerates a missing or malformed pages field', () => {
		for (const pages of [undefined, null, 'x', 42, []]) {
			const result = parseInkData(JSON.stringify({ version: 1, pages }));
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.data.pages).toEqual({});
		}
	});
});

describe('serialize / parse round-trip', () => {
	it('survives a full round-trip through the store', () => {
		const store = new InkStore();
		const pen = createStroke(DEFAULT_PEN, 'p1');
		pen.points.push([53.18, 702.28, 0.4], [120.5, 650.25, 0.85]);
		store.add('pdf:0', pen);
		const high = createStroke(
			{ tool: 'highlighter', color: '#ffee00', width: 12, opacity: 0.4 },
			'h1',
		);
		high.points.push([10, 20, 1]);
		store.add('pdf:3', high);

		const written = serializeInkData(store.toData());
		const result = parseInkData(written);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toEqual(store.toData());
		expect(result.dropped).toBe(0);

		// And loading it back reproduces the same store.
		const reloaded = new InkStore();
		reloaded.load(result.data);
		expect(reloaded.toData()).toEqual(store.toData());
	});

	it('keeps stroke points to a hundredth of a point', () => {
		const store = new InkStore();
		const stroke = createStroke(DEFAULT_PEN, 'p');
		stroke.points.push([53.183456, 702.284321, 0.123456]);
		store.add('pdf:0', stroke);
		const result = parseInkData(serializeInkData(store.toData()));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(strokeAt(result.data, 0)?.points[0]).toEqual([53.18, 702.28, 0.12]);
	});

	it('writes compact JSON, one line plus a newline', () => {
		const store = new InkStore();
		const stroke = createStroke(DEFAULT_PEN, 'p');
		stroke.points.push([1, 2, 1], [3, 4, 1]);
		store.add('pdf:0', stroke);
		const text = serializeInkData(store.toData());
		expect(text.trimEnd()).not.toContain('\n');
		expect(text).not.toContain('\t');
	});

	it('leaves everything but stroke points untouched', () => {
		const store = new InkStore();
		const stroke = createStroke({ ...DEFAULT_PEN, width: 1.23456 }, 'p');
		stroke.points.push([1, 2, 1]);
		store.add('pdf:0', stroke);
		const result = parseInkData(serializeInkData(store.toData()));
		expect(result.ok && strokeAt(result.data, 0)?.width).toBe(1.23456);
	});

	it('writes a trailing newline and declares its version', () => {
		const data: InkData = {
			version: INK_DATA_VERSION,
			pages: {},
			insertedPages: [],
		};
		const text = serializeInkData(data);
		expect(text.endsWith('\n')).toBe(true);
		expect(JSON.parse(text)).toEqual({
			version: 5,
			pages: {},
			insertedPages: [],
		});
	});

	it('an empty store round-trips to an empty document', () => {
		const result = parseInkData(serializeInkData(new InkStore().toData()));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data.pages).toEqual({});
	});
});

describe('InkStore.load', () => {
	it('replaces existing strokes rather than merging', () => {
		const store = new InkStore();
		store.add('pdf:0', createStroke(DEFAULT_PEN, 'old'));
		const stroke = createStroke(DEFAULT_PEN, 'new');
		stroke.points.push([1, 2, 0.5]);
		store.load({ version: 1, pages: { 'pdf:5': [stroke] }, insertedPages: [] });
		expect(store.itemsFor('pdf:0')).toEqual([]);
		expect(store.itemsFor('pdf:5').map((s) => s.id)).toEqual(['new']);
	});

	it('bumps the revision so a renderer invalidates its cache', () => {
		const store = new InkStore();
		const before = store.version;
		store.load({ version: 1, pages: {}, insertedPages: [] });
		expect(store.version).toBeGreaterThan(before);
	});
});

describe('v1 to v2 migration', () => {
	it('turns a v1 stroke into an item of type "stroke"', () => {
		const result = parseInkData(v1Doc({ '0': [v1Stroke('a')] }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.sourceVersion).toBe(1);
		expect(result.migrated).toBe(true);
		expect(result.data.version).toBe(INK_DATA_VERSION);

		const stroke = strokeAt(result.data, 0);
		expect(stroke).toBeDefined();
		if (!stroke) return;
		expect(stroke.type).toBe('stroke');
	});

	it('preserves every v1 field exactly', () => {
		const original = v1Stroke('keep-me');
		const result = parseInkData(v1Doc({ '4': [original] }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const stroke = strokeAt(result.data, 4);
		expect(stroke).toBeDefined();
		if (!stroke) return;
		expect(stroke.id).toBe('keep-me');
		expect(stroke.tool).toBe('pen');
		expect(stroke.color).toBe('#111111');
		expect(stroke.width).toBe(2);
		expect(stroke.opacity).toBe(1);
		expect(stroke.points).toEqual([
			[100, 200, 0.5],
			[110, 210, 0.7],
		]);
	});

	it('fills in the fields v1 did not have', () => {
		const result = parseInkData(v1Doc({ '0': [v1Stroke()] }));
		if (!result.ok) return;
		const stroke = strokeAt(result.data, 0);
		if (!stroke) return;
		// Strokes are baked into PDF space, so they are never separately rotated.
		expect(stroke.rotation).toBe(0);
		expect(stroke.z).toBe(0);
	});

	it('derives z from array order, so the page looks unchanged', () => {
		const result = parseInkData(
			v1Doc({ '0': [v1Stroke('a'), v1Stroke('b'), v1Stroke('c')] }),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const items = result.data.pages['pdf:0'] ?? [];
		expect(items.map((item) => [item.id, item.z])).toEqual([
			['a', 0],
			['b', 1],
			['c', 2],
		]);
	});

	it('migrates a highlighter stroke, keeping its tool and opacity', () => {
		const highlighter = {
			...v1Stroke('h'),
			tool: 'highlighter',
			opacity: 0.35,
			width: 16,
		};
		const result = parseInkData(v1Doc({ '0': [highlighter] }));
		if (!result.ok) return;
		const stroke = strokeAt(result.data, 0);
		expect(stroke?.tool).toBe('highlighter');
		expect(stroke?.opacity).toBe(0.35);
		expect(stroke?.width).toBe(16);
	});

	it('migrates every page independently, with per-page z', () => {
		const result = parseInkData(
			v1Doc({ '0': [v1Stroke('a'), v1Stroke('b')], '7': [v1Stroke('c')] }),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.pages['pdf:0']?.map((i) => i.z)).toEqual([0, 1]);
		// z restarts per page, because paint order is per page.
		expect(result.data.pages['pdf:7']?.map((i) => i.z)).toEqual([0]);
	});

	it('drops malformed v1 strokes but keeps the good ones', () => {
		const result = parseInkData(
			v1Doc({
				'0': [
					v1Stroke('good'),
					{ ...v1Stroke('bad-tool'), tool: 'crayon' },
					{ ...v1Stroke('no-points'), points: [] },
					null,
				],
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.pages['pdf:0']?.map((i) => i.id)).toEqual(['good']);
		expect(result.dropped).toBe(3);
		// z follows the original array position, not the surviving count.
		expect(result.data.pages['pdf:0']?.[0]?.z).toBe(0);
	});

	it('a v1 file with no strokes migrates to an empty v2 document', () => {
		const result = parseInkData(v1Doc({}));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.migrated).toBe(true);
		expect(result.data.pages).toEqual({});
	});

	it('a v1 stroke carrying stray v2 fields ignores them', () => {
		// v1 never wrote a z, so a file claiming version 1 must not be trusted to
		// have a meaningful one: array order is the only ordering v1 had.
		const result = parseInkData(
			v1Doc({ '0': [{ ...v1Stroke('a'), z: 99, type: 'shape' }] }),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const stroke = strokeAt(result.data, 0);
		expect(stroke?.type).toBe('stroke');
		expect(stroke?.z).toBe(0);
	});

	it('the migrated result re-serialises as valid v2 and is then stable', () => {
		const first = parseInkData(v1Doc({ '0': [v1Stroke('a'), v1Stroke('b')] }));
		expect(first.ok).toBe(true);
		if (!first.ok) return;

		const second = parseInkData(serializeInkData(first.data));
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		// Reading the upgraded file needs no further migration.
		expect(second.migrated).toBe(false);
		expect(second.sourceVersion).toBe(INK_DATA_VERSION);
		expect(second.data).toEqual(first.data);
	});
});

describe('removed shape kinds migrate rather than vanish', () => {
	function shapeDoc(kind: string): string {
		return JSON.stringify({
			version: 2,
			pages: {
				'pdf:0': [
					{
						type: 'shape',
						id: 'sh',
						color: '#111',
						opacity: 1,
						rotation: 0,
						z: 0,
						updatedAt: 0,
						kind,
						box: { x: 0, y: 0, w: 100, h: 100 },
						width: 2,
						fill: null,
					},
				],
			},
		});
	}

	it('turns the removed axes3d_q into the centred variant', () => {
		const result = parseInkData(shapeDoc('axes3d_q'));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const item = result.data.pages['pdf:0']?.[0];
		expect(item?.type).toBe('shape');
		if (!item || item.type !== 'shape') return;
		expect(item.kind).toBe('axes3d_c');
		// Migrated, not dropped.
		expect(result.dropped).toBe(0);
	});

	it('still keeps the shape kinds that remain', () => {
		for (const kind of ['line', 'arrow', 'rect', 'ellipse', 'triangle', 'axes2d_q', 'axes2d_c', 'axes3d_c']) {
			const result = parseInkData(shapeDoc(kind));
			expect(result.ok, kind).toBe(true);
			if (!result.ok) continue;
			const item = result.data.pages['pdf:0']?.[0];
			if (!item || item.type !== 'shape') continue;
			expect(item.kind, kind).toBe(kind);
		}
	});

	it('still drops a kind it has never heard of', () => {
		const result = parseInkData(shapeDoc('hexagon'));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.pages['pdf:0']).toBeUndefined();
		expect(result.dropped).toBe(1);
	});
});

describe('v3 to v4 migration', () => {
	/** A v3 sidecar: numeric page keys, timestamped items, no page records. */
	function v3Doc(pages: Record<string, unknown>): string {
		return JSON.stringify({ version: 3, pages });
	}

	it('files items under pdf:<n> instead of the bare index', () => {
		const result = parseInkData(
			v3Doc({ '0': [validStroke('a')], '7': [validStroke('b')] }),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(Object.keys(result.data.pages).sort()).toEqual(['pdf:0', 'pdf:7']);
		expect(result.sourceVersion).toBe(3);
		expect(result.migrated).toBe(true);
	});

	it('keeps the timestamps a v3 file already had', () => {
		// Unlike a v1 or v2 item, a v3 item has a real updatedAt and must not be
		// stamped back to 0 — that would make it lose every merge.
		const result = parseInkData(
			v3Doc({ '2': [{ ...validStroke('a'), updatedAt: 12_345 }] }),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(strokeAt(result.data, 2)?.updatedAt).toBe(12_345);
	});

	it('carries tombstones across the migration', () => {
		const result = parseInkData(
			v3Doc({
				'0': [{ ...validStroke('gone'), updatedAt: 900, deletedAt: 900 }],
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.pages['pdf:0']?.[0]?.deletedAt).toBe(900);
	});

	it('gives a v3 file an empty page-record list', () => {
		const result = parseInkData(v3Doc({ '0': [validStroke()] }));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data.insertedPages).toEqual([]);
	});

	it('migrates every page independently', () => {
		const pages: Record<string, unknown> = {};
		for (let i = 0; i < 20; i++) pages[String(i)] = [validStroke(`s${String(i)}`)];
		const result = parseInkData(v3Doc(pages));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(Object.keys(result.data.pages)).toHaveLength(20);
		expect(result.data.pages['pdf:19']?.[0]?.id).toBe('s19');
	});

	it('is idempotent: re-parsing the migrated file changes nothing', () => {
		const once = parseInkData(v3Doc({ '3': [validStroke('a')] }));
		expect(once.ok).toBe(true);
		if (!once.ok) return;
		const twice = parseInkData(serializeInkData(once.data));
		expect(twice.ok).toBe(true);
		if (!twice.ok) return;
		expect(twice.data).toEqual(once.data);
		expect(twice.migrated).toBe(false);
	});
});

describe('inserted page records', () => {
	const A4 = { width: 595.28, height: 841.89 };

	function withPages(insertedPages: unknown[], pages = {}): string {
		return JSON.stringify({ version: 4, pages, insertedPages });
	}

	const validPage = (over: Record<string, unknown> = {}) => ({
		id: 'p1',
		afterPdfPage: 2,
		sortKey: 'a1',
		template: 'grid5',
		size: A4,
		updatedAt: 5000,
		...over,
	});

	it('round-trips a page record', () => {
		const result = parseInkData(withPages([validPage()]));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.insertedPages).toEqual([
			{
				id: 'p1',
				afterPdfPage: 2,
				sortKey: 'a1',
				template: 'grid5',
				size: A4,
				updatedAt: 5000,
			},
		]);
	});

	it('keeps a tombstoned page', () => {
		const result = parseInkData(
			withPages([validPage({ deletedAt: 9000, updatedAt: 9000 })]),
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data.insertedPages[0]?.deletedAt).toBe(9000);
		}
	});

	it('drops a record with no id, since the id is the merge key', () => {
		const result = parseInkData(
			withPages([validPage({ id: '' }), validPage({ id: undefined })]),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.insertedPages).toEqual([]);
		expect(result.dropped).toBe(2);
	});

	it('repairs a bad template rather than losing the page', () => {
		// The page still holds annotations. Blank ruling is a far smaller loss.
		const result = parseInkData(withPages([validPage({ template: 'plaid' })]));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data.insertedPages[0]?.template).toBe('blank');
	});

	it('repairs a bad size rather than losing the page', () => {
		for (const size of [undefined, null, {}, { width: 0, height: 10 }, 'big']) {
			const result = parseInkData(withPages([validPage({ size })]));
			expect(result.ok).toBe(true);
			if (!result.ok) continue;
			expect(result.data.insertedPages[0]?.size).toEqual({
				width: 612,
				height: 792,
			});
		}
	});

	it('repairs a sort key that would break the next insertion', () => {
		// keyBetween validates its bounds, so an unusable key left in place would
		// make inserting next to this page throw rather than misplace it.
		for (const sortKey of ['', 'a1V0', '!!', 42, undefined]) {
			const result = parseInkData(withPages([validPage({ sortKey })]));
			expect(result.ok).toBe(true);
			if (!result.ok) continue;
			expect(result.data.insertedPages[0]?.sortKey).toBe('a0');
		}
	});

	it('clamps a gap below the first page', () => {
		const result = parseInkData(withPages([validPage({ afterPdfPage: -9 })]));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data.insertedPages[0]?.afterPdfPage).toBe(-1);
	});

	it('truncates a fractional gap', () => {
		const result = parseInkData(withPages([validPage({ afterPdfPage: 2.7 })]));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data.insertedPages[0]?.afterPdfPage).toBe(2);
	});

	it('ignores a page list that is not a list', () => {
		for (const insertedPages of ['nope', 5, { id: 'p1' }, null]) {
			const result = parseInkData(
				JSON.stringify({ version: 4, pages: {}, insertedPages }),
			);
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.data.insertedPages).toEqual([]);
		}
	});

	it('reads items filed under an inserted page key', () => {
		const result = parseInkData(
			withPages([validPage()], { 'ins:p1': [validStroke('on-insert')] }),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.pages['ins:p1']?.[0]?.id).toBe('on-insert');
	});

	it('survives a full round-trip through serialize', () => {
		const first = parseInkData(
			withPages([validPage(), validPage({ id: 'p2', sortKey: 'a2' })], {
				'ins:p1': [validStroke('a')],
			}),
		);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const second = parseInkData(serializeInkData(first.data));
		expect(second.ok).toBe(true);
		if (second.ok) expect(second.data).toEqual(first.data);
	});
});

describe('isSyncLeftover', () => {
	const sidecar = 'Worksheets/Wkst 9-28.pdf.ink.json';

	it('recognises the copies iCloud Drive leaves behind', () => {
		for (const name of [
			'Worksheets/Wkst 9-28.pdf.ink 2.json',
			'Worksheets/Wkst 9-28.pdf.ink.json 3.bak',
			'Worksheets/Wkst 9-28.pdf.ink.json 2.bak',
			'Worksheets/Wkst 9-28.pdf.ink.json 4.json',
			'Worksheets/Wkst 9-28.pdf.ink.json.json',
			'Worksheets/Wkst 9-28.pdf.ink.json 2.tmp',
		]) {
			expect(isSyncLeftover(sidecar, name), name).toBe(true);
		}
	});

	it('never matches the live sidecar, its backup or its temp file', () => {
		for (const name of [
			sidecar,
			`${sidecar}.bak`,
			`${sidecar}.tmp`,
		]) {
			expect(isSyncLeftover(sidecar, name), name).toBe(false);
		}
	});

	it('leaves other files alone', () => {
		for (const name of [
			'Worksheets/Wkst 9-28.pdf',
			'Worksheets/Wkst 9-28 2.pdf',
			'Worksheets/Wkst 9-28.pdf.ink.json.notes.json',
			'Worksheets/other.pdf.ink 2.json',
			'Worksheets/Wkst 9-28.pdf.ink 2.json/inside.json',
		]) {
			expect(isSyncLeftover(sidecar, name), name).toBe(false);
		}
	});

	it('is not fooled by a PDF whose own name ends in a number', () => {
		const numbered = 'Worksheets/Homework_5_split 3.pdf.ink.json';
		expect(isSyncLeftover(numbered, numbered)).toBe(false);
		expect(
			isSyncLeftover(numbered, 'Worksheets/Homework_5_split 3.pdf.ink 2.json'),
		).toBe(true);
		// The sidecar of a different PDF, "Homework_5_split.pdf", is not ours.
		expect(
			isSyncLeftover(
				'Worksheets/Homework_5_split.pdf.ink.json',
				'Worksheets/Homework_5_split 3.pdf.ink.json',
			),
		).toBe(false);
	});
});

describe('isNotebookLeftover', () => {
	const notebook = 'Class/Notes.inknote';

	it('recognises conflict copies and numbered backups', () => {
		for (const name of [
			'Class/Notes (conflict).inknote',
			'Class/Notes (Conflict 2026-10-03 12.00.00).inknote',
			'Class/Notes.inknote (conflict)',
			'Class/Notes.inknote 2.bak',
			'Class/Notes.inknote 3.tmp',
		]) {
			expect(isNotebookLeftover(notebook, name), name).toBe(true);
		}
	});

	it('never matches the notebook, its backup or its temp file', () => {
		for (const name of [notebook, `${notebook}.bak`, `${notebook}.tmp`]) {
			expect(isNotebookLeftover(notebook, name), name).toBe(false);
		}
	});

	it('leaves notebooks the user named alike alone', () => {
		for (const name of [
			'Class/Notes 2.inknote',
			'Class/Notes on conflict.inknote',
			'Class/Notes.pdf.ink.json',
			'Class/Notes (conflict).inknote/inside.inknote',
			'Other/Notes (conflict).inknote',
		]) {
			expect(isNotebookLeftover(notebook, name), name).toBe(false);
		}
	});
});
