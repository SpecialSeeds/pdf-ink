import { Keymap, type Plugin, TFile, TFolder } from 'obsidian';
import { BOARD_ICON, NOTEBOOK_ICON, PDF_INK_ICON, VIEW_TYPE_PDF_INK } from '../constants';
import type { PdfInkHost } from '../settings';
import { createBoard, createNotebook } from '../utils/create-notebook';
import { createPdf } from '../utils/create-pdf';
import {
	openInInkViewSafely,
	openInPlainViewSafely,
} from '../utils/open-ink-view';

/**
 * Add an annotate entry to the context menu of any `.pdf`.
 *
 * `file-menu` also fires for tab headers and a tab's more-options menu, and those
 * are exactly the sources that pass a `leaf` — so this one handler covers the
 * core PDF viewer's own menu, with the right leaf, for free.
 */
export function registerFileMenu(plugin: Plugin & PdfInkHost): void {
	plugin.registerEvent(
		plugin.app.workspace.on('file-menu', (menu, file, _source, leaf) => {
			// A folder's menu offers a new PDF or notebook inside it.
			if (file instanceof TFolder) {
				menu.addItem((item) =>
					item
						.setTitle('New PDF')
						.setIcon('file-plus-2')
						.setSection('action-primary')
						.onClick(() => {
							void createPdf(plugin.app, plugin.settings, file);
						}),
				);
				menu.addItem((item) =>
					item
						.setTitle('New notebook')
						.setIcon(NOTEBOOK_ICON)
						.setSection('action-primary')
						.onClick(() => {
							void createNotebook(plugin.app, { titleHeader: plugin.settings.addTitleHeader }, file);
						}),
				);
				menu.addItem((item) =>
					item
						.setTitle('New board')
						.setIcon(BOARD_ICON)
						.setSection('action-primary')
						.onClick(() => {
							void createBoard(plugin.app, { titleHeader: plugin.settings.addTitleHeader }, file);
						}),
				);
				return;
			}
			// `file` is a TAbstractFile: narrow it, never cast. `extension` is
			// lowercase and has no leading dot.
			if (!(file instanceof TFile) || file.extension !== 'pdf') return;

			menu.addItem((item) =>
				item
					.setTitle('Annotate with ink')
					.setIcon(PDF_INK_ICON)
					// Groups this with Obsidian's own open verbs. An unknown
					// section id just becomes its own trailing group.
					.setSection('open')
					.onClick((evt) => {
						// Honour Cmd/Ctrl (+Alt/+Shift) the way every other open
						// affordance in Obsidian does, so the in-place swap below
						// is never the only option.
						const paneType = Keymap.isModEvent(evt);
						const target = paneType
							? plugin.app.workspace.getLeaf(paneType)
							: // No leaf means the file explorer: replace the
							  // active tab. getLeaf(false) also declines to
							  // clobber a pinned one.
							  (leaf ?? plugin.app.workspace.getLeaf(false));
						openInInkViewSafely(plugin.app, file, target);
					}),
			);

			// From an ink tab's own menu, offer the way back to the plain viewer —
			// the only one besides the command once PDFs open here by default.
			if (leaf?.view.getViewType() === VIEW_TYPE_PDF_INK) {
				menu.addItem((item) =>
					item
						.setTitle("Open in Obsidian's viewer")
						.setIcon('file-text')
						.setSection('open')
						.onClick(() => {
							openInPlainViewSafely(
								plugin.app,
								file,
								leaf,
								plugin.plainPdfViewType,
							);
						}),
				);
			}
		}),
	);
}
