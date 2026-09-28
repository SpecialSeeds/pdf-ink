import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { PAGE_SIZES, rulingFromKeywords } from '../core/new-pdf';
import { createBlankPdf } from './new-pdf';

describe('createBlankPdf', () => {
	it('makes one page of the chosen size', async () => {
		for (const size of ['letter', 'a4'] as const) {
			const doc = await PDFDocument.load(
				await createBlankPdf({ size, template: 'lined' }),
			);
			expect(doc.getPageCount()).toBe(1);
			const { width, height } = doc.getPage(0).getSize();
			expect(width).toBeCloseTo(PAGE_SIZES[size].width, 2);
			expect(height).toBeCloseTo(PAGE_SIZES[size].height, 2);
		}
	});

	it('names its ruling in the Keywords', async () => {
		const doc = await PDFDocument.load(
			await createBlankPdf({ size: 'letter', template: 'grid5' }),
		);
		expect(rulingFromKeywords(doc.getKeywords())).toBe('grid5');
	});

	it('draws the ruling into the page, and nothing for blank', async () => {
		const lined = await createBlankPdf({ size: 'letter', template: 'lined' });
		const blank = await createBlankPdf({ size: 'letter', template: 'blank' });
		// Ruling is page content, so a ruled page is the bigger file.
		expect(lined.byteLength).toBeGreaterThan(blank.byteLength + 200);
	});
});
