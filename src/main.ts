import { Plugin } from 'obsidian';
import { registerCommands } from './commands';
import { INK_LINK_HOVER_SOURCE, NOTEBOOK_ICON, VIEW_TYPE_PDF_INK } from './constants';
import { NOTEBOOK_EXTENSION } from './core/new-notebook';
import { registerFileMenu } from './menus/file-menu';
import { registerSidecarEvents } from './pdf/sidecar';
import {
	DEFAULT_SETTINGS,
	type PdfInkSettings,
	PdfInkSettingTab,
	mergeSettings,
} from './settings';
import { PdfInkView } from './ui/pdf-ink-view';
import { BoardLifecycle, VIEW_TYPE_BOARD } from './ui/board-lifecycle';
import { BoardView } from './ui/board-view';
import { NOTE_SEARCH_ICON, NoteSearchView, VIEW_TYPE_NOTE_SEARCH } from './ui/search-view';
import { transcriptRedirectHandler } from './transcription/redirect';
import { transcriptHandlers } from './transcription/transcript-sync';
import { createNotebook } from './utils/create-notebook';
import { forgetImage, retryMissingImages, setImageLoader } from './ui/image-cache';
import { readImageBytes } from './utils/images';
import { createPdf } from './utils/create-pdf';
import { DefaultPdfViewer } from './utils/default-viewer';
import { InkLinkIndex } from './links/ink-link-index';
import { AnnotationStore } from './pdf/annotation-store';

export default class PdfInkPlugin extends Plugin {
	settings: PdfInkSettings = DEFAULT_SETTINGS;
	private readonly defaultViewer = new DefaultPdfViewer(this);
	private readonly boards = new BoardLifecycle(this);
	private readonly links = new InkLinkIndex(
		this,
		() => this.settings.inkLinksInGraph,
		(sourcePath, rewrite) => this.rewriteLinks(sourcePath, rewrite),
	);
	/** Whether the link index was on at the last save, so a change starts or clears it. */
	private linksEnabled = DEFAULT_SETTINGS.inkLinksInGraph;

	override async onload(): Promise<void> {
		// Registered before any await: a restored workspace holding a pdf-ink-view
		// leaf needs this creator to exist by the time the layout is rebuilt, or
		// the leaf comes back as an empty pane.
		//
		// Taking over `.pdf` goes through DefaultPdfViewer rather than
		// registerExtensions, so the core viewer can always be handed it back.
		this.registerView(
			VIEW_TYPE_PDF_INK,
			(leaf) => new PdfInkView(leaf, this),
		);
		// A notebook has no other viewer, so it is ours outright — unlike `.pdf`,
		// which the core viewer owns until the user hands it over.
		this.registerExtensions([NOTEBOOK_EXTENSION], VIEW_TYPE_PDF_INK);
		// Temporary boards: no file, so a view type of their own, restored by id.
		this.registerView(VIEW_TYPE_BOARD, (leaf) => new BoardView(leaf, this, this.boards));
		this.boards.register();

		// Like a drawing plugin's "new drawing": one click from the sidebar ribbon
		// to a fresh page to write on.
		this.addRibbonIcon('file-plus-2', 'Create new PDF', () => {
			void createPdf(this.app, this.settings);
		});
		this.addRibbonIcon(NOTEBOOK_ICON, 'New notebook', () => {
			void createNotebook(this.app, { titleHeader: this.settings.addTitleHeader });
		});

		// Transcription: searching the handwriting, and keeping transcripts with
		// their notebooks.
		this.registerView(VIEW_TYPE_NOTE_SEARCH, (leaf) => new NoteSearchView(leaf, this));
		this.addRibbonIcon(NOTE_SEARCH_ICON, 'Search notes', () => {
			void this.openNoteSearch();
		});
		const transcripts = transcriptHandlers(this.app, () => this.settings);
		this.registerEvent(this.app.vault.on('rename', transcripts.rename));
		this.registerEvent(this.app.vault.on('delete', transcripts.remove));
		this.registerEvent(this.app.metadataCache.on('changed', transcripts.changed));
		this.registerEvent(
			this.app.workspace.on('file-open', transcriptRedirectHandler(this.app, () => this.settings)),
		);

		// Image items name their pictures by vault path; this is how they are read,
		// and how a picture that changes, moves or turns up is read again.
		setImageLoader((src) => readImageBytes(this.app, src));
		this.register(() => {
			setImageLoader(null);
		});
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				forgetImage(file.path);
			}),
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				forgetImage(file.path);
			}),
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				forgetImage(oldPath);
				retryMissingImages();
			}),
		);
		this.registerEvent(
			this.app.vault.on('create', () => {
				retryMissingImages();
			}),
		);

		// Text box links: in the graph, followed on renames, previewed on hover.
		this.registerHoverLinkSource(INK_LINK_HOVER_SOURCE, { display: 'PDF Ink', defaultMod: true });

		registerCommands(this, this.boards);
		registerFileMenu(this);
		// Vault-wide, so a PDF renamed while closed does not orphan its sidecar.
		registerSidecarEvents(this);

		this.settings = mergeSettings(await this.loadData());
		this.linksEnabled = this.settings.inkLinksInGraph;
		// After the settings: enabled mid-session, layout ready fires at once, and
		// must see whether links are switched off.
		this.links.register();
		this.defaultViewer.apply(this.settings.openByDefault);
		this.addSettingTab(new PdfInkSettingTab(this.app, this));
	}

	/** Show the note search, in the right sidebar beside Obsidian's own search. */
	async openNoteSearch(): Promise<void> {
		const workspace = this.app.workspace;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_NOTE_SEARCH)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			await leaf?.setViewState({ type: VIEW_TYPE_NOTE_SEARCH, active: true });
		}
		if (leaf) await workspace.revealLeaf(leaf);
	}

	/**
	 * Rewrite one PDF's or notebook's text boxes: a link's target was renamed.
	 * An open document is edited through its view, as one undoable edit; a
	 * closed one is loaded, merged with what is on disk and saved the usual
	 * way, which for a notebook means in place, never by rename.
	 */
	private async rewriteLinks(sourcePath: string, rewrite: (text: string) => string | null): Promise<void> {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PDF_INK)) {
			const view = leaf.view;
			if (view instanceof PdfInkView && view.file?.path === sourcePath) {
				view.rewriteLinkText(rewrite);
				return;
			}
		}
		const file = this.app.vault.getFileByPath(sourcePath);
		if (!file) return;
		const store = new AnnotationStore(this.app, () => {});
		await store.load(file);
		if (store.isFrozen) return;
		if (store.rewriteText(rewrite) > 0) await store.flush();
	}

	/** The view type that shows a PDF without ink, for leaving the ink view. */
	get plainPdfViewType(): string {
		return this.defaultViewer.plainViewType;
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.defaultViewer.apply(this.settings.openByDefault);
		if (this.settings.inkLinksInGraph !== this.linksEnabled) {
			this.linksEnabled = this.settings.inkLinksInGraph;
			void this.links.setEnabled(this.linksEnabled);
		}
		// Settings that change how an open view behaves — the diagnostics overlay —
		// take effect where the user can see them, not on the next reopen.
		for (const leaf of [
			...this.app.workspace.getLeavesOfType(VIEW_TYPE_PDF_INK),
			...this.app.workspace.getLeavesOfType(VIEW_TYPE_BOARD),
		]) {
			const view = leaf.view;
			if (view instanceof PdfInkView) view.refreshSettings();
		}
	}

	// No onunload: registerView, addCommand and registerEvent all unwind on their
	// own, and DefaultPdfViewer hands `.pdf` back to the core viewer. Detaching
	// the view's leaves would also reset placement the user chose.
}
