import { Notice, type Plugin } from 'obsidian';
import { BOARD_ICON, NOTEBOOK_ICON, PDF_INK_ICON } from '../constants';
import {
	openInInkViewSafely,
	openInPlainViewSafely,
} from '../utils/open-ink-view';
import type { PdfInkHost } from '../settings';
import { PdfInkView } from '../ui/pdf-ink-view';
import { effectiveThemes } from '../core/theme';
import { resolveExportChoice } from '../ui/export-theme-modal';
import { createBoard, createNotebook } from '../utils/create-notebook';
import { FolderPicker, convertImportedTitles } from '../ui/convert-titles-modal';
import { removeFolder, runRenderCommand } from '../transcription/render';
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
		id: 'render-for-transcription',
		name: 'Render notebooks for transcription',
		icon: 'scan-text',
		callback: () => {
			new FolderPicker(
				plugin.app,
				(folder) => {
					void runRenderCommand(plugin.app, folder, plugin.settings);
				},
				'Render notebooks for transcription in which folder?',
			).open();
		},
	});

	plugin.addCommand({
		id: 'clear-transcription-renders',
		name: 'Clear transcription renders',
		icon: 'trash-2',
		callback: () => {
			void (async () => {
				const folder = plugin.settings.renderFolder;
				const removed = await removeFolder(plugin.app.vault.adapter, folder);
				new Notice(removed ? `Removed ${folder}.` : 'There were no transcription renders to clear.');
			})();
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
					// Not open here, so whether it has inserted pages is unknown: offer anyway.
					const choice = await resolveExportChoice(plugin.app, plugin, true);
					if (choice === null) return;
					await exportAnnotatedCopy(plugin.app, target.file, {
						suffix: plugin.settings.exportSuffix,
						mode: plugin.settings.exportMode,
						theme: choice.theme,
						insertedPages: choice.insertedPages,
						themes: effectiveThemes(plugin.settings.pageThemes),
						headerDateFormat: plugin.settings.headerDateFormat,
					});
				})();
			}
			return true;
		},
	});
}
