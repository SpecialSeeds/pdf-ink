import { describe, expect, it } from 'vitest';
import type { Point, Rect } from '../types/pdfjs';
import {
	DEFAULT_PRESSURE,
	applyInverseTransform,
	applyTransform,
	clientToCanvasPoint,
	createPageTransform,
	normalizePressure,
} from './coords';

/** US Letter, origin at (0, 0). */
const LETTER: Rect = [0, 0, 612, 792];

/**
 * Page 1 of the cropped_mediabox.pdf fixture. CropBox equals MediaBox here, but
 * the origin is NOT (0, 0) — verified directly against the file.
 */
const OFFSET_BOX: Rect = [53.18, 97.03, 591.91, 702.28];

const ROTATIONS = [0, 90, 180, 270] as const;

function closeTo(actual: Point, expected: Point, precision = 6): void {
	expect(actual[0]).toBeCloseTo(expected[0], precision);
	expect(actual[1]).toBeCloseTo(expected[1], precision);
}

describe('applyTransform / applyInverseTransform', () => {
	it('round-trips through an arbitrary invertible matrix', () => {
		const m = [2, 0.5, -0.25, 3, 17, -9] as const;
		for (const p of [
			[0, 0],
			[1, 1],
			[-13.5, 42.25],
			[612, 792],
		] as Point[]) {
			closeTo(applyInverseTransform(applyTransform(p, [...m]), [...m]), p);
		}
	});

	it('returns the origin rather than NaN for a degenerate matrix', () => {
		// A zero determinant has no inverse; callers must not see NaN leak into
		// stored stroke data.
		expect(applyInverseTransform([5, 5], [0, 0, 0, 0, 0, 0])).toEqual([0, 0]);
	});
});

describe('createPageTransform — page size', () => {
	it('keeps width and height for 0 and 180', () => {
		for (const rotation of [0, 180]) {
			const vp = createPageTransform({ viewBox: LETTER, scale: 1, rotation });
			expect([vp.width, vp.height]).toEqual([612, 792]);
		}
	});

	it('swaps width and height for 90 and 270', () => {
		for (const rotation of [90, 270]) {
			const vp = createPageTransform({ viewBox: LETTER, scale: 1, rotation });
			expect([vp.width, vp.height]).toEqual([792, 612]);
		}
	});

	it('scales both axes', () => {
		const vp = createPageTransform({ viewBox: LETTER, scale: 2, rotation: 0 });
		expect([vp.width, vp.height]).toEqual([1224, 1584]);
	});

	it('folds /UserUnit into the scale, as pdf.js does', () => {
		const vp = createPageTransform({
			viewBox: LETTER,
			scale: 1,
			rotation: 0,
			userUnit: 2,
		});
		expect([vp.width, vp.height]).toEqual([1224, 1584]);
		expect(vp.scale).toBe(2);
	});

	it('normalises equivalent rotations', () => {
		expect(createPageTransform({ viewBox: LETTER, scale: 1, rotation: 360 }).rotation).toBe(0);
		expect(createPageTransform({ viewBox: LETTER, scale: 1, rotation: -90 }).rotation).toBe(270);
		expect(createPageTransform({ viewBox: LETTER, scale: 1, rotation: 450 }).rotation).toBe(90);
	});

	it('rejects a rotation that is not a quarter turn', () => {
		expect(() =>
			createPageTransform({ viewBox: LETTER, scale: 1, rotation: 45 }),
		).toThrow(/rotation/i);
	});
});

describe('createPageTransform — rotation 0', () => {
	const vp = createPageTransform({ viewBox: LETTER, scale: 1, rotation: 0 });

	it('flips y: canvas top-left is the PDF upper-left', () => {
		closeTo(vp.convertToPdfPoint(0, 0), [0, 792]);
	});

	it('maps the PDF origin to the canvas bottom-left', () => {
		closeTo(vp.convertToViewportPoint(0, 0), [0, 792]);
	});

	it('moving DOWN the canvas decreases the PDF y', () => {
		const top = vp.convertToPdfPoint(100, 10);
		const bottom = vp.convertToPdfPoint(100, 700);
		expect(bottom[1]).toBeLessThan(top[1]);
		expect(top[0]).toBeCloseTo(bottom[0], 6);
	});

	it('moving RIGHT increases the PDF x', () => {
		expect(vp.convertToPdfPoint(500, 100)[0]).toBeGreaterThan(
			vp.convertToPdfPoint(100, 100)[0],
		);
	});
});

describe('createPageTransform — quarter turns place the PDF origin correctly', () => {
	// With the page rotated, the PDF origin (lower-left of the unrotated page)
	// lands on a different canvas corner. These are the four cases.
	const cases: { rotation: number; origin: Point; far: Point }[] = [
		{ rotation: 0, origin: [0, 792], far: [612, 0] },
		{ rotation: 90, origin: [0, 0], far: [792, 612] },
		{ rotation: 180, origin: [612, 0], far: [0, 792] },
		{ rotation: 270, origin: [792, 612], far: [0, 0] },
	];

	for (const { rotation, origin, far } of cases) {
		it(`rotation ${String(rotation)} puts PDF (0,0) at canvas (${origin.join(',')})`, () => {
			const vp = createPageTransform({ viewBox: LETTER, scale: 1, rotation });
			closeTo(vp.convertToViewportPoint(0, 0), origin);
			closeTo(vp.convertToViewportPoint(612, 792), far);
		});
	}
});

describe('createPageTransform — round-trips for every rotation', () => {
	for (const rotation of ROTATIONS) {
		for (const scale of [1, 0.5, 2.75]) {
			it(`rotation ${String(rotation)} at scale ${String(scale)} round-trips`, () => {
				const vp = createPageTransform({ viewBox: LETTER, scale, rotation });
				// Sample across the whole canvas, including the corners.
				for (const fx of [0, 0.25, 0.5, 0.77, 1]) {
					for (const fy of [0, 0.33, 0.5, 1]) {
						const canvas: Point = [vp.width * fx, vp.height * fy];
						const pdf = vp.convertToPdfPoint(canvas[0], canvas[1]);
						closeTo(vp.convertToViewportPoint(pdf[0], pdf[1]), canvas, 4);
					}
				}
			});
		}
	}

	it('every rotation keeps samples inside the page box', () => {
		for (const rotation of ROTATIONS) {
			const vp = createPageTransform({ viewBox: LETTER, scale: 1, rotation });
			for (const fx of [0, 0.5, 1]) {
				for (const fy of [0, 0.5, 1]) {
					const [x, y] = vp.convertToPdfPoint(vp.width * fx, vp.height * fy);
					expect(x).toBeGreaterThanOrEqual(LETTER[0] - 1e-6);
					expect(x).toBeLessThanOrEqual(LETTER[2] + 1e-6);
					expect(y).toBeGreaterThanOrEqual(LETTER[1] - 1e-6);
					expect(y).toBeLessThanOrEqual(LETTER[3] + 1e-6);
				}
			}
		}
	});
});

describe('createPageTransform — non-zero MediaBox origin', () => {
	it('canvas (0,0) maps to the viewBox upper-left, not to (0,0)', () => {
		const vp = createPageTransform({ viewBox: OFFSET_BOX, scale: 1, rotation: 0 });
		// The exact values pdf.js produces for this fixture page.
		closeTo(vp.convertToPdfPoint(0, 0), [53.18, 702.28], 4);
		expect(vp.width).toBeCloseTo(538.73, 4);
		expect(vp.height).toBeCloseTo(605.25, 4);
	});

	it('never yields a point outside the viewBox, for any rotation', () => {
		for (const rotation of ROTATIONS) {
			const vp = createPageTransform({
				viewBox: OFFSET_BOX,
				scale: 1.5,
				rotation,
			});
			for (const fx of [0, 0.5, 1]) {
				for (const fy of [0, 0.5, 1]) {
					const [x, y] = vp.convertToPdfPoint(vp.width * fx, vp.height * fy);
					expect(x).toBeGreaterThanOrEqual(OFFSET_BOX[0] - 1e-6);
					expect(x).toBeLessThanOrEqual(OFFSET_BOX[2] + 1e-6);
					expect(y).toBeGreaterThanOrEqual(OFFSET_BOX[1] - 1e-6);
					expect(y).toBeLessThanOrEqual(OFFSET_BOX[3] + 1e-6);
				}
			}
		}
	});

	it('round-trips for every rotation', () => {
		for (const rotation of ROTATIONS) {
			const vp = createPageTransform({
				viewBox: OFFSET_BOX,
				scale: 1.25,
				rotation,
			});
			for (const canvas of [
				[0, 0],
				[vp.width, 0],
				[0, vp.height],
				[vp.width, vp.height],
				[vp.width / 3, vp.height / 7],
			] as Point[]) {
				const pdf = vp.convertToPdfPoint(canvas[0], canvas[1]);
				closeTo(vp.convertToViewportPoint(pdf[0], pdf[1]), canvas, 4);
			}
		}
	});

	it('is scale-invariant in PDF space: zoom must not move a stroke', () => {
		// The same fractional position on the page must produce the same PDF
		// point at any zoom. This is what makes stored strokes survive zooming.
		for (const rotation of ROTATIONS) {
			const a = createPageTransform({ viewBox: OFFSET_BOX, scale: 1, rotation });
			const b = createPageTransform({ viewBox: OFFSET_BOX, scale: 3.5, rotation });
			for (const [fx, fy] of [
				[0.1, 0.2],
				[0.5, 0.5],
				[0.9, 0.75],
			]) {
				closeTo(
					b.convertToPdfPoint(b.width * (fx ?? 0), b.height * (fy ?? 0)),
					a.convertToPdfPoint(a.width * (fx ?? 0), a.height * (fy ?? 0)),
					4,
				);
			}
		}
	});
});

describe('clientToCanvasPoint', () => {
	it('subtracts the element origin', () => {
		const rect = { left: 40, top: 100, width: 200, height: 400 };
		closeTo(clientToCanvasPoint(rect, 60, 150, 200, 400), [20, 50]);
	});

	it('corrects for an ancestor CSS transform stretching the rect', () => {
		// The element is 200x400 CSS px but is being displayed at 2x by the zoom
		// preview, so a pointer 100px into the rect is 50px into the canvas.
		const rect = { left: 0, top: 0, width: 400, height: 800 };
		closeTo(clientToCanvasPoint(rect, 100, 200, 200, 400), [50, 100]);
	});

	it('falls back to 1:1 for a zero-sized rect', () => {
		const rect = { left: 10, top: 10, width: 0, height: 0 };
		closeTo(clientToCanvasPoint(rect, 30, 40, 200, 400), [20, 30]);
	});
});

describe('normalizePressure', () => {
	it('pins a mouse to the default, whatever it reports', () => {
		for (const reported of [0, 0.5, 1, Number.NaN]) {
			expect(normalizePressure(reported, 'mouse')).toBe(DEFAULT_PRESSURE);
		}
	});

	it('passes a pen through', () => {
		expect(normalizePressure(0.25, 'pen')).toBe(0.25);
		expect(normalizePressure(1, 'pen')).toBe(1);
	});

	it('substitutes the default when a pen reports zero', () => {
		// A zero-pressure sample would render an invisible, zero-width stroke.
		expect(normalizePressure(0, 'pen')).toBe(DEFAULT_PRESSURE);
		expect(normalizePressure(-1, 'pen')).toBe(DEFAULT_PRESSURE);
		expect(normalizePressure(Number.NaN, 'touch')).toBe(DEFAULT_PRESSURE);
	});

	it('clamps above 1', () => {
		expect(normalizePressure(4, 'pen')).toBe(1);
	});
});

describe('pressure dropouts', () => {
	it('carries the previous pressure through a zero reading', () => {
		// WebKit drops the occasional zero into an Apple Pencil stroke. Substituting
		// a fixed default for those made the width lurch and beaded the line.
		expect(normalizePressure(0, 'pen', 0.12)).toBeCloseTo(0.12, 6);
		expect(normalizePressure(0, 'pen', 0.9)).toBeCloseTo(0.9, 6);
	});

	it('still falls back to the default at the start of a stroke', () => {
		expect(normalizePressure(0, 'pen')).toBe(DEFAULT_PRESSURE);
		expect(normalizePressure(0, 'touch')).toBe(DEFAULT_PRESSURE);
	});

	it('ignores an unusable fallback', () => {
		for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(normalizePressure(0, 'pen', bad)).toBe(DEFAULT_PRESSURE);
		}
	});

	it('clamps a fallback above 1', () => {
		expect(normalizePressure(0, 'pen', 4)).toBe(1);
	});

	it('prefers a real reading over the fallback', () => {
		expect(normalizePressure(0.3, 'pen', 0.9)).toBeCloseTo(0.3, 6);
	});

	it('still pins a mouse to the default, fallback or not', () => {
		expect(normalizePressure(0, 'mouse', 0.9)).toBe(DEFAULT_PRESSURE);
		expect(normalizePressure(0.8, 'mouse', 0.9)).toBe(DEFAULT_PRESSURE);
	});
});
