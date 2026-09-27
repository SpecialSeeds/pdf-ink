/**
 * Plugin settings: shape, defaults, and the merge that loads them. Pure — no
 * Obsidian import, so it is unit testable. The settings *tab* lives in
 * src/settings.ts.
 */

import { BUFFER_PAGES } from '../constants';
import {
	COLOURED_TOOLS,
	type ColouredTool,
	type EraserMode,
	SIZED_ERASER_RANGE,
	WIDTH_RANGES,
	defaultToolState,
} from './tools';

export type DefaultZoomMode = 'fit-width' | 'actual-size';

export interface PdfInkSettings {
	/** Zoom a PDF opens at when the workspace has no saved zoom for it. */
	defaultZoomMode: DefaultZoomMode;
	/** Pages kept rendered on each side of the visible range. */
	bufferPages: number;
	/** Last colour used with each tool, so it survives reopening a PDF. */
	toolColors: Record<ColouredTool, string>;
	/** Default width for each drawing tool, in PDF points. */
	toolWidths: Record<SizedTool, number>;
	/** Default text size, in PDF points. */
	textFontSize: number;
	/** Last eraser mode used. */
	eraserMode: EraserMode;
	/** Last sized-eraser radius, in screen pixels. */
	eraserRadiusPx: number;
	/** Whole-stroke eraser hit radius, in PDF points. */
	eraserWidth: number;
	/** Appended to the filename on export, before the extension. */
	exportSuffix: string;
	/** Whether export flattens annotations or writes native /Ink entries. */
	exportMode: ExportMode;
	/**
	 * Whether touches stop drawing once a pen has been seen. Off suits a device
	 * with no stylus, where every touch is meant to draw.
	 */
	palmRejection: boolean;
	/**
	 * Whether a stylus has ever been used in this vault.
	 *
	 * Remembered rather than re-learned per view, because palm rejection can only
	 * start once a pen has been seen — and a hand usually reaches the glass before
	 * the pencil does. Learning it afresh in every tab meant the first palm of each
	 * tab drew a blob. Not shown in settings: it is an observation, not a choice,
	 * and turning palm rejection off is the way to override it.
	 */
	penSeen: boolean;
	/**
	 * Show a live readout of touch and stylus events over the document.
	 *
	 * For diagnosing input problems on a tablet, where the same code behaves
	 * differently and there is otherwise no way to see what the device reported.
	 */
	inputDiagnostics: boolean;
}

/** Tools whose size is a width rather than a font size. */
export type SizedTool = 'pen' | 'highlighter' | 'shape';

export const SIZED_TOOLS: readonly SizedTool[] = ['pen', 'highlighter', 'shape'];

export type ExportMode = 'flatten' | 'native';

export const DEFAULT_EXPORT_SUFFIX = ' (annotated)';

function defaultToolWidths(): Record<SizedTool, number> {
	const tools = defaultToolState();
	return {
		pen: tools.pen.width,
		highlighter: tools.highlighter.width,
		shape: tools.shape.width,
	};
}

function defaultToolColors(): Record<ColouredTool, string> {
	const tools = defaultToolState();
	return {
		pen: tools.pen.color,
		highlighter: tools.highlighter.color,
		shape: tools.shape.color,
		text: tools.text.color,
	};
}

export const DEFAULT_SETTINGS: PdfInkSettings = {
	defaultZoomMode: 'fit-width',
	bufferPages: BUFFER_PAGES,
	toolColors: defaultToolColors(),
	toolWidths: defaultToolWidths(),
	textFontSize: defaultToolState().text.fontSize,
	eraserMode: defaultToolState().eraser.mode,
	eraserRadiusPx: defaultToolState().eraser.radiusPx,
	eraserWidth: defaultToolState().eraser.width,
	exportSuffix: DEFAULT_EXPORT_SUFFIX,
	exportMode: 'flatten',
	palmRejection: true,
	penSeen: false,
	inputDiagnostics: false,
};

function clampWidth(tool: SizedTool, value: number): number {
	const range = WIDTH_RANGES[tool];
	return Math.min(range.max, Math.max(range.min, value));
}

/**
 * Merge stored settings over the defaults, ignoring anything unrecognised.
 *
 * `toolColors` is merged key by key: a plain Object.assign would replace the whole
 * record and drop any tool the stored file predates. The result never aliases
 * DEFAULT_SETTINGS, so a later edit cannot corrupt the defaults.
 */
export function mergeSettings(stored: unknown): PdfInkSettings {
	const merged: PdfInkSettings = {
		...DEFAULT_SETTINGS,
		toolColors: defaultToolColors(),
		toolWidths: defaultToolWidths(),
	};
	if (stored === null || typeof stored !== 'object') return merged;
	const raw = stored as Record<string, unknown>;

	const zoom = raw['defaultZoomMode'];
	if (zoom === 'actual-size' || zoom === 'fit-width') {
		merged.defaultZoomMode = zoom;
	}

	const buffer = raw['bufferPages'];
	if (typeof buffer === 'number' && Number.isInteger(buffer)) {
		merged.bufferPages = Math.min(3, Math.max(0, buffer));
	}

	const mode = raw['eraserMode'];
	if (mode === 'stroke' || mode === 'sized') merged.eraserMode = mode;

	const radius = raw['eraserRadiusPx'];
	if (typeof radius === 'number' && Number.isFinite(radius)) {
		merged.eraserRadiusPx = Math.min(
			SIZED_ERASER_RANGE.max,
			Math.max(SIZED_ERASER_RANGE.min, radius),
		);
	}

	const colors = raw['toolColors'];
	if (colors !== null && typeof colors === 'object') {
		const byTool = colors as Record<string, unknown>;
		for (const tool of COLOURED_TOOLS) {
			const value = byTool[tool];
			if (typeof value === 'string' && value.length > 0) {
				merged.toolColors[tool] = value;
			}
		}
	}

	const widths = raw['toolWidths'];
	if (widths !== null && typeof widths === 'object') {
		const byTool = widths as Record<string, unknown>;
		for (const tool of SIZED_TOOLS) {
			const value = byTool[tool];
			if (typeof value === 'number' && Number.isFinite(value)) {
				merged.toolWidths[tool] = clampWidth(tool, value);
			}
		}
	}

	const fontSize = raw['textFontSize'];
	if (typeof fontSize === 'number' && Number.isFinite(fontSize)) {
		merged.textFontSize = Math.min(
			WIDTH_RANGES.text.max,
			Math.max(WIDTH_RANGES.text.min, fontSize),
		);
	}

	const eraserWidth = raw['eraserWidth'];
	if (typeof eraserWidth === 'number' && Number.isFinite(eraserWidth)) {
		merged.eraserWidth = Math.min(
			WIDTH_RANGES.eraser.max,
			Math.max(WIDTH_RANGES.eraser.min, eraserWidth),
		);
	}

	const suffix = raw['exportSuffix'];
	// An empty suffix would export over the original, so it is not allowed.
	if (typeof suffix === 'string' && suffix.trim().length > 0) {
		merged.exportSuffix = suffix;
	}

	const exportMode = raw['exportMode'];
	if (exportMode === 'flatten' || exportMode === 'native') {
		merged.exportMode = exportMode;
	}

	const palm = raw['palmRejection'];
	if (typeof palm === 'boolean') merged.palmRejection = palm;

	const penSeen = raw['penSeen'];
	if (typeof penSeen === 'boolean') merged.penSeen = penSeen;

	const diagnostics = raw['inputDiagnostics'];
	if (typeof diagnostics === 'boolean') merged.inputDiagnostics = diagnostics;

	return merged;
}
