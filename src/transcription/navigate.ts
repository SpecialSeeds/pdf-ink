import type { App, TFile, WorkspaceLeaf } from 'obsidian';
import { PdfInkView, type RevealTarget } from '../ui/pdf-ink-view';
import { openInInkView } from '../utils/open-ink-view';

/**
 * Open `source` in the ink view in `leaf`, and show `target` in it: the page,
 * zoomed and scrolled so the block is in view, its outline flashed.
 */
export async function openSourceAt(
	app: App,
	source: TFile,
	leaf: WorkspaceLeaf,
	target: RevealTarget,
): Promise<void> {
	await openInInkView(app, source, leaf);
	const view = leaf.view;
	if (view instanceof PdfInkView) view.requestReveal(target);
}
