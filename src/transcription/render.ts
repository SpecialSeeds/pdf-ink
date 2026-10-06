import { type App, type DataAdapter, Notice, Platform, type TFile, type TFolder, normalizePath } from 'obsidian';
import { blockBox, segmentPage, type BlockBox } from '../core/blocks';
import { DESKTOP_BUDGET, MOBILE_BUDGET } from '../core/canvas-budget';
import { sidecarPathFor } from '../core/ink-serialization';
import { isNotebookPath } from '../core/new-notebook';
import {
	INSTRUCTIONS_FILE,
	MANIFEST_FILE,
	isRenderStale,
	isTranscriptCurrent,
	renderDirFor,
	renderPagePath,
	transcriptPathFor,
	transcriptionInstructions,
} from '../core/transcripts';
import { TRANSCRIPTION_SCALE, canvasToPng, rasterisePage } from './raster';
import { openSource, readSourceInk } from './sources';
import { frontmatterOf } from './frontmatter';

export interface TranscriptionFolders {
	readonly transcriptFolder: string;
	readonly renderFolder: string;
}

/** One page as the manifest describes it. */
export interface ManifestPage {
	readonly page: number;
	/** The render, vault-relative; null once deleted or when not rendered. */
	readonly image: string | null;
	/** Page size in points. */
	readonly width: number;
	readonly height: number;
	/** Pixels per point of the render. */
	readonly scale: number;
	/** Block id -> [x, y, w, h] in PDF space. */
	readonly blocks: Record<string, BlockBox>;
}

export interface ManifestSource {
	/** The notebook or PDF, vault-relative. */
	readonly path: string;
	readonly pageCount: number;
	/** The newest edit in it, epoch ms: what a transcript's source_updated must equal. */
	readonly updatedAt: number;
	readonly transcript: string;
	readonly pages: ManifestPage[];
}

export interface Manifest {
	readonly version: 1;
	readonly generated: string;
	readonly sources: ManifestSource[];
}

export function manifestPath(renderFolder: string): string {
	return `${renderFolder}/${MANIFEST_FILE}`;
}

/** The manifest as it stands, or an empty one. Hidden folders go through the adapter. */
export async function readManifest(adapter: DataAdapter, renderFolder: string): Promise<Manifest> {
	const path = manifestPath(renderFolder);
	try {
		if (await adapter.exists(path)) {
			const parsed = JSON.parse(await adapter.read(path)) as Partial<Manifest>;
			if (Array.isArray(parsed.sources)) {
				return { version: 1, generated: parsed.generated ?? '', sources: parsed.sources };
			}
		}
	} catch (err) {
		console.warn('pdf-ink: the render manifest could not be read; starting a new one', err);
	}
	return { version: 1, generated: '', sources: [] };
}

export async function writeManifest(adapter: DataAdapter, renderFolder: string, manifest: Manifest): Promise<void> {
	await ensureFolder(adapter, renderFolder);
	await adapter.write(manifestPath(renderFolder), `${JSON.stringify(manifest, null, '\t')}\n`);
}

/** Make `folder` and every folder above it. */
export async function ensureFolder(adapter: DataAdapter, folder: string): Promise<void> {
	let path = '';
	for (const part of normalizePath(folder).split('/')) {
		path = path ? `${path}/${part}` : part;
		if (!(await adapter.exists(path))) await adapter.mkdir(path);
	}
}

/** Remove a folder and everything in it, if it is there. */
export async function removeFolder(adapter: DataAdapter, folder: string): Promise<boolean> {
	if (!(await adapter.exists(folder))) return false;
	await adapter.rmdir(folder, true);
	return true;
}

/** Every notebook, and every PDF with ink, in `folder` and below. */
export function transcribableIn(app: App, folder: TFolder): TFile[] {
	const prefix = folder.isRoot() ? '' : `${folder.path}/`;
	return app.vault
		.getFiles()
		.filter(
			(file) =>
				file.path.startsWith(prefix) &&
				(isNotebookPath(file.path) ||
					(file.extension === 'pdf' && app.vault.getFileByPath(sidecarPathFor(file.path)) !== null)),
		)
		.sort((a, b) => a.path.localeCompare(b.path));
}

/** The transcript's frontmatter `source_updated`, or undefined when there is none. */
export function transcriptSourceUpdated(app: App, transcriptPath: string): unknown {
	const file = app.vault.getFileByPath(transcriptPath);
	if (!file) return undefined;
	const frontmatter = frontmatterOf(app, file);
	return frontmatter?.['source_updated'];
}

/** The instructions file in the transcript folder, as it should read. */
export async function writeInstructions(app: App, folders: TranscriptionFolders): Promise<void> {
	const path = `${folders.transcriptFolder}/${INSTRUCTIONS_FILE}`;
	const text = transcriptionInstructions(folders.renderFolder, folders.transcriptFolder);
	const existing = app.vault.getFileByPath(path);
	if (existing) {
		if ((await app.vault.read(existing)) !== text) await app.vault.modify(existing, text);
		return;
	}
	if (!app.vault.getFolderByPath(folders.transcriptFolder)) {
		await app.vault.createFolder(folders.transcriptFolder).catch(() => undefined);
	}
	await app.vault.create(path, text);
}

export interface RenderSummary {
	rendered: number;
	pages: number;
	upToDate: number;
	transcribed: number;
	failed: string[];
}

/**
 * Render every source in `folder` for transcription and record it in the
 * manifest. A source already transcribed and unchanged is not rendered again,
 * and neither is one whose renders are newer than it; both keep their manifest
 * entry, with block boxes, so lookups and Claudian's checks still work.
 */
export async function renderForTranscription(
	app: App,
	folder: TFolder,
	folders: TranscriptionFolders,
	progress: (message: string) => void = () => undefined,
): Promise<RenderSummary> {
	const adapter = app.vault.adapter;
	const manifest = await readManifest(adapter, folders.renderFolder);
	const entries = new Map(manifest.sources.map((s) => [s.path, s]));
	const summary: RenderSummary = { rendered: 0, pages: 0, upToDate: 0, transcribed: 0, failed: [] };
	const maxPixels = (Platform.isMobile ? MOBILE_BUDGET : DESKTOP_BUDGET).maxArea;
	const sources = transcribableIn(app, folder);

	for (const [n, file] of sources.entries()) {
		progress(`Rendering ${String(n + 1)} of ${String(sources.length)}: ${file.basename}`);
		const transcript = transcriptPathFor(file.path, folders.transcriptFolder);
		try {
			const ink = await readSourceInk(app, file);
			if (!ink) continue;
			const current = isTranscriptCurrent(transcriptSourceUpdated(app, transcript), ink.latest);
			const firstPage = renderPagePath(file.path, folders.renderFolder, 1);
			const renderedAt = (await adapter.stat(firstPage))?.mtime ?? null;
			const renderNeeded = !current && isRenderStale(renderedAt, ink.mtimes);
			const previous = entries.get(file.path);
			if (!renderNeeded && previous?.updatedAt === ink.latest) {
				if (current) summary.transcribed += 1;
				else summary.upToDate += 1;
				continue;
			}

			const source = await openSource(app, file);
			if (!source) continue;
			try {
				const dir = renderDirFor(file.path, folders.renderFolder);
				// A page dropped since last time must not leave its old image behind.
				if (renderNeeded) await removeFolder(adapter, dir);
				const pages: ManifestPage[] = [];
				for (const page of source.pages) {
					const blocks = segmentPage(
						page.items,
						page.geometry.baseViewport.width,
						page.geometry.baseViewport.height,
					);
					const boxes = Object.fromEntries(blocks.map((b) => [b.id, blockBox(b.bounds)]));
					let image: string | null = null;
					let scale = TRANSCRIPTION_SCALE;
					if (renderNeeded) {
						const raster = await rasterisePage(page, {
							scale: TRANSCRIPTION_SCALE,
							grayscale: true,
							blocks,
							maxPixels,
						});
						image = renderPagePath(file.path, folders.renderFolder, page.number);
						scale = raster.scale;
						await ensureFolder(adapter, dir);
						await adapter.writeBinary(image, await canvasToPng(raster.canvas));
						summary.pages += 1;
					} else {
						image = previous?.pages.find((p) => p.page === page.number)?.image ?? null;
					}
					const base = page.geometry.baseViewport;
					pages.push({
						page: page.number,
						image,
						width: Math.round(base.width * 10) / 10,
						height: Math.round(base.height * 10) / 10,
						scale: Math.round(scale * 1000) / 1000,
						blocks: boxes,
					});
				}
				entries.set(file.path, {
					path: file.path,
					pageCount: source.pages.length,
					updatedAt: ink.latest,
					transcript,
					pages,
				});
				if (renderNeeded) summary.rendered += 1;
				else if (current) summary.transcribed += 1;
				else summary.upToDate += 1;
			} finally {
				await source.close();
			}
		} catch (err) {
			console.error(`pdf-ink: could not render ${file.path}`, err);
			summary.failed.push(file.path);
		}
	}

	// Sources that are gone take their entries with them.
	for (const path of [...entries.keys()]) {
		if (!app.vault.getFileByPath(path)) entries.delete(path);
	}
	await writeManifest(adapter, folders.renderFolder, {
		version: 1,
		generated: new Date().toISOString(),
		sources: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)),
	});
	await writeInstructions(app, folders);
	return summary;
}

/** The command: pick a folder, render it, and say what happened. */
export async function runRenderCommand(app: App, folder: TFolder, folders: TranscriptionFolders): Promise<void> {
	const notice = new Notice('Rendering notebooks for transcription…', 0);
	try {
		const summary = await renderForTranscription(app, folder, folders, (message) => {
			notice.setMessage(message);
		});
		const parts = [
			`Rendered ${String(summary.rendered)} source(s), ${String(summary.pages)} page(s).`,
			summary.upToDate > 0 ? `${String(summary.upToDate)} already rendered.` : '',
			summary.transcribed > 0 ? `${String(summary.transcribed)} already transcribed.` : '',
			summary.failed.length > 0 ? `Could not render: ${summary.failed.join(', ')}.` : '',
			`Ask Claudian to "transcribe notes".`,
		];
		notice.setMessage(parts.filter((p) => p.length > 0).join(' '));
		window.setTimeout(() => {
			notice.hide();
		}, 10_000);
	} catch (err) {
		console.error('pdf-ink: rendering for transcription failed', err);
		notice.setMessage('Could not render notebooks for transcription.');
		window.setTimeout(() => {
			notice.hide();
		}, 6_000);
	}
}
