import { type App, FileView, type TFile, type WorkspaceLeaf } from 'obsidian';
import { VIEW_TYPE_PDF_INK } from '../constants';

export interface PdfTarget {
	readonly file: TFile;
	/** The leaf to convert — this is what makes "replace this tab" correct. */
	readonly leaf: WorkspaceLeaf;
	readonly alreadyInk: boolean;
}

/**
 * The PDF the user means by "current", together with the leaf showing it.
 *
 * Preferred over `workspace.getActiveFile()`, whose documented fallback is "the
 * most recently active file" — that returns a PDF closed ten minutes ago while
 * the graph view is focused, and yields no leaf, so a second lookup would be
 * needed anyway. Matching on `FileView` rather than on a view-type string also
 * means the core PDF viewer and any third-party one both work.
 */
export function resolvePdfTarget(app: App): PdfTarget | null {
	const view = app.workspace.getActiveViewOfType(FileView);
	if (view?.file && view.file.extension === 'pdf') {
		return {
			file: view.file,
			leaf: view.leaf,
			alreadyInk: view.getViewType() === VIEW_TYPE_PDF_INK,
		};
	}

	// Focus is in a sidebar. Fall back to the most recent main-area leaf and read
	// its stored state, rather than `leaf.view instanceof FileView`, which is
	// false while the leaf is deferred.
	const recent = app.workspace.getMostRecentLeaf();
	if (recent) {
		const state = recent.getViewState();
		const path = state.state?.['file'];
		if (typeof path === 'string') {
			const file = app.vault.getFileByPath(path);
			if (file && file.extension === 'pdf') {
				return {
					file,
					leaf: recent,
					alreadyInk: state.type === VIEW_TYPE_PDF_INK,
				};
			}
		}
	}

	return null;
}
