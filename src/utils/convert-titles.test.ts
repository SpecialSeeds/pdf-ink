import type { App, TFile, TFolder } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { basePathFor, packBase } from '../core/base-layer';
import { parseInkData, serializeInkData } from '../core/ink-serialization';
import { type InkData, INK_DATA_VERSION, type Item, type TextItem } from '../core/items';
import { insertedPageKey } from '../core/pages';
import { SKIP_REASONS, convertTitleToHeader } from '../core/title-migration';
import { applyTitleConversions, planTitleConversions } from './convert-titles';

const PAGE = insertedPageKey('p1');
const OCT_3_2026_1402 = new Date(2026, 9, 3, 14, 2).getTime();

function text(id: string, value: string, x: number, top: number, fontSize: number): TextItem {
	return {
		type: 'text',
		id,
		color: '#000000',
		opacity: 1,
		rotation: 0,
		z: 0,
		updatedAt: 1,
		box: { x, y: top - fontSize * 1.2, w: 300, h: fontSize * 1.2 },
		text: value,
		fontSize,
	};
}

/** OneNote's title and date as text boxes at the top of a Letter page. */
function titleItems(title: string): Item[] {
	return [
		text('t', title, 36, 777, 20),
		text('d', 'Saturday, October 3, 2026', 36, 748, 10),
		text('h', '2:02 PM', 165, 748, 10),
		text('body', 'Proportionality', 36, 600, 14),
	];
}

function notebook(pages: Record<string, Item[]> = {}): InkData {
	return {
		version: INK_DATA_VERSION,
		pages,
		insertedPages: [
			{ id: 'p1', afterPdfPage: -1, sortKey: 'a0', template: 'blank', size: { width: 612, height: 792 }, updatedAt: 1 },
		],
		docId: 'doc',
	};
}

describe('convertTitleToHeader', () => {
	it('replaces title text in the notebook itself with a header', () => {
		const conversion = convertTitleToHeader(notebook({ [PAGE]: titleItems('Week 2') }), undefined, 'Week 2', 99);
		expect(conversion?.createdAt).toBe(OCT_3_2026_1402);
		expect(conversion?.removed).toBe(3);
		expect(conversion?.data.header).toEqual({ createdAt: OCT_3_2026_1402 });
		const items = conversion?.data.pages[PAGE] ?? [];
		expect(items.filter((i) => i.deletedAt === undefined).map((i) => i.id)).toEqual(['body']);
	});

	it('hides title text in the base layer with tombstones, leaving the base alone', () => {
		const base = { [PAGE]: titleItems('Week 2') };
		const conversion = convertTitleToHeader(notebook(), base, 'Week 2', 99);
		const records = conversion?.data.pages[PAGE] ?? [];
		expect(records.map((i) => [i.id, i.deletedAt])).toEqual([
			['t', 99],
			['d', 99],
			['h', 99],
		]);
		expect(base[PAGE]).toHaveLength(4);
	});

	it('leaves a notebook without its title, or with a header already, alone', () => {
		expect(convertTitleToHeader(notebook({ [PAGE]: titleItems('Week 2') }), undefined, 'Week 3', 99)).toBeNull();
		const headed = { ...notebook({ [PAGE]: titleItems('Week 2') }), header: { createdAt: 5 } };
		expect(convertTitleToHeader(headed, undefined, 'Week 2', 99)).toBeNull();
	});
});

/** Text and binary files by path, recording every write. */
class FakeVault {
	readonly text = new Map<string, string>();
	readonly binary = new Map<string, Uint8Array>();
	readonly writes: string[] = [];

	file(path: string): TFile {
		const name = path.slice(path.lastIndexOf('/') + 1);
		return { path, name, basename: name.replace(/\.[^.]+$/, ''), extension: name.split('.').pop() ?? '' } as TFile;
	}
	getFiles(): TFile[] {
		return [...this.text.keys(), ...this.binary.keys()].map((path) => this.file(path));
	}
	getFileByPath(path: string): TFile | null {
		return this.text.has(path) || this.binary.has(path) ? this.file(path) : null;
	}
	read(file: TFile): Promise<string> {
		return Promise.resolve(this.text.get(file.path) ?? '');
	}
	readBinary(file: TFile): Promise<ArrayBuffer> {
		const bytes = this.binary.get(file.path);
		return bytes ? Promise.resolve(bytes.slice().buffer) : Promise.reject(new Error('missing'));
	}
	process(file: TFile, fn: (data: string) => string): Promise<string> {
		const next = fn(this.text.get(file.path) ?? '');
		this.text.set(file.path, next);
		this.writes.push(file.path);
		return Promise.resolve(next);
	}
}

const folder = { path: 'class', isRoot: () => false } as unknown as TFolder;

async function vaultWithNotes(): Promise<FakeVault> {
	const vault = new FakeVault();
	// An imported notebook: its title text is in the base layer.
	const { bytes, ref } = await packBase({ [PAGE]: titleItems('Week 2') });
	vault.binary.set(basePathFor('class/Week 2.inknote'), bytes);
	vault.text.set('class/Week 2.inknote', serializeInkData({ ...notebook(), base: ref }));
	// One whose title is in the notebook itself, in a subfolder.
	vault.text.set('class/old/Week 1.inknote', serializeInkData(notebook({ [PAGE]: titleItems('Week 1') })));
	// One that opens with something else.
	vault.text.set('class/Scratch.inknote', serializeInkData(notebook({ [PAGE]: titleItems('Week 9') })));
	// Out of the chosen folder.
	vault.text.set('other/Week 4.inknote', serializeInkData(notebook({ [PAGE]: titleItems('Week 4') })));
	return vault;
}

describe('the conversion command', () => {
	it('lists the matches in a dry run, without writing anything', async () => {
		const vault = await vaultWithNotes();
		const before = new Map(vault.text);
		const plan = await planTitleConversions({ vault } as unknown as App, folder);
		expect(plan.matches.map((m) => [m.file.path, m.createdAt, m.removed])).toEqual([
			['class/old/Week 1.inknote', OCT_3_2026_1402, 3],
			['class/Week 2.inknote', OCT_3_2026_1402, 3],
		]);
		expect(plan.skipped.map((s) => [s.file.path, s.reason])).toEqual([['class/Scratch.inknote', 'title-mismatch']]);
		expect(plan.unreadable).toEqual([]);
		expect(vault.writes).toEqual([]);
		expect(vault.text).toEqual(before);
	});

	it('lists the notebooks it checked but would not convert, with the reason', async () => {
		const vault = new FakeVault();
		const [title, date, time, body] = titleItems('Week 5');
		if (!title || !date || !time || !body) throw new Error('unreachable');
		vault.text.set('class/Blank.inknote', serializeInkData(notebook()));
		vault.text.set('class/Sketch.inknote', serializeInkData(notebook({ [PAGE]: [body] })));
		vault.text.set('class/Renamed.inknote', serializeInkData(notebook({ [PAGE]: titleItems('Week 5') })));
		vault.text.set('class/Week 5.inknote', serializeInkData(notebook({ [PAGE]: [title, body] })));
		vault.text.set(
			'class/Headed.inknote',
			serializeInkData({ ...notebook({ [PAGE]: titleItems('Headed') }), header: { createdAt: 1 } }),
		);
		vault.text.set('class/Week 6.inknote', serializeInkData(notebook({ [PAGE]: titleItems('Week 6') })));

		const plan = await planTitleConversions({ vault } as unknown as App, folder);
		expect(plan.matches.map((m) => m.file.path)).toEqual(['class/Week 6.inknote']);
		expect(plan.skipped.map((s) => [s.file.path, s.reason, SKIP_REASONS[s.reason]])).toEqual([
			['class/Blank.inknote', 'no-title-text', 'no title text at the top of page 1'],
			['class/Headed.inknote', 'has-header', 'it has a header already'],
			['class/Renamed.inknote', 'title-mismatch', "the title doesn't match the file name"],
			// Its topmost text is the body, far below where a title would be.
			['class/Sketch.inknote', 'no-title-text', 'no title text at the top of page 1'],
			['class/Week 5.inknote', 'no-date-line', 'no date line under the title'],
		]);
		expect(vault.writes).toEqual([]);
	});

	it('writes headers once confirmed, and leaves the base layer untouched', async () => {
		const vault = await vaultWithNotes();
		const baseBefore = vault.binary.get(basePathFor('class/Week 2.inknote'));
		const app = { vault } as unknown as App;
		const plan = await planTitleConversions(app, folder);
		expect(await applyTitleConversions(app, plan.matches)).toBe(2);
		for (const path of ['class/Week 2.inknote', 'class/old/Week 1.inknote']) {
			const parsed = parseInkData(vault.text.get(path) ?? '');
			expect(parsed.ok && parsed.data.header).toEqual({ createdAt: OCT_3_2026_1402 });
		}
		expect(vault.binary.get(basePathFor('class/Week 2.inknote'))).toBe(baseBefore);
		// Run again, nothing is left to convert.
		expect((await planTitleConversions(app, folder)).matches).toEqual([]);
	});
});
