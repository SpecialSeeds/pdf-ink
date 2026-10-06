import type { App, TFile } from 'obsidian';
import { type BasePages, basePathFor, layerItems } from '../core/base-layer';
import { parseInkData, sidecarPathFor } from '../core/ink-serialization';
import { type InkData, type Item, liveItems } from '../core/items';
import { isNotebookPath } from '../core/new-notebook';
import { composePages } from '../core/page-composition';
import type { PageKey } from '../core/pages';
import { latestUpdatedAt } from '../core/transcripts';
import { readBaseLayer } from '../pdf/base-file';
import { openPdfDocument } from '../pdf/document';
import { getPdfJs } from '../pdf/pdfjs';
import type { PDFDocumentLoadingTask } from '../types/pdfjs';
import type { PageGeometry } from '../types/view';

/**
 * A notebook's or PDF's ink, as stored: its data, its base layer, and when
 * anything in it last changed. Read without opening a PDF, so cheap enough to
 * check whether a transcript is current.
 */
export interface SourceInk {
	readonly file: TFile;
	readonly data: InkData;
	readonly base: BasePages | undefined;
	/** The newest edit anywhere in it; a transcript is current while it matches. */
	readonly latest: number;
	/** When each of its files was last written: the source, its sidecar, its base. */
	readonly mtimes: readonly number[];
}

/**
 * The ink of `file`, or null when it has none to transcribe: a PDF without a
 * sidecar, or with nothing live in it; a notebook that cannot be read.
 */
export async function readSourceInk(app: App, file: TFile): Promise<SourceInk | null> {
	const notebook = isNotebookPath(file.path);
	const store = notebook ? file : app.vault.getFileByPath(sidecarPathFor(file.path));
	if (!store) return null;
	const parsed = parseInkData(await app.vault.read(store));
	if (!parsed.ok) return null;
	const data = parsed.data;
	const mtimes = [file.stat.mtime, store.stat.mtime];
	let base: BasePages | undefined;
	if (data.base) {
		const found = await readBaseLayer(app, file, data.base);
		if (typeof found !== 'string') {
			base = found.pages;
			mtimes.push(found.file.stat.mtime);
		}
	}
	if (!notebook) {
		const live = Object.values(data.pages).some((items) => liveItems(items).length > 0);
		if (!live) return null;
	}
	const baseFile = app.vault.getFileByPath(basePathFor(file.path));
	if (baseFile) mtimes.push(baseFile.stat.mtime);
	return { file, data, base, latest: latestUpdatedAt(data, base), mtimes };
}

/** One page of a source, ready to render. */
export interface SourcePage {
	/** 1-based, in display order. */
	readonly number: number;
	readonly key: PageKey;
	readonly geometry: PageGeometry;
	/** Live items, both layers, in no particular order. */
	readonly items: readonly Item[];
}

/** A source opened for rendering. Close it when done: a PDF holds pdf.js memory. */
export interface OpenSource extends SourceInk {
	readonly pages: readonly SourcePage[];
	close(): Promise<void>;
}

/** Open a source's pages, its PDF included, for rendering. */
export async function openSource(app: App, file: TFile): Promise<OpenSource | null> {
	const ink = await readSourceInk(app, file);
	if (!ink) return null;
	let task: PDFDocumentLoadingTask | null = null;
	let pdfGeometry: readonly PageGeometry[] = [];
	if (!isNotebookPath(file.path)) {
		const doc = await openPdfDocument(app, file, await getPdfJs());
		task = doc.loadingTask;
		pdfGeometry = doc.geometry;
	}
	const composed = composePages(pdfGeometry, ink.data.insertedPages);
	const pages = composed.map((geometry, i): SourcePage => ({
		number: i + 1,
		key: geometry.key,
		geometry,
		items: liveItems(layerItems(ink.base?.[geometry.key], ink.data.pages[geometry.key] ?? [])),
	}));
	return {
		...ink,
		pages,
		close: async () => {
			await task?.destroy();
		},
	};
}
