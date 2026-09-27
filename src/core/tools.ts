/**
 * Tool selection and per-tool settings. Pure.
 */

import type { ShapeKind } from './items';
import type { ToolPreset } from './stroke';

export type ToolKind =
	| 'pen'
	| 'highlighter'
	| 'shape'
	| 'text'
	| 'eraser'
	| 'lasso';

/** The tools that own a colour, and so a persisted last-used colour. */
export type ColouredTool = 'pen' | 'highlighter' | 'shape' | 'text';

export const COLOURED_TOOLS: readonly ColouredTool[] = [
	'pen',
	'highlighter',
	'shape',
	'text',
];

export interface ToolSettings {
	color: string;
	/** Nib diameter in PDF points. */
	width: number;
}

export interface ShapeToolSettings extends ToolSettings {
	kind: ShapeKind;
}

/** 'stroke' deletes a whole item; 'sized' cuts away what the disc touches. */
export type EraserMode = 'stroke' | 'sized';

export interface EraserSettings {
	mode: EraserMode;
	/** Stroke-mode hit radius, in PDF points. */
	width: number;
	/** Sized-mode radius, in SCREEN pixels: it should feel the same at any zoom. */
	radiusPx: number;
}

export interface TextToolSettings {
	color: string;
	/** In PDF points. */
	fontSize: number;
	/** Width a tap-created box takes, in PDF points. */
	defaultWidth: number;
}

export interface ToolState {
	active: ToolKind;
	/** Each tool remembers its own colour and width. */
	pen: ToolSettings;
	highlighter: ToolSettings;
	shape: ShapeToolSettings;
	text: TextToolSettings;
	eraser: EraserSettings;
}

export interface NamedColor {
	readonly name: string;
	readonly value: string;
}

/** Always on the toolbar, one click away. */
export const QUICK_COLORS: readonly NamedColor[] = [
	{ name: 'Black', value: '#1f1f1f' },
	{ name: 'Red', value: '#c0392b' },
	{ name: 'Blue', value: '#1f6feb' },
	{ name: 'Yellow', value: '#e6b800' },
];

/** The twelve behind the chevron. */
export const EXTRA_COLORS: readonly NamedColor[] = [
	{ name: 'Grey', value: '#6b7280' },
	{ name: 'White', value: '#ffffff' },
	{ name: 'Maroon', value: '#7f1d1d' },
	{ name: 'Orange', value: '#ea580c' },
	{ name: 'Amber', value: '#f59e0b' },
	{ name: 'Lime', value: '#84cc16' },
	{ name: 'Green', value: '#158f48' },
	{ name: 'Teal', value: '#0d9488' },
	{ name: 'Cyan', value: '#06b6d4' },
	{ name: 'Indigo', value: '#4338ca' },
	{ name: 'Purple', value: '#8250df' },
	{ name: 'Pink', value: '#db2777' },
];

/** Translucent enough to read through, per the highlighter spec. */
export const HIGHLIGHTER_OPACITY = 0.35;

export interface WidthRange {
	readonly min: number;
	readonly max: number;
	readonly step: number;
}

export const WIDTH_RANGES: Record<ToolKind, WidthRange> = {
	pen: { min: 1, max: 12, step: 0.5 },
	highlighter: { min: 8, max: 40, step: 1 },
	shape: { min: 0.5, max: 12, step: 0.5 },
	// For text the slider is the font size.
	text: { min: 6, max: 72, step: 1 },
	eraser: { min: 6, max: 48, step: 1 },
	// The lasso has no size of its own; the slider is hidden for it.
	lasso: { min: 1, max: 1, step: 1 },
};

/** Sized-mode radius range, in screen pixels. */
export const SIZED_ERASER_RANGE: WidthRange = { min: 4, max: 60, step: 1 };

/**
 * The slider range for the active tool.
 *
 * The eraser is the only tool whose quantity changes meaning: stroke mode sets a
 * hit radius in PDF points, sized mode a disc radius in screen pixels.
 */
export function widthRangeFor(state: ToolState): WidthRange {
	if (state.active === 'eraser' && state.eraser.mode === 'sized') {
		return SIZED_ERASER_RANGE;
	}
	return WIDTH_RANGES[state.active];
}

/** The unit label for the active slider. */
export function widthUnitFor(state: ToolState): string {
	return state.active === 'eraser' && state.eraser.mode === 'sized' ? 'px' : 'pt';
}

export function toggleEraserMode(state: ToolState): EraserMode {
	state.eraser.mode = state.eraser.mode === 'stroke' ? 'sized' : 'stroke';
	return state.eraser.mode;
}

export function defaultToolState(): ToolState {
	return {
		active: 'pen',
		pen: { color: '#1f1f1f', width: 2 },
		highlighter: { color: '#e6b800', width: 16 },
		shape: { color: '#1f1f1f', width: 2, kind: 'line' },
		text: { color: '#1f1f1f', fontSize: 12, defaultWidth: 180 },
		eraser: { mode: 'stroke', width: 18, radiusPx: 16 },
	};
}

/** The tool whose colour a swatch click changes, or null for the eraser. */
export function colouredTool(state: ToolState): ColouredTool | null {
	if (state.active === 'eraser' || state.active === 'lasso') return null;
	return state.active;
}

export function activeWidth(state: ToolState): number {
	switch (state.active) {
		case 'pen':
			return state.pen.width;
		case 'highlighter':
			return state.highlighter.width;
		case 'shape':
			return state.shape.width;
		case 'text':
			return state.text.fontSize;
		case 'eraser':
			return state.eraser.mode === 'sized'
				? state.eraser.radiusPx
				: state.eraser.width;
		case 'lasso':
			return 1;
	}
}

export function activeColor(state: ToolState): string | null {
	const tool = colouredTool(state);
	return tool === null ? null : state[tool].color;
}

export function setActiveWidth(state: ToolState, width: number): void {
	const range = widthRangeFor(state);
	const clamped = Math.min(range.max, Math.max(range.min, width));
	switch (state.active) {
		case 'pen':
			state.pen.width = clamped;
			break;
		case 'highlighter':
			state.highlighter.width = clamped;
			break;
		case 'shape':
			state.shape.width = clamped;
			break;
		case 'text':
			state.text.fontSize = clamped;
			break;
		case 'eraser':
			if (state.eraser.mode === 'sized') state.eraser.radiusPx = clamped;
			else state.eraser.width = clamped;
			break;
		case 'lasso':
			break;
	}
}

/** Applies to the active tool only; the eraser has no colour. */
export function setActiveColor(state: ToolState, color: string): void {
	const tool = colouredTool(state);
	if (tool !== null) state[tool].color = color;
}

/** The stroke preset for a freehand tool, or null for shapes and the eraser. */
/** The colour and size a new text box takes. */
export function textSettings(state: ToolState): TextToolSettings {
	return state.text;
}

export function presetFor(state: ToolState): ToolPreset | null {
	if (state.active === 'pen') {
		return {
			tool: 'pen',
			color: state.pen.color,
			width: state.pen.width,
			opacity: 1,
		};
	}
	if (state.active === 'highlighter') {
		return {
			tool: 'highlighter',
			color: state.highlighter.color,
			width: state.highlighter.width,
			opacity: HIGHLIGHTER_OPACITY,
		};
	}
	return null;
}

/** Eraser hit radius in PDF points. */
export function eraserRadius(state: ToolState): number {
	return state.eraser.width / 2;
}
