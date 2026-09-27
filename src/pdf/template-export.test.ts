import { inflateSync } from 'node:zlib';
import { PDFDocument, PDFRawStream, PDFStream } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { MM, templateGeometry } from '../core/templates';
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
	const doc = await PDFDocument.load(bytes);
	const contents = doc.getPage(0).node.Contents();
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
