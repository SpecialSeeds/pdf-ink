import type { App, TFile } from 'obsidian';
import { Notice } from '../test/obsidian-stub';
import { beforeEach, describe, expect, it } from 'vitest';
import { renameNotebookFromTitle } from './rename-notebook';

/** Paths in the vault, and the renames the file manager was asked for. */
function fakeApp(paths: string[]): { app: App; files: Set<string>; renames: [string, string][] } {
	const files = new Set(paths);
	const renames: [string, string][] = [];
	const app = {
		vault: {
			getAbstractFileByPath: (path: string) => (files.has(path) ? { path } : null),
		},
		fileManager: {
			renameFile: (file: TFile, to: string) => {
				files.delete(file.path);
				files.add(to);
				renames.push([file.path, to]);
				return Promise.resolve();
			},
		},
	} as unknown as App;
	return { app, files, renames };
}

const notebook = { path: 'class/Week 2.inknote', basename: 'Week 2' } as TFile;

beforeEach(() => {
	Notice.reset();
});

describe('editing the header title', () => {
	it('renames the notebook through the file manager', async () => {
		const { app, files, renames } = fakeApp([notebook.path]);
		expect(await renameNotebookFromTitle(app, notebook, 'Week 2: forces')).toBe('refused');
		expect(await renameNotebookFromTitle(app, notebook, 'Week 2 forces')).toBe('renamed');
		expect(renames).toEqual([['class/Week 2.inknote', 'class/Week 2 forces.inknote']]);
		expect(files.has('class/Week 2 forces.inknote')).toBe(true);
	});

	it('reverts a name already taken, with a notice, and renames nothing', async () => {
		const { app, files, renames } = fakeApp([notebook.path, 'class/Week 3.inknote']);
		expect(await renameNotebookFromTitle(app, notebook, 'Week 3')).toBe('refused');
		expect(renames).toEqual([]);
		expect(files.has(notebook.path)).toBe(true);
		expect(Notice.messages.join(' ')).toMatch(/already taken/);
	});

	it('does nothing for the same name, and refuses an empty one', async () => {
		const { app, renames } = fakeApp([notebook.path]);
		expect(await renameNotebookFromTitle(app, notebook, 'Week 2')).toBe('unchanged');
		expect(await renameNotebookFromTitle(app, notebook, '   ')).toBe('refused');
		expect(renames).toEqual([]);
		expect(Notice.messages).toHaveLength(1);
	});

	it('keeps the name, with a notice, when the rename itself fails', async () => {
		const { app } = fakeApp([notebook.path]);
		(app.fileManager as unknown as { renameFile: () => Promise<void> }).renameFile = () =>
			Promise.reject(new Error('locked'));
		expect(await renameNotebookFromTitle(app, notebook, 'Other')).toBe('refused');
		expect(Notice.messages.join(' ')).toMatch(/Could not rename/);
	});
});
