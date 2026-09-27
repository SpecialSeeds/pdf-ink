import { describe, expect, it } from 'vitest';
import { MAX_ZOOM, MIN_ZOOM, PDF_TO_CSS_UNITS } from '../constants';
import { fitPageZoom, fitWidthZoom, maxBaseHeight, maxBaseWidth } from './layout';

/** A4 portrait and landscape, in points, as pdf.js reports them. */
const PORTRAIT = { baseWidth: 595.28, baseHeight: 841.89 };
const LANDSCAPE = { baseWidth: 841.89, baseHeight: 595.28 };

describe('maxBaseHeight', () => {
	it('takes the tallest page', () => {
		expect(maxBaseHeight([PORTRAIT, LANDSCAPE])).toBeCloseTo(841.89, 6);
		expect(maxBaseWidth([PORTRAIT, LANDSCAPE])).toBeCloseTo(841.89, 6);
	});

	it('is zero for an empty document', () => {
		expect(maxBaseHeight([])).toBe(0);
	});
});

describe('fitPageZoom', () => {
	it('takes whichever axis runs out first', () => {
		// A tall pane: width is the constraint, so it matches fit-width.
		const wide = fitPageZoom(1000, 5000, 16, 595.28, 841.89);
		expect(wide).toBeCloseTo(fitWidthZoom(1000, 16, 595.28), 6);

		// A short pane: height is the constraint, so it comes out smaller.
		const short = fitPageZoom(1000, 400, 16, 595.28, 841.89);
		expect(short).toBeLessThan(fitWidthZoom(1000, 16, 595.28));
	});

	it('puts the whole page inside the pane, both ways', () => {
		for (const [w, h] of [
			[1200, 800],
			[400, 1000],
			[900, 900],
		] as const) {
			const zoom = fitPageZoom(w, h, 16, 595.28, 841.89);
			const scale = zoom * PDF_TO_CSS_UNITS;
			expect(595.28 * scale).toBeLessThanOrEqual(w - 2 * 16 + 1e-6);
			expect(841.89 * scale).toBeLessThanOrEqual(h - 2 * 16 + 1e-6);
		}
	});

	it('fits the largest page, so no page overflows', () => {
		const pages = [PORTRAIT, LANDSCAPE];
		const zoom = fitPageZoom(
			900,
			700,
			16,
			maxBaseWidth(pages),
			maxBaseHeight(pages),
		);
		const scale = zoom * PDF_TO_CSS_UNITS;
		for (const page of pages) {
			expect(page.baseWidth * scale).toBeLessThanOrEqual(900 - 32 + 1e-6);
			expect(page.baseHeight * scale).toBeLessThanOrEqual(700 - 32 + 1e-6);
		}
	});

	it('is never larger than fit-width, since it adds a second constraint', () => {
		for (const h of [200, 600, 1200, 4000]) {
			expect(fitPageZoom(1000, h, 16, 595.28, 841.89)).toBeLessThanOrEqual(
				fitWidthZoom(1000, 16, 595.28) + 1e-9,
			);
		}
	});

	it('stays inside the zoom limits', () => {
		// A pane far too small, and one far too large.
		expect(fitPageZoom(10, 10, 16, 595.28, 841.89)).toBeGreaterThanOrEqual(
			MIN_ZOOM,
		);
		expect(fitPageZoom(100000, 100000, 16, 1, 1)).toBeLessThanOrEqual(MAX_ZOOM);
	});

	it('falls back to 1 for a document with no measurable page', () => {
		expect(fitPageZoom(1000, 800, 16, 0, 0)).toBe(1);
		expect(fitPageZoom(1000, 800, 16, 595.28, 0)).toBe(1);
	});
});
