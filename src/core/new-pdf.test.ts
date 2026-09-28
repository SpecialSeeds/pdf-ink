import { describe, expect, it } from 'vitest';
import {
	PAGE_SIZES,
	rulingFromKeywords,
	rulingKeyword,
	untitledPdfPath,
} from './new-pdf';
import { PAGE_TEMPLATES } from './templates';

describe('PAGE_SIZES', () => {
	it('has Letter and A4 in points', () => {
		expect(PAGE_SIZES.letter).toEqual({ width: 612, height: 792 });
		expect(PAGE_SIZES.a4.width).toBeCloseTo(595.28, 1);
		expect(PAGE_SIZES.a4.height).toBeCloseTo(841.89, 1);
	});
});

describe('ruling keyword', () => {
	it('round-trips every template', () => {
		for (const template of PAGE_TEMPLATES) {
			expect(rulingFromKeywords(rulingKeyword(template))).toBe(template);
		}
	});

	it('is found among other keywords', () => {
		expect(rulingFromKeywords(`maths, ${rulingKeyword('grid5')} notes`)).toBe('grid5');
	});

	it('is null for any other PDF', () => {
		expect(rulingFromKeywords(undefined)).toBeNull();
		expect(rulingFromKeywords('')).toBeNull();
		expect(rulingFromKeywords('physics lecture')).toBeNull();
		expect(rulingFromKeywords('pdf-ink-ruling:wavy')).toBeNull();
	});
});

describe('untitledPdfPath', () => {
	it('starts at Untitled.pdf', () => {
		expect(untitledPdfPath('Notes', () => false)).toBe('Notes/Untitled.pdf');
	});

	it('works at the vault root', () => {
		expect(untitledPdfPath('', () => false)).toBe('Untitled.pdf');
		expect(untitledPdfPath('/', () => false)).toBe('Untitled.pdf');
	});

	it('numbers past names already taken', () => {
		const taken = new Set(['Notes/Untitled.pdf', 'Notes/Untitled 1.pdf']);
		expect(untitledPdfPath('Notes', (path) => taken.has(path))).toBe(
			'Notes/Untitled 2.pdf',
		);
	});
});
