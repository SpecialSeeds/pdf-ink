/**
 * Stroke geometry and construction. Pure.
 *
 * The data model itself lives in items.ts; this module is the stroke-specific
 * behaviour that both the canvas renderer and the eraser's hit testing consume.
 */

import { getStroke } from 'perfect-freehand';
import type { StrokeOptions, Vec2 } from 'perfect-freehand';
import type { PointConverter } from './coords';
import { type InkTool, type Stroke, type StrokeSample, systemClock } from './items';

/** Everything the active tool contributes to a new stroke. */
export interface ToolPreset {
	readonly tool: InkTool;
	readonly color: string;
	readonly width: number;
	readonly opacity: number;
}

/** Default nib. Width is in PDF points, so it scales with the page. */
export const DEFAULT_PEN: ToolPreset = {
	tool: 'pen',
	color: '#1f1f1f',
	width: 2,
	opacity: 1,
};

let idCounter = 0;

export function createStrokeId(): string {
	idCounter += 1;
	return `${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

export function createStroke(
	preset: ToolPreset,
	id = createStrokeId(),
	now = systemClock(),
): Stroke {
	return {
		type: 'stroke',
		id,
		tool: preset.tool,
		color: preset.color,
		width: preset.width,
		opacity: preset.opacity,
		// Strokes are captured already baked into PDF space, so they are never
		// separately rotated. z is assigned by the store when the item is added.
		rotation: 0,
		z: 0,
		updatedAt: now,
		points: [],
		// Always present so a stroke round-trips through JSON unchanged; only a
		// sized erase ever sets them true.
		cutStart: false,
		cutEnd: false,
	};
}

/**
 * Project stored PDF-space samples back into canvas CSS pixels for drawing.
 * Pressure is carried through untouched.
 */
export function toCanvasSamples(
	stroke: Stroke,
	converter: PointConverter,
): StrokeSample[] {
	return stroke.points.map(([x, y, pressure]) => {
		const [cssX, cssY] = converter.convertToViewportPoint(x, y);
		return [cssX, cssY, pressure] satisfies StrokeSample;
	});
}

/**
 * The pressure every sample is recorded at.
 *
 * Ink is constant width: stylus pressure made strokes lurch between hairline and
 * full weight as the reading wandered, which read as glitchy handwriting rather
 * than expression. The third coordinate stays in the schema so older sidecars
 * still load, but nothing varies with it.
 */
export const FLAT_PRESSURE = 1;

/** No stroke is ever drawn thinner than this, in CSS px. Below it, ink dots. */
export const MIN_VISIBLE_STROKE_CSS = 1.4;

export interface CutEnds {
	readonly start?: boolean;
	readonly end?: boolean;
}

function strokeOptionsFor(
	sizeCss: number,
	complete: boolean,
	_tool: InkTool,
	cut?: CutEnds,
	/** The narrowest the stroke may draw, in the same units as `sizeCss`. */
	minSize = MIN_VISIBLE_STROKE_CSS,
): StrokeOptions {
	return {
		size: Math.max(minSize, sizeCss),
		// Constant width for every tool, whatever pressure an older stroke stored.
		thinning: 0,
		smoothing: 0.5,
		streamline: 0.5,
		// Nor may perfect-freehand invent pressure from velocity.
		simulatePressure: false,
		// A cut end is blunt: it was sliced by the eraser, not lifted off the page.
		start: { cap: true, taper: cut?.start === true ? false : 0 },
		end: { cap: true, taper: cut?.end === true ? false : 0 },
		// Tells perfect-freehand the stroke is finished so it can close the tail
		// properly; passing true mid-stroke makes the live end jitter.
		last: complete,
	};
}

/** Options a caller can inspect, so cut ends are testable. */
export function strokeOptions(
	sizeCss: number,
	complete: boolean,
	tool: InkTool,
	cut?: CutEnds,
): StrokeOptions {
	return strokeOptionsFor(sizeCss, complete, tool, cut);
}

/** The filled outline of a stroke, in whatever space `samples` are given in. */
export function strokeOutline(
	samples: readonly StrokeSample[],
	sizeCss: number,
	complete: boolean,
	tool: InkTool = 'pen',
	cut?: CutEnds,
): Vec2[] {
	if (samples.length === 0) return [];
	return getStroke(
		samples.map(([x, y]) => [x, y, FLAT_PRESSURE]),
		strokeOptionsFor(sizeCss, complete, tool, cut),
	);
}

/**
 * Units per point that a stroke's outline is worked out in, for the screen.
 *
 * perfect-freehand drops points that lie within one unit of each other, which
 * in points would round the corners off handwriting; in quarter points it
 * matches the outline worked out at the display's own scale, which is what the
 * screen used to compute on every repaint.
 */
export const OUTLINE_UNITS = 4;

/**
 * A committed stroke's outline in PDF space, for drawing at any zoom: worked
 * out once and drawn through the viewport, rather than again at every repaint
 * and every zoom. `minWidth` is the narrowest it may draw, in points: the
 * screen's minimum visible width at the current zoom.
 */
export function strokeOutlinePdf(stroke: Stroke, minWidth: number): Vec2[] {
	if (stroke.points.length === 0) return [];
	const k = OUTLINE_UNITS;
	const outline = getStroke(
		stroke.points.map(([x, y]) => [x * k, y * k, FLAT_PRESSURE]),
		strokeOptionsFor(
			stroke.width * k,
			true,
			stroke.tool,
			{ start: stroke.cutStart, end: stroke.cutEnd },
			minWidth * k,
		),
	);
	return outline.map(([x, y]) => [x / k, y / k]);
}

/**
 * SVG path data for a closed outline, using midpoint quadratics so the polygon
 * perfect-freehand returns reads as a smooth nib rather than a faceted one.
 */
export function outlineToPathData(outline: readonly Vec2[]): string {
	const first = outline[0];
	if (first === undefined) return '';

	const parts: string[] = [`M ${round(first[0])} ${round(first[1])}`];
	if (outline.length === 1) {
		// A single tap still has to leave a mark.
		parts.push(`L ${round(first[0] + 0.01)} ${round(first[1])}`);
	}
	for (let i = 0; i < outline.length; i++) {
		const a = outline[i];
		const b = outline[(i + 1) % outline.length];
		if (a === undefined || b === undefined) continue;
		parts.push(
			`Q ${round(a[0])} ${round(a[1])} ${round((a[0] + b[0]) / 2)} ${round((a[1] + b[1]) / 2)}`,
		);
	}
	parts.push('Z');
	return parts.join(' ');
}

function round(value: number): string {
	return (Math.round(value * 100) / 100).toString();
}
