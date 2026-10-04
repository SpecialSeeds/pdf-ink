import { describe, expect, it } from 'vitest';
import {
	STUB_PATH,
	compactBaseTombstones,
	decodeBase,
	encodeBase,
	layerItems,
	layerPages,
	packBase,
	unpackBase,
} from './base-layer';
import { InkStore } from './ink-store';
import { INK_DATA_VERSION, type Item, type PathItem } from './items';

function path(id: string, x = 0, over: Partial<PathItem> = {}): PathItem {
	return {
		type: 'path',
		id,
		color: '#000000',
		opacity: 1,
		rotation: 0,
		z: 0,
		updatedAt: 1,
		d: `M${String(x)} 0L${String(x + 10)} 0L${String(x + 10)} 10Z`,
		...over,
	};
}

describe('base files', () => {
	it('round-trip through gzip, checked by hash', async () => {
		const pages = { 'ins:a': [path('p1'), path('p2', 20)] };
		const { bytes, ref } = await packBase(pages);
		expect(bytes[0]).toBe(0x1f);
		expect(bytes[1]).toBe(0x8b);
		const unpacked = await unpackBase(bytes, ref);
		expect(unpacked).toEqual({ ok: true, pages });
	});

	it('refuse bytes whose hash is not the one named', async () => {
		const { bytes } = await packBase({ 'ins:a': [path('p1')] });
		const other = await packBase({ 'ins:a': [path('p2')] });
		expect(await unpackBase(bytes, other.ref)).toEqual({ ok: false, reason: 'hash-mismatch' });
	});

	it('refuse text that is not a base file, and drop records that do not validate', () => {
		expect(decodeBase('{"format":"something else","version":1,"pages":{}}')).toBeNull();
		expect(decodeBase('not json')).toBeNull();
		const text = encodeBase({ 'ins:a': [path('ok'), { ...path('bad'), d: 'q1 2' }] });
		expect(decodeBase(text)?.['ins:a']?.map((i) => i.id)).toEqual(['ok']);
	});
});

describe('layering', () => {
	it('lets a user record replace the base item with its id, whatever the timestamps', () => {
		const base = [path('a'), path('b', 20)];
		const edited = path('a', 50, { updatedAt: 0 });
		expect(layerItems(base, [edited]).map((i) => [i.id, i.type === 'path' && i.d])).toEqual([
			['b', base[1]?.d],
			['a', edited.d],
		]);
		expect(layerPages({ 'ins:x': base }, { 'ins:y': [path('c')] })).toEqual({
			'ins:x': base,
			'ins:y': [path('c')],
		});
	});

	it('writes a tombstone over a base path without its outline', () => {
		const dead = path('a', 0, { deletedAt: 5 });
		const out = compactBaseTombstones({ 'ins:x': [dead, path('mine')] }, (id) => id === 'a');
		expect(out['ins:x']?.[0]).toEqual({ ...dead, d: STUB_PATH });
		expect(out['ins:x']?.[1]).toEqual(path('mine'));
	});
});

describe('InkStore with a base layer', () => {
	function store(): InkStore {
		const ink = new InkStore(() => 100);
		ink.load({ version: INK_DATA_VERSION, pages: {}, insertedPages: [] });
		ink.setBase({ 'ins:x': [path('a'), path('b', 20)] });
		return ink;
	}

	it('shows both layers and serialises only the user layer', () => {
		const ink = store();
		ink.add('ins:x', path('mine', 40));
		expect(ink.itemsFor('ins:x').map((i) => i.id)).toEqual(['a', 'b', 'mine']);
		expect(ink.toData().pages['ins:x']?.map((i) => i.id)).toEqual(['mine']);
		expect(ink.pageKeys()).toEqual(['ins:x']);
	});

	it('copies an edited base item into the user layer under the same id', () => {
		const ink = store();
		expect(ink.replaceById('ins:x', path('a', 70))).toBe(true);
		const shown = ink.itemsFor('ins:x').find((i) => i.id === 'a');
		expect(shown?.type === 'path' && shown.d).toBe(path('a', 70).d);
		expect(ink.toData().pages['ins:x']?.map((i) => i.id)).toEqual(['a']);
	});

	it('tombstones a removed base item in the user layer, and revives it on undo', () => {
		const ink = store();
		expect(ink.removeById('ins:x', 'a')).toBeGreaterThanOrEqual(0);
		expect(ink.itemsFor('ins:x').map((i) => i.id)).toEqual(['b']);
		const records: Item[] = [...(ink.toData().pages['ins:x'] ?? [])];
		expect(records.map((i) => [i.id, i.deletedAt])).toEqual([['a', 100]]);
		ink.insertAt('ins:x', 0, path('a'));
		expect(ink.itemsFor('ins:x').map((i) => i.id).sort()).toEqual(['a', 'b']);
	});

	it('keeps the base when the user layer is reloaded, as a merge does', () => {
		const ink = store();
		ink.load({ version: INK_DATA_VERSION, pages: { 'ins:x': [path('c', 90)] }, insertedPages: [] });
		expect(ink.itemsFor('ins:x').map((i) => i.id)).toEqual(['a', 'b', 'c']);
		expect(ink.isBaseItem('a')).toBe(true);
		expect(ink.isBaseItem('c')).toBe(false);
	});
});
