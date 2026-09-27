import { type App, Notice, type Plugin, TFile } from 'obsidian';
import { sidecarPathFor } from '../core/ink-serialization';

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
			if (!(file instanceof TFile) || file.extension !== 'pdf') return;
			void moveSidecar(plugin.app, oldPath, file.path);
		}),
	);

	plugin.registerEvent(
		plugin.app.vault.on('delete', (file) => {
			if (!(file instanceof TFile) || file.extension !== 'pdf') return;
			void trashSidecar(plugin.app, file.path);
		}),
	);
}

async function moveSidecar(
	app: App,
	oldPdfPath: string,
	newPdfPath: string,
): Promise<void> {
	const sidecar = app.vault.getFileByPath(sidecarPathFor(oldPdfPath));
	if (!sidecar) return;

	const newPath = sidecarPathFor(newPdfPath);
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

async function trashSidecar(app: App, pdfPath: string): Promise<void> {
	const sidecar = app.vault.getFileByPath(sidecarPathFor(pdfPath));
	if (!sidecar) return;
	try {
		// Trash rather than delete: this is the user's work, and it honours their
		// configured deletion behaviour so it stays recoverable.
		await app.fileManager.trashFile(sidecar);
	} catch (err) {
		console.error(`pdf-ink: could not trash ${sidecar.path}`, err);
	}
}
