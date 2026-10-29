import { describe, expect, it } from 'vitest';
import { findInPage, foldQuery, pageText, runBox, type TextRun } from './pdf-find';

const run = (str: string, x: number, y: number, extra: Partial<TextRun> = {}): TextRun => ({
	str,
	transform: [12, 0, 0, 12, x, y],
	width: str.length * 6,
	height: 12,
	...extra,
});

describe('findInPage', () => {
	it('finds every match, ignoring case', () => {
		const page = pageText([run('The cat sat on the mat', 72, 700)]);
		expect(findInPage(page, 'the')).toHaveLength(2);
		expect(findInPage(page, 'AT')).toHaveLength(3);
	});

	it('boxes a match within its run, proportionally', () => {
		const page = pageText([run('abcdef', 100, 500)]);
		const [hit] = findInPage(page, 'cd');
		const [box] = hit?.boxes ?? [];
		if (!box) throw new Error('no box');
		expect(box[0]).toBeCloseTo(112);
		expect(box[2]).toBeCloseTo(12);
		// From a little below the baseline to the top of the text.
		expect(box[1]).toBeLessThan(500);
		expect(box[1] + box[3]).toBeCloseTo(512);
	});

	it('matches across a line break, with a box on each line', () => {
		const page = pageText([run('heart', 72, 700, { hasEOL: true }), run('failure', 72, 686)]);
		const [hit] = findInPage(page, 'heart failure');
		expect(hit?.boxes).toHaveLength(2);
	});

	it('treats any whitespace as any other', () => {
		const page = pageText([run('a  \t b', 0, 0)]);
		expect(findInPage(page, 'a b')).toHaveLength(1);
	});

	it('ignores accents and ligatures', () => {
		const page = pageText([run('Café ﬁnal', 0, 0)]);
		expect(findInPage(page, 'cafe')).toHaveLength(1);
		expect(findInPage(page, 'final')).toHaveLength(1);
	});

	it('finds nothing for an empty query', () => {
		expect(findInPage(pageText([run('text', 0, 0)]), '   ')).toEqual([]);
	});

	it('does not overlap matches', () => {
		expect(findInPage(pageText([run('aaaa', 0, 0)]), 'aa')).toHaveLength(2);
	});
});

describe('foldQuery', () => {
	it('trims and collapses', () => {
		expect(foldQuery('  Heart   Failure ')).toBe('heart failure');
	});
});

describe('runBox', () => {
	it('boxes rotated text along its own baseline', () => {
		// Text running up the page.
		const box = runBox({ str: 'ab', transform: [0, 10, -10, 0, 50, 100], width: 20, height: 10 }, 0, 2);
		expect(box[1]).toBeCloseTo(100);
		expect(box[3]).toBeCloseTo(20);
		expect(box[2]).toBeCloseTo(12);
	});
});
