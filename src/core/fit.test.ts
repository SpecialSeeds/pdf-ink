import { describe, expect, it } from 'vitest';
import { MAX_ZOOM, MIN_ZOOM, PDF_TO_CSS_UNITS } from '../constants';
import { fitHeightZoom, maxBaseHeight, maxBaseWidth } from './layout';

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

describe('fitHeightZoom', () => {
	it('puts the tallest page\'s whole height in the pane', () => {
		for (const h of [400, 800, 1200]) {
			const zoom = fitHeightZoom(h, 16, 841.89);
			expect(841.89 * zoom * PDF_TO_CSS_UNITS).toBeCloseTo(h - 32, 6);
		}
	});

	it('ignores the width, so a landscape page fills the height and pans across', () => {
		const zoom = fitHeightZoom(800, 16, LANDSCAPE.baseHeight);
		expect(LANDSCAPE.baseWidth * zoom * PDF_TO_CSS_UNITS).toBeGreaterThan(800);
	});

	it('stays inside the zoom limits', () => {
		expect(fitHeightZoom(10, 16, 841.89)).toBeGreaterThanOrEqual(MIN_ZOOM);
		expect(fitHeightZoom(100000, 16, 1)).toBeLessThanOrEqual(MAX_ZOOM);
	});

	it('falls back to 1 for a document with no measurable page', () => {
		expect(fitHeightZoom(800, 16, 0)).toBe(1);
	});
});
