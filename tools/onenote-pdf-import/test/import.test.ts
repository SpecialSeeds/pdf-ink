import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	PDFDocument,
	type PDFPage,
	StandardFonts,
	clip,
	closePath,
	concatTransformationMatrix,
	endPath,
	fill,
	lineTo,
	moveTo,
	popGraphicsState,
	pushGraphicsState,
	rectangle,
	rgb,
	setFillingRgbColor,
} from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unpackBase } from '../../../src/core/base-layer';
import { parseInkData } from '../../../src/core/ink-serialization';
import { HEADER_CONTENT_TOP } from '../../../src/core/header';
import { pathBounds } from '../../../src/core/path';
import { buildNotebook, classify } from '../src/build';
import { compareCanvases, describeComparison } from '../src/compare';
import { type RawPath, extractPdf } from '../src/extract';
import {
	type Canvas,
	MAC_EXPORT_WARNING,
	PX_TO_PT,
	pathNumbers,
	reconstructCanvas,
} from '../src/reconstruct';
import { noteName, runImport } from '../src/run';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));
const fixture = (name: string): string => join(FIXTURES, name);
const IOS_BOARD = fixture('Section 1.pdf');
const IOS_TALL = fixture('1.3 Modeling Building ODEs_long.pdf');
const MAC_SLICED = fixture('1.3 Modeling Building ODEs.pdf');

async function load(path: string): Promise<Canvas> {
	return reconstructCanvas(await extractPdf(new Uint8Array(readFileSync(path))));
}

/** A closed, filled polygon on the synthetic canvas, in CSS px, y up. */
interface Blob {
	readonly color: [number, number, number];
	readonly points: [number, number][];
}

function square(x: number, y: number, size = 10, color: [number, number, number] = [0, 0, 0]): Blob {
	return {
		color,
		points: [
			[x, y],
			[x + size, y],
			[x + size, y + size],
			[x, y + size],
		],
	};
}

function drawBlobs(page: PDFPage, blobs: readonly Blob[], map: (x: number, y: number) => [number, number]): void {
	for (const blob of blobs) {
		const [first, ...rest] = blob.points.map(([x, y]) => map(x, y));
		if (!first) continue;
		page.pushOperators(
			setFillingRgbColor(...blob.color),
			moveTo(...first),
			...rest.map(([x, y]) => lineTo(x, y)),
			closePath(),
			fill(),
		);
	}
}

/** An iOS-style export: one page the size of the canvas, a white background, ink in px. */
async function iosPdf(width: number, height: number, blobs: readonly Blob[], title = 'Synthetic'): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const page = doc.addPage([width, height]);
	page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(1, 1, 1) });
	drawBlobs(page, blobs, (x, y) => [x, y]);
	page.drawText(title, { x: 48, y: height - 40, size: 26.666667, font });
	return doc.save();
}

/** How the synthetic Mac export places the canvas: scaled by `s`, sliced into windows. */
const MAC = { s: 0.5, left: 18, bottom: 59, windowHeight: 686, step: 688 };

/**
 * A Mac-style export of the same canvas: Letter pages, the canvas scaled down by
 * {@link MAC}.s, every page drawing ALL the ink shifted so its slice falls in the
 * clip window, and the title drawn under a scaling transform.
 */
async function macPdf(width: number, height: number, blobs: readonly Blob[], title = 'Synthetic'): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const top = MAC.bottom + MAC.windowHeight;
	const pages = Math.ceil((height * MAC.s) / MAC.windowHeight);
	for (let k = 0; k < pages; k++) {
		const page = doc.addPage([612, 792]);
		const shift = top - height * MAC.s + k * MAC.step;
		page.pushOperators(
			pushGraphicsState(),
			rectangle(MAC.left, MAC.bottom, width * MAC.s, MAC.windowHeight),
			clip(),
			endPath(),
		);
		drawBlobs(page, blobs, (x, y) => [MAC.left + x * MAC.s, shift + y * MAC.s]);
		page.pushOperators(popGraphicsState());
		page.pushOperators(pushGraphicsState(), concatTransformationMatrix(MAC.s, 0, 0, MAC.s, MAC.left, shift));
		page.drawText(title, { x: 48, y: height - 40, size: 26.666667, font });
		page.pushOperators(popGraphicsState());
	}
	// OneNote's Mac export ends with an empty page.
	doc.addPage([612, 792]);
	return doc.save();
}

/** A tall synthetic note: rows of squares down a 1040 px canvas, in three colours. */
function tallNote(): { width: number; height: number; blobs: Blob[] } {
	const blobs: Blob[] = [];
	const colors: [number, number, number][] = [
		[0, 0, 0],
		[0, 0.627, 0.843],
		[0.906, 0.071, 0.145],
	];
	let n = 0;
	for (let y = 3800; y > 100; y -= 37) {
		for (let x = 60; x < 900; x += 160) {
			blobs.push(square(x + (n % 7), y, 12 + (n % 5), colors[n % 3]));
			n += 1;
		}
	}
	return { width: 1040, height: 3960, blobs };
}

describe('noteName', () => {
	it('is the file name, without its extension or unusable characters', () => {
		expect(noteName('1.3 Modeling Building ODEs.pdf')).toBe('1.3 Modeling Building ODEs');
		expect(noteName('Week 2: forces / torque #3 [draft].PDF')).toBe('Week 2 forces torque 3 draft');
		expect(noteName('  ..hidden.pdf')).toBe('hidden');
		expect(noteName('???.pdf')).toBe('Untitled');
	});
});

describe('classify', () => {
	it('makes a board of a canvas wider than tall, or far wider than Letter', () => {
		expect(classify(2000, 1000)).toBe('board');
		expect(classify(1000, 3000)).toBe('board');
		expect(classify(780, 2969)).toBe('paginated');
		expect(classify(612, 792)).toBe('paginated');
	});
});

describe('extracting an export', () => {
	it('reads filled paths with their exact colours, in page space', async () => {
		const pages = await extractPdf(await iosPdf(400, 300, [square(20, 30, 10, [0, 0.627, 0.843])]));
		const ink = pages[0]?.paths.filter((p) => p.color !== '#ffffff') ?? [];
		expect(ink).toHaveLength(1);
		expect(ink[0]?.color).toBe('#00a0d7');
		expect(ink[0]?.paint).toBe('fill');
		expect(ink[0]?.bounds).toEqual({ minX: 20, minY: 30, maxX: 30, maxY: 40 });
	});

	it('reads typed text with its position and size', async () => {
		const pages = await extractPdf(await iosPdf(400, 300, [], 'Hello there'));
		const text = pages[0]?.texts[0];
		expect(text?.text).toBe('Hello there');
		expect(text?.x).toBeCloseTo(48, 3);
		expect(text?.y).toBeCloseTo(260, 3);
		expect(text?.fontSize).toBeCloseTo(26.666667, 3);
	});
});

describe('reconstructing an iOS export', () => {
	it('keeps the whole page as the canvas, in points, without its background', async () => {
		const canvas = reconstructCanvas(await extractPdf(await iosPdf(400, 300, [square(20, 30)])));
		expect(canvas.format).toBe('ios');
		expect(canvas.width).toBeCloseTo(400 * PX_TO_PT, 6);
		expect(canvas.height).toBeCloseTo(300 * PX_TO_PT, 6);
		expect(canvas.paths).toHaveLength(1);
		expect(canvas.paths[0]?.bounds.minX).toBeCloseTo(20 * PX_TO_PT, 6);
		// OneNote's 26.67 px title is its 20 pt title.
		expect(canvas.texts[0]?.fontSize).toBeCloseTo(20, 3);
	});
});

describe('reconstructing a Mac export', () => {
	it('stitches the slices, drops every copy, and undoes the export scale', async () => {
		const note = tallNote();
		const mac = reconstructCanvas(await extractPdf(await macPdf(note.width, note.height, note.blobs)));
		const ios = reconstructCanvas(await extractPdf(await iosPdf(note.width, note.height, note.blobs)));

		expect(mac.format).toBe('mac');
		expect(mac.contentPages).toBe(Math.ceil((note.height * MAC.s) / MAC.windowHeight));
		mac.offsets.forEach(([dx, dy], k) => {
			expect(dx).toBeCloseTo(0, 3);
			expect(dy).toBeCloseTo(-k * MAC.step, 3);
		});
		expect(mac.paths).toHaveLength(note.blobs.length);
		expect(mac.duplicates).toBeGreaterThan(0);
		expect(mac.texts).toHaveLength(1);
		expect(mac.texts[0]?.fontSize).toBeCloseTo(20, 2);

		const comparison = compareCanvases(ios, mac, 0.5);
		const report = describeComparison(comparison);
		expect(comparison.extra, report).toEqual([]);
		expect(comparison.missing, report).toEqual([]);
		expect(comparison.retraced, report).toEqual([]);
		expect(comparison.matched).toBe(note.blobs.length);
	});

	it('is told apart from an iOS export by its several Letter pages', async () => {
		const note = tallNote();
		const pages = await extractPdf(await macPdf(note.width, note.height, note.blobs));
		expect(pages.length).toBeGreaterThan(1);
		expect(reconstructCanvas(pages).format).toBe('mac');
	});
});

describe('building a notebook', () => {
	it('paginates a tall canvas into Letter pages, every path exactly once', async () => {
		const note = tallNote();
		const canvas = reconstructCanvas(await extractPdf(await iosPdf(note.width, note.height, note.blobs)));
		let next = 0;
		const built = buildNotebook(canvas, { now: 5, newId: () => `id${String((next += 1))}`, docId: 'doc' });

		expect(built.layout).toBe('paginated');
		expect(built.data.layout).toBeUndefined();
		expect(built.pageCount).toBeGreaterThan(1);
		for (const page of built.data.insertedPages) {
			expect(page.size).toEqual({ width: 612, height: 792 });
			expect(page.afterPdfPage).toBe(-1);
		}
		const items = Object.values(built.data.pages).flat();
		const paths = items.filter((i) => i.type === 'path');
		expect(paths).toHaveLength(note.blobs.length);
		expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
		for (const path of paths) {
			const b = pathBounds(path);
			expect(b?.minX).toBeGreaterThanOrEqual(36 - 0.01);
			expect(b?.maxX).toBeLessThanOrEqual(576 + 0.01);
			expect(b?.minY).toBeGreaterThanOrEqual(36 - 0.01);
			expect(b?.maxY).toBeLessThanOrEqual(756 + 0.01);
		}
		// Pages are ordered by distinct keys, in the order they were built.
		const keys = built.data.insertedPages.map((p) => p.sortKey);
		expect([...keys].sort()).toEqual(keys);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('keeps a wide canvas as one board page at its own size', async () => {
		const canvas = reconstructCanvas(await extractPdf(await iosPdf(2400, 1000, [square(100, 100), square(2200, 900)])));
		const built = buildNotebook(canvas, { now: 5 });
		expect(built.layout).toBe('board');
		expect(built.data.layout).toBe('board');
		expect(built.data.insertedPages).toHaveLength(1);
		expect(built.data.insertedPages[0]?.size).toEqual({ width: 1800, height: 750 });
		expect(built.data.insertedPages[0]?.template).toBe('grid5');
	});

	it('writes path items with exact colours, outline widths and highlight', () => {
		const raw = (over: Partial<RawPath>): RawPath => ({
			commands: [
				{ op: 'move', x: 1, y: 1 },
				{ op: 'line', x: 5, y: 1 },
				{ op: 'close' },
			],
			paint: 'fill',
			color: '#e71225',
			alpha: 1,
			lineWidth: 0,
			highlight: false,
			clip: null,
			bounds: { minX: 1, minY: 1, maxX: 5, maxY: 1 },
			...over,
		});
		const canvas: Canvas = {
			format: 'ios',
			width: 2000,
			height: 1000,
			paths: [raw({}), raw({ paint: 'stroke', lineWidth: 2.1 }), raw({ color: '#00f900', highlight: true })],
			texts: [],
			contentPages: 1,
			offsets: [[0, 0]],
			duplicates: 0,
			scale: [0.75, 0.75],
			warnings: [],
		};
		const items = Object.values(buildNotebook(canvas, { now: 1 }).data.pages).flat();
		expect(items.map((i) => (i.type === 'path' ? [i.color, i.strokeWidth, i.highlight] : null))).toEqual([
			['#e71225', undefined, undefined],
			['#e71225', 2.1, undefined],
			['#00f900', undefined, true],
		]);
	});
});

describe('running an import', () => {
	let dir = '';
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'onenote-import-'));
		await writeFile(join(dir, 'Board note.pdf'), await iosPdf(2400, 1000, [square(100, 100)]));
		await writeFile(join(dir, 'Tall: note.pdf'), await iosPdf(700, 2000, [square(100, 1900)]));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('writes one notebook per PDF, named after the file', async () => {
		const lines: string[] = [];
		const results = await runImport({ input: dir, output: dir, now: 1, log: (l) => lines.push(l) });
		expect(results.map((r) => r.status)).toEqual(['written', 'written']);
		expect((await readdir(dir)).filter((f) => f.includes('.inknote')).sort()).toEqual([
			'Board note.inknote',
			'Board note.inknote.gz',
			'Tall note.inknote',
			'Tall note.inknote.gz',
		]);
		const parsed = parseInkData(await readFile(join(dir, 'Board note.inknote'), 'utf8'));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.data.version).toBe(5);
		expect(parsed.data.layout).toBe('board');
		expect(typeof parsed.data.docId).toBe('string');
		// The imported ink is all in the base layer the notebook names.
		expect(parsed.data.pages).toEqual({});
		const ref = parsed.data.base;
		if (!ref) throw new Error('no base reference');
		const unpacked = await unpackBase(new Uint8Array(await readFile(join(dir, 'Board note.inknote.gz'))), ref);
		expect(unpacked.ok && Object.values(unpacked.pages).flat().filter((i) => i.type === 'path')).toHaveLength(1);
	});

	it('skips notes already written when it is run again', async () => {
		await runImport({ input: dir, output: dir, now: 1, log: () => undefined });
		const before = await readFile(join(dir, 'Tall note.inknote'), 'utf8');
		const lines: string[] = [];
		const again = await runImport({ input: dir, output: dir, now: 2, log: (l) => lines.push(l) });
		expect(again.map((r) => r.status)).toEqual(['skipped', 'skipped']);
		expect(await readFile(join(dir, 'Tall note.inknote'), 'utf8')).toBe(before);
		expect(lines.join('\n')).toContain('already exists');
	});

	it('warns that a Mac export can drop ink', async () => {
		const note = tallNote();
		await writeFile(join(dir, 'Mac note.pdf'), await macPdf(note.width, note.height, note.blobs.slice(0, 40)));
		const lines: string[] = [];
		await runImport({ input: dir, output: dir, dryRun: true, only: 'mac', log: (l) => lines.push(l) });
		expect(lines.join('\n')).toContain('warning: ' + MAC_EXPORT_WARNING);
		expect(MAC_EXPORT_WARNING).toBe('Mac OneNote exports can drop ink; prefer iPad exports.');
	});

	it('lists without writing on a dry run, and filters with --only', async () => {
		const lines: string[] = [];
		const results = await runImport({ input: dir, output: dir, dryRun: true, only: 'TALL', log: (l) => lines.push(l) });
		expect(results.map((r) => [r.name, r.status])).toEqual([['Tall note', 'listed']]);
		expect((await readdir(dir)).some((f) => f.endsWith('.inknote'))).toBe(false);
		const report = lines.join('\n');
		expect(report).toContain('iOS export');
		expect(report).toMatch(/canvas 525 x 1500 pt, 1 paths/);
		expect(report).toContain('paginated');
	});
});

describe.skipIf(!existsSync(IOS_BOARD))('fixture: iOS board (Section 1)', () => {
	it('is vector ink in its exported colours, and imports as one board page at its own size', async () => {
		const canvas = await load(IOS_BOARD);
		const colors = new Set(canvas.paths.map((p) => p.color));
		expect([...colors].sort()).toEqual(
			['#000000', '#008c3a', '#00a0d7', '#00f900', '#d9aeff', '#e71225', '#ffc114'].sort(),
		);
		const built = buildNotebook(canvas, { now: 1 });
		expect(built.layout).toBe('board');
		expect(built.data.layout).toBe('board');
		expect(built.data.insertedPages).toHaveLength(1);
		// The page's 6607.443 x 3228.232 px, in points.
		const size = built.data.insertedPages[0]?.size;
		expect(size?.width).toBeCloseTo(6607.443 * PX_TO_PT, 2);
		expect(size?.height).toBeCloseTo(3228.232 * PX_TO_PT, 2);
		const items = Object.values(built.data.pages).flat();
		expect(items.filter((i) => i.type === 'path')).toHaveLength(canvas.paths.length);
		expect(items.filter((i) => i.type === 'text').map((i) => (i.type === 'text' ? i.text : ''))).toContain('Section 1');
	});
});

describe.skipIf(!existsSync(MAC_SLICED))('fixture: Mac sliced export', () => {
	it('reconstructs with no duplicate paths', async () => {
		const canvas = await load(MAC_SLICED);
		expect(canvas.format).toBe('mac');
		expect(canvas.contentPages).toBe(2);
		expect(canvas.offsets[1]?.[1]).toBeCloseTo(-688.007, 2);
		expect(canvas.duplicates).toBeGreaterThan(2000);

		// No two paths left with the same geometry.
		const seen = new Map<string, number[][]>();
		let repeats = 0;
		for (const path of canvas.paths) {
			const n = pathNumbers(path.commands);
			const key = `${path.color}|${String(n.length)}|${(n[0] ?? 0).toFixed(0)},${(n[1] ?? 0).toFixed(0)}`;
			const list = seen.get(key) ?? [];
			if (list.some((other) => other.every((v, i) => Math.abs(v - (n[i] ?? 0)) < 0.05))) repeats += 1;
			list.push(n);
			seen.set(key, list);
		}
		expect(repeats).toBe(0);
	});
});

describe.skipIf(!existsSync(MAC_SLICED) || !existsSync(IOS_TALL))('fixture: Mac export against iOS export of the same note', () => {
	it('reconstructs exactly: every Mac path is an iOS path, or the Mac export\'s retracing of one', async () => {
		const ios = await load(IOS_TALL);
		const mac = await load(MAC_SLICED);
		// 0.5 pt point for point; a stroke the Mac export retraced with fewer
		// points is paired by outline within 1 pt and reported, not failed.
		const comparison = compareCanvases(ios, mac, 0.5, 1);
		const report = describeComparison(comparison);
		// What the Mac export itself lost or retraced is a diagnostic, not a failure.
		console.info(`Mac against iOS export of the same note:\n${report}`);
		expect(comparison.extra, report).toEqual([]);
		expect(comparison.matched + comparison.retraced.length).toBe(mac.paths.length);
	});

	it('imports the iOS export of the tall note as Letter pages', async () => {
		const built = buildNotebook(await load(IOS_TALL), { now: 1 });
		expect(built.layout).toBe('paginated');
		expect(built.data.insertedPages.every((p) => p.size.width === 612 && p.size.height === 792)).toBe(true);
	});
});

describe('the title header', () => {
	it('needs a date line as well as the title', async () => {
		const note = tallNote();
		const canvas = reconstructCanvas(await extractPdf(await iosPdf(note.width, note.height, note.blobs, 'Synthetic')));
		// iosPdf writes no date, so the title alone is not enough.
		expect(buildNotebook(canvas, { now: 1, title: 'Synthetic' }).header).toBeUndefined();
	});

	it('starts page 1 below the header band on a paginated import', async () => {
		const note = tallNote();
		const canvas = reconstructCanvas(await extractPdf(await iosPdf(note.width, note.height, note.blobs)));
		const withDate: Canvas = {
			...canvas,
			texts: [
				...canvas.texts,
				{ ...canvas.texts[0], text: 'Saturday, October 3, 2026 2:02 PM', y: (canvas.texts[0]?.y ?? 0) - 18, fontSize: 10 } as Canvas['texts'][number],
			],
		};
		const built = buildNotebook(withDate, { now: 1, title: 'Synthetic' });
		expect(built.header).toEqual({ createdAt: new Date(2026, 9, 3, 14, 2).getTime() });
		const first = built.data.insertedPages[0];
		const items = first ? (built.data.pages[`ins:${first.id}`] ?? []) : [];
		expect(items.some((i) => i.type === 'text')).toBe(false);
		for (const item of items) {
			expect(item.type === 'path' && (pathBounds(item)?.maxY ?? 0)).toBeLessThanOrEqual(792 - HEADER_CONTENT_TOP + 1e-6);
		}
	});
});

describe.skipIf(!existsSync(IOS_BOARD))('fixture: the title header of the iOS board', () => {
	it('comes from its title and date, which are no longer text', async () => {
		const built = buildNotebook(await load(IOS_BOARD), { now: 1, title: 'Section 1' });
		expect(built.header).toEqual({ createdAt: new Date(2026, 7, 26, 11, 15).getTime() });
		expect(built.data.header).toEqual(built.header);
		const texts = Object.values(built.data.pages)
			.flat()
			.filter((i) => i.type === 'text');
		expect(texts).toEqual([]);
	});
});

describe.skipIf(!existsSync(MAC_SLICED) || !existsSync(IOS_TALL))('fixture: the title header of the 1.3 note', () => {
	it('comes from the Mac export named after the note', async () => {
		const built = buildNotebook(await load(MAC_SLICED), { now: 1, title: '1.3 Modeling Building ODEs' });
		expect(built.header).toEqual({ createdAt: new Date(2026, 9, 3, 14, 2).getTime() });
		expect(Object.values(built.data.pages).flat().some((i) => i.type === 'text')).toBe(false);
	});

	it('comes from the iOS export too, when it carries the note\'s name', async () => {
		const canvas = await load(IOS_TALL);
		expect(buildNotebook(canvas, { now: 1, title: '1.3 Modeling Building ODEs' }).header).toEqual({
			createdAt: new Date(2026, 9, 3, 14, 2).getTime(),
		});
		// Its file is named "..._long", which is not the title: no header, the text stays.
		const asNamed = buildNotebook(canvas, { now: 1, title: '1.3 Modeling Building ODEs_long' });
		expect(asNamed.header).toBeUndefined();
		expect(Object.values(asNamed.data.pages).flat().filter((i) => i.type === 'text')).toHaveLength(3);
	});
});
