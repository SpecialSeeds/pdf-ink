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
