import { describe, expect, it } from 'vitest';
import { syntheticViewport } from './page-viewport';

describe('syntheticViewport', () => {
	it('reports the page size at scale 1', () => {
		const viewport = syntheticViewport(595.28, 841.89);
		expect(viewport.width).toBeCloseTo(595.28, 6);
		expect(viewport.height).toBeCloseTo(841.89, 6);
		expect(viewport.scale).toBe(1);
		expect(viewport.rotation).toBe(0);
		expect(viewport.viewBox).toEqual([0, 0, 595.28, 841.89]);
	});

	it('scales like pdf.js: size multiplies, PDF space does not', () => {
		const viewport = syntheticViewport(100, 200, 2);
		expect(viewport.width).toBe(200);
		expect(viewport.height).toBe(400);
		// The bottom-left of the page is the bottom-left of the viewport.
		expect(viewport.convertToPdfPoint(0, 400)).toEqual([0, 0]);
		expect(viewport.convertToPdfPoint(200, 0)).toEqual([100, 200]);
	});

	it('flips y, so viewport top is PDF top', () => {
		const viewport = syntheticViewport(100, 200);
		expect(viewport.convertToPdfPoint(0, 0)).toEqual([0, 200]);
		expect(viewport.convertToPdfPoint(0, 200)).toEqual([0, 0]);
		expect(viewport.convertToViewportPoint(0, 200)).toEqual([0, 0]);
		expect(viewport.convertToViewportPoint(0, 0)).toEqual([0, 200]);
	});

	it('round-trips both ways at any scale', () => {
		for (const scale of [0.25, 1, 1.3333, 4]) {
			const viewport = syntheticViewport(612, 792, scale);
			for (const [x, y] of [
				[0, 0],
				[306, 396],
				[612, 792],
				[17.5, 613.25],
			] as const) {
				const [vx, vy] = viewport.convertToViewportPoint(x, y);
				const [px, py] = viewport.convertToPdfPoint(vx, vy);
				expect(px).toBeCloseTo(x, 6);
				expect(py).toBeCloseTo(y, 6);
			}
		}
	});

	it('agrees with its own transform matrix', () => {
		// The matrix is what pdf.js hands the canvas, so it must describe the same
		// mapping as convertToViewportPoint or rendering and ink would disagree.
		const viewport = syntheticViewport(300, 500, 1.5);
		const [a, b, c, d, e, f] = viewport.transform;
		for (const [x, y] of [
			[0, 0],
			[300, 500],
			[123.5, 77.25],
		] as const) {
			const [vx, vy] = viewport.convertToViewportPoint(x, y);
			expect(a * x + c * y + e).toBeCloseTo(vx, 6);
			expect(b * x + d * y + f).toBeCloseTo(vy, 6);
		}
	});

	it('clones to a new scale, keeping the page size', () => {
		const base = syntheticViewport(200, 400);
		const zoomed = base.clone({ scale: 3 });
		expect(zoomed.width).toBe(600);
		expect(zoomed.height).toBe(1200);
		expect(zoomed.convertToPdfPoint(600, 0)).toEqual([200, 400]);
		// The original is untouched, as pdf.js's clone is.
		expect(base.width).toBe(200);
	});

	it('clones with no arguments to an identical viewport', () => {
		const base = syntheticViewport(200, 400, 2);
		const copy = base.clone();
		expect(copy.width).toBe(base.width);
		expect(copy.scale).toBe(base.scale);
	});

	it('honours an offset in both directions', () => {
		const viewport = syntheticViewport(100, 100, 1, 10, 20);
		expect(viewport.convertToViewportPoint(0, 100)).toEqual([10, 20]);
		expect(viewport.convertToPdfPoint(10, 20)).toEqual([0, 100]);
	});

	it('ignores a rotation request rather than lying about one', () => {
		// Inserted pages are created upright and have no /Rotate to honour.
		const rotated = syntheticViewport(100, 200).clone({ rotation: 90 });
		expect(rotated.rotation).toBe(0);
		expect(rotated.width).toBe(100);
	});

	it('never reports a zero-area page, which would stall virtualization', () => {
		const viewport = syntheticViewport(0, 0, 0);
		expect(viewport.width).toBeGreaterThan(0);
		expect(viewport.height).toBeGreaterThan(0);
		expect(viewport.scale).toBeGreaterThan(0);
	});
});
