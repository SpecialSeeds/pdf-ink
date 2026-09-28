import { type App, Notice, type TFile, type WorkspaceLeaf } from 'obsidian';
import { VIEW_TYPE_PDF_INK } from '../constants';

/**
 * Swap `leaf` in place to the ink view for `file`.
 *
 * `ViewState` has no `file` field, so the path travels in `state` under the same
 * key `FileView.getState()` emits — which makes opening and workspace restore a
 * single code path. Idempotent: re-invoking for the leaf and file already shown
 * only reveals it.
 *
 * Deliberately never touches `leaf.view` afterwards: until a deferred leaf loads,
 * its view is a `DeferredView`, so routing through state means there is no window
 * in which we hold a half-initialised view.
 */
export async function openInInkView(
	app: App,
	file: TFile,
	leaf: WorkspaceLeaf,
): Promise<void> {
	const current = leaf.getViewState();
	const sameTarget =
		current.type === VIEW_TYPE_PDF_INK &&
		current.state?.['file'] === file.path;

	if (!sameTarget) {
		await leaf.setViewState({
			type: VIEW_TYPE_PDF_INK,
			// Needed: the file-explorer entry point runs with focus in the
			// sidebar, and without this the ink view renders but keyboard focus
			// stays behind.
			active: true,
			state: { file: file.path },
		});
	}

	// Awaiting this guarantees the leaf is foregrounded and fully loaded.
	await app.workspace.revealLeaf(leaf);
}

/** Fire-and-forget wrapper for the synchronous callbacks that invoke this. */
export function openInInkViewSafely(
	app: App,
	file: TFile,
	leaf: WorkspaceLeaf,
): void {
	openInInkView(app, file, leaf).catch((err: unknown) => {
		console.error('pdf-ink: could not open the annotation view', err);
		new Notice('Could not open this PDF for annotation.');
	});
}

/**
 * Swap `leaf` back to a plain PDF viewer for `file`.
 *
 * The way out once the ink view opens PDFs by default: without it, the only route
 * to Obsidian's own viewer would be turning the setting off.
 */
export function openInPlainViewSafely(
	app: App,
	file: TFile,
	leaf: WorkspaceLeaf,
	viewType: string,
): void {
	leaf
		.setViewState({ type: viewType, active: true, state: { file: file.path } })
		.then(() => app.workspace.revealLeaf(leaf))
		.catch((err: unknown) => {
			console.error('pdf-ink: could not open the plain PDF viewer', err);
			new Notice('Could not open this PDF in the built-in viewer.');
		});
}
