import { type App, Notice, type TFolder } from 'obsidian';
import { NOTEBOOK_EXTENSION, newNotebookText } from '../core/new-notebook';
import { untitledPath } from '../core/new-pdf';
import { openInInkView } from './open-ink-view';

/**
 * Make a new notebook — one Letter page ruled as a grid — and open it for
 * writing in a new tab.
 *
 * With no folder given it goes where Obsidian puts new notes, as a new PDF does.
 */
export async function createNotebook(app: App, folder?: TFolder): Promise<void> {
	try {
		const parent =
			folder ??
			app.fileManager.getNewFileParent(app.workspace.getActiveFile()?.path ?? '');
		const path = untitledPath(
			parent.path,
			NOTEBOOK_EXTENSION,
			(candidate) => app.vault.getAbstractFileByPath(candidate) !== null,
		);
		const file = await app.vault.create(path, newNotebookText(Date.now()));
		await openInInkView(app, file, app.workspace.getLeaf('tab'));
	} catch (err) {
		console.error('pdf-ink: could not create a notebook', err);
		new Notice('Could not create a new notebook.');
	}
}
