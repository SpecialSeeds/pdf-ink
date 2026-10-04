import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlendMode, PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import type { Item, PathItem, ShapeItem, TextItem } from '../core/items';
import { pathCommands } from '../core/path';
import { HEADER_BAND, HEADER_RULE } from '../core/header';
import { DEFAULT_PAGE_THEMES } from '../core/theme';
import type { InsertedPage } from '../core/pages';
import type { PageTemplate } from '../core/templates';
import { layoutTextLines, wrapText } from '../core/text-layout';
import { createStroke } from '../core/stroke';
import {
	MAX_PDF_PAGE_SIDE,
	exportAnnotatedPdf,
	exportAnnotatedPdfWithReport,
	parseColor,
	scaledNote,
} from './export';
import { embeddedFontBytes } from './font';

/** A two-page A4 document to annotate. */
async function blankPdf(): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	doc.addPage([595, 842]);
	doc.addPage([595, 842]);
	return doc.save();
}

function textItem(text: string, over: Partial<TextItem> = {}): TextItem {
	return {
		type: 'text',
		id: 't1',
		color: '#112233',
		opacity: 1,
		rotation: 0,
		z: 0,
		updatedAt: 0,
		box: { x: 50, y: 700, w: 200, h: 60 },
		text,
		fontSize: 12,
		...over,
	};
}

const GREEK = 'αβγδεζηθ ΩΣΔΦ';
const SYMBOLS = 'µ ± × ÷ − °';

describe('parseColor', () => {
	it('reads six-digit hex', () => {
		expect(parseColor('#ff0000')).toEqual({ r: 1, g: 0, b: 0 });
		expect(parseColor('#000000')).toEqual({ r: 0, g: 0, b: 0 });
	});

	it('expands three-digit hex', () => {
		expect(parseColor('#fff')).toEqual({ r: 1, g: 1, b: 1 });
	});

	it('falls back to black on junk rather than throwing', () => {
		expect(parseColor('rebeccapurple')).toEqual({ r: 0, g: 0, b: 0 });
		expect(parseColor('')).toEqual({ r: 0, g: 0, b: 0 });
	});
});

describe('the bundled font', () => {
	it('is a real TrueType file', () => {
		const bytes = embeddedFontBytes();
		expect(bytes.length).toBeGreaterThan(10_000);
		// TrueType files start with the 0x00010000 version tag.
		expect([...bytes.slice(0, 4)]).toEqual([0, 1, 0, 0]);
	});

	it('is small enough to ride inside main.js', () => {
		expect(embeddedFontBytes().length).toBeLessThan(120_000);
	});
});

describe('Greek letters, µ and ± survive export', () => {
	it('the standard fonts genuinely cannot encode them', async () => {
		// This is why a TTF has to be embedded at all.
		const doc = await PDFDocument.create();
		const page = doc.addPage([595, 842]);
		const helvetica = await doc.embedFont(StandardFonts.Helvetica);
		expect(() => {
			page.drawText('αβγ', { x: 10, y: 10, size: 12, font: helvetica });
		}).toThrow();
	});

	it('the embedded font encodes every one of them', async () => {
		const doc = await PDFDocument.create();
		const { default: fontkit } = await import('@pdf-lib/fontkit');
		doc.registerFontkit(fontkit);
		const font = await doc.embedFont(embeddedFontBytes());

		for (const character of [...GREEK, ...SYMBOLS].filter((c) => c !== ' ')) {
			// A missing glyph measures zero or throws; a real one has width.
			expect(
				font.widthOfTextAtSize(character, 12),
				`glyph ${character}`,
			).toBeGreaterThan(0);
		}
	});

	it('exports a document containing them without throwing', async () => {
		const bytes = await exportAnnotatedPdf({
			pdfBytes: await blankPdf(),
			pages: { 'pdf:0': [textItem(`${GREEK}\n${SYMBOLS}`)] },
		});
		expect(bytes.length).toBeGreaterThan(1000);
		// The result must still be a readable PDF.
		const reloaded = await PDFDocument.load(bytes);
		expect(reloaded.getPageCount()).toBe(2);
	});

	it('embeds the font file into the output', async () => {
		const bytes = await exportAnnotatedPdf({
			pdfBytes: await blankPdf(),
			pages: { 'pdf:0': [textItem(GREEK)] },
		});
		// pdf-lib saves with object streams, so the dictionaries are compressed;
		// re-saving without them makes the keys inspectable.
		const flat = await (await PDFDocument.load(bytes)).save({
			useObjectStreams: false,
		});
		const text = new TextDecoder('latin1').decode(flat);
		// A FontFile2 entry is an embedded TrueType program. pdf-lib embeds it as a
		// composite font, so the descendant is CIDFontType2 rather than /TrueType.
		expect(text).toContain('/FontFile2');
		expect(text).toContain('/CIDFontType2');
	});

	it('a subset still carries the glyphs actually used', async () => {
		const doc = await PDFDocument.create();
		const { default: fontkit } = await import('@pdf-lib/fontkit');
		doc.registerFontkit(fontkit);
		const font = await doc.embedFont(embeddedFontBytes(), { subset: true });
		const page = doc.addPage([200, 200]);
		expect(() => {
			page.drawText('µ ± αβγ', { x: 10, y: 10, size: 12, font });
		}).not.toThrow();
		const saved = await doc.save();
		expect(saved.length).toBeGreaterThan(1000);
	});
});

describe('export preserves the original document', () => {
	it('keeps the page count and every page size', async () => {
		const source = await PDFDocument.create();
		source.addPage([595, 842]);
		source.addPage([200, 400]);
		source.addPage([842, 595]);
		const original = await source.save();

		const exported = await exportAnnotatedPdf({
			pdfBytes: original,
			pages: { 'pdf:1': [textItem('hello')] },
		});

		const before = await PDFDocument.load(original);
		const after = await PDFDocument.load(exported);
		expect(after.getPageCount()).toBe(before.getPageCount());
		for (let i = 0; i < before.getPageCount(); i++) {
			expect(after.getPage(i).getSize()).toEqual(before.getPage(i).getSize());
		}
	});

	it('ignores items on pages the document does not have', async () => {
		const bytes = await exportAnnotatedPdf({
			pdfBytes: await blankPdf(),
			pages: { 'pdf:99': [textItem('off the end')], '-1': [textItem('before')] },
		});
		expect((await PDFDocument.load(bytes)).getPageCount()).toBe(2);
	});

	it('exports an empty annotation set as an unchanged-size document', async () => {
		const bytes = await exportAnnotatedPdf({
			pdfBytes: await blankPdf(),
			pages: {},
		});
		expect((await PDFDocument.load(bytes)).getPageCount()).toBe(2);
	});
});

describe('every item type exports', () => {
	it('draws strokes, shapes and text without throwing', async () => {
		const stroke = createStroke(
			{ tool: 'pen', color: '#c0392b', width: 2, opacity: 1 },
			's1',
		);
		stroke.points.push([50, 50, 0.4], [150, 120, 0.9], [250, 60, 0.5]);
		const highlighter = createStroke(
			{ tool: 'highlighter', color: '#ffe066', width: 16, opacity: 0.35 },
			's2',
		);
		highlighter.points.push([50, 300, 1], [300, 300, 1]);
		const shape: ShapeItem = {
			type: 'shape',
			id: 'sh1',
			color: '#1f6feb',
			opacity: 1,
			rotation: 0,
			z: 1,
			updatedAt: 0,
			kind: 'axes3d_c',
			box: { x: 300, y: 400, w: 200, h: 200 },
			width: 1.5,
			fill: null,
		};
		const items: Item[] = [stroke, highlighter, shape, textItem('mixed page')];

		const bytes = await exportAnnotatedPdf({
			pdfBytes: await blankPdf(),
			pages: { 'pdf:0': items },
		});
		expect((await PDFDocument.load(bytes)).getPageCount()).toBe(2);
	});

	it('applies rotation to text', async () => {
		const bytes = await exportAnnotatedPdf({
			pdfBytes: await blankPdf(),
			pages: { 'pdf:0': [textItem('turned', { rotation: 30 })] },
		});
		expect((await PDFDocument.load(bytes)).getPageCount()).toBe(2);
	});
});

describe('wrapping matches the screen renderer', () => {
	it('the exporter measures with the embedded font, not a guess', async () => {
		const doc = await PDFDocument.create();
		const { default: fontkit } = await import('@pdf-lib/fontkit');
		doc.registerFontkit(fontkit);
		const font = await doc.embedFont(embeddedFontBytes());
		const measure = (text: string): number => font.widthOfTextAtSize(text, 12);

		const box = { x: 0, y: 100, w: 90, h: 50 };
		const lines = layoutTextLines(
			'the quick brown fox jumps over the lazy dog',
			box,
			12,
			measure,
		);
		expect(lines.length).toBeGreaterThan(1);
		// Nothing overflows the box, which is the property the screen shares.
		for (const line of lines) {
			expect(measure(line.text)).toBeLessThanOrEqual(box.w);
		}
	});

	it('both renderers get identical lines from identical measurements', async () => {
		const doc = await PDFDocument.create();
		const { default: fontkit } = await import('@pdf-lib/fontkit');
		doc.registerFontkit(fontkit);
		const font = await doc.embedFont(embeddedFontBytes());
		const measure = (text: string): number => font.widthOfTextAtSize(text, 12);

		// The screen path calls the same wrapText with a canvas-based measure; given
		// the same measurements it must produce the same lines.
		const viaWrap = wrapText('alpha beta gamma delta', 80, measure);
		const viaLayout = layoutTextLines(
			'alpha beta gamma delta',
			{ x: 0, y: 0, w: 80, h: 100 },
			12,
			measure,
		).map((line) => line.text);
		expect(viaLayout).toEqual(viaWrap);
	});

	it('wraps Greek text too', async () => {
		const doc = await PDFDocument.create();
		const { default: fontkit } = await import('@pdf-lib/fontkit');
		doc.registerFontkit(fontkit);
		const font = await doc.embedFont(embeddedFontBytes());
		const measure = (text: string): number => font.widthOfTextAtSize(text, 12);
		const lines = wrapText('αβγδε ζηθικ λμνξο', 40, measure);
		expect(lines.length).toBeGreaterThan(1);
		for (const line of lines) expect(measure(line)).toBeLessThanOrEqual(40);
	});
});

/** Pen and highlighter strokes across a page, for geometry round-trips. */
function inkFor(page: number): Item[] {
	const pen = createStroke(
		{ tool: 'pen', color: '#000000', width: 3, opacity: 1 },
		`pen-${String(page)}`,
	);
	pen.points.push([80, 80, 0.4], [200, 300, 0.9], [320, 120, 0.5]);
	const highlighter = createStroke(
		{ tool: 'highlighter', color: '#ffe066', width: 18, opacity: 0.35 },
		`hl-${String(page)}`,
	);
	highlighter.points.push([60, 400, 1], [400, 400, 1]);
	return [pen, highlighter];
}

describe('round-trip preserves page geometry', () => {
	/** Pages with awkward geometry: rotation, a non-zero origin, mixed sizes. */
	async function awkwardPdf(): Promise<Uint8Array> {
		const doc = await PDFDocument.create();
		for (const rotation of [0, 90, 180, 270]) {
			const page = doc.addPage([612, 792]);
			page.setRotation(degrees(rotation));
		}
		// A non-zero MediaBox origin, as cropped_mediabox.pdf has.
		const cropped = doc.addPage([612, 792]);
		cropped.setMediaBox(53.18, 97.03, 538.73, 605.25);
		// Mixed sizes, including landscape.
		doc.addPage([419.53, 595.28]);
		doc.addPage([841.89, 595.28]);
		return doc.save();
	}

	it('keeps the page count', async () => {
		const original = await awkwardPdf();
		const exported = await exportAnnotatedPdf({
			pdfBytes: original,
			pages: { 'pdf:0': inkFor(0), 'pdf:4': inkFor(4), 'pdf:6': inkFor(6) },
		});
		const before = await PDFDocument.load(original);
		const after = await PDFDocument.load(exported);
		expect(after.getPageCount()).toBe(before.getPageCount());
	});

	it('keeps every page size, including the cropped and landscape ones', async () => {
		const original = await awkwardPdf();
		const exported = await exportAnnotatedPdf({
			pdfBytes: original,
			pages: Object.fromEntries(
				Array.from({ length: 7 }, (_, i) => [String(i), inkFor(i)]),
			),
		});
		const before = await PDFDocument.load(original);
		const after = await PDFDocument.load(exported);
		for (let i = 0; i < before.getPageCount(); i++) {
			expect(after.getPage(i).getSize(), `page ${String(i)}`).toEqual(
				before.getPage(i).getSize(),
			);
		}
	});

	it('keeps every page rotation', async () => {
		const original = await awkwardPdf();
		const exported = await exportAnnotatedPdf({
			pdfBytes: original,
			pages: { 'pdf:1': inkFor(1), 'pdf:2': inkFor(2), 'pdf:3': inkFor(3) },
		});
		const before = await PDFDocument.load(original);
		const after = await PDFDocument.load(exported);
		for (let i = 0; i < before.getPageCount(); i++) {
			expect(
				after.getPage(i).getRotation().angle,
				`page ${String(i)}`,
			).toBe(before.getPage(i).getRotation().angle);
		}
	});

	it('keeps a non-zero MediaBox origin exactly', async () => {
		const original = await awkwardPdf();
		const exported = await exportAnnotatedPdf({
			pdfBytes: original,
			pages: { 'pdf:4': inkFor(4) },
		});
		const box = (await PDFDocument.load(exported)).getPage(4).getMediaBox();
		expect(box.x).toBeCloseTo(53.18, 4);
		expect(box.y).toBeCloseTo(97.03, 4);
	});

	it('leaves the original bytes untouched', async () => {
		const original = await awkwardPdf();
		const copy = Uint8Array.from(original);
		await exportAnnotatedPdf({ pdfBytes: original, pages: { 'pdf:0': inkFor(0) } });
		expect(Array.from(original)).toEqual(Array.from(copy));
	});

	// The repo's real fixtures are untracked, so this only runs where they exist.
	const root = fileURLToPath(new URL('../..', import.meta.url));
	for (const name of ['cropped_mediabox.pdf', 'rotated_pages.pdf', 'mixed_page_sizes.pdf']) {
		const path = join(root, name);
		const runner = existsSync(path) ? it : it.skip;
		runner(`round-trips the real ${name} fixture unchanged`, async () => {
			const original = new Uint8Array(readFileSync(path));
			const before = await PDFDocument.load(original);
			const pages = Object.fromEntries(
				Array.from({ length: before.getPageCount() }, (_, i) => [
					String(i),
					inkFor(i),
				]),
			);
			const after = await PDFDocument.load(
				await exportAnnotatedPdf({ pdfBytes: original, pages }),
			);
			expect(after.getPageCount()).toBe(before.getPageCount());
			for (let i = 0; i < before.getPageCount(); i++) {
				expect(after.getPage(i).getSize(), `${name} page ${String(i)}`).toEqual(
					before.getPage(i).getSize(),
				);
				expect(after.getPage(i).getRotation().angle).toBe(
					before.getPage(i).getRotation().angle,
				);
			}
		});
	}
});

describe('highlighter export', () => {
	it('multiplies with the page instead of covering it', async () => {
		const highlighter = createStroke(
			{ tool: 'highlighter', color: '#ffe066', width: 18, opacity: 0.35 },
			'hl',
		);
		highlighter.points.push([60, 400, 1], [400, 400, 1]);
		const bytes = await exportAnnotatedPdf({
			pdfBytes: await blankPdf(),
			pages: { 'pdf:0': [highlighter] },
		});
		const flat = await (await PDFDocument.load(bytes)).save({
			useObjectStreams: false,
		});
		const text = new TextDecoder('latin1').decode(flat);
		// The graphics state carries the blend mode and the 0.35 fill alpha.
		expect(text).toContain('/Multiply');
		expect(text).toMatch(/\/ca 0?\.35/);
	});

	it('a pen stroke stays opaque and normally blended', async () => {
		const pen = createStroke(
			{ tool: 'pen', color: '#000000', width: 3, opacity: 1 },
			'pen',
		);
		pen.points.push([60, 400, 1], [400, 400, 1]);
		const bytes = await exportAnnotatedPdf({
			pdfBytes: await blankPdf(),
			pages: { 'pdf:0': [pen] },
		});
		const flat = await (await PDFDocument.load(bytes)).save({
			useObjectStreams: false,
		});
		const text = new TextDecoder('latin1').decode(flat);
		expect(text).not.toContain('/Multiply');
		expect(BlendMode.Multiply).toBe('Multiply');
	});
});

describe('native /Ink annotations', () => {
	function penStroke(id = 'k1'): Item {
		const stroke = createStroke(
			{ tool: 'pen', color: '#ff0000', width: 4, opacity: 1 },
			id,
		);
		stroke.points.push([100, 100, 1], [200, 180, 1], [300, 120, 1]);
		return stroke;
	}

	async function exported(mode: 'flatten' | 'native'): Promise<string> {
		const bytes = await exportAnnotatedPdf({
			pdfBytes: await blankPdf(),
			pages: { 'pdf:0': [penStroke()] },
			mode,
		});
		const flat = await (await PDFDocument.load(bytes)).save({
			useObjectStreams: false,
		});
		return new TextDecoder('latin1').decode(flat);
	}

	it('writes an Ink annotation in native mode', async () => {
		const text = await exported('native');
		expect(text).toContain('/Subtype /Ink');
		expect(text).toContain('/InkList');
		expect(text).toContain('/Annot');
	});

	it('writes no annotation when flattening', async () => {
		const text = await exported('flatten');
		expect(text).not.toContain('/Subtype /Ink');
	});

	it('defaults to flattening when no mode is given', async () => {
		const bytes = await exportAnnotatedPdf({
			pdfBytes: await blankPdf(),
			pages: { 'pdf:0': [penStroke()] },
		});
		const flat = await (await PDFDocument.load(bytes)).save({
			useObjectStreams: false,
		});
		expect(new TextDecoder('latin1').decode(flat)).not.toContain('/Subtype /Ink');
	});

	it('carries an appearance stream, so it renders outside Acrobat too', async () => {
		const text = await exported('native');
		expect(text).toContain('/AP');
		expect(text).toContain('/Subtype /Form');
	});

	it('records the colour, width and print flag', async () => {
		const text = await exported('native');
		// #ff0000 as PDF colour components.
		expect(text).toMatch(/\/C \[ ?1 0 0 ?\]/);
		expect(text).toContain('/BS');
		expect(text).toContain('/F 4');
	});

	it('gives a highlighter a multiply blend in its appearance', async () => {
		const highlighter = createStroke(
			{ tool: 'highlighter', color: '#ffe066', width: 18, opacity: 0.35 },
			'hl',
		);
		highlighter.points.push([60, 400, 1], [400, 400, 1]);
		const bytes = await exportAnnotatedPdf({
			pdfBytes: await blankPdf(),
			pages: { 'pdf:0': [highlighter] },
			mode: 'native',
		});
		const flat = await (await PDFDocument.load(bytes)).save({
			useObjectStreams: false,
		});
		const text = new TextDecoder('latin1').decode(flat);
		expect(text).toContain('/BM /Multiply');
		expect(text).toMatch(/\/ca 0?\.35/);
	});

	it('still flattens shapes and text in native mode', async () => {
		const shape: ShapeItem = {
			type: 'shape',
			id: 'sh',
			color: '#1f6feb',
			opacity: 1,
			rotation: 0,
			z: 0,
			updatedAt: 0,
			kind: 'rect',
			box: { x: 50, y: 50, w: 100, h: 80 },
			width: 2,
			fill: null,
		};
		const bytes = await exportAnnotatedPdf({
			pdfBytes: await blankPdf(),
			pages: { 'pdf:0': [shape, textItem('still drawn')] },
			mode: 'native',
		});
		const flat = await (await PDFDocument.load(bytes)).save({
			useObjectStreams: false,
		});
		const text = new TextDecoder('latin1').decode(flat);
		// No Ink annotation, because neither is a stroke.
		expect(text).not.toContain('/Subtype /Ink');
		// The text was still embedded and drawn.
		expect(text).toContain('/FontFile2');
	});

	it('keeps page count and sizes in native mode too', async () => {
		const original = await blankPdf();
		const bytes = await exportAnnotatedPdf({
			pdfBytes: original,
			pages: { 'pdf:0': [penStroke('a')], '1': [penStroke('b')] },
			mode: 'native',
		});
		const before = await PDFDocument.load(original);
		const after = await PDFDocument.load(bytes);
		expect(after.getPageCount()).toBe(before.getPageCount());
		for (let i = 0; i < before.getPageCount(); i++) {
			expect(after.getPage(i).getSize()).toEqual(before.getPage(i).getSize());
		}
	});
});

describe('inserted pages are spliced into the export', () => {
	/** Three pages of distinct sizes, so position can be read off the output. */
	async function sizedPdf(): Promise<Uint8Array> {
		const doc = await PDFDocument.create();
		doc.addPage([100, 200]);
		doc.addPage([300, 400]);
		doc.addPage([500, 600]);
		return doc.save();
	}

	function insertedPage(
		id: string,
		afterPdfPage: number,
		over: Partial<InsertedPage> = {},
	): InsertedPage {
		return {
			id,
			afterPdfPage,
			sortKey: 'a0',
			template: 'blank',
			// A size no original page has, so it is unmistakable in the output.
			size: { width: 777, height: 888 },
			updatedAt: 1000,
			...over,
		};
	}

	const sizesOf = async (bytes: Uint8Array): Promise<[number, number][]> => {
		const doc = await PDFDocument.load(bytes);
		return doc
			.getPages()
			.map((page) => [Math.round(page.getWidth()), Math.round(page.getHeight())]);
	};

	it('adds one page per inserted record', async () => {
		const original = await sizedPdf();
		const exported = await exportAnnotatedPdf({
			pdfBytes: original,
			pages: {},
			insertedPages: [insertedPage('a', 0), insertedPage('b', 2)],
		});
		const before = await PDFDocument.load(original);
		const after = await PDFDocument.load(exported);
		expect(after.getPageCount()).toBe(before.getPageCount() + 2);
	});

	it('puts each inserted page at the position its record describes', async () => {
		const exported = await exportAnnotatedPdf({
			pdfBytes: await sizedPdf(),
			pages: {},
			insertedPages: [
				// Before the first page, between 0 and 1, and at the very end.
				insertedPage('top', -1),
				insertedPage('mid', 0),
				insertedPage('end', 2),
			],
		});
		expect(await sizesOf(exported)).toEqual([
			[777, 888],
			[100, 200],
			[777, 888],
			[300, 400],
			[500, 600],
			[777, 888],
		]);
	});

	it('orders several pages in one gap by sort key', async () => {
		const exported = await exportAnnotatedPdf({
			pdfBytes: await sizedPdf(),
			pages: {},
			insertedPages: [
				insertedPage('second', 0, {
					sortKey: 'a2',
					size: { width: 222, height: 222 },
				}),
				insertedPage('first', 0, {
					sortKey: 'a1',
					size: { width: 111, height: 111 },
				}),
			],
		});
		expect(await sizesOf(exported)).toEqual([
			[100, 200],
			[111, 111],
			[222, 222],
			[300, 400],
			[500, 600],
		]);
	});

	it('leaves every original page at its own size and in its own order', async () => {
		const original = await sizedPdf();
		const exported = await exportAnnotatedPdf({
			pdfBytes: original,
			pages: {},
			insertedPages: [insertedPage('a', -1), insertedPage('b', 1)],
		});
		const originals = (await sizesOf(exported)).filter(
			([w]) => w !== 777,
		);
		expect(originals).toEqual(await sizesOf(original));
	});

	it('skips tombstoned pages', async () => {
		const exported = await exportAnnotatedPdf({
			pdfBytes: await sizedPdf(),
			pages: {},
			insertedPages: [
				insertedPage('gone', 0, { deletedAt: 2000 }),
				insertedPage('kept', 0),
			],
		});
		expect(await sizesOf(exported)).toEqual([
			[100, 200],
			[777, 888],
			[300, 400],
			[500, 600],
		]);
	});

	it('is unchanged when there are no inserted pages', async () => {
		const original = await sizedPdf();
		for (const insertedPages of [undefined, []]) {
			const exported = await exportAnnotatedPdf({
				pdfBytes: original,
				pages: {},
				insertedPages,
			});
			expect(await sizesOf(exported)).toEqual(await sizesOf(original));
		}
	});

	it('draws items onto the inserted page they belong to', async () => {
		// Ink on an inserted page must land there and not on whatever original page
		// now occupies that index.
		const exported = await exportAnnotatedPdf({
			pdfBytes: await sizedPdf(),
			pages: { 'ins:a': inkFor(0) },
			insertedPages: [insertedPage('a', 0)],
		});
		const doc = await PDFDocument.load(exported);
		const inserted = doc.getPage(1);
		expect(Math.round(inserted.getWidth())).toBe(777);
		// The page carries content beyond its own ruling, which blank has none of.
		expect(inserted.node.Contents()).toBeDefined();
	});

	it('leaves items alone when their page is not in this document', async () => {
		// A sidecar written against a different PDF: better to drop the item than to
		// draw it on an unrelated page.
		const exported = await exportAnnotatedPdf({
			pdfBytes: await sizedPdf(),
			pages: { 'ins:missing': inkFor(0), 'pdf:9': inkFor(1) },
			insertedPages: [],
		});
		expect(await sizesOf(exported)).toEqual([
			[100, 200],
			[300, 400],
			[500, 600],
		]);
	});

	it('rules an inserted page, and rules a blank one with nothing', async () => {
		const sizeFor = async (template: PageTemplate): Promise<number> => {
			const exported = await exportAnnotatedPdf({
				pdfBytes: await sizedPdf(),
				pages: {},
				insertedPages: [insertedPage('a', 0, { template })],
			});
			return exported.byteLength;
		};
		const blank = await sizeFor('blank');
		// Each ruling adds real drawing operators, and a denser one adds more.
		expect(await sizeFor('lined10')).toBeGreaterThan(blank);
		expect(await sizeFor('grid5')).toBeGreaterThan(await sizeFor('lined10'));
		expect(await sizeFor('dot')).toBeGreaterThan(await sizeFor('grid5'));
	});

	it('still produces a valid, reloadable document', async () => {
		const exported = await exportAnnotatedPdf({
			pdfBytes: await sizedPdf(),
			pages: { 'ins:a': inkFor(0), 'pdf:0': inkFor(1) },
			insertedPages: [insertedPage('a', 1, { template: 'grid5' })],
		});
		const doc = await PDFDocument.load(exported);
		expect(doc.getPageCount()).toBe(4);
		// A second pass over the exported bytes must also hold up.
		expect((await PDFDocument.load(await doc.save())).getPageCount()).toBe(4);
	});
});

describe('path export', () => {
	/** A path's points as drawn on an exported page, in page space, via pdf.js. */
	async function drawnPaths(
		bytes: Uint8Array,
		pageNumber: number,
	): Promise<{ paint: number; points: [number, number][] }[]> {
		const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
		const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
		const page = await doc.getPage(pageNumber);
		const list = await page.getOperatorList();
		const { OPS } = pdfjs;
		type M = [number, number, number, number, number, number];
		const multiply = (m: M, n: M): M => [
			n[0] * m[0] + n[1] * m[2],
			n[0] * m[1] + n[1] * m[3],
			n[2] * m[0] + n[3] * m[2],
			n[2] * m[1] + n[3] * m[3],
			n[4] * m[0] + n[5] * m[2] + m[4],
			n[4] * m[1] + n[5] * m[3] + m[5],
		];
		let ctm: M = [1, 0, 0, 1, 0, 0];
		const stack: M[] = [];
		const out: { paint: number; points: [number, number][] }[] = [];
		list.fnArray.forEach((fn, i) => {
			const args = list.argsArray[i] as unknown[];
			if (fn === OPS.save) stack.push(ctm);
			else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
			else if (fn === OPS.transform) ctm = multiply(ctm, args as M);
			else if (fn === OPS.constructPath) {
				const data = (args[1] as ArrayLike<number>[])[0] ?? [];
				const points: [number, number][] = [];
				for (let k = 0; k < data.length; ) {
					const op = data[k++];
					const count = op === 0 || op === 1 ? 2 : op === 2 ? 6 : 0;
					for (let j = 0; j < count; j += 2) {
						const x = data[k + j] ?? 0;
						const y = data[k + j + 1] ?? 0;
						points.push([ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]);
					}
					k += count;
				}
				out.push({ paint: args[0] as number, points });
			}
		});
		return out;
	}

	const path: PathItem = {
		type: 'path',
		id: 'p',
		color: '#e71225',
		opacity: 1,
		rotation: 0,
		z: 0,
		updatedAt: 0,
		d: 'M100 700L200 700C220 720 240 740 260 760L120 760Z',
	};

	/** The path's own points, control points included, in order. */
	function storedPoints(item: PathItem): [number, number][] {
		return pathCommands(item).flatMap((c): [number, number][] =>
			c.op === 'close'
				? []
				: c.op === 'cubic'
					? [
							[c.x1, c.y1],
							[c.x2, c.y2],
							[c.x, c.y],
						]
					: [[c.x, c.y]],
		);
	}

	it('lands every point of the stored geometry where it was', async () => {
		const bytes = await exportAnnotatedPdf({
			pdfBytes: await blankPdf(),
			pages: { 'pdf:0': [path] },
		});
		const drawn = await drawnPaths(bytes, 1);
		const expected = storedPoints(path);
		const match = drawn.find((p) => p.points.length === expected.length);
		expect(match).toBeDefined();
		match?.points.forEach(([x, y], i) => {
			expect(x).toBeCloseTo(expected[i]?.[0] ?? NaN, 3);
			expect(y).toBeCloseTo(expected[i]?.[1] ?? NaN, 3);
		});
	});

	it('fills a path and strokes an outline path', async () => {
		const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
		const bytes = await exportAnnotatedPdf({
			pdfBytes: await blankPdf(),
			pages: { 'pdf:0': [path, { ...path, id: 'q', strokeWidth: 3 }] },
		});
		const paints = (await drawnPaths(bytes, 1)).map((p) => p.paint);
		expect(paints).toContain(OPS.fill);
		expect(paints.some((p) => p === OPS.stroke || p === OPS.closeStroke)).toBe(true);
	});

	it('maps base ink through the inserted page theme, and blends highlighter paths', async () => {
		const inserted: InsertedPage = {
			id: 'a',
			afterPdfPage: -1,
			sortKey: 'a0',
			template: 'blank',
			size: { width: 612, height: 792 },
			updatedAt: 0,
		};
		const bytes = await exportAnnotatedPdf({
			pages: {
				'ins:a': [
					{ ...path, color: '#000000' },
					{ ...path, id: 'h', color: '#ffc114', highlight: true, opacity: 0.5 },
				],
			},
			insertedPages: [inserted],
			theme: 'dark',
		});
		const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
		const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
		const list = await (await doc.getPage(1)).getOperatorList();
		const fills = list.fnArray
			.map((fn, i) => (fn === pdfjs.OPS.setFillRGBColor ? (list.argsArray[i] as string[])[0] : null))
			.filter((c) => c !== null);
		// Black base ink renders white on dark paper; the yellow keeps its colour.
		expect(fills).toContain('#ffffff');
		expect(fills).toContain('#ffc114');
		const flat = await (await PDFDocument.load(bytes)).save({ useObjectStreams: false });
		// Over dark paper a highlighter screens rather than multiplies.
		expect(new TextDecoder('latin1').decode(flat)).toContain('/Screen');
	});
});

describe('board export', () => {
	function boardPage(over: Partial<InsertedPage> = {}): InsertedPage {
		return {
			id: 'b',
			afterPdfPage: -1,
			sortKey: 'a0',
			template: 'grid5',
			size: { width: 2000, height: 900 },
			updatedAt: 0,
			...over,
		};
	}

	it('exports a board as one page at its own size, its origin included', async () => {
		const report = await exportAnnotatedPdfWithReport({
			pages: { 'ins:b': [] },
			insertedPages: [boardPage({ origin: { x: 0, y: -300 } })],
		});
		expect(report.scaledPages).toEqual([]);
		const doc = await PDFDocument.load(report.bytes);
		expect(doc.getPageCount()).toBe(1);
		const box = doc.getPage(0).getMediaBox();
		expect(box).toEqual({ x: 0, y: -300, width: 2000, height: 900 });
	});

	it('draws a path on a grown board where it is stored', async () => {
		const path: PathItem = {
			type: 'path',
			id: 'low',
			color: '#000000',
			opacity: 1,
			rotation: 0,
			z: 0,
			updatedAt: 0,
			d: 'M100 -250L200 -250L200 -200Z',
		};
		const bytes = await exportAnnotatedPdf({
			pages: { 'ins:b': [path] },
			insertedPages: [boardPage({ template: 'blank', origin: { x: 0, y: -300 } })],
		});
		const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
		const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
		const page = await doc.getPage(1);
		const view: number[] = page.view;
		expect(view[1]).toBe(-300);
		const viewport = page.getViewport({ scale: 1 });
		// pdf.js places (100, -250) 50 pt above the bottom-left corner.
		const [x, y] = viewport.convertToViewportPoint(100, -250) as [number, number];
		expect(x).toBeCloseTo(100, 6);
		expect(y).toBeCloseTo(900 - 50, 6);
	});

	it('scales a board with a side over 14,400 pt uniformly to fit, and reports it', async () => {
		const report = await exportAnnotatedPdfWithReport({
			pages: {},
			insertedPages: [boardPage({ template: 'blank', size: { width: 28_800, height: 3_000 } })],
		});
		expect(report.scaledPages).toEqual([{ index: 0, factor: 0.5 }]);
		const box = (await PDFDocument.load(report.bytes)).getPage(0).getMediaBox();
		expect(box.width).toBeCloseTo(MAX_PDF_PAGE_SIDE, 6);
		expect(box.height).toBeCloseTo(1_500, 6);
		expect(scaledNote(report.scaledPages)).toBe(
			". Page 1 was larger than PDF's 14,400 pt limit and was scaled to 50% to fit.",
		);
		expect(scaledNote([])).toBe('');
	});
});

describe('notebook header export', () => {
	const notebookPage: InsertedPage = {
		id: 'n1',
		afterPdfPage: -1,
		sortKey: 'a0',
		template: 'grid5',
		size: { width: 612, height: 792 },
		updatedAt: 0,
	};
	const second: InsertedPage = { ...notebookPage, id: 'n2', sortKey: 'a1' };
	const header = { title: 'Week 2 forces', date: 'Saturday, October 3, 2026  2:02 PM' };

	/** Text and fill colours drawn on each page, via pdf.js. */
	async function drawn(bytes: Uint8Array): Promise<{ text: string; fills: string[]; lineYs: number[] }[]> {
		const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
		const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
		const pages: { text: string; fills: string[]; lineYs: number[] }[] = [];
		for (let n = 1; n <= doc.numPages; n++) {
			const page = await doc.getPage(n);
			const content = await page.getTextContent();
			const list = await page.getOperatorList();
			const fills: string[] = [];
			const lineYs: number[] = [];
			list.fnArray.forEach((fn, i) => {
				const args = list.argsArray[i] as unknown[];
				if (fn === pdfjs.OPS.setFillRGBColor) fills.push(String(args[0]));
				if (fn === pdfjs.OPS.constructPath && args[0] === pdfjs.OPS.stroke) {
					// A stroked line: pdf-lib writes it as move, move, line. Every
					// point's y, so a line reaching into the band is caught.
					const data = Array.from((args[1] as ArrayLike<number>[])[0] ?? []);
					for (let k = 0; k + 2 < data.length; k += 3) lineYs.push(data[k + 2] ?? 0);
				}
			});
			pages.push({
				text: content.items.map((item) => ('str' in item ? item.str : '')).join(' '),
				fills,
				lineYs,
			});
		}
		return pages;
	}

	for (const theme of ['light', 'dark'] as const) {
		it(`draws the title, date and rule on page 1 only, in the ${theme} theme`, async () => {
			const bytes = await exportAnnotatedPdf({
				pages: {},
				insertedPages: [notebookPage, second],
				theme,
				header,
			});
			const [first, other] = await drawn(bytes);
			expect(first?.text).toContain(header.title);
			// pdf.js reads OneNote's double space back as one.
			expect(first?.text).toContain(header.date.replace(/\s+/g, ' '));
			expect(other?.text).not.toContain(header.title);

			const colours = DEFAULT_PAGE_THEMES[theme];
			// Title in base ink, date in the muted grey.
			expect(first?.fills).toContain(colours.baseInk);
			expect(first?.fills).toContain(colours.headerMuted);

			// On page 1 nothing is ruled in the band but the header's own rule;
			// page 2 is ruled right up to its top margin.
			const band = 792 - HEADER_BAND;
			const rule = 792 - HEADER_RULE;
			const inBand = (first?.lineYs ?? []).filter((y) => y > band + 0.01 && Math.abs(y - rule) > 0.01);
			expect(inBand).toEqual([]);
			expect(first?.lineYs).toContain(rule);
			expect((other?.lineYs ?? []).some((y) => y > band + 0.01)).toBe(true);
		});
	}
});
