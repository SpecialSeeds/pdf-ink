import { inflateSync } from 'node:zlib';
import { PDFDocument, PDFRawStream, PDFStream } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { MM, templateGeometry } from '../core/templates';
import type { Stroke } from '../core/items';
import { newNotebookData } from '../core/new-notebook';
import { createStroke } from '../core/stroke';
import { DEFAULT_PAGE_THEMES, effectiveThemes } from '../core/theme';
import type { InsertedPage } from '../core/pages';
import { exportAnnotatedPdf } from './export';

const W = 400;
const H = 500;

function page(template: InsertedPage['template']): InsertedPage {
	return {
		id: 'p1',
		afterPdfPage: -1,
		sortKey: 'a0',
		template,
		size: { width: W, height: H },
		updatedAt: 1000,
	};
}

async function onePagePdf(): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	doc.addPage([200, 200]);
	return doc.save();
}

/** The decoded content stream of the inserted page. */
async function insertedContent(
	template: InsertedPage['template'],
): Promise<string> {
	const bytes = await exportAnnotatedPdf({
		pdfBytes: await onePagePdf(),
		pages: {},
		insertedPages: [page(template)],
	});
	return contentOf(bytes, 0);
}

/** The decoded content streams of one page of an exported file. */
async function contentOf(bytes: Uint8Array, index: number): Promise<string> {
	const doc = await PDFDocument.load(bytes);
	const contents = doc.getPage(index).node.Contents();
	// A page that was drawn nothing at all has no content stream to decode.
	if (contents === undefined) return '';
	const parts: string[] = [];
	const collect = (stream: PDFStream): void => {
		if (!(stream instanceof PDFRawStream)) return;
		const raw = stream.asUint8Array();
		// Content streams come back Flate-compressed; decode them so the operators
		// can be read. Node's zlib is fine here — this is a test, not plugin code.
		let text: string;
		try {
			text = new TextDecoder().decode(inflateSync(raw));
		} catch {
			text = new TextDecoder().decode(raw);
		}
		parts.push(text);
	};
	if (contents instanceof PDFStream) collect(contents);
	else {
		// An array of streams: pdf-lib appends ours after the page's own.
		for (const ref of (contents as { asArray(): unknown[] }).asArray()) {
			const resolved = doc.context.lookup(ref as never);
			if (resolved instanceof PDFStream) collect(resolved);
		}
	}
	return parts.join('\n');
}

describe('the exported ruling matches the shared geometry', () => {
	it('draws every ruled line at its PDF-space coordinates', async () => {
		const content = await insertedContent('lined10');
		const { lines } = templateGeometry('lined10', W, H);
		expect(lines.length).toBeGreaterThan(10);

		for (const line of lines) {
			// pdf-lib emits "x y m" then "x y l" per line, at full precision.
			const move = `${String(line.x1)} ${String(line.y1)} m`;
			const to = `${String(line.x2)} ${String(line.y2)} l`;
			expect(content, move).toContain(move);
			expect(content, to).toContain(to);
		}
	});

	it('anchors the first rule one spacing below the top margin', async () => {
		const content = await insertedContent('lined10');
		const y = H - 6 * MM - 10 * MM;
		expect(content).toContain(`${String(6 * MM)} ${String(y)} m`);
	});

	it('draws every grid line, minor ones included, whatever the screen shows', async () => {
		const content = await insertedContent('grid5');
		const { lines } = templateGeometry('grid5', W, H);
		expect(lines.some((line) => line.major === false)).toBe(true);
		for (const line of lines) {
			expect(content).toContain(`${String(line.x1)} ${String(line.y1)} m`);
		}
	});

	it('draws a grid on both axes', async () => {
		const content = await insertedContent('grid5');
		const { lines } = templateGeometry('grid5', W, H);
		const vertical = lines.filter((line) => line.x1 === line.x2);
		const horizontal = lines.filter((line) => line.y1 === line.y2);
		for (const line of [...vertical.slice(0, 3), ...horizontal.slice(0, 3)]) {
			expect(content).toContain(`${String(line.x1)} ${String(line.y1)} m`);
		}
	});

	it('draws a dot per intersection, as curves at the dot centres', async () => {
		const content = await insertedContent('dot');
		const { dots, dotRadius } = templateGeometry('dot', W, H);
		expect(dots.length).toBeGreaterThan(100);
		// pdf-lib starts a circle at its leftmost point, (x - r, y).
		for (const dot of dots.slice(0, 5)) {
			expect(content).toContain(
				`${String(dot.x - dotRadius)} ${String(dot.y)} m`,
			);
		}
	});

	it('draws nothing at all for a blank page', async () => {
		// Not even a content stream: a blank inserted page costs one page object.
		expect(await insertedContent('blank')).toBe('');
	});

	it('uses the same hairline width the screen renderer is given', async () => {
		const content = await insertedContent('grid5');
		const { lineWidth } = templateGeometry('grid5', W, H);
		expect(content).toContain(`${String(lineWidth)} w`);
	});

	it('keeps every mark inside the page box', async () => {
		const { lines, dots } = templateGeometry('grid5', W, H);
		for (const line of lines) {
			for (const [x, y] of [
				[line.x1, line.y1],
				[line.x2, line.y2],
			]) {
				expect(x).toBeGreaterThanOrEqual(0);
				expect(x).toBeLessThanOrEqual(W);
				expect(y).toBeGreaterThanOrEqual(0);
				expect(y).toBeLessThanOrEqual(H);
			}
		}
		expect(dots).toEqual([]);
	});
});

/** Every fill colour set in a content stream, as 0–255 channels. */
function fills(content: string): [number, number, number][] {
	return colours(content, 'rg');
}

/** Every stroke colour, as the ruling's lines use. */
function strokes(content: string): [number, number, number][] {
	return colours(content, 'RG');
}

function colours(content: string, op: 'rg' | 'RG'): [number, number, number][] {
	const pattern = new RegExp(`([\\d.]+) ([\\d.]+) ([\\d.]+) ${op}\\b`, 'g');
	return [...content.matchAll(pattern)].map((match) => [
		Math.round(Number(match[1]) * 255),
		Math.round(Number(match[2]) * 255),
		Math.round(Number(match[3]) * 255),
	]);
}

function strokeIn(color: string, id = 's1'): Stroke {
	const stroke = createStroke({ tool: 'pen', color, width: 2, opacity: 1 }, id);
	stroke.points.push([100, 300, 0.5], [150, 320, 0.5], [200, 300, 0.5]);
	return stroke;
}

describe('page themes in export', () => {
	const dark = DEFAULT_PAGE_THEMES.dark;

	it('exports a notebook with no PDF behind it, one page per record', async () => {
		const data = newNotebookData(1000, 'n1');
		const second = { ...page('lined'), id: 'n2', sortKey: 'b0', size: { width: 612, height: 792 } };
		const bytes = await exportAnnotatedPdf({
			pages: { 'ins:n1': [strokeIn('#000000')] },
			insertedPages: [...data.insertedPages, second],
		});
		const doc = await PDFDocument.load(bytes);
		expect(doc.getPageCount()).toBe(2);
		expect(doc.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
	});

	it('paints dark paper and maps base ink to the dark theme on a notebook page', async () => {
		const bytes = await exportAnnotatedPdf({
			pages: { 'ins:n1': [strokeIn('#000000'), strokeIn('#e53935', 's2')] },
			insertedPages: newNotebookData(1000, 'n1').insertedPages,
			theme: 'dark',
		});
		const content = await contentOf(bytes, 0);
		const colours = fills(content);
		expect(colours).toContainEqual([0x1e, 0x1e, 0x1e]); // paper
		expect(strokes(content)).toContainEqual([0x2c, 0x3a, 0x4a]); // grid lines
		expect(colours).toContainEqual([255, 255, 255]); // black ink, now white
		// Red is not base ink, so it is exactly as stored.
		expect(colours).toContainEqual([0xe5, 0x39, 0x35]);
		expect(colours).not.toContainEqual([0, 0, 0]);
		expect(dark.paper).toBe('#1e1e1e');
	});

	it('paints a customised light paper, and skips only pure white', async () => {
		const tinted = await exportAnnotatedPdf({
			pages: {},
			insertedPages: newNotebookData(1000, 'n1').insertedPages,
			theme: 'light',
			themes: effectiveThemes({ light: { paper: '#fdf6e3' } }),
		});
		expect(fills(await contentOf(tinted, 0))).toContainEqual([0xfd, 0xf6, 0xe3]);

		const white = await exportAnnotatedPdf({
			pages: {},
			insertedPages: newNotebookData(1000, 'n1').insertedPages,
			theme: 'light',
		});
		expect(fills(await contentOf(white, 0))).not.toContainEqual([255, 255, 255]);
	});

	it('keeps original PDF pages light whatever the theme', async () => {
		const bytes = await exportAnnotatedPdf({
			pdfBytes: await onePagePdf(),
			pages: { 'pdf:0': [strokeIn('#ffffff')] },
			theme: 'dark',
		});
		const colours = fills(await contentOf(bytes, 0));
		// White ink on a white page renders as the light theme's near black.
		expect(colours).toContainEqual([0x1a, 0x1a, 0x1a]);
		expect(colours).not.toContainEqual([0x1e, 0x1e, 0x1e]);
	});

	it('uses the configured colours, not just the defaults', async () => {
		const bytes = await exportAnnotatedPdf({
			pages: { 'ins:n1': [strokeIn('#000000')] },
			insertedPages: newNotebookData(1000, 'n1').insertedPages,
			theme: 'dark',
			themes: effectiveThemes({ dark: { paper: '#102030', baseInk: '#eeddcc' } }),
		});
		const colours = fills(await contentOf(bytes, 0));
		expect(colours).toContainEqual([0x10, 0x20, 0x30]);
		expect(colours).toContainEqual([0xee, 0xdd, 0xcc]);
	});

	it('screens a highlighter over dark paper and multiplies it over light', async () => {
		const highlight = (): Stroke => {
			const stroke = createStroke(
				{ tool: 'highlighter', color: '#e6b800', width: 12, opacity: 0.35 },
				'h1',
			);
			stroke.points.push([100, 300, 0.5], [200, 300, 0.5]);
			return stroke;
		};
		const blendOf = async (theme: 'light' | 'dark'): Promise<string> => {
			const bytes = await exportAnnotatedPdf({
				pages: { 'ins:n1': [highlight()] },
				insertedPages: newNotebookData(1000, 'n1').insertedPages,
				theme,
			});
			const doc = await PDFDocument.load(bytes);
			const resources = doc.getPage(0).node.Resources();
			return String(resources?.toString());
		};
		expect(await blendOf('dark')).toContain('/Screen');
		expect(await blendOf('light')).toContain('/Multiply');
	});
});
