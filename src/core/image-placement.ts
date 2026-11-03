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
