import { type App, Notice, type TFile } from 'obsidian';
import type { ExportMode } from '../core/settings-schema';
import { confirm } from '../ui/confirm-modal';
import { parseInkData, sidecarPathFor } from '../core/ink-serialization';
import { exportAnnotatedPdfWithReport, scaledNote } from '../pdf/export';
import { readBaseLayer } from '../pdf/base-file';
import { layerPages } from '../core/base-layer';
import { exportPathFor, parentFolder } from '../core/export-path';
import { isNotebookPath } from '../core/new-notebook';
import type { PageThemes, ThemeName } from '../core/theme';
import { type HeaderDateFormat, headerText } from '../core/header';

export interface ExportSettings {
	readonly suffix: string;
	readonly mode: ExportMode;
	/** The theme inserted and notebook pages export in. */
	readonly theme: ThemeName;
	readonly themes: PageThemes;
	/** How a notebook header writes its date, unless the notebook says. */
	readonly headerDateFormat: HeaderDateFormat;
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
		// A notebook's imported ink lives in its base layer; export draws both.
		let pages = parsed.data.pages;
		const ref = parsed.data.base;
		if (notebook && ref) {
			const base = await readBaseLayer(app, file, ref);
			if (typeof base === 'string') {
				new Notice(`Could not read this notebook's imported ink (${base}); nothing was exported.`);
				return;
			}
			pages = layerPages(base.pages, pages);
		}
		const { bytes: flattened, scaledPages } = await exportAnnotatedPdfWithReport({
			pdfBytes,
			pages,
			insertedPages: parsed.data.insertedPages,
			mode: settings.mode,
			theme: settings.theme,
			themes: settings.themes,
			// The title is the notebook's name now, whatever it was when written.
			...(notebook && parsed.data.header
				? { header: headerText(file.path, parsed.data.header, settings.headerDateFormat) }
				: {}),
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

		new Notice(`Exported to ${target}${scaledNote(scaledPages)}`);
	} catch (err) {
		console.error('pdf-ink: export failed', err);
		new Notice(`Could not export this ${notebook ? 'notebook' : 'PDF'}.`);
	}
}
