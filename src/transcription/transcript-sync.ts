import { type App, Notice, type TAbstractFile, TFile, TFolder } from 'obsidian';
import { blockBox, segmentPage } from '../core/blocks';
import {
	type BlocksField,
	isTranscribable,
	isTranscriptCurrent,
	isTranscriptPath,
	renderDirFor,
	shouldDeleteRenders,
	transcriptPathFor,
} from '../core/transcripts';
import { type TranscriptionFolders, readManifest, removeFolder, writeManifest } from './render';
import { openSource, readSourceInk } from './sources';
import { frontmatterOf } from './frontmatter';

/** The parent folder of a vault path, '' at the root. */
function parentOf(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash < 0 ? '' : path.slice(0, slash);
}

/** Make `folder` and every folder above it, through the vault. */
async function ensureVaultFolder(app: App, folder: string): Promise<void> {
	let path = '';
	for (const part of folder.split('/').filter((p) => p.length > 0)) {
		path = path ? `${path}/${part}` : part;
		if (!app.vault.getAbstractFileByPath(path)) await app.vault.createFolder(path);
	}
}

export type MoveOutcome = 'moved' | 'none' | 'blocked';

/**
 * A source moved from `oldSource` to `newSource`: move its transcript to match,
 * and point the transcript's `source` at the new path. A transcript already at
 * the destination is left alone, with a notice, rather than overwritten.
 */
export async function moveTranscript(
	app: App,
	transcriptFolder: string,
	oldSource: string,
	newSource: string,
): Promise<MoveOutcome> {
	const from = transcriptPathFor(oldSource, transcriptFolder);
	const to = transcriptPathFor(newSource, transcriptFolder);
	const transcript = app.vault.getFileByPath(from);
	if (!transcript || from === to) return 'none';
	if (app.vault.getAbstractFileByPath(to)) {
		new Notice(`A transcript already exists at ${to}; the old one was left at ${from}.`);
		return 'blocked';
	}
	await ensureVaultFolder(app, parentOf(to));
	await app.fileManager.renameFile(transcript, to);
	const moved = app.vault.getFileByPath(to);
	if (moved) {
		await app.fileManager.processFrontMatter(moved, (frontmatter: Record<string, unknown>) => {
			frontmatter['source'] = newSource;
		});
	}
	return 'moved';
}

/** A folder of sources moved: move its mirror in the transcript folder, and repoint every transcript in it. */
export async function moveTranscriptFolder(
	app: App,
	transcriptFolder: string,
	oldFolder: string,
	newFolder: string,
): Promise<MoveOutcome> {
	const from = `${transcriptFolder}/${oldFolder}`;
	const to = `${transcriptFolder}/${newFolder}`;
	const mirror = app.vault.getFolderByPath(from);
	if (!mirror) return 'none';
	if (app.vault.getAbstractFileByPath(to)) {
		new Notice(`Transcripts already exist at ${to}; those for ${oldFolder} were left at ${from}.`);
		return 'blocked';
	}
	await ensureVaultFolder(app, parentOf(to));
	await app.fileManager.renameFile(mirror, to);
	for (const file of app.vault.getFiles()) {
		if (!file.path.startsWith(`${to}/`) || file.extension !== 'md') continue;
		await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
			const source = frontmatter['source'];
			if (typeof source === 'string' && source.startsWith(`${oldFolder}/`)) {
				frontmatter['source'] = `${newFolder}/${source.slice(oldFolder.length + 1)}`;
			}
		});
	}
	return 'moved';
}

/** A source was deleted: its transcript goes to the trash too. */
export async function trashTranscript(app: App, transcriptFolder: string, source: string): Promise<boolean> {
	const transcript = app.vault.getFileByPath(transcriptPathFor(source, transcriptFolder));
	if (!transcript) return false;
	await app.fileManager.trashFile(transcript);
	return true;
}

/** A folder of sources was deleted: its mirror of transcripts goes to the trash. */
export async function trashTranscriptFolder(app: App, transcriptFolder: string, folder: string): Promise<boolean> {
	const mirror = app.vault.getFolderByPath(`${transcriptFolder}/${folder}`);
	if (!mirror) return false;
	await app.fileManager.trashFile(mirror);
	return true;
}

/** Stable JSON, so two `blocks` fields compare by content whatever their key order. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((v) => canonical(Number(v))).join(',')}]`;
	if (value !== null && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

export interface TranscriptSettings extends TranscriptionFolders {
	readonly deleteRendersAfterTranscription: boolean;
}

/**
 * A transcript was written or changed. Copy its source's block boxes into its
 * frontmatter, so a lookup never needs the render folder; then, once it is up
 * to date with its source, delete that source's renders if asked to.
 *
 * The boxes come from the manifest when it describes the same edit of the
 * source the transcript was made from, and are worked out afresh otherwise
 * (they are deterministic). Nothing is written when they already match, which
 * is also what stops this answering its own write.
 */
export async function syncTranscript(app: App, settings: TranscriptSettings, file: TFile): Promise<void> {
	if (!isTranscriptPath(file.path, settings.transcriptFolder)) return;
	const frontmatter = frontmatterOf(app, file);
	const sourcePath = frontmatter?.['source'];
	if (typeof sourcePath !== 'string') return;
	const sourceFile = app.vault.getFileByPath(sourcePath);
	if (!sourceFile) return;
	const sourceUpdated = frontmatter?.['source_updated'];

	const adapter = app.vault.adapter;
	const manifest = await readManifest(adapter, settings.renderFolder);
	const entry = manifest.sources.find((s) => s.path === sourcePath);
	const ink = await readSourceInk(app, sourceFile);
	if (!ink) return;

	let field: BlocksField | null = null;
	if (entry && isTranscriptCurrent(sourceUpdated, entry.updatedAt)) {
		field = Object.fromEntries(entry.pages.map((p) => [String(p.page), p.blocks]));
	} else if (isTranscriptCurrent(sourceUpdated, ink.latest)) {
		const source = await openSource(app, sourceFile);
		if (source) {
			try {
				field = Object.fromEntries(
					source.pages.map((page) => [
						String(page.number),
						Object.fromEntries(
							segmentPage(page.items, page.geometry.baseViewport.width, page.geometry.baseViewport.height).map(
								(b) => [b.id, blockBox(b.bounds)],
							),
						),
					]),
				);
			} finally {
				await source.close();
			}
		}
	}
	if (field && canonical(frontmatter?.['blocks'] ?? null) !== canonical(field)) {
		const blocks = field;
		await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			fm['blocks'] = blocks;
		});
	}

	if (shouldDeleteRenders(settings.deleteRendersAfterTranscription, sourceUpdated, ink.latest)) {
		const removed = await removeFolder(adapter, renderDirFor(sourcePath, settings.renderFolder));
		if (removed && entry) {
			await writeManifest(adapter, settings.renderFolder, {
				...manifest,
				sources: manifest.sources.map((s) =>
					s.path === sourcePath ? { ...s, pages: s.pages.map((p) => ({ ...p, image: null })) } : s,
				),
			});
		}
	}
}

/** Everything that keeps transcripts following their sources, for the plugin to register. */
export function transcriptHandlers(app: App, settings: () => TranscriptSettings): {
	rename: (file: TAbstractFile, oldPath: string) => void;
	remove: (file: TAbstractFile) => void;
	changed: (file: TFile) => void;
} {
	const pending = new Map<string, number>();
	return {
		rename: (file, oldPath) => {
			const folder = settings().transcriptFolder;
			// Moving the transcripts themselves is not a source moving.
			if (oldPath.startsWith(`${folder}/`) || file.path.startsWith(`${folder}/`)) return;
			if (file instanceof TFile && isTranscribable(oldPath)) {
				void moveTranscript(app, folder, oldPath, file.path).catch((err: unknown) => {
					console.error(`pdf-ink: could not move the transcript of ${oldPath}`, err);
				});
			} else if (file instanceof TFolder) {
				void moveTranscriptFolder(app, folder, oldPath, file.path).catch((err: unknown) => {
					console.error(`pdf-ink: could not move the transcripts of ${oldPath}`, err);
				});
			}
		},
		remove: (file) => {
			const folder = settings().transcriptFolder;
			if (file.path.startsWith(`${folder}/`)) return;
			if (file instanceof TFile && isTranscribable(file.path)) {
				void trashTranscript(app, folder, file.path).catch((err: unknown) => {
					console.error(`pdf-ink: could not trash the transcript of ${file.path}`, err);
				});
			} else if (file instanceof TFolder) {
				void trashTranscriptFolder(app, folder, file.path).catch((err: unknown) => {
					console.error(`pdf-ink: could not trash the transcripts of ${file.path}`, err);
				});
			}
		},
		changed: (file) => {
			if (!isTranscriptPath(file.path, settings().transcriptFolder)) return;
			// Claudian may write in several passes: act once it settles.
			window.clearTimeout(pending.get(file.path));
			pending.set(
				file.path,
				window.setTimeout(() => {
					pending.delete(file.path);
					void syncTranscript(app, settings(), file).catch((err: unknown) => {
						console.error(`pdf-ink: could not update ${file.path}`, err);
					});
				}, 1500),
			);
		},
	};
}
