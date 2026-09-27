import { type App, Notice, type TFile } from 'obsidian';
import type { ExportMode } from '../core/settings-schema';
import { confirm } from '../ui/confirm-modal';
import { parseInkData, sidecarPathFor } from '../core/ink-serialization';
import { exportAnnotatedPdf } from '../pdf/export';

/**
 * `paper.pdf` becomes `paper (annotated).pdf`, beside the original.
 *
 * The suffix goes before the extension so the result is still a `.pdf`, and an
 * empty suffix is refused because it would export over the source.
 */
export function exportPathFor(pdfPath: string, suffix: string): string {
	const safe = suffix.trim().length > 0 ? suffix : ' (annotated)';
	const dot = pdfPath.lastIndexOf('.');
	const stem = dot > 0 ? pdfPath.slice(0, dot) : pdfPath;
	const extension = dot > 0 ? pdfPath.slice(dot) : '.pdf';
	return `${stem}${safe}${extension}`;
}

export interface ExportSettings {
	readonly suffix: string;
	readonly mode: ExportMode;
}

/**
 * Flatten a PDF's annotations into a new file.
 *
 * The source PDF is re-read rather than reused from memory, so the export always
 * reflects what is on disk, and it is never written to.
 */
export async function exportAnnotatedCopy(
	app: App,
	file: TFile,
	settings: ExportSettings,
): Promise<void> {
	const sidecar = app.vault.getFileByPath(sidecarPathFor(file.path));
	if (!sidecar) {
		new Notice('This PDF has no annotations to export.');
		return;
	}

	try {
		const parsed = parseInkData(await app.vault.read(sidecar));
		if (!parsed.ok) {
			new Notice('Could not read the annotations for this PDF.');
			return;
		}

		const pdfBytes = new Uint8Array(await app.vault.readBinary(file));
		const flattened = await exportAnnotatedPdf({
			pdfBytes,
			pages: parsed.data.pages,
			insertedPages: parsed.data.insertedPages,
			mode: settings.mode,
		});

		const target = exportPathFor(file.path, settings.suffix);
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
		if (existing) await app.vault.modifyBinary(existing, buffer);
		else await app.vault.createBinary(target, buffer);

		new Notice(`Exported to ${target}`);
	} catch (err) {
		console.error('pdf-ink: export failed', err);
		new Notice('Could not export this PDF.');
	}
}
