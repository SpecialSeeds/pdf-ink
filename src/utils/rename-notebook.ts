import { type App, Notice, type TFile } from 'obsidian';
import { renameTargetFor } from '../core/header';

export type RenameOutcome = 'renamed' | 'unchanged' | 'refused';

/**
 * Rename a notebook to the title typed into its header, through the file
 * manager so links to it follow. Its base layer moves with it (see
 * src/pdf/sidecar.ts). A refusal says why; nothing on disk changes.
 */
export async function renameNotebookFromTitle(
	app: App,
	file: TFile,
	title: string,
): Promise<RenameOutcome> {
	const target = renameTargetFor(file.path, title, (path) => app.vault.getAbstractFileByPath(path) !== null);
	if (!target.ok) {
		if (target.reason === 'unchanged') return 'unchanged';
		new Notice(
			target.reason === 'exists'
				? `"${title.trim()}" is already taken in this folder. The notebook keeps its name.`
				: target.reason === 'empty'
					? 'A notebook needs a name. It keeps the one it has.'
					: 'A file name cannot contain \\ / : * ? " < > | # ^ [ ] or start with a dot. The notebook keeps its name.',
		);
		return 'refused';
	}
	try {
		await app.fileManager.renameFile(file, target.path);
		return 'renamed';
	} catch (err) {
		console.error(`pdf-ink: could not rename ${file.path} to ${target.path}`, err);
		new Notice('Could not rename the notebook. It keeps its name.');
		return 'refused';
	}
}
