import { Keymap, type Plugin, TFile } from 'obsidian';
import { PDF_INK_ICON } from '../constants';
import { openInInkViewSafely } from '../utils/open-ink-view';

/**
 * Add an annotate entry to the context menu of any `.pdf`.
 *
 * `file-menu` also fires for tab headers and a tab's more-options menu, and those
 * are exactly the sources that pass a `leaf` — so this one handler covers the
 * core PDF viewer's own menu, with the right leaf, for free.
 */
export function registerFileMenu(plugin: Plugin): void {
	plugin.registerEvent(
		plugin.app.workspace.on('file-menu', (menu, file, _source, leaf) => {
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
		}),
	);
}
