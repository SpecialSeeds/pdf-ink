import { type App, Notice, type TFolder } from 'obsidian';
import { untitledPdfPath } from '../core/new-pdf';
import { createBlankPdf } from '../pdf/new-pdf';
import type { PdfInkSettings } from '../settings';
import { openInInkView } from './open-ink-view';

/**
 * Make a new ruled PDF and open it for writing in a new tab.
 *
 * With no folder given it goes where Obsidian puts new notes, which honours the
 * user's "default location for new notes" — beside the open file, a fixed
 * folder, or the vault root.
 */
export async function createPdf(
	app: App,
	settings: PdfInkSettings,
	folder?: TFolder,
): Promise<void> {
	try {
		const parent =
			folder ??
			app.fileManager.getNewFileParent(app.workspace.getActiveFile()?.path ?? '');
		const path = untitledPdfPath(
			parent.path,
			(candidate) => app.vault.getAbstractFileByPath(candidate) !== null,
		);
		const bytes = await createBlankPdf({
			size: settings.newPdfPageSize,
			template: settings.newPdfTemplate,
		});
		const buffer = bytes.buffer.slice(
			bytes.byteOffset,
			bytes.byteOffset + bytes.byteLength,
		) as ArrayBuffer;
		const file = await app.vault.createBinary(path, buffer);
		await openInInkView(app, file, app.workspace.getLeaf('tab'));
	} catch (err) {
		console.error('pdf-ink: could not create a PDF', err);
		new Notice('Could not create a new PDF.');
	}
}
