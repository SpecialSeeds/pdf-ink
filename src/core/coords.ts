/**
 * Coordinate conversion between pointer/canvas space and PDF user space.
 *
 * Pure: no DOM, no Obsidian, no pdf.js import. Everything here is unit tested.
 *
 * Three spaces are in play:
 *	- **client**   — `PointerEvent.clientX/Y`, viewport pixels.
 *	- **canvas**   — CSS pixels within a page's canvas, y DOWN from the top-left.
 *	- **PDF user** — points, y UP, origin at the viewBox's lower-left, which is
 *					 NOT necessarily (0, 0).
 *
 * Strokes are always stored in PDF user space, so they survive zoom, rotation and
 * re-rendering.
 */

import type { Matrix, Point, Rect } from '../types/pdfjs';

/** Anything that can map between canvas CSS px and PDF user space. */
export interface PointConverter {
	convertToPdfPoint(x: number, y: number): Point;
	convertToViewportPoint(x: number, y: number): Point;
}

/** `[a, b, c, d, e, f]` applied as `x' = ax + cy + e`, `y' = bx + dy + f`. */
export function applyTransform(point: Point, m: Matrix): Point {
	const [x, y] = point;
	return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function applyInverseTransform(point: Point, m: Matrix): Point {
	const [x, y] = point;
	const determinant = m[0] * m[3] - m[1] * m[2];
	if (determinant === 0) return [0, 0];
	return [
		(x * m[3] - y * m[2] + m[2] * m[5] - m[4] * m[3]) / determinant,
		(-x * m[1] + y * m[0] + m[4] * m[1] - m[5] * m[0]) / determinant,
	];
}

export interface PageTransformParams {
	/** page.view — CropBox intersected with MediaBox, in PDF user space. */
	readonly viewBox: Rect;
	readonly scale: number;
	/** 0, 90, 180 or 270. Other multiples of 90 are normalised. */
	readonly rotation: number;
	/** /UserUnit, which pdf.js folds into the scale. */
	readonly userUnit?: number;
	readonly offsetX?: number;
	readonly offsetY?: number;
	readonly dontFlip?: boolean;
}

export interface PageTransform extends PointConverter {
	readonly transform: Matrix;
	readonly width: number;
	readonly height: number;
	readonly scale: number;
	readonly rotation: number;
	readonly viewBox: Rect;
}

/**
 * Build a page transform with the same semantics as pdf.js's `PageViewport`.
 *
 * Production code uses the live `viewport` object from pdf.js, per the project
 * invariant. This exists because the same math is needed where no viewport is
 * available — the pdf-lib export pass — and because it makes the conversion
 * pipeline testable without loading pdf.js.
 */
export function createPageTransform(params: PageTransformParams): PageTransform {
	const { viewBox, rotation, userUnit = 1, offsetX = 0, offsetY = 0 } = params;
	const scale = params.scale * userUnit;

	const centerX = (viewBox[2] + viewBox[0]) / 2;
	const centerY = (viewBox[3] + viewBox[1]) / 2;

	let normalised = rotation % 360;
	if (normalised < 0) normalised += 360;

	let rotateA: number;
	let rotateB: number;
	let rotateC: number;
	let rotateD: number;
	switch (normalised) {
		case 180:
			rotateA = -1;
			rotateB = 0;
			rotateC = 0;
			rotateD = 1;
			break;
		case 90:
			rotateA = 0;
			rotateB = 1;
			rotateC = 1;
			rotateD = 0;
			break;
		case 270:
			rotateA = 0;
			rotateB = -1;
			rotateC = -1;
			rotateD = 0;
			break;
		case 0:
			rotateA = 1;
			rotateB = 0;
			rotateC = 0;
			// y flips: PDF space is y-up, canvas space is y-down.
			rotateD = -1;
			break;
		default:
			throw new Error(`Unsupported page rotation: ${String(rotation)}`);
	}

	if (params.dontFlip === true) {
		rotateC = -rotateC;
		rotateD = -rotateD;
	}

	let offsetCanvasX: number;
	let offsetCanvasY: number;
	let width: number;
	let height: number;
	if (rotateA === 0) {
		// Quarter turn: the page's width and height swap.
		offsetCanvasX = Math.abs(centerY - viewBox[1]) * scale + offsetX;
		offsetCanvasY = Math.abs(centerX - viewBox[0]) * scale + offsetY;
		width = (viewBox[3] - viewBox[1]) * scale;
		height = (viewBox[2] - viewBox[0]) * scale;
	} else {
		offsetCanvasX = Math.abs(centerX - viewBox[0]) * scale + offsetX;
		offsetCanvasY = Math.abs(centerY - viewBox[1]) * scale + offsetY;
		width = (viewBox[2] - viewBox[0]) * scale;
		height = (viewBox[3] - viewBox[1]) * scale;
	}

	// The translation terms fold in the viewBox origin, which is why a non-zero
	// MediaBox origin needs no special handling anywhere else.
	const transform: Matrix = [
		rotateA * scale,
		rotateB * scale,
		rotateC * scale,
		rotateD * scale,
		offsetCanvasX - rotateA * scale * centerX - rotateC * scale * centerY,
		offsetCanvasY - rotateB * scale * centerX - rotateD * scale * centerY,
	];

	return {
		transform,
		width,
		height,
		scale,
		rotation: normalised,
		viewBox,
		convertToPdfPoint: (x, y) => applyInverseTransform([x, y], transform),
		convertToViewportPoint: (x, y) => applyTransform([x, y], transform),
	};
}

/** The part of a DOMRect this module needs. */
export interface RectLike {
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
}

/**
 * Pointer client coordinates to canvas CSS pixels.
 *
 * `cssWidth`/`cssHeight` are the canvas's own CSS box. They are passed
 * separately rather than taken from the rect so that a CSS transform on an
 * ancestor — the zoom preview — cannot silently offset every sample.
 */
export function clientToCanvasPoint(
	rect: RectLike,
	clientX: number,
	clientY: number,
	cssWidth: number,
	cssHeight: number,
): Point {
	const scaleX = rect.width > 0 ? cssWidth / rect.width : 1;
	const scaleY = rect.height > 0 ? cssHeight / rect.height : 1;
	return [(clientX - rect.left) * scaleX, (clientY - rect.top) * scaleY];
}

/** Pressure given to a stored sample that has none, when loading a sidecar. */
export const DEFAULT_PRESSURE = 0.5;
