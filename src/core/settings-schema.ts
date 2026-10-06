/**
 * Plugin settings: shape, defaults, and the merge that loads them. Pure — no
 * Obsidian import, so it is unit testable. The settings *tab* lives in
 * src/settings.ts.
 */

import { BUFFER_PAGES } from '../constants';
import { normalizeHex } from './color';
import { DEFAULT_RENDER_FOLDER, DEFAULT_TRANSCRIPT_FOLDER, normalizeFolder } from './transcripts';
import { DEFAULT_TINT_COLOR, DEFAULT_TINT_STRENGTH, clampTintStrength } from './paper-tint';
import { type HeaderDateFormat, isHeaderDateFormat } from './header';
import { type NewPdfPageSize, isNewPdfPageSize } from './new-pdf';
import { type PageTemplate, isPageTemplate } from './templates';
import {
	type PageThemeOverrides,
	type ThemeName,
	emptyThemeOverrides,
	isThemeName,
	readThemeOverrides,
} from './theme';
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
	/**
	 * Which edge the floating tool palette sits against.
	 *
	 * A vertical bar under the hand that is not holding the pen, so tools can be
	 * changed without crossing the page or looking away from what is being written.
	 */
	toolbarSide: ToolbarSide;
	/**
	 * Open PDFs in the ink view rather than Obsidian's own viewer.
	 *
	 * The core viewer stays installed and is handed `.pdf` back when this is turned
	 * off or the plugin is disabled.
	 */
	openByDefault: boolean;
	/**
	 * Hold the zoom where it is: pinches, Ctrl/Cmd+scroll and the zoom buttons all
	 * leave it alone, so a hand on the glass cannot rescale the page mid-sentence.
	 */
	zoomLocked: boolean;
	/** Page size of a PDF created from the ribbon or a folder's menu. */
	newPdfPageSize: NewPdfPageSize;
	/** Ruling of a new PDF, and of pages later inserted into it. */
	newPdfTemplate: PageTemplate;
	/**
	 * Colours the user changed in the page themes, laid over the defaults in
	 * src/core/theme.ts. Only what was changed is stored, so a later change to a
	 * default still reaches everyone who left that colour alone.
	 */
	pageThemes: PageThemeOverrides;
	/** The theme last chosen for export, preselected next time. */
	exportTheme: ThemeName;
	/** Ask which theme to export in; off exports in {@link exportTheme} directly. */
	askExportTheme: boolean;
	/**
	 * Lay a tinted sheet over every light page on screen, to soften white paper.
	 * Never changes the PDF, the ink or an export. See src/core/paper-tint.ts.
	 */
	paperTint: boolean;
	/** The sheet's colour. */
	paperTintColor: string;
	/** How much of it shows, 0.1 to 1. */
	paperTintStrength: number;
	/** Where transcripts of handwriting live, mirroring their sources' paths. */
	transcriptFolder: string;
	/** Where pages are rendered for transcription; a dot folder, hidden from the file explorer. */
	renderFolder: string;
	/** Open a transcript's source, at the matching handwriting, in place of the transcript. */
	openSourcesInsteadOfTranscripts: boolean;
	/** Delete a source's renders once its transcript is up to date with it. */
	deleteRendersAfterTranscription: boolean;
	/** Give new notebooks and boards a title header, as OneNote pages have. */
	addTitleHeader: boolean;
	/** How a header writes its date, unless the notebook says otherwise. */
	headerDateFormat: HeaderDateFormat;
}

/** The edge the tool palette docks to. */
export type ToolbarSide = 'left' | 'right';

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
	toolbarSide: 'left',
	openByDefault: true,
	zoomLocked: false,
	newPdfPageSize: 'letter',
	newPdfTemplate: 'lined',
	pageThemes: emptyThemeOverrides(),
	exportTheme: 'light',
	askExportTheme: true,
	paperTint: false,
	paperTintColor: DEFAULT_TINT_COLOR,
	paperTintStrength: DEFAULT_TINT_STRENGTH,
	transcriptFolder: DEFAULT_TRANSCRIPT_FOLDER,
	renderFolder: DEFAULT_RENDER_FOLDER,
	openSourcesInsteadOfTranscripts: true,
	deleteRendersAfterTranscription: true,
	addTitleHeader: true,
	headerDateFormat: 'onenote',
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
		pageThemes: emptyThemeOverrides(),
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

	const side = raw['toolbarSide'];
	if (side === 'left' || side === 'right') merged.toolbarSide = side;

	const byDefault = raw['openByDefault'];
	if (typeof byDefault === 'boolean') merged.openByDefault = byDefault;

	const zoomLocked = raw['zoomLocked'];
	if (typeof zoomLocked === 'boolean') merged.zoomLocked = zoomLocked;

	const pageSize = raw['newPdfPageSize'];
	if (isNewPdfPageSize(pageSize)) merged.newPdfPageSize = pageSize;

	const template = raw['newPdfTemplate'];
	if (isPageTemplate(template)) merged.newPdfTemplate = template;

	merged.pageThemes = readThemeOverrides(raw['pageThemes']);

	const exportTheme = raw['exportTheme'];
	if (isThemeName(exportTheme)) merged.exportTheme = exportTheme;

	const askExportTheme = raw['askExportTheme'];
	if (typeof askExportTheme === 'boolean') merged.askExportTheme = askExportTheme;

	const paperTint = raw['paperTint'];
	if (typeof paperTint === 'boolean') merged.paperTint = paperTint;

	const tintColor = raw['paperTintColor'];
	const tintHex = typeof tintColor === 'string' ? normalizeHex(tintColor) : null;
	if (tintHex !== null) merged.paperTintColor = tintHex;

	const tintStrength = raw['paperTintStrength'];
	if (typeof tintStrength === 'number') merged.paperTintStrength = clampTintStrength(tintStrength);

	const transcriptFolder = raw['transcriptFolder'];
	if (typeof transcriptFolder === 'string') {
		merged.transcriptFolder = normalizeFolder(transcriptFolder, DEFAULT_TRANSCRIPT_FOLDER);
	}
	const renderFolder = raw['renderFolder'];
	if (typeof renderFolder === 'string') {
		merged.renderFolder = normalizeFolder(renderFolder, DEFAULT_RENDER_FOLDER);
	}
	const openSources = raw['openSourcesInsteadOfTranscripts'];
	if (typeof openSources === 'boolean') merged.openSourcesInsteadOfTranscripts = openSources;
	const deleteRenders = raw['deleteRendersAfterTranscription'];
	if (typeof deleteRenders === 'boolean') merged.deleteRendersAfterTranscription = deleteRenders;

	const addTitleHeader = raw['addTitleHeader'];
	if (typeof addTitleHeader === 'boolean') merged.addTitleHeader = addTitleHeader;

	const headerDateFormat = raw['headerDateFormat'];
	if (isHeaderDateFormat(headerDateFormat)) merged.headerDateFormat = headerDateFormat;

	return merged;
}
