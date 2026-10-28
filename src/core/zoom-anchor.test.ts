import { describe, expect, it } from 'vitest';
import { computeLayout, remapOffset } from './layout';

const GAP = 12;
const letter = { baseWidth: 612, baseHeight: 792 };
const pages = Array.from({ length: 120 }, () => letter);

describe('remapOffset', () => {
	it('keeps a point on page 100 on page 100 when zooming in', () => {
		const from = computeLayout(pages, 1, GAP);
		const to = computeLayout(pages, 2, GAP);
		const page = from.pages[99];
		const target = to.pages[99];
		if (!page || !target) throw new Error('no page');
		const y = page.offsetTop + page.cssHeight / 4;
		const mapped = remapOffset(from, to, y);
		expect(mapped).toBeCloseTo(target.offsetTop + target.cssHeight / 4, 6);
		// Scaling the whole offset, as before, lands about a page and a half away.
		expect(Math.abs(y * 2 - mapped)).toBeGreaterThan(target.cssHeight / 2);
	});

	it('keeps the same fraction of a page across mixed sizes', () => {
		const mixed = [letter, { baseWidth: 595, baseHeight: 1008 }, letter];
		const from = computeLayout(mixed, 0.8, GAP);
		const to = computeLayout(mixed, 1.7, GAP);
		const page = from.pages[1];
		const target = to.pages[1];
		if (!page || !target) throw new Error('no page');
		const mapped = remapOffset(from, to, page.offsetTop + page.cssHeight * 0.6);
		expect(mapped).toBeCloseTo(target.offsetTop + target.cssHeight * 0.6, 6);
	});

	it('keeps a point in a gap the same distance below its page', () => {
		const from = computeLayout(pages, 1, GAP);
		const to = computeLayout(pages, 3, GAP);
		const page = from.pages[4];
		const target = to.pages[4];
		if (!page || !target) throw new Error('no page');
		const mapped = remapOffset(from, to, page.offsetTop + page.cssHeight + 5);
		expect(mapped).toBeCloseTo(target.offsetTop + target.cssHeight + 5, 6);
	});

	it('maps the top of the document to the top', () => {
		const from = computeLayout(pages, 1, GAP);
		const to = computeLayout(pages, 2.5, GAP);
		expect(remapOffset(from, to, 0)).toBe(0);
	});

	it('leaves an offset alone when there are no pages', () => {
		const empty = computeLayout([], 1, GAP);
		expect(remapOffset(empty, empty, 40)).toBe(40);
	});
});
