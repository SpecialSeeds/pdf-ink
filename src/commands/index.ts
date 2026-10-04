import type { Plugin } from 'obsidian';
import { BOARD_ICON, NOTEBOOK_ICON, PDF_INK_ICON } from '../constants';
import {
	openInInkViewSafely,
	openInPlainViewSafely,
} from '../utils/open-ink-view';
import type { PdfInkHost } from '../settings';
import { PdfInkView } from '../ui/pdf-ink-view';
import { effectiveThemes } from '../core/theme';
import { resolveExportTheme } from '../ui/export-theme-modal';
import { createBoard, createNotebook } from '../utils/create-notebook';
import { convertImportedTitles } from '../ui/convert-titles-modal';
import { createPdf } from '../utils/create-pdf';
import { exportAnnotatedCopy } from '../utils/export-pdf';
import { resolvePdfTarget } from '../utils/pdf-target';

export function registerCommands(plugin: Plugin & PdfInkHost): void {
	plugin.addCommand({
		id: 'annotate-current-pdf',
		name: 'Annotate current PDF',
		icon: PDF_INK_ICON,
		// checkCallback, not callback: the editor variants are typed to
		// MarkdownView | MarkdownFileInfo and cannot see a PDF at all. Obsidian
		// calls this on every palette keystroke, so the check stays cheap.
		checkCallback: (checking: boolean): boolean => {
			const target = resolvePdfTarget(plugin.app);
			if (!target) return false;
			// Already annotating this file — keep a no-op out of the palette.
			if (target.alreadyInk) return false;
			if (checking) return true;
			openInInkViewSafely(plugin.app, target.file, target.leaf);
			return true;
		},
	});

	plugin.addCommand({
		id: 'create-pdf',
		name: 'Create new PDF',
		icon: 'file-plus-2',
		callback: () => {
			void createPdf(plugin.app, plugin.settings);
		},
	});

	plugin.addCommand({
		id: 'create-notebook',
		name: 'New notebook',
		icon: NOTEBOOK_ICON,
		callback: () => {
			void createNotebook(plugin.app, { titleHeader: plugin.settings.addTitleHeader });
		},
	});

	plugin.addCommand({
		id: 'create-board',
		name: 'New board',
		icon: BOARD_ICON,
		callback: () => {
			void createBoard(plugin.app, { titleHeader: plugin.settings.addTitleHeader });
		},
	});

	plugin.addCommand({
		id: 'convert-imported-titles',
		name: 'Convert imported titles to headers',
		icon: 'heading',
		callback: () => {
			convertImportedTitles(plugin.app);
		},
	});

	plugin.addCommand({
		id: 'toggle-page-theme',
		name: 'Toggle light or dark pages',
		icon: 'sun-moon',
		checkCallback: (checking: boolean): boolean => {
			const view = plugin.app.workspace.getActiveViewOfType(PdfInkView);
			if (!view?.file) return false;
			if (!checking) view.toggleTheme();
			return true;
		},
	});

	plugin.addCommand({
		id: 'open-in-plain-viewer',
		name: "Open current PDF in Obsidian's viewer",
		icon: 'file-text',
		checkCallback: (checking: boolean): boolean => {
			const target = resolvePdfTarget(plugin.app);
			if (!target?.alreadyInk) return false;
			if (checking) return true;
			openInPlainViewSafely(
				plugin.app,
				target.file,
				target.leaf,
				plugin.plainPdfViewType,
			);
			return true;
		},
	});

	// Also reachable as Mod+Z / Mod+Shift+Z while the ink view has focus, via the
	// view's own Scope. These exist so the actions are discoverable in the palette
	// and rebindable, without claiming a default hotkey globally.
	plugin.addCommand({
		id: 'undo-stroke',
		name: 'Undo stroke',
		icon: 'undo',
		checkCallback: (checking: boolean): boolean => {
			const view = plugin.app.workspace.getActiveViewOfType(PdfInkView);
			if (!view?.canUndoInk()) return false;
			if (!checking) view.undoInk();
			return true;
		},
	});

	plugin.addCommand({
		id: 'redo-stroke',
		name: 'Redo stroke',
		icon: 'redo',
		checkCallback: (checking: boolean): boolean => {
			const view = plugin.app.workspace.getActiveViewOfType(PdfInkView);
			if (!view?.canRedoInk()) return false;
			if (!checking) view.redoInk();
			return true;
		},
	});

	plugin.addCommand({
		id: 'toggle-eraser-mode',
		name: 'Toggle eraser mode',
		icon: 'eraser',
		// No hotkey, here or in the view's Scope: an eraser key is too easy to hit
		// by accident mid-page. Users who want one can bind it.
		checkCallback: (checking: boolean): boolean => {
			const view = plugin.app.workspace.getActiveViewOfType(PdfInkView);
			if (!view) return false;
			if (!checking) view.toggleEraserMode();
			return true;
		},
	});

	/*
	 * Tool toggles, as commands as well as gestures.
	 *
	 * The Apple Pencil's double-tap and squeeze are delivered to native code and
	 * never reach the page, so there is nothing to bind them to directly. These
	 * give the same effect from a keyboard, and from the two- and three-finger taps
	 * the ink layer recognises.
	 */
	for (const [tool, name, icon] of [
		['eraser', 'Toggle eraser', 'eraser'],
		['lasso', 'Toggle selection tool', 'lasso'],
	] as const) {
		plugin.addCommand({
			id: `toggle-${tool}-tool`,
			name,
			icon,
			checkCallback: (checking: boolean): boolean => {
				const view = plugin.app.workspace.getActiveViewOfType(PdfInkView);
				if (!view) return false;
				if (!checking) view.toggleTool(tool);
				return true;
			},
		});
	}

	/*
	 * Page management, as commands as well as the "+" between pages and the page
	 * context menu. Neither of those is reachable on a tablet — the "+" follows a
	 * hovering pointer, and iOS does not reliably raise a context menu on a long
	 * press — so without these there is no way to add a page on an iPad.
	 */
	for (const [id, name, icon, run, available] of [
		[
			'insert-page-below',
			'Insert page below',
			'arrow-down-to-line',
			(view: PdfInkView) => {
				view.insertPageBelowCurrent();
			},
			(view: PdfInkView) => view.canInsertPage(),
		],
		[
			'insert-page-above',
			'Insert page above',
			'arrow-up-to-line',
			(view: PdfInkView) => {
				view.insertPageAboveCurrent();
			},
			(view: PdfInkView) => view.canInsertPage(),
		],
		[
			'page-options',
			'Page options',
			'file-cog',
			(view: PdfInkView) => {
				view.openPageMenu();
			},
			(view: PdfInkView) => view.hasCurrentPage(),
		],
	] as const) {
		plugin.addCommand({
			id,
			name,
			icon,
			checkCallback: (checking: boolean): boolean => {
				const view = plugin.app.workspace.getActiveViewOfType(PdfInkView);
				if (!view || !available(view)) return false;
				if (!checking) run(view);
				return true;
			},
		});
	}

	plugin.addCommand({
		id: 'toggle-zoom-lock',
		name: 'Toggle zoom lock',
		icon: 'lock',
		checkCallback: (checking: boolean): boolean => {
			const view = plugin.app.workspace.getActiveViewOfType(PdfInkView);
			if (!view) return false;
			if (!checking) view.toggleZoomLock();
			return true;
		},
	});

	plugin.addCommand({
		id: 'flip-toolbar-side',
		name: 'Move tool palette to the other side',
		icon: 'flip-horizontal',
		checkCallback: (checking: boolean): boolean => {
			const view = plugin.app.workspace.getActiveViewOfType(PdfInkView);
			if (!view) return false;
			if (!checking) view.flipToolbarSide();
			return true;
		},
	});

	plugin.addCommand({
		id: 'export-annotated-pdf',
		name: 'Export annotated PDF',
		icon: 'file-down',
		checkCallback: (checking: boolean): boolean => {
			// A notebook has no other viewer, so the ink view showing it is the target.
			const active = plugin.app.workspace.getActiveViewOfType(PdfInkView);
			if (active?.file) {
				if (!checking) void active.exportAnnotated();
				return true;
			}
			const target = resolvePdfTarget(plugin.app);
			if (!target) return false;
			if (checking) return true;
			// From the ink view, go through it so unsaved ink is flushed first.
			const view = target.leaf.view;
			if (view instanceof PdfInkView && view.file === target.file) {
				void view.exportAnnotated();
			} else {
				void (async () => {
					const theme = await resolveExportTheme(plugin.app, plugin);
					if (theme === null) return;
					await exportAnnotatedCopy(plugin.app, target.file, {
						suffix: plugin.settings.exportSuffix,
						mode: plugin.settings.exportMode,
						theme,
						themes: effectiveThemes(plugin.settings.pageThemes),
						headerDateFormat: plugin.settings.headerDateFormat,
					});
				})();
			}
			return true;
		},
	});
}
