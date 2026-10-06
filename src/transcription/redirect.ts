import { type App, MarkdownView, Notice, type TFile } from 'obsidian';
import { blockBoxFrom, isTranscriptPath, resolveRedirect } from '../core/transcripts';
import { openSourceAt } from './navigate';
import { frontmatterOf } from './frontmatter';

export interface RedirectSettings {
	readonly transcriptFolder: string;
	readonly openSourcesInsteadOfTranscripts: boolean;
}

/** Long enough for Obsidian to place the cursor on a search match after opening. */
const SETTLE_MS = 150;

/**
 * A transcript was opened in a tab. Swap it, in that tab, for its source at the
 * handwriting nearest where the transcript was opened: the block of the
 * cursor's line, else the page of the heading above it, else page 1.
 */
export async function redirectTranscript(app: App, settings: RedirectSettings, file: TFile): Promise<boolean> {
	if (!settings.openSourcesInsteadOfTranscripts) return false;
	if (!isTranscriptPath(file.path, settings.transcriptFolder)) return false;
	const view = app.workspace.getActiveViewOfType(MarkdownView);
	if (!view || view.file?.path !== file.path) return false;
	const frontmatter = frontmatterOf(app, file);
	const sourcePath = frontmatter?.['source'];
	if (typeof sourcePath !== 'string') return false;
	const source = app.vault.getFileByPath(sourcePath);
	if (!source) {
		new Notice(`This transcript's notebook, ${sourcePath}, is not in the vault.`);
		return false;
	}
	const line =
		view.getMode() === 'source' ? view.editor.getCursor().line : Math.round(view.currentMode.getScroll());
	const target = resolveRedirect(view.editor.getValue(), line);
	const box = target.block ? blockBoxFrom(frontmatter?.['blocks'], target.page, target.block) : null;
	await openSourceAt(app, source, view.leaf, { ...target, ...(box ? { box } : {}) });
	return true;
}

/** The handler for the workspace's file-open event. */
export function transcriptRedirectHandler(app: App, settings: () => RedirectSettings): (file: TFile | null) => void {
	return (file) => {
		if (!file || !isTranscriptPath(file.path, settings().transcriptFolder)) return;
		window.setTimeout(() => {
			void redirectTranscript(app, settings(), file).catch((err: unknown) => {
				console.error(`pdf-ink: could not open the source of ${file.path}`, err);
			});
		}, SETTLE_MS);
	};
}
