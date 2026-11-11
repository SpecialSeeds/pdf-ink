import { type App, Notice, type TFile } from 'obsidian';
import type { ExportMode } from '../core/settings-schema';
import { confirm } from '../ui/confirm-modal';
import { type ExportChoice, resolveExportChoice } from '../ui/export-theme-modal';
import { parseInkData, sidecarPathFor } from '../core/ink-serialization';
import { type ExportReport, exportAnnotatedPdfWithReport, scaledNote } from '../pdf/export';
import { readBaseLayer } from '../pdf/base-file';
import { layerPages } from '../core/base-layer';
import { ORIGINAL_PAGES_VARIANT, exportPathFor, parentFolder } from '../core/export-path';
import { isNotebookPath } from '../core/new-notebook';
import type { PageThemes } from '../core/theme';
import { type HeaderText, headerText } from '../core/header';
import type { Item } from '../core/items';
import type { InsertedPage, PageKey } from '../core/pages';
import { type ExportQuality, QUALITY_PROFILES } from '../core/export-quality';
import type { PdfInkHost } from '../settings';
import { collectImageBytes, imagesForQuality } from './images';

/** Everything an export draws, read from disk once however often it is built. */
export interface ExportSource {
	readonly file: TFile;
	readonly notebook: boolean;
	/** The original PDF's bytes; absent for a notebook. */
	readonly pdfBytes?: Uint8Array;
	readonly pages: Readonly<Record<PageKey, Item[]>>;
	readonly insertedPages: readonly InsertedPage[];
	readonly header?: HeaderText;
	/** Every placed picture's bytes, as stored in the vault. */
	readonly images: ReadonlyMap<string, Uint8Array>;
}

/**
 * Read what a PDF's or notebook's export draws, or say why it cannot be.
 *
 * The source is re-read rather than reused from memory, so the export always
 * reflects what is on disk, and it is never written to.
 */
export async function loadExportSource(
	app: App,
	file: TFile,
	headerDateFormat: PdfInkHost['settings']['headerDateFormat'],
): Promise<ExportSource | string> {
	const notebook = isNotebookPath(file.path);
	// A notebook is its own ink data; a PDF's lives in its sidecar.
	const source = notebook ? file : app.vault.getFileByPath(sidecarPathFor(file.path));
	if (!source) return 'This PDF has no annotations to export.';

	const raw = await app.vault.read(source);
	const parsed = parseInkData(raw);
	if (!parsed.ok) {
		return notebook && raw.trim().length === 0
			? 'This notebook is empty.'
			: `Could not read the ${notebook ? 'notebook' : 'annotations for this PDF'}.`;
	}

	// A notebook's imported ink lives in its base layer; export draws both.
	let pages = parsed.data.pages;
	const ref = parsed.data.base;
	if (notebook && ref) {
		const base = await readBaseLayer(app, file, ref);
		if (typeof base === 'string') {
			return `Could not read this notebook's imported ink (${base}); nothing was exported.`;
		}
		pages = layerPages(base.pages, pages);
	}
	return {
		file,
		notebook,
		...(notebook ? {} : { pdfBytes: new Uint8Array(await app.vault.readBinary(file)) }),
		pages,
		insertedPages: parsed.data.insertedPages,
		// The title is the notebook's name now, whatever it was when written.
		...(notebook && parsed.data.header
			? { header: headerText(file.path, parsed.data.header, headerDateFormat) }
			: {}),
		images: await collectImageBytes(app, pages),
	};
}

/** How many built exports are kept: the one shown and the one before it. */
const KEPT_BUILDS = 2;

/**
 * Builds a source's export for any choice, each choice once: the dialog measures
 * a quality's size by building it, and exporting that choice reuses the bytes.
 */
export function exportBuilder(
	source: ExportSource,
	settings: { readonly mode: ExportMode; readonly themes: PageThemes },
): (choice: ExportChoice) => Promise<ExportReport> {
	const reports = new Map<string, Promise<ExportReport>>();
	const pictures = new Map<ExportQuality, Promise<Map<string, Uint8Array>>>();
	const picturesFor = (quality: ExportQuality): Promise<Map<string, Uint8Array>> => {
		let found = pictures.get(quality);
		if (!found) {
			found = imagesForQuality(source.images, source.pages, QUALITY_PROFILES[quality]);
			pictures.set(quality, found);
		}
		return found;
	};
	return (choice) => {
		const originalOnly = !source.notebook && !choice.insertedPages;
		const key = `${choice.theme}|${String(originalOnly)}|${choice.quality}`;
		let report = reports.get(key);
		if (!report) {
			report = (async () =>
				exportAnnotatedPdfWithReport({
					...(source.pdfBytes ? { pdfBytes: source.pdfBytes } : {}),
					pages: source.pages,
					// Ink keyed to a page not in the export is skipped, so dropping the
					// records drops their ink too.
					insertedPages: originalOnly ? [] : source.insertedPages,
					mode: settings.mode,
					theme: choice.theme,
					themes: settings.themes,
					images: await picturesFor(choice.quality),
					quality: choice.quality,
					...(source.header ? { header: source.header } : {}),
				}))();
			// A failed build is not remembered, so asking again tries again.
			report.catch(() => reports.delete(key));
			reports.set(key, report);
			// Each build is a whole PDF in memory; a tablet cannot hold one per level.
			for (const old of reports.keys()) {
				if (reports.size <= KEPT_BUILDS) break;
				reports.delete(old);
			}
		} else {
			// Most recently used last, so it is the last to be dropped.
			reports.delete(key);
			reports.set(key, report);
		}
		return report;
	};
}

/**
 * Flatten a PDF's annotations — or a notebook — into a new PDF, asking how
 * (theme, pages, quality) unless the settings say not to.
 */
export async function exportAnnotatedCopy(
	app: App,
	host: PdfInkHost,
	file: TFile,
	themes: PageThemes,
): Promise<void> {
	const notebook = isNotebookPath(file.path);
	const failed = `Could not export this ${notebook ? 'notebook' : 'PDF'}.`;
	try {
		const source = await loadExportSource(app, file, host.settings.headerDateFormat);
		if (typeof source === 'string') {
			new Notice(source);
			return;
		}
		const build = exportBuilder(source, { mode: host.settings.exportMode, themes });
		// Leaving out inserted pages is only worth offering when there are some.
		const offerOriginal =
			!notebook && source.insertedPages.some((page) => page.deletedAt === undefined);
		const choice = await resolveExportChoice(app, host, {
			offerOriginal,
			measure: async (asked) => (await build(asked)).bytes.byteLength,
			...(source.pdfBytes ? { originalSize: source.pdfBytes.byteLength } : {}),
		});
		if (choice === null) return;
		const report = await build(choice);
		await saveExport(app, source, report, choice, host.settings.exportSuffix);
	} catch (err) {
		console.error('pdf-ink: export failed', err);
		new Notice(failed);
	}
}

async function saveExport(
	app: App,
	source: ExportSource,
	{ bytes: flattened, scaledPages }: ExportReport,
	choice: ExportChoice,
	suffix: string,
): Promise<void> {
	const { file, notebook } = source;
	const originalOnly = !notebook && !choice.insertedPages;
	// A notebook exports beside itself as a PDF of the same name.
	const target = notebook
		? exportPathFor(`${file.path.slice(0, -file.extension.length)}pdf`, suffix)
		: exportPathFor(file.path, suffix, originalOnly ? ORIGINAL_PAGES_VARIANT : '');
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
}
