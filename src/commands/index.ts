import type { Plugin } from 'obsidian';
import { PDF_INK_ICON } from '../constants';
import { openInInkViewSafely } from '../utils/open-ink-view';
import type { PdfInkHost } from '../settings';
import { PdfInkView } from '../ui/pdf-ink-view';
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
		// Also Mod+Shift+E while the ink view has focus, via the view's Scope.
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
	for (const [id, name, icon, run] of [
		[
			'insert-page-below',
			'Insert page below',
			'arrow-down-to-line',
			(view: PdfInkView) => {
				view.insertPageBelowCurrent();
			},
		],
		[
			'insert-page-above',
			'Insert page above',
			'arrow-up-to-line',
			(view: PdfInkView) => {
				view.insertPageAboveCurrent();
			},
		],
		[
			'page-options',
			'Page options',
			'file-cog',
			(view: PdfInkView) => {
				view.openPageMenu();
			},
		],
	] as const) {
		plugin.addCommand({
			id,
			name,
			icon,
			checkCallback: (checking: boolean): boolean => {
				const view = plugin.app.workspace.getActiveViewOfType(PdfInkView);
				if (!view?.hasCurrentPage()) return false;
				if (!checking) run(view);
				return true;
			},
		});
	}

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
			const target = resolvePdfTarget(plugin.app);
			if (!target) return false;
			if (!checking) {
				void exportAnnotatedCopy(plugin.app, target.file, {
					suffix: plugin.settings.exportSuffix,
					mode: plugin.settings.exportMode,
				});
			}
			return true;
		},
	});
}
