/**
 * Where an inserted picture lands. Pure.
 */

import type { Bounds } from './hit-test';
import type { Box } from './items';

/** CSS px to PDF points: a picture comes in at the size a browser would show it. */
export const POINTS_PER_PX = 0.75;

/** The most of the page's width or height a new picture covers. */
export const MAX_PAGE_FRACTION = 0.6;

/**
 * The box a picture of `width` by `height` pixels takes on a page: its natural
 * size, shrunk to fit {@link MAX_PAGE_FRACTION} of the page with its proportions
 * kept, centred on `centre` and then pulled inside the page.
 */
export function placeImage(
	width: number,
	height: number,
	page: Bounds,
	centre: readonly [number, number],
): Box {
	const pageW = page.maxX - page.minX;
	const pageH = page.maxY - page.minY;
	const naturalW = Math.max(1, width) * POINTS_PER_PX;
	const naturalH = Math.max(1, height) * POINTS_PER_PX;
	const fit = Math.min(
		1,
		(pageW * MAX_PAGE_FRACTION) / naturalW,
		(pageH * MAX_PAGE_FRACTION) / naturalH,
	);
	const w = naturalW * fit;
	const h = naturalH * fit;
	const x = clamp(centre[0] - w / 2, page.minX, page.maxX - w);
	const y = clamp(centre[1] - h / 2, page.minY, page.maxY - h);
	return { x, y, w, h };
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), Math.max(min, max));
}

/** The gap between pictures placed together, in points. */
export const IMAGE_GAP = 12;

/**
 * Boxes for several pictures placed at once: a grid as square as the count
 * allows, in the order given (left to right, top down), centred on `centre` and
 * pulled inside the page as a whole. Each picture keeps its proportions and is
 * shrunk to fit its cell, so together they cover no more of the page than one
 * picture would. One picture is exactly {@link placeImage}.
 */
export function placeImages(
	sizes: readonly { readonly width: number; readonly height: number }[],
	page: Bounds,
	centre: readonly [number, number],
): Box[] {
	if (sizes.length === 0) return [];
	if (sizes.length === 1) {
		const [only] = sizes;
		return only ? [placeImage(only.width, only.height, page, centre)] : [];
	}
	const cols = Math.ceil(Math.sqrt(sizes.length));
	const rows = Math.ceil(sizes.length / cols);
	const pageW = page.maxX - page.minX;
	const pageH = page.maxY - page.minY;
	const cellW = Math.max(1, (pageW * MAX_PAGE_FRACTION - IMAGE_GAP * (cols - 1)) / cols);
	const cellH = Math.max(1, (pageH * MAX_PAGE_FRACTION - IMAGE_GAP * (rows - 1)) / rows);

	const fitted = sizes.map(({ width, height }) => {
		const naturalW = Math.max(1, width) * POINTS_PER_PX;
		const naturalH = Math.max(1, height) * POINTS_PER_PX;
		const fit = Math.min(1, cellW / naturalW, cellH / naturalH);
		return { w: naturalW * fit, h: naturalH * fit };
	});
	// Columns as wide as their widest picture, rows as tall as their tallest.
	const colW = Array.from({ length: cols }, () => 0);
	const rowH = Array.from({ length: rows }, () => 0);
	fitted.forEach(({ w, h }, i) => {
		const c = i % cols;
		const r = Math.floor(i / cols);
		colW[c] = Math.max(colW[c] ?? 0, w);
		rowH[r] = Math.max(rowH[r] ?? 0, h);
	});
	const totalW = colW.reduce((a, b) => a + b, 0) + IMAGE_GAP * (cols - 1);
	const totalH = rowH.reduce((a, b) => a + b, 0) + IMAGE_GAP * (rows - 1);
	const left = clamp(centre[0] - totalW / 2, page.minX, page.maxX - totalW);
	// PDF space has y up: the first row is the top one.
	const top = clamp(centre[1] + totalH / 2, page.minY + totalH, page.maxY);

	return fitted.map(({ w, h }, i) => {
		const c = i % cols;
		const r = Math.floor(i / cols);
		let x = left;
		for (let k = 0; k < c; k++) x += (colW[k] ?? 0) + IMAGE_GAP;
		let yTop = top;
		for (let k = 0; k < r; k++) yTop -= (rowH[k] ?? 0) + IMAGE_GAP;
		// Centred in its cell.
		const cx = x + ((colW[c] ?? 0) - w) / 2;
		const cy = yTop - ((rowH[r] ?? 0) + h) / 2;
		return { x: cx, y: cy, w, h };
	});
}
