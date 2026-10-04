import { type App, Notice, type Plugin, TFile } from 'obsidian';
import { basePathFor } from '../core/base-layer';
import { sidecarPathFor } from '../core/ink-serialization';
import { NOTEBOOK_EXTENSION } from '../core/new-notebook';

/** The file that has to travel with `file`: a PDF's sidecar, a notebook's base layer. */
function companionPath(extension: string, path: string): string | null {
	if (extension === 'pdf') return sidecarPathFor(path);
	if (extension === NOTEBOOK_EXTENSION) return basePathFor(path);
	return null;
}

/**
 * Keep each PDF's annotation sidecar alongside it as files move and disappear.
 *
 * Registered at the plugin level rather than on the view, so renaming a PDF that
 * is not currently open does not orphan its annotations.
 *
 * Folder renames need no handling: Obsidian reports those on the folder, and the
 * PDF and its sidecar move together because they live side by side.
 */
export function registerSidecarEvents(plugin: Plugin): void {
	plugin.registerEvent(
		plugin.app.vault.on('rename', (file, oldPath) => {
			if (!(file instanceof TFile)) return;
			const from = companionPath(file.extension, oldPath);
			const to = companionPath(file.extension, file.path);
			if (from !== null && to !== null) void moveSidecar(plugin.app, from, to);
		}),
	);

	plugin.registerEvent(
		plugin.app.vault.on('delete', (file) => {
			if (!(file instanceof TFile)) return;
			const companion = companionPath(file.extension, file.path);
			if (companion !== null) void trashSidecar(plugin.app, companion);
		}),
	);
}

async function moveSidecar(
	app: App,
	oldPath: string,
	newPath: string,
): Promise<void> {
	const sidecar = app.vault.getFileByPath(oldPath);
	if (!sidecar) return;
	if (sidecar.path === newPath) return;

	if (app.vault.getFileByPath(newPath)) {
		// Refuse rather than clobber annotations that already belong to the
		// destination name.
		console.warn(`pdf-ink: ${newPath} already exists; left ${sidecar.path} in place`);
		new Notice('Annotations for the new name already exist, so the old ones were left behind.');
		return;
	}

	try {
		await app.vault.rename(sidecar, newPath);
	} catch (err) {
		console.error(`pdf-ink: could not move ${sidecar.path} to ${newPath}`, err);
		new Notice('Could not move the annotations for this PDF.');
	}
}

async function trashSidecar(app: App, path: string): Promise<void> {
	const sidecar = app.vault.getFileByPath(path);
	if (!sidecar) return;
	try {
		// Trash rather than delete: this is the user's work, and it honours their
		// configured deletion behaviour so it stays recoverable.
		await app.fileManager.trashFile(sidecar);
	} catch (err) {
		console.error(`pdf-ink: could not trash ${sidecar.path}`, err);
	}
}
