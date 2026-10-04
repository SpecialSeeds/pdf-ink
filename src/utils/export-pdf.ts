import { type App, Notice, type TFile } from 'obsidian';
import type { ExportMode } from '../core/settings-schema';
import { confirm } from '../ui/confirm-modal';
import { parseInkData, sidecarPathFor } from '../core/ink-serialization';
import { exportAnnotatedPdf } from '../pdf/export';
import { exportPathFor, parentFolder } from '../core/export-path';
import { isNotebookPath } from '../core/new-notebook';
import type { PageThemes, ThemeName } from '../core/theme';

export interface ExportSettings {
	readonly suffix: string;
	readonly mode: ExportMode;
	/** The theme inserted and notebook pages export in. */
	readonly theme: ThemeName;
	readonly themes: PageThemes;
}

/**
 * Flatten a PDF's annotations — or a notebook — into a new PDF.
 *
 * The source is re-read rather than reused from memory, so the export always
 * reflects what is on disk, and it is never written to.
 */
export async function exportAnnotatedCopy(
	app: App,
	file: TFile,
	settings: ExportSettings,
): Promise<void> {
	const notebook = isNotebookPath(file.path);
	// A notebook is its own ink data; a PDF's lives in its sidecar.
	const source = notebook ? file : app.vault.getFileByPath(sidecarPathFor(file.path));
	if (!source) {
		new Notice('This PDF has no annotations to export.');
		return;
	}

	try {
		const raw = await app.vault.read(source);
		const parsed = parseInkData(raw);
		if (!parsed.ok) {
			new Notice(
				notebook && raw.trim().length === 0
					? 'This notebook is empty.'
					: `Could not read the ${notebook ? 'notebook' : 'annotations for this PDF'}.`,
			);
			return;
		}

		const pdfBytes = notebook
			? undefined
			: new Uint8Array(await app.vault.readBinary(file));
		const flattened = await exportAnnotatedPdf({
			pdfBytes,
			pages: parsed.data.pages,
			insertedPages: parsed.data.insertedPages,
			mode: settings.mode,
			theme: settings.theme,
			themes: settings.themes,
		});

		// A notebook exports beside itself as a PDF of the same name.
		const target = notebook
			? exportPathFor(`${file.path.slice(0, -file.extension.length)}pdf`, settings.suffix)
			: exportPathFor(file.path, settings.suffix);
		const existing = app.vault.getFileByPath(target);
		if (existing) {
			// Re-exporting is normal, but it silently replaced the previous file.
			const replace = await confirm(app, {
				title: 'Replace existing export?',
				message: `${target} already exists. Exporting again will overwrite it.`,
				cta: 'Overwrite',
				warning: true,
			});
			if (!replace) return;
		}

		// A Uint8Array view over its own buffer is what the vault API wants.
		const buffer = flattened.buffer.slice(
			flattened.byteOffset,
			flattened.byteOffset + flattened.byteLength,
		) as ArrayBuffer;
		if (existing) {
			await app.vault.modifyBinary(existing, buffer);
		} else {
			const folder = parentFolder(target);
			if (folder && !app.vault.getFolderByPath(folder)) {
				await app.vault.createFolder(folder);
			}
			await app.vault.createBinary(target, buffer);
		}

		new Notice(`Exported to ${target}`);
	} catch (err) {
		console.error('pdf-ink: export failed', err);
		new Notice(`Could not export this ${notebook ? 'notebook' : 'PDF'}.`);
	}
}
