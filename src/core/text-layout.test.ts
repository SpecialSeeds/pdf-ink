import { describe, expect, it } from 'vitest';
import {
	BASELINE_RATIO,
	LINE_HEIGHT,
	type MeasureText,
	layoutTextLines,
	lineHeightFor,
	textHeightFor,
	wrapText,
} from './text-layout';

/** A stand-in for a real font: every character is exactly 10 units wide. */
const fixed: MeasureText = (text) => text.length * 10;

describe('wrapText', () => {
	it('keeps text that fits on one line', () => {
		expect(wrapText('abc', 100, fixed)).toEqual(['abc']);
	});

	it('wraps at word boundaries', () => {
		// 'aaa bbb' is 70 wide; a 50-wide box takes one word per line.
		expect(wrapText('aaa bbb', 50, fixed)).toEqual(['aaa', 'bbb']);
	});

	it('fits as many words per line as it can', () => {
		// 'aa bb cc' is exactly 80 wide, so it fits; 'dd' spills over.
		expect(wrapText('aa bb cc dd', 80, fixed)).toEqual(['aa bb cc', 'dd']);
		expect(wrapText('aa bb cc dd', 79, fixed)).toEqual(['aa bb', 'cc dd']);
	});

	it('honours explicit newlines', () => {
		expect(wrapText('one\ntwo', 1000, fixed)).toEqual(['one', 'two']);
	});

	it('preserves blank lines', () => {
		expect(wrapText('a\n\nb', 1000, fixed)).toEqual(['a', '', 'b']);
	});

	it('breaks a word too long for the box rather than overflowing', () => {
		// 8 characters at 10 each, in a 30-wide box.
		expect(wrapText('abcdefgh', 30, fixed)).toEqual(['abc', 'def', 'gh']);
	});

	it('never returns a line wider than the box', () => {
		const lines = wrapText(
			'short and a verylongunbreakableword plus more',
			60,
			fixed,
		);
		for (const line of lines) {
			expect(fixed(line)).toBeLessThanOrEqual(60);
		}
	});

	it('returns a single empty line for empty text', () => {
		expect(wrapText('', 100, fixed)).toEqual(['']);
	});

	it('survives a zero or negative width without looping', () => {
		expect(wrapText('ab', 0, fixed).length).toBeGreaterThan(0);
		expect(wrapText('ab', -50, fixed).length).toBeGreaterThan(0);
	});

	it('wraps Greek and symbols like any other text', () => {
		expect(wrapText('αβγ δεζ', 50, fixed)).toEqual(['αβγ', 'δεζ']);
		expect(wrapText('µ ±', 1000, fixed)).toEqual(['µ ±']);
	});
});

describe('metrics', () => {
	it('spaces lines by the font size times the line height', () => {
		expect(lineHeightFor(10)).toBeCloseTo(10 * LINE_HEIGHT, 9);
	});

	it('sizes a box from its line count', () => {
		expect(textHeightFor(3, 10)).toBeCloseTo(3 * lineHeightFor(10), 9);
		// An empty box still has one line's height.
		expect(textHeightFor(0, 10)).toBeCloseTo(lineHeightFor(10), 9);
	});
});

describe('layoutTextLines', () => {
	const box = { x: 100, y: 200, w: 60, h: 40 };

	it('puts the first baseline below the box top', () => {
		const [first] = layoutTextLines('ab', box, 10, fixed);
		expect(first).toBeDefined();
		if (!first) return;
		expect(first.x).toBe(100);
		// Top edge is y = 240 in PDF's y-up space.
		expect(first.y).toBeCloseTo(240 - 10 * BASELINE_RATIO, 9);
	});

	it('steps each following line downward', () => {
		const lines = layoutTextLines('aaa bbb ccc', box, 10, fixed);
		expect(lines.length).toBeGreaterThan(1);
		for (let i = 1; i < lines.length; i++) {
			const previous = lines[i - 1];
			const current = lines[i];
			if (!previous || !current) continue;
			// y decreases going down the page.
			expect(previous.y - current.y).toBeCloseTo(lineHeightFor(10), 9);
		}
	});

	it('wraps to the box width', () => {
		const lines = layoutTextLines('aaa bbb', { ...box, w: 40 }, 10, fixed);
		expect(lines.map((l) => l.text)).toEqual(['aaa', 'bbb']);
	});

	it('normalises a negative box', () => {
		const negative = { x: 160, y: 240, w: -60, h: -40 };
		const [fromNegative] = layoutTextLines('ab', negative, 10, fixed);
		const [fromPositive] = layoutTextLines('ab', box, 10, fixed);
		expect(fromNegative?.x).toBeCloseTo(fromPositive?.x ?? 0, 9);
		expect(fromNegative?.y).toBeCloseTo(fromPositive?.y ?? 0, 9);
	});

	it('scales with the font size', () => {
		const small = layoutTextLines('a\nb', box, 10, fixed);
		const large = layoutTextLines('a\nb', box, 20, fixed);
		const gap = (lines: typeof small): number =>
			(lines[0]?.y ?? 0) - (lines[1]?.y ?? 0);
		expect(gap(large)).toBeCloseTo(2 * gap(small), 9);
	});
});
