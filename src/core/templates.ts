/**
 * Ruling for inserted pages: blank, lined, grid and dot. Pure geometry.
 *
 * Every function returns lines and dots in PDF user space (points, y up, origin
 * at the page's bottom-left corner) so the canvas renderer and the pdf-lib
 * exporter consume exactly the same numbers. Anything else drifts: a template
 * drawn one way on screen and another way on export is a bug the user only finds
 * after printing.
 *
 * Colour is not geometry: the ruling is drawn in the page theme's grid colour
 * (src/core/theme.ts), chosen by whoever draws it.
 */

/** Points per millimetre: 72 pt/in over 25.4 mm/in. */
export const MM = 72 / 25.4;

/**
 * The six templates. The ruled ones differ only in spacing — 8 mm is the plain
 * "lined" default, with 7.5 mm and 10 mm as the tighter and looser rules.
 */
export type PageTemplate =
	| 'blank'
	| 'lined'
	| 'grid5'
	| 'dot'
	| 'lined7.5'
	| 'lined10';

export const PAGE_TEMPLATES: readonly PageTemplate[] = [
	'blank',
	'lined',
	'lined7.5',
	'lined10',
	'grid5',
	'dot',
];

export const TEMPLATE_LABELS: Record<PageTemplate, string> = {
	blank: 'Blank',
	lined: 'Lined',
	'lined7.5': 'Lined (7.5 mm)',
	lined10: 'Lined (10 mm)',
	grid5: 'Grid (5 mm)',
	dot: 'Dot grid (5 mm)',
};

export function isPageTemplate(value: unknown): value is PageTemplate {
	return (
		typeof value === 'string' &&
		PAGE_TEMPLATES.includes(value as PageTemplate)
	);
}

/** Spacing in millimetres, per template. Blank has none. */
const SPACING_MM: Record<PageTemplate, number> = {
	blank: 0,
	lined: 8,
	'lined7.5': 7.5,
	lined10: 10,
	grid5: 5,
	dot: 5,
};

/**
 * Breathing room at the page edge, in millimetres.
 *
 * Ruling that runs into the trim looks like a printing error, and on an inserted
 * page there is nothing else to give the eye an edge.
 */
const MARGIN_MM = 6;

/** Hairlines: present enough to write along, faint enough to ignore. */
const LINE_WIDTH = 0.4;
const DOT_RADIUS = 0.5;

export interface TemplateLine {
	readonly x1: number;
	readonly y1: number;
	readonly x2: number;
	readonly y2: number;
	/** A grid's every {@link MAJOR_EVERY}th line, kept when the rest are too dense to draw. */
	readonly major?: boolean;
}

export interface TemplateDot {
	readonly x: number;
	readonly y: number;
	/** On a major line both ways. */
	readonly major?: boolean;
}

/** Every this-many grid lines is a major one. */
export const MAJOR_EVERY = 5;

/** Grid spacing on screen, in CSS px, at or below which minor lines are not drawn. */
export const MINOR_HIDDEN_BELOW_PX = 8;
/** ...and at or above which they are drawn in full. Between the two they fade in. */
export const MINOR_SOLID_ABOVE_PX = 16;

/**
 * How strongly to draw a grid's minor lines when they are `spacingPx` CSS px
 * apart on screen: none when dense enough to turn the page grey, fading in as
 * the page is zoomed. Screen only; an export always draws the full grid.
 */
export function minorGridAlpha(spacingPx: number): number {
	if (!(spacingPx > MINOR_HIDDEN_BELOW_PX)) return 0;
	if (spacingPx >= MINOR_SOLID_ABOVE_PX) return 1;
	return (spacingPx - MINOR_HIDDEN_BELOW_PX) / (MINOR_SOLID_ABOVE_PX - MINOR_HIDDEN_BELOW_PX);
}

export interface TemplateGeometry {
	readonly lines: readonly TemplateLine[];
	readonly dots: readonly TemplateDot[];
	/** In PDF points. */
	readonly lineWidth: number;
	readonly dotRadius: number;
}

const EMPTY: TemplateGeometry = {
	lines: [],
	dots: [],
	lineWidth: LINE_WIDTH,
	dotRadius: DOT_RADIUS,
};

/**
 * The distance between rules or grid lines, in points; 0 for a blank page.
 *
 * A board grows by whole multiples of this, which is what keeps its existing
 * ruling exactly where it was: the grid is centred, so growing by a whole number
 * of cells adds cells without shifting any, and ruled lines hang from the top.
 */
export function templateSpacing(template: PageTemplate): number {
	return (SPACING_MM[template] ?? 0) * MM;
}

/** `geometry` moved by (dx, dy): the ruling of a page whose origin is not (0, 0). */
export function translateTemplate(
	geometry: TemplateGeometry,
	dx: number,
	dy: number,
): TemplateGeometry {
	if (dx === 0 && dy === 0) return geometry;
	return {
		...geometry,
		lines: geometry.lines.map((l) => ({ ...l, x1: l.x1 + dx, y1: l.y1 + dy, x2: l.x2 + dx, y2: l.y2 + dy })),
		dots: geometry.dots.map((d) => ({ ...d, x: d.x + dx, y: d.y + dy })),
	};
}

/**
 * The ruling for one page, in PDF user space.
 *
 * Total rather than throwing: an unknown template — from a sidecar written by a
 * newer build — rules the page blank instead of losing the page.
 */
export function templateGeometry(
	template: PageTemplate,
	width: number,
	height: number,
): TemplateGeometry {
	const margin = MARGIN_MM * MM;
	if (width <= 2 * margin || height <= 2 * margin) return EMPTY;
	const spacing = (SPACING_MM[template] ?? 0) * MM;
	if (spacing <= 0) return EMPTY;

	switch (template) {
		case 'lined':
		case 'lined7.5':
		case 'lined10':
			return { ...EMPTY, lines: ruledLines(width, height, margin, spacing) };
		case 'grid5':
			return { ...EMPTY, lines: gridLines(width, height, margin, spacing) };
		case 'dot':
			return { ...EMPTY, dots: gridDots(width, height, margin, spacing) };
		case 'blank':
			return EMPTY;
	}
}

/**
 * Horizontal rules, laid out downwards from the top margin the way a notebook is.
 *
 * Anchored to the top rather than centred vertically so that pages of different
 * heights still start writing at the same place.
 */
function ruledLines(
	width: number,
	height: number,
	margin: number,
	spacing: number,
): TemplateLine[] {
	const lines: TemplateLine[] = [];
	const left = margin;
	const right = width - margin;
	for (let y = height - margin - spacing; y >= margin; y -= spacing) {
		lines.push({ x1: left, y1: y, x2: right, y2: y });
	}
	return lines;
}

/**
 * Evenly spaced positions centred within `[margin, extent - margin]`.
 *
 * Centring rather than starting at the margin is what makes a grid look square to
 * the page instead of leaving one wide gutter on the far side.
 */
function centredTicks(extent: number, margin: number, spacing: number): number[] {
	const available = extent - 2 * margin;
	const count = Math.floor(available / spacing);
	if (count < 1) return [];
	const span = count * spacing;
	const start = margin + (available - span) / 2;
	const ticks: number[] = [];
	for (let i = 0; i <= count; i++) ticks.push(start + i * spacing);
	return ticks;
}

function gridLines(
	width: number,
	height: number,
	margin: number,
	spacing: number,
): TemplateLine[] {
	const xs = centredTicks(width, margin, spacing);
	const ys = centredTicks(height, margin, spacing);
	if (xs.length === 0 || ys.length === 0) return [];
	const top = ys[ys.length - 1] ?? 0;
	const bottom = ys[0] ?? 0;
	const left = xs[0] ?? 0;
	const right = xs[xs.length - 1] ?? 0;

	const lines: TemplateLine[] = [];
	xs.forEach((x, i) => {
		lines.push({ x1: x, y1: bottom, x2: x, y2: top, major: isMajorFromLeft(i) });
	});
	ys.forEach((y, j) => {
		lines.push({ x1: left, y1: y, x2: right, y2: y, major: isMajorFromTop(j, ys.length) });
	});
	return lines;
}

/*
 * Major lines are counted from the left and the top: the edges a board never
 * moves when it grows, so growing it never turns a major line minor.
 */
function isMajorFromLeft(i: number): boolean {
	return i % MAJOR_EVERY === 0;
}

function isMajorFromTop(j: number, count: number): boolean {
	return (count - 1 - j) % MAJOR_EVERY === 0;
}

function gridDots(
	width: number,
	height: number,
	margin: number,
	spacing: number,
): TemplateDot[] {
	const xs = centredTicks(width, margin, spacing);
	const ys = centredTicks(height, margin, spacing);
	const dots: TemplateDot[] = [];
	ys.forEach((y, j) => {
		xs.forEach((x, i) => {
			dots.push({ x, y, major: isMajorFromLeft(i) && isMajorFromTop(j, ys.length) });
		});
	});
	return dots;
}
