import { type App, Notice, type TFolder } from 'obsidian';
import { newBoardData } from '../core/board';
import { serializeInkData } from '../core/ink-serialization';
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
	await createNotebookFile(app, 'notebook', folder);
}

/**
 * Make a new board — one wide ruled page that grows as it is written on — and
 * open it in a new tab. A board is a notebook file like any other.
 */
export async function createBoard(app: App, folder?: TFolder): Promise<void> {
	await createNotebookFile(app, 'board', folder);
}

async function createNotebookFile(
	app: App,
	kind: 'notebook' | 'board',
	folder?: TFolder,
): Promise<void> {
	try {
		const parent =
			folder ??
			app.fileManager.getNewFileParent(app.workspace.getActiveFile()?.path ?? '');
		const path = untitledPath(
			parent.path,
			NOTEBOOK_EXTENSION,
			(candidate) => app.vault.getAbstractFileByPath(candidate) !== null,
		);
		const text =
			kind === 'board'
				? serializeInkData(newBoardData(Date.now()))
				: newNotebookText(Date.now());
		const file = await app.vault.create(path, text);
		await openInInkView(app, file, app.workspace.getLeaf('tab'));
	} catch (err) {
		console.error(`pdf-ink: could not create a ${kind}`, err);
		new Notice(`Could not create a new ${kind}.`);
	}
}
