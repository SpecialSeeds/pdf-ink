import { describe, expect, it } from 'vitest';
import {
	composePages,
	insertedGeometry,
	pageSizes,
	pagesSignature,
	sizeLookup,
} from './page-composition';
import { syntheticViewport } from './page-viewport';
import {
	type InsertedPage,
	orderPages,
	pdfPageKey,
	sizeForInsertion,
	tombstonedPage,
} from './pages';
import type { PDFPageProxy } from '../types/pdfjs';
import type { PageGeometry } from '../types/view';

/** A page of the source document, sized but without a real pdf.js page behind it. */
function pdfGeom(pdfIndex: number, width = 612, height = 792): PageGeometry {
	const baseViewport = syntheticViewport(width, height);
	return {
		key: pdfPageKey(pdfIndex),
		source: {
			kind: 'pdf',
			pdfIndex,
			// Only identity matters here; nothing under test rasterises.
			page: { pageNumber: pdfIndex + 1 } as unknown as PDFPageProxy,
		},
		baseViewport,
		baseWidth: width,
		baseHeight: height,
		rotation: 0,
	};
}

function inserted(
	id: string,
	afterPdfPage: number,
	over: Partial<InsertedPage> = {},
): InsertedPage {
	return {
		id,
		afterPdfPage,
		sortKey: 'a0',
		template: 'blank',
		size: { width: 595, height: 842 },
		updatedAt: 1000,
		...over,
	};
}

const keys = (geometry: readonly PageGeometry[]): string[] =>
	geometry.map((geom) => geom.key);

describe('insertedGeometry', () => {
	it('derives a viewport from the record size', () => {
		const geom = insertedGeometry(inserted('a', 0));
		expect(geom.key).toBe('ins:a');
		expect(geom.baseWidth).toBe(595);
		expect(geom.baseHeight).toBe(842);
		expect(geom.rotation).toBe(0);
		// Usable for coordinate conversion, exactly as a pdf.js viewport is.
		expect(geom.baseViewport.convertToPdfPoint(0, 842)).toEqual([0, 0]);
	});

	it('carries the record, so a template change reaches the renderer', () => {
		const geom = insertedGeometry(inserted('a', 0, { template: 'grid5' }));
		expect(geom.source.kind).toBe('inserted');
		if (geom.source.kind === 'inserted') {
			expect(geom.source.page.template).toBe('grid5');
		}
	});
});

describe('composePages', () => {
	const document = [pdfGeom(0), pdfGeom(1), pdfGeom(2)];

	it('is the source document when nothing is inserted', () => {
		expect(keys(composePages(document, []))).toEqual([
			'pdf:0',
			'pdf:1',
			'pdf:2',
		]);
	});

	it('splices inserted pages into their gaps', () => {
		const composed = composePages(document, [
			inserted('top', -1),
			inserted('mid', 1),
		]);
		expect(keys(composed)).toEqual([
			'ins:top',
			'pdf:0',
			'pdf:1',
			'ins:mid',
			'pdf:2',
		]);
	});

	it('reuses the document\'s own geometry objects for its pages', () => {
		// Identity matters: the page list matches records by key, and a fresh object
		// for an unchanged page would force a pointless re-rasterise.
		const composed = composePages(document, [inserted('a', 0)]);
		expect(composed[0]).toBe(document[0]);
		expect(composed[2]).toBe(document[1]);
	});

	it('leaves out deleted pages', () => {
		const composed = composePages(document, [
			tombstonedPage(inserted('gone', 0), 2000),
		]);
		expect(keys(composed)).toEqual(['pdf:0', 'pdf:1', 'pdf:2']);
	});

	it('handles a document with no pages of its own', () => {
		expect(keys(composePages([], [inserted('a', -1)]))).toEqual(['ins:a']);
		expect(composePages([], [])).toEqual([]);
	});

	it('agrees with orderPages, which the exporter uses', () => {
		// The viewer and the exporter must not disagree about what page 4 is.
		const pages = [inserted('a', -1), inserted('b', 1), inserted('c', 2)];
		expect(keys(composePages(document, pages))).toEqual(
			orderPages(document.length, pages).map((slot) => slot.key),
		);
	});
});

describe('pagesSignature', () => {
	const document = [pdfGeom(0), pdfGeom(1)];

	it('is stable for the same page list', () => {
		const pages = [inserted('a', 0)];
		expect(pagesSignature(composePages(document, pages))).toBe(
			pagesSignature(composePages(document, pages)),
		);
	});

	it('changes when a page is added', () => {
		expect(pagesSignature(composePages(document, []))).not.toBe(
			pagesSignature(composePages(document, [inserted('a', 0)])),
		);
	});

	it('changes when a page moves', () => {
		expect(
			pagesSignature(composePages(document, [inserted('a', 0)])),
		).not.toBe(pagesSignature(composePages(document, [inserted('a', 1)])));
	});

	it('changes when a template changes, since the ruling must be redrawn', () => {
		expect(
			pagesSignature(composePages(document, [inserted('a', 0)])),
		).not.toBe(
			pagesSignature(
				composePages(document, [inserted('a', 0, { template: 'dot' })]),
			),
		);
	});

	it('changes when a page is resized, since the layout must be redone', () => {
		expect(
			pagesSignature(composePages(document, [inserted('a', 0)])),
		).not.toBe(
			pagesSignature(
				composePages(document, [
					inserted('a', 0, { size: { width: 100, height: 100 } }),
				]),
			),
		);
	});

	it('ignores the timestamp, which changes on every edit', () => {
		// Otherwise every stroke on the page would trigger a structural rebuild.
		expect(
			pagesSignature(composePages(document, [inserted('a', 0)])),
		).toBe(
			pagesSignature(
				composePages(document, [inserted('a', 0, { updatedAt: 999_999 })]),
			),
		);
	});
});

describe('pageSizes and sizeLookup', () => {
	it('answers with each page\'s own size', () => {
		const composed = composePages(
			[pdfGeom(0, 100, 200), pdfGeom(1, 300, 400)],
			[inserted('a', 0, { size: { width: 50, height: 60 } })],
		);
		const lookup = sizeLookup(pageSizes(composed));
		const order = orderPages(2, [
			inserted('a', 0, { size: { width: 50, height: 60 } }),
		]);
		expect(order.map(lookup)).toEqual([
			{ width: 100, height: 200 },
			{ width: 50, height: 60 },
			{ width: 300, height: 400 },
		]);
	});

	it('feeds sizeForInsertion, so a new page matches its neighbour', () => {
		const composed = composePages([pdfGeom(0, 100, 200), pdfGeom(1, 300, 400)], []);
		const order = orderPages(2, []);
		const lookup = sizeLookup(pageSizes(composed));
		expect(sizeForInsertion(order, 1, lookup)).toEqual({
			width: 100,
			height: 200,
		});
		expect(sizeForInsertion(order, 2, lookup)).toEqual({
			width: 300,
			height: 400,
		});
	});
});
