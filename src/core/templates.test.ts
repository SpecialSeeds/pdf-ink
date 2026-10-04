import { describe, expect, it } from 'vitest';
import {
	MM,
	PAGE_TEMPLATES,
	TEMPLATE_LABELS,
	isPageTemplate,
	templateGeometry,
} from './templates';

/** A4 in points, the size pdf.js reports for the fixtures. */
const A4_W = 595.28;
const A4_H = 841.89;

const MARGIN = 6 * MM;

describe('templateGeometry', () => {
	it('rules nothing for a blank page', () => {
		const geometry = templateGeometry('blank', A4_W, A4_H);
		expect(geometry.lines).toEqual([]);
		expect(geometry.dots).toEqual([]);
	});

	it('spaces ruled lines at the template spacing', () => {
		for (const [template, mm] of [
			['lined', 8],
			['lined7.5', 7.5],
			['lined10', 10],
		] as const) {
			const { lines } = templateGeometry(template, A4_W, A4_H);
			expect(lines.length).toBeGreaterThan(1);
			const first = lines[0];
			const second = lines[1];
			if (!first || !second) throw new Error('expected at least two rules');
			expect(first.y1 - second.y1).toBeCloseTo(mm * MM, 6);
		}
	});

	it('starts ruling one spacing below the top margin', () => {
		const { lines } = templateGeometry('lined10', A4_W, A4_H);
		const first = lines[0];
		if (!first) throw new Error('expected a rule');
		expect(first.y1).toBeCloseTo(A4_H - MARGIN - 10 * MM, 6);
	});

	it('draws ruled lines horizontally across the page inside the margin', () => {
		const { lines } = templateGeometry('lined', A4_W, A4_H);
		for (const line of lines) {
			expect(line.y1).toBe(line.y2);
			expect(line.x1).toBeCloseTo(MARGIN, 6);
			expect(line.x2).toBeCloseTo(A4_W - MARGIN, 6);
			expect(line.y1).toBeGreaterThanOrEqual(MARGIN);
			expect(line.y1).toBeLessThanOrEqual(A4_H - MARGIN);
		}
	});

	it('gives a grid both axes at one spacing', () => {
		const { lines } = templateGeometry('grid5', A4_W, A4_H);
		const vertical = lines.filter((line) => line.x1 === line.x2);
		const horizontal = lines.filter((line) => line.y1 === line.y2);
		expect(vertical.length).toBeGreaterThan(1);
		expect(horizontal.length).toBeGreaterThan(1);
		expect(vertical.length + horizontal.length).toBe(lines.length);

		const spacing = 5 * MM;
		const firstV = vertical[0];
		const secondV = vertical[1];
		const firstH = horizontal[0];
		const secondH = horizontal[1];
		if (!firstV || !secondV || !firstH || !secondH) {
			throw new Error('expected two lines on each axis');
		}
		expect(secondV.x1 - firstV.x1).toBeCloseTo(spacing, 6);
		expect(secondH.y1 - firstH.y1).toBeCloseTo(spacing, 6);
	});

	it('centres the grid, so the gutters on opposite edges match', () => {
		const { lines } = templateGeometry('grid5', A4_W, A4_H);
		const xs = lines.filter((line) => line.x1 === line.x2).map((line) => line.x1);
		const ys = lines.filter((line) => line.y1 === line.y2).map((line) => line.y1);
		const left = Math.min(...xs);
		const right = A4_W - Math.max(...xs);
		const bottom = Math.min(...ys);
		const top = A4_H - Math.max(...ys);
		expect(left).toBeCloseTo(right, 6);
		expect(bottom).toBeCloseTo(top, 6);
		expect(left).toBeGreaterThanOrEqual(MARGIN - 1e-9);
	});

	it('puts a dot at every grid intersection', () => {
		const grid = templateGeometry('grid5', A4_W, A4_H);
		const dotted = templateGeometry('dot', A4_W, A4_H);
		const columns = grid.lines.filter((line) => line.x1 === line.x2).length;
		const rows = grid.lines.filter((line) => line.y1 === line.y2).length;
		expect(dotted.dots).toHaveLength(columns * rows);
		expect(dotted.lines).toEqual([]);
	});

	it('keeps every dot inside the margin', () => {
		const { dots } = templateGeometry('dot', A4_W, A4_H);
		for (const dot of dots) {
			expect(dot.x).toBeGreaterThanOrEqual(MARGIN - 1e-9);
			expect(dot.x).toBeLessThanOrEqual(A4_W - MARGIN + 1e-9);
			expect(dot.y).toBeGreaterThanOrEqual(MARGIN - 1e-9);
			expect(dot.y).toBeLessThanOrEqual(A4_H - MARGIN + 1e-9);
		}
	});

	it('rules a landscape page across its longer axis', () => {
		const { lines } = templateGeometry('lined10', A4_H, A4_W);
		const first = lines[0];
		if (!first) throw new Error('expected a rule');
		expect(first.x2 - first.x1).toBeCloseTo(A4_H - 2 * MARGIN, 6);
	});

	it('rules nothing on a page too small for the margin', () => {
		const tiny = templateGeometry('grid5', 8, 8);
		expect(tiny.lines).toEqual([]);
		expect(tiny.dots).toEqual([]);
	});

	it('scales the ruling count with page height', () => {
		const a4 = templateGeometry('lined10', A4_W, A4_H).lines.length;
		const tall = templateGeometry('lined10', A4_W, A4_H * 2).lines.length;
		// Twice the height is more than twice the rules, since the margin is fixed.
		expect(tall).toBeGreaterThan(a4 * 2);
	});

	it('uses hairline widths, so ruling never competes with ink', () => {
		const geometry = templateGeometry('grid5', A4_W, A4_H);
		expect(geometry.lineWidth).toBeLessThan(1);
		expect(geometry.dotRadius).toBeLessThan(1);
	});
});

describe('the template list', () => {
	it('labels every template', () => {
		for (const template of PAGE_TEMPLATES) {
			expect(TEMPLATE_LABELS[template]).toBeTruthy();
		}
		expect(Object.keys(TEMPLATE_LABELS)).toHaveLength(PAGE_TEMPLATES.length);
	});

	it('recognises its own members and nothing else', () => {
		for (const template of PAGE_TEMPLATES) {
			expect(isPageTemplate(template)).toBe(true);
		}
		expect(isPageTemplate('squared')).toBe(false);
		expect(isPageTemplate(5)).toBe(false);
		expect(isPageTemplate(null)).toBe(false);
	});
});
