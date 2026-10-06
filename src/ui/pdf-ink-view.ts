import {
	Component,
	FileView,
	type IconName,
	Notice,
	Platform,
	TFile,
	type ViewStateResult,
	type WorkspaceLeaf,
} from 'obsidian';
import { PAGE_GAP, PDF_INK_ICON, VIEW_TYPE_PDF_INK } from '../constants';
import {
	type CanvasBudget,
	DESKTOP_BUDGET,
	MOBILE_BUDGET,
} from '../core/canvas-budget';
import { maxBaseHeight, maxBaseWidth } from '../core/layout';
import { type Bounds, boundsContain, itemBounds } from '../core/hit-test';
import { grownBoardPage } from '../core/board';
import { type BlockBox, blockBox, segmentPage } from '../core/blocks';
import { type InkTarget, blockBoxFrom, parseInkSubpath, transcriptPathFor } from '../core/transcripts';

/** A place in the handwriting to show: a page, and a block on it by id or box. */
export interface RevealTarget extends InkTarget {
	/** `[x, y, w, h]` in PDF space, when already known. */
	readonly box?: BlockBox;
}

/** How long a found block stays outlined. */
const FLASH_MS = 1500;
import { paperTintStyle } from '../core/paper-tint';
import { type HeaderText, headerText, headerTitleBox } from '../core/header';
import { HeaderEditor } from './header-editor';
import { renameNotebookFromTitle } from '../utils/rename-notebook';
import type { Item } from '../core/items';
import {
	NOTEBOOK_EXTENSION,
	isNotebookPath,
	isNumberedCopyName,
	shouldAppendPage,
} from '../core/new-notebook';
import { pageBounds } from '../core/page-bounds';
import { composePages, pagesSignature } from '../core/page-composition';
import type { PageKey } from '../core/pages';
import {
	type PageTheme,
	type PageThemes,
	type ThemeName,
	effectiveThemes,
	highlighterBlend,
	themeForPage,
} from '../core/theme';
import { readInkViewState, writeInkViewState } from '../core/view-state';
import { AnnotationStore } from '../pdf/annotation-store';
import {
	type PdfInkDocument,
	notebookDocument,
	openPdfDocument,
} from '../pdf/document';
import { getPdfJs } from '../pdf/pdfjs';
import { exportAnnotatedCopy } from '../utils/export-pdf';
import { type PdfInkHost } from '../settings';
import type { ToolKind } from '../core/tools';
import type { PageGeometry, PageRecord, ZoomMode } from '../types/view';
import { resolveExportTheme } from './export-theme-modal';
import { askAboutSyncCopy } from './sync-copy-modal';
import { confirm } from './confirm-modal';
import { PageEditor } from './page-editor';
import { PageList } from './page-list';
import { InputDiagnostics } from './input-diagnostics';
import { PdfSidebar } from './pdf-sidebar';
import { PageRenderer } from './page-renderer';
import { PdfInkToolbar } from './toolbar';
import { ZoomController, type ZoomHost } from './zoom-controller';
import { DprWatcher } from './dpr-watcher';
import { InkController } from './ink-controller';
import { attachZoomGestures } from './zoom-gestures';
import { frontmatterOf } from '../transcription/frontmatter';

/**
 * A PDF viewer with an ink layer stacked over every page.
 *
 * By default it is the handler for `.pdf` (see DefaultPdfViewer), and with that
 * setting off it is reached through its command, its file-menu item, or a
 * restored workspace.
 */
export class PdfInkView extends FileView implements ZoomHost {
	scrollEl!: HTMLElement;
	sizerEl!: HTMLElement;
	pagesEl!: HTMLElement;

	private statusEl!: HTMLElement;
	/** Renaming the notebook from its title. */
	private readonly headerEditor = new HeaderEditor(this, (title) => {
		void this.renameFromHeader(title);
	});
	/** The "no pages" notice of an empty notebook, while it shows. */
	private emptyEl: HTMLElement | null = null;
	private toolbar!: PdfInkToolbar;
	private sidebar!: PdfSidebar;
	private diagnostics!: InputDiagnostics;
	private renderer!: PageRenderer;
	private zoom!: ZoomController;

	private pageList: PageList | null = null;
	private pageEditor: PageEditor | null = null;
	/**
	 * Owns the page editor's DOM listeners for the life of one document.
	 *
	 * A child component rather than the view itself: the editor is rebuilt on every
	 * file switch, and registering on the view would stack up a set of handlers per
	 * document until the tab closed.
	 */
	private pageEditorScope: Component | null = null;
	/** The document's pages in display order: original pages plus insertions. */
	private composed: readonly PageGeometry[] = [];
	/** Guards the structural rebuild, so an ordinary stroke does not trigger one. */
	private composedSignature = '';
	private syncingPages = false;
	/** Strokes for the open document, persisted to a sidecar beside the PDF. */
	private annotations!: AnnotationStore;
	private ink: InkController | null = null;
	private document: PdfInkDocument | null = null;

	/**
	 * Bumped on every file switch and on close. A render that completes after
	 * this has moved on must not touch the DOM of a document we no longer show.
	 */
	private epoch = 0;

	private dprWatcher!: DprWatcher;

	/**
	 * True once onOpen has built the shell. Obsidian can call getState() on a
	 * constructed-but-not-yet-opened view during a workspace save, and the
	 * definite-assignment fields above would still be undefined.
	 */
	private ready = false;

	/** Restored from workspace state, consumed on the next file load. */
	private pendingZoomMode: ZoomMode | null = null;
	/**
	 * The page to reopen at, as a page key rather than a number.
	 *
	 * A saved number would point at whatever now sits at that position, which is
	 * the wrong page as soon as anything has been inserted above it.
	 */
	private pendingPageKey: PageKey | null = null;
	/** A place to show once the document is mounted. */
	private pendingReveal: RevealTarget | null = null;

	/**
	 * Light or dark notebook and inserted pages, for this tab. Restored from the
	 * workspace, and otherwise following Obsidian's own theme when the tab opened.
	 */
	private theme: ThemeName = obsidianTheme();
	/** The theme colours in effect: the settings laid over the defaults. */
	private pageThemes: PageThemes;
	/** A check for sync copies is running. */
	private checkingCopies = false;
	/** Another check is wanted once the running one finishes. */
	private copiesChanged = false;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly host: PdfInkHost,
	) {
		super(leaf);
		this.icon = PDF_INK_ICON;
		this.pageThemes = effectiveThemes(host.settings.pageThemes);
	}

	getViewType(): string {
		return VIEW_TYPE_PDF_INK;
	}

	override getIcon(): IconName {
		return PDF_INK_ICON;
	}

	override getDisplayText(): string {
		return this.file ? this.file.basename : 'PDF ink';
	}

	/** Whether the open file is a notebook rather than a PDF. */
	get isNotebook(): boolean {
		return this.file !== null && isNotebookPath(this.file.path);
	}

	/**
	 * Obsidian consults this when putting a file into an existing leaf of this
	 * type, such as back/forward navigation, even when `.pdf` is routed elsewhere.
	 * Returning false would make the leaf silently swap itself to another view.
	 */
	override canAcceptExtension(extension: string): boolean {
		const ext = extension.toLowerCase();
		return ext === 'pdf' || ext === NOTEBOOK_EXTENSION;
	}

	override getState(): Record<string, unknown> {
		const state = super.getState();
		if (!this.ready) return state;
		return Object.assign(
			state,
			writeInkViewState(
				this.zoom.getMode(),
				this.zoom.getZoom(),
				this.currentPageNumber(),
				this.currentPageKey(),
				this.theme,
			),
		);
	}

	override async setState(
		state: unknown,
		result: ViewStateResult,
	): Promise<void> {
		// Read our own keys BEFORE awaiting super: super.setState assigns
		// this.file and drives onUnloadFile/onLoadFile, so anything the load
		// needs must already be on `this`. Reading afterwards would render at the
		// default zoom first and then visibly re-render.
		const restored = readInkViewState(state);
		if (restored.zoomMode) this.pendingZoomMode = restored.zoomMode;
		if (restored.pageKey !== null) this.pendingPageKey = restored.pageKey;
		if (restored.theme !== null && restored.theme !== this.theme) {
			this.theme = restored.theme;
			if (this.ready) this.applyTheme();
		}

		// Leave result.history alone — FileView sets it when the file changes, and
		// overriding it is how the back button breaks.
		await super.setState(state, result);
	}

	protected override async onOpen(): Promise<void> {
		// Runs before setState, so this.file is still null here: build only the
		// static shell. Every per-document resource belongs in onLoadFile.
		this.contentEl.empty();
		this.contentEl.addClass('pdf-ink-view');
		this.contentEl.setCssProps({
			'--pdf-ink-page-gap': `${String(PAGE_GAP)}px`,
		});

		this.annotations = new AnnotationStore(this.app, () => {
			// Pages first: an inserted page has to exist before its ink is painted,
			// and a merge from another device can add one at any time.
			this.syncPages();
			this.repaintInk();
			this.ink?.refresh();
		});

		this.toolbar = new PdfInkToolbar(this.contentEl, this, {
			toggleSidebar: () => {
				this.toolbar.setSidebarOpen(this.sidebar.toggle());
			},
			previousPage: () => {
				this.goToPage(this.currentPageNumber() - 1);
			},
			nextPage: () => {
				this.goToPage(this.currentPageNumber() + 1);
			},
			zoomOut: () => {
				this.zoom.zoomOut();
			},
			zoomIn: () => {
				this.zoom.zoomIn();
			},
			fitWidth: () => {
				this.zoom.fitWidth();
			},
			fitPage: () => {
				this.zoom.fitPage();
			},
			toggleZoomLock: () => {
				this.toggleZoomLock();
			},
			insertPageAbove: () => {
				this.insertPageAboveCurrent();
			},
			insertPageBelow: () => {
				this.insertPageBelowCurrent();
			},
			pageOptions: (at) => {
				this.openPageMenu(at);
			},
			toggleTheme: () => {
				this.toggleTheme();
			},
			exportPdf: () => {
				void this.exportAnnotated();
			},
			togglePaperTint: () => {
				this.togglePaperTint();
			},
			goToPage: (pageNumber) => {
				this.goToPage(pageNumber);
			},
		});

		// The sidebar sits beside the scroller, not above it, so opening it narrows
		// the page rather than covering it.
		const bodyEl = this.contentEl.createDiv({ cls: 'pdf-ink-body' });
		this.sidebar = new PdfSidebar(bodyEl, this, {
			goToIndex: (index) => {
				this.pageList?.scrollToPage(index);
			},
			insertedTheme: () => this.insertedTheme(),
		});

		this.scrollEl = bodyEl.createDiv({ cls: 'pdf-ink-scroll' });
		this.diagnostics = new InputDiagnostics(this.contentEl, this);
		this.diagnostics.setEnabled(this.host.settings.inputDiagnostics);
		this.statusEl = this.scrollEl.createDiv({ cls: 'pdf-ink-status' });
		this.sizerEl = this.scrollEl.createDiv({ cls: 'pdf-ink-sizer' });
		this.pagesEl = this.sizerEl.createDiv({ cls: 'pdf-ink-pages' });

		this.renderer = new PageRenderer(
			this.budget(),
			() => this.epoch,
			(record) => {
				// Resizing a canvas clears it, so committed ink has to be repainted.
				this.ink?.redraw(record);
			},
			() => this.insertedTheme(),
		);
		this.zoom = new ZoomController(this, this);
		this.applyZoomLock();
		attachZoomGestures(this, this.scrollEl, this.zoom);

		this.dprWatcher = new DprWatcher(this, this.containerEl, (dpr) => {
			// Boxes are unchanged, so no relayout and no anchor work is needed.
			this.pageList?.setDpr(dpr);
		});
		this.dprWatcher.start();

		this.ink = new InkController(
			this,
			this.app,
			this.contentEl,
			this.pagesEl,
			this.annotations,
			this.host,
			{
				resolveRecord: (target) => this.pageList?.recordForTarget(target),
				recordForPage: (pageKey) => this.pageList?.recordForKey(pageKey),
				repaint: () => {
					this.repaintInk();
				},
				traceInput: (event, fields) => {
					this.diagnostics.log(event, fields);
				},
				tracingInput: () => this.diagnostics.isEnabled,
				pageTheme: (record) => this.pageTheme(record),
				itemsCommitted: (pageKey, items) => {
					this.growNotebook(pageKey, items);
				},
				headerTitleAt: (record, x, y) => {
					const source = record.geom.source;
					return (
						source.kind === 'inserted' &&
						source.header !== undefined &&
						boundsContain(headerTitleBox(source.page), x, y)
					);
				},
				editHeader: (record) => {
					this.headerEditor.open(record, this.pageTheme(record));
				},
			},
		);
		this.scope = this.ink.scope;

		/*
		 * A sync client — or this vault on another device — can write the sidecar
		 * while it is open here. Merging on the modify event means our next save
		 * folds those edits in rather than overwriting them.
		 */
		this.registerEvent(
			this.app.vault.on('modify', (changed) => {
				if (changed instanceof TFile) {
					this.annotations.handleExternalChange(changed);
					this.annotations.handleBaseAppeared(changed);
				}
			}),
		);

		// A sync client can drop a numbered copy of this notebook in at any time.
		const onAppear = (file: unknown): void => {
			const open = this.file;
			if (!(file instanceof TFile) || !open) return;
			if (isNumberedCopyName(open.path, file.path)) this.checkNumberedCopies();
			// A notebook can arrive by sync before its base layer does.
			this.annotations.handleBaseAppeared(file);
		};
		this.registerEvent(this.app.vault.on('create', onAppear));
		this.registerEvent(this.app.vault.on('rename', onAppear));
		this.applyThemeStyles();
		this.ready = true;
	}

	override async onLoadFile(file: TFile): Promise<void> {
		const epoch = ++this.epoch;
		await this.releaseDocument();
		if (epoch !== this.epoch) return;

		const notebook = isNotebookPath(file.path);
		const noun = notebook ? 'notebook' : 'PDF';
		this.setStatus(`Loading ${noun}…`);
		try {
			let loaded: PdfInkDocument;
			if (notebook) {
				loaded = notebookDocument();
			} else {
				const pdfjs = await getPdfJs();
				if (epoch !== this.epoch) return;

				loaded = await openPdfDocument(this.app, file, pdfjs);
				if (epoch !== this.epoch) {
					await loaded.loadingTask?.destroy();
					return;
				}
			}

			this.document = loaded;
			// Before mounting: the first render then paints committed strokes with
			// no blank flash.
			await this.annotations.load(file);
			if (epoch !== this.epoch) return;
			this.mountDocument(loaded);
			this.repaintInk();
			this.setStatus(null);
			if (notebook) this.checkNumberedCopies();
		} catch (err) {
			if (epoch !== this.epoch) return;
			console.error(`pdf-ink: could not open ${noun}`, err);
			this.setStatus(`Could not open this ${noun}.`);
			new Notice(`Could not open this ${noun}.`);
		}
	}

	override async onUnloadFile(_file: TFile): Promise<void> {
		// A file can change without onOpen running again (back/forward, rename,
		// openFile on this leaf), so all per-document teardown lives here.
		this.epoch++;
		await this.releaseDocument();
	}

	protected override async onClose(): Promise<void> {
		this.ready = false;
		this.epoch++;
		await this.releaseDocument();
	}

	/** Re-read settings that can change while a view is open. */
	refreshSettings(): void {
		if (!this.ready) return;
		this.diagnostics.setEnabled(this.host.settings.inputDiagnostics);
		this.applyZoomLock();
		this.ink?.applySettings();

		// Theme colours edited in the settings tab show at once, not on reopen.
		const themes = effectiveThemes(this.host.settings.pageThemes);
		if (JSON.stringify(themes) !== JSON.stringify(this.pageThemes)) {
			this.pageThemes = themes;
			this.applyTheme();
		}
		// So does a change of the header's date format.
		this.syncPages();
		this.applyPaperTint();
	}

	/**
	 * The title header to draw, if this notebook has one. The title is the file's
	 * name at this moment, so a rename shows as soon as it happens.
	 */
	private currentHeader(): HeaderText | undefined {
		const file = this.file;
		const header = this.annotations.header;
		if (!file || !header || !this.isNotebook) return undefined;
		return headerText(file.path, header, this.host.settings.headerDateFormat);
	}

	/** Renamed here or anywhere else: the header shows the new name at once. */
	override async onRename(file: TFile): Promise<void> {
		await super.onRename(file);
		this.syncPages();
	}

	/**
	 * Rename the notebook to what was typed into its title. Refused, with a
	 * notice, for a name already taken or one a file cannot have; the title then
	 * simply shows the old name again, since it is always the file's.
	 */
	async renameFromHeader(title: string): Promise<void> {
		const file = this.file;
		if (!file || !this.isNotebook) return;
		await renameNotebookFromTitle(this.app, file, title);
		this.syncPages();
	}

	/**
	 * Ask about any numbered copy of this notebook that shares its identity.
	 * Never merges on its own; one check at a time, with one more queued if a copy
	 * turns up while the user is still answering.
	 */
	private checkNumberedCopies(): void {
		if (!this.isNotebook) return;
		this.copiesChanged = true;
		if (this.checkingCopies) return;
		this.checkingCopies = true;
		void (async () => {
			try {
				while (this.copiesChanged) {
					this.copiesChanged = false;
					await this.annotations.resolveNumberedCopies((copy, notebook) =>
						askAboutSyncCopy(this.app, copy, notebook),
					);
					await this.annotations.offerToMoveBase((found, target) =>
						confirm(this.app, {
							title: "Move this notebook's imported ink?",
							message: `Its imported ink was found at ${found.path}. Move it to ${target}, beside the notebook?`,
							cta: 'Move',
						}),
					);
				}
			} catch (err) {
				console.error('pdf-ink: could not check for sync copies', err);
			} finally {
				this.checkingCopies = false;
			}
		})();
	}

	/** Switch this tab's notebook and inserted pages between light and dark. */
	toggleTheme(): void {
		this.theme = this.theme === 'dark' ? 'light' : 'dark';
		this.applyTheme();
		// The theme is per tab, saved with the workspace.
		this.app.workspace.requestSaveLayout();
	}

	/** The colours of a notebook or inserted page, under this tab's theme. */
	private insertedTheme(): PageTheme {
		return this.pageThemes[this.theme];
	}

	/** The theme a page's ink renders under: original PDF pages are always light. */
	private pageTheme(record: PageRecord): PageTheme {
		return this.pageThemes[themeForPage(record.geom.source.kind, this.theme)];
	}

	/** Paint every page the theme reaches again, and update what shows it. */
	private applyTheme(): void {
		if (!this.ready) return;
		this.applyThemeStyles();
		this.pageList?.repaint((record) => record.geom.source.kind === 'inserted');
		this.sidebar.repaintInserted();
		// Ink on every page: a changed light theme reaches PDF pages too.
		this.repaintInk();
		this.ink?.refresh();
	}

	/**
	 * The paper behind an inserted page before its bitmap lands, and how its
	 * highlighter blends — chosen from the paper's luminance, so a customised
	 * paper still gets the blend that keeps highlights visible.
	 */
	private applyThemeStyles(): void {
		const paper = this.insertedTheme().paper;
		this.pagesEl.setCssProps({
			'--pdf-ink-inserted-paper': paper,
			'--pdf-ink-inserted-blend': highlighterBlend(paper),
		});
		// Dark notebook pages are already easy on the eyes: the tint skips them.
		this.contentEl.toggleClass('is-dark-pages', this.theme === 'dark');
		this.toolbar.setTheme(this.theme);
		this.applyPaperTint();
	}

	/** Lay the paper tint over the pages, or take it away. Screen only. */
	private applyPaperTint(): void {
		const settings = this.host.settings;
		this.contentEl.toggleClass('is-paper-tinted', settings.paperTint);
		this.contentEl.setCssProps(
			paperTintStyle({
				enabled: settings.paperTint,
				color: settings.paperTintColor,
				strength: settings.paperTintStrength,
			}),
		);
		this.toolbar.setPaperTint(settings.paperTint);
	}

	/** Turn the paper tint on or off, in every open view. */
	togglePaperTint(): void {
		this.host.settings.paperTint = !this.host.settings.paperTint;
		// Saving refreshes every open view, this one included.
		void this.host.saveSettings();
	}

	/**
	 * Grow a notebook as it is written in: ink near the bottom of the last page
	 * adds the next one, as part of the same undo step as the ink. A board never
	 * adds a page; its one page widens or lengthens instead.
	 */
	private growNotebook(pageKey: PageKey, items: readonly Item[]): void {
		if (this.document?.kind !== 'notebook') return;
		if (this.annotations.layout === 'board') {
			this.growBoard(pageKey, items);
			return;
		}
		const last = this.composed[this.composed.length - 1];
		if (!last || last.key !== pageKey) return;

		let lowest = Number.POSITIVE_INFINITY;
		for (const item of items) {
			const bounds = itemBounds(item);
			if (bounds) lowest = Math.min(lowest, bounds.minY);
		}
		if (!Number.isFinite(lowest)) return;

		const page = pageBounds(last.baseViewport, last.baseWidth, last.baseHeight);
		if (shouldAppendPage(lowest, page.minY, page.maxY - page.minY, true)) {
			this.pageEditor?.appendPage();
		}
	}

	/** Widen or lengthen a board page when ink lands near its right or bottom edge. */
	private growBoard(pageKey: PageKey, items: readonly Item[]): void {
		const geom = this.composed.find((g) => g.key === pageKey);
		if (geom?.source.kind !== 'inserted') return;
		let ink: Bounds | null = null;
		for (const item of items) {
			const b = itemBounds(item);
			if (!b) continue;
			ink = ink
				? {
						minX: Math.min(ink.minX, b.minX),
						minY: Math.min(ink.minY, b.minY),
						maxX: Math.max(ink.maxX, b.maxX),
						maxY: Math.max(ink.maxY, b.maxY),
					}
				: b;
		}
		if (!ink) return;
		const grown = grownBoardPage(geom.source.page, ink, Date.now());
		if (grown) this.annotations.resizePageJoined(grown);
	}

	/** Lock or unlock the zoom, in every open ink view. */
	toggleZoomLock(): void {
		this.host.settings.zoomLocked = !this.host.settings.zoomLocked;
		// Saving refreshes every open view, this one included.
		void this.host.saveSettings();
		new Notice(this.host.settings.zoomLocked ? 'Zoom locked' : 'Zoom unlocked', 900);
	}

	private applyZoomLock(): void {
		const locked = this.host.settings.zoomLocked;
		this.zoom.setLocked(locked);
		this.toolbar.setZoomLocked(locked);
	}

	/** Move the tool palette to the other edge. */
	flipToolbarSide(): void {
		this.ink?.flipToolbarSide();
	}

	override onResize(): void {
		if (!this.ready) return;
		// Only meaningful in fit-width mode; a fixed zoom just re-centres, which
		// CSS handles on its own.
		this.zoom.recomputeFit();
	}

	// --- ZoomHost -------------------------------------------------------

	maxBaseWidth(): number {
		// The displayed pages, not just the document's own: an inserted page can be
		// the widest thing on screen, and fit-width has to account for it.
		return maxBaseWidth(this.composed);
	}

	maxBaseHeight(): number {
		return maxBaseHeight(this.composed);
	}

	contentSize(): { width: number; height: number } {
		const layout = this.pageList?.getLayout();
		return {
			width: layout?.contentWidth ?? 0,
			height: layout?.contentHeight ?? 0,
		};
	}

	applyZoom(zoom: number): void {
		// The title editor is placed for the old zoom; finish the rename instead.
		this.headerEditor.close(true);
		this.pageList?.relayout(zoom);
		// The selection box is positioned in CSS px, so it has to follow the zoom.
		this.ink?.refreshSelectionBox();
	}

	onZoomChanged(zoom: number, mode: ZoomMode): void {
		this.toolbar.setZoom(zoom, mode);
	}

	// --- internals ------------------------------------------------------

	private mountDocument(loaded: PdfInkDocument): void {
		const list = new PageList(
			this.sizerEl,
			this.pagesEl,
			this.scrollEl,
			this.renderer,
			(pageNumber) => {
				this.toolbar.setCurrentPage(pageNumber);
				this.sidebar.setActiveIndex(pageNumber - 1);
			},
			this.host.settings.bufferPages,
		);
		this.pageList = list;

		this.composed = composePages(
			loaded.geometry,
			this.annotations.insertedPages(),
			this.currentHeader(),
		);
		this.composedSignature = pagesSignature(this.composed);
		this.toolbar.setPageCount(this.composed.length);
		this.sidebar.setPages(this.composed);
		void this.sidebar.loadOutline(loaded.doc);
		this.showEmptyNotebook();

		const mode: ZoomMode = this.pendingZoomMode ?? this.defaultZoomMode();
		this.pendingZoomMode = null;

		// Resolve the zoom first and build at it, so the pages are rasterised
		// once rather than at a provisional scale and then again.
		const zoom = this.zoom.resolveInitialZoom(mode);
		list.build(this.composed, zoom, this.dprWatcher.value);
		this.zoom.adopt(zoom, mode);

		const editorScope = new Component();
		this.addChild(editorScope);
		this.pageEditorScope = editorScope;
		this.pageEditor = new PageEditor(
			editorScope,
			this.pagesEl,
			this.scrollEl,
			this.annotations,
			{
				geometry: () => this.composed,
				layout: () => list.getLayout(),
				pdfPageCount: () => loaded.geometry.length,
				scrollToPage: (index) => {
					list.scrollToPage(index);
				},
				documentRuling: () => loaded.ruling,
			},
		);

		const target = this.pendingPageKey ?? null;
		this.pendingPageKey = null;
		if (target !== null) {
			const at = this.composed.findIndex((geom) => geom.key === target);
			// A page key that is no longer in the document simply reopens at the top,
			// which is better than refusing to restore the tab at all.
			if (at >= 0) list.scrollToPage(at);
		}
		// A search result, transcript or link asked for a place in the handwriting.
		const reveal = this.pendingReveal;
		this.pendingReveal = null;
		if (reveal) this.reveal(reveal);
	}

	/**
	 * Show a place in the handwriting: scroll to the page, zoom out if the block
	 * would not fit, centre it, and flash its outline. Waits for the document
	 * if it is still loading.
	 */
	requestReveal(target: RevealTarget): void {
		if (this.pageList) this.reveal(target);
		else this.pendingReveal = target;
	}

	/** A link into this file: `#page=N`, or `#page=N&block=BX`. */
	override setEphemeralState(state: unknown): void {
		super.setEphemeralState(state);
		const subpath = (state as { subpath?: unknown } | null)?.subpath;
		if (typeof subpath !== 'string') return;
		const target = parseInkSubpath(subpath);
		if (target) this.requestReveal(target);
	}

	private reveal(target: RevealTarget): void {
		const list = this.pageList;
		if (!list || this.composed.length === 0) return;
		const index = Math.min(Math.max(1, target.page), this.composed.length) - 1;
		const geom = this.composed[index];
		if (!geom) return;
		const box = target.box ?? (target.block ? this.blockBoxFor(index, target.block) : null);
		if (!box) {
			list.scrollToPage(index);
			return;
		}

		// Zoom out only as far as the block needs to fit, with a margin.
		const [x, y, w, h] = box;
		const pageBox = list.getLayout().pages[index];
		const scale = pageBox?.scale ?? geom.baseViewport.scale;
		const room = { w: this.scrollEl.clientWidth * 0.9, h: this.scrollEl.clientHeight * 0.8 };
		const fit = Math.min(room.w / Math.max(1, w * scale), room.h / Math.max(1, h * scale));
		if (fit < 1) this.zoom.zoomTo(this.zoom.getZoom() * fit);

		const laid = list.getLayout().pages[index];
		const record = list.recordAt(index);
		if (!laid || !record) return;
		const viewport = geom.baseViewport.clone({ scale: laid.scale });
		const [left = 0, top = 0] = viewport.convertToViewportPoint(x, y + h);
		const [right = 0, bottom = 0] = viewport.convertToViewportPoint(x + w, y);
		const rect = {
			x: Math.min(left, right),
			y: Math.min(top, bottom),
			w: Math.abs(right - left),
			h: Math.abs(bottom - top),
		};
		this.scrollEl.scrollTop = laid.offsetTop + rect.y + rect.h / 2 - this.scrollEl.clientHeight / 2;
		const pageLeft = this.sizerEl.offsetLeft + record.wrapperEl.offsetLeft;
		this.scrollEl.scrollLeft = pageLeft + rect.x + rect.w / 2 - this.scrollEl.clientWidth / 2;
		list.updateRetainSet();
		this.flash(record.wrapperEl, rect);
	}

	/** Outline a found block for a moment, so the eye lands on it. */
	private flash(wrapperEl: HTMLElement, rect: { x: number; y: number; w: number; h: number }): void {
		const pad = 6;
		const flashEl = wrapperEl.createDiv({ cls: 'pdf-ink-flash' });
		flashEl.setCssProps({
			'--pdf-ink-flash-x': `${String(rect.x - pad)}px`,
			'--pdf-ink-flash-y': `${String(rect.y - pad)}px`,
			'--pdf-ink-flash-w': `${String(rect.w + 2 * pad)}px`,
			'--pdf-ink-flash-h': `${String(rect.h + 2 * pad)}px`,
		});
		window.setTimeout(() => {
			flashEl.remove();
		}, FLASH_MS);
	}

	/**
	 * Where block `block` is on display page `index`: as its transcript recorded
	 * it, since that is what the transcript's ids mean, or else worked out from
	 * the page as it is now.
	 */
	private blockBoxFor(index: number, block: string): BlockBox | null {
		const file = this.file;
		if (!file) return null;
		const transcript = this.app.vault.getFileByPath(
			transcriptPathFor(file.path, this.host.settings.transcriptFolder),
		);
		const frontmatter = transcript
			? frontmatterOf(this.app, transcript)
			: undefined;
		const recorded = blockBoxFrom(frontmatter?.['blocks'], index + 1, block);
		if (recorded) return recorded;
		const geom = this.composed[index];
		if (!geom) return null;
		const found = segmentPage(this.annotations.itemsFor(geom.key), geom.baseWidth, geom.baseHeight).find(
			(b) => b.id === block,
		);
		return found ? blockBox(found.bounds) : null;
	}

	/**
	 * Rebuild the page list when — and only when — the set of pages has changed.
	 *
	 * Every store mutation lands here, including a stroke, so the signature check is
	 * what keeps drawing from paying for a relayout of the whole document.
	 */
	private syncPages(): void {
		const loaded = this.document;
		const list = this.pageList;
		// Re-entrant: committing the open text box below is itself a store change.
		if (!loaded || !list || this.syncingPages) return;

		const composed = composePages(
			loaded.geometry,
			this.annotations.insertedPages(),
			this.currentHeader(),
		);
		const signature = pagesSignature(composed);
		if (signature === this.composedSignature) return;

		this.syncingPages = true;
		try {
			this.composed = composed;
			this.composedSignature = signature;
			this.pageEditor?.hideGap();
			// An open editor is a textarea inside a page wrapper that may be about to
			// be removed. Commit it first, so what was typed is kept rather than
			// going with the element. Only items change, so the signature stands.
			this.ink?.cancelActive();
			list.setPages(composed, this.zoom.getZoom());
			this.toolbar.setPageCount(composed.length);
			this.sidebar.setPages(composed);
			// Fit-width is measured against the widest page, which may have changed.
			this.zoom.recomputeFit();
			this.showEmptyNotebook();
			// A deleted page leaves a selection pointing at items that are now gone.
			this.ink?.pruneSelection();
			this.ink?.refreshSelectionBox();
		} finally {
			this.syncingPages = false;
		}
	}

	canUndoInk(): boolean {
		return this.ready && (this.ink?.canUndo ?? false);
	}

	canRedoInk(): boolean {
		return this.ready && (this.ink?.canRedo ?? false);
	}

	undoInk(): void {
		this.ink?.undo();
	}

	redoInk(): void {
		this.ink?.redo();
	}

	toggleEraserMode(): void {
		this.ink?.toggleEraser();
	}

	/** Switch to a tool, or back to the previous one. */
	toggleTool(tool: ToolKind): void {
		this.ink?.toggleTool(tool);
	}

	/** Whether there is a page to act on, for the command's check pass. */
	hasCurrentPage(): boolean {
		return this.ready && this.composed.length > 0;
	}

	/** Whether a page can be inserted: beside the one in view, or into an empty notebook. */
	canInsertPage(): boolean {
		return this.hasCurrentPage() || (this.ready && this.document?.kind === 'notebook');
	}

	/**
	 * Open the page menu for whatever page is in view.
	 *
	 * Anchored to the middle of the document rather than to a pointer, because the
	 * command can be run from the palette or from a mobile toolbar where there is no
	 * pointer to anchor to.
	 */
	openPageMenu(at?: { x: number; y: number }): void {
		const key = this.currentPageKey();
		if (key === null) return;
		const box = this.scrollEl.getBoundingClientRect();
		this.pageEditor?.showMenuFor(
			key,
			at ?? {
				x: box.left + box.width / 2,
				y: box.top + Math.min(box.height / 2, 200),
			},
		);
	}

	/**
	 * Export this PDF with its annotations.
	 *
	 * Flushes first: saves are debounced, and the export reads the sidecar on
	 * disk, so the last half-second of writing would otherwise be left out.
	 */
	async exportAnnotated(): Promise<void> {
		const file = this.file;
		if (!file) return;
		this.ink?.flushText();
		await this.annotations.flush();
		const theme = await resolveExportTheme(this.app, this.host);
		if (theme === null) return;
		await exportAnnotatedCopy(this.app, file, {
			suffix: this.host.settings.exportSuffix,
			mode: this.host.settings.exportMode,
			theme,
			themes: this.pageThemes,
			headerDateFormat: this.host.settings.headerDateFormat,
		});
	}

	/** Insert a page immediately after the one in view. */
	insertPageBelowCurrent(): void {
		if (this.addFirstPage()) return;
		const key = this.currentPageKey();
		if (key !== null) this.pageEditor?.insertBelow(key);
	}

	/** Insert a page immediately before the one in view. */
	insertPageAboveCurrent(): void {
		if (this.addFirstPage()) return;
		const key = this.currentPageKey();
		if (key !== null) this.pageEditor?.insertAbove(key);
	}

	/**
	 * Give an empty notebook a page. True when it did, so the caller stops: with no
	 * page in view there is nothing to insert above or below.
	 */
	private addFirstPage(): boolean {
		if (this.document?.kind !== 'notebook' || this.composed.length > 0) return false;
		this.pageEditor?.insertAt(0);
		return true;
	}

	/**
	 * An empty notebook — its last page deleted, or an empty file — says so and
	 * offers a page, since there is no page to open a menu on or insert beside.
	 */
	private showEmptyNotebook(): void {
		const empty = this.document?.kind === 'notebook' && this.composed.length === 0;
		this.emptyEl?.remove();
		this.emptyEl = null;
		if (!empty) return;
		const emptyEl = this.scrollEl.createDiv({ cls: 'pdf-ink-empty-notebook' });
		emptyEl.createDiv({ text: 'This notebook has no pages.' });
		const buttonEl = emptyEl.createEl('button', { cls: 'mod-cta', text: 'Add a page' });
		buttonEl.addEventListener('click', () => {
			this.addFirstPage();
		});
		this.emptyEl = emptyEl;
	}

	/** Repaint every live page's ink from PDF space at the current viewport. */
	private repaintInk(): void {
		const ink = this.ink;
		if (!ink) return;
		this.pageList?.eachRecord((record) => {
			ink.redraw(record);
		});
	}

	private async releaseDocument(): Promise<void> {
		// Persist before letting go of the document. Obsidian unloads backgrounded
		// views, so this is what makes ink survive a tab switch, not just a close.
		// Commits any open text editor before the flush, so nothing typed is lost.
		this.ink?.cancelActive();
		await this.annotations.flush();
		this.annotations.discard();

		// Thumbnails and the outline belong to the document that is going away; page
		// keys repeat between documents, so they cannot be left to be matched.
		this.sidebar.reset();

		this.pageEditor = null;
		// Unloads its listeners before PageList.dispose() empties the container the
		// insert control lives in.
		const editorScope = this.pageEditorScope;
		this.pageEditorScope = null;
		if (editorScope) this.removeChild(editorScope);
		this.composed = [];
		this.composedSignature = '';

		const list = this.pageList;
		this.pageList = null;
		if (list) await list.dispose();

		this.emptyEl?.remove();
		this.emptyEl = null;

		const loaded = this.document;
		this.document = null;
		if (loaded?.loadingTask) {
			try {
				// Destroys the document and its worker-side data too.
				await loaded.loadingTask.destroy();
			} catch (err) {
				console.error('pdf-ink: error releasing PDF', err);
			}
		}
	}

	/** Scroll to a 1-based page number, clamped to the document. */
	private goToPage(pageNumber: number): void {
		const list = this.pageList;
		if (!list || this.composed.length === 0) return;
		const clamped = Math.min(
			Math.max(1, Math.round(pageNumber)),
			this.composed.length,
		);
		list.scrollToPage(clamped - 1);
		this.toolbar.setCurrentPage(clamped);
	}

	private currentPageNumber(): number {
		const list = this.pageList;
		if (!list) return 1;
		const layout = list.getLayout();
		for (const [index, box] of layout.pages.entries()) {
			if (box.offsetTop + box.cssHeight > this.scrollEl.scrollTop) {
				return index + 1;
			}
		}
		return 1;
	}

	/** The key of the page currently at the top of the viewport. */
	private currentPageKey(): PageKey | null {
		if (this.pageList === null) return this.pendingPageKey;
		return this.composed[this.currentPageNumber() - 1]?.key ?? null;
	}

	private defaultZoomMode(): ZoomMode {
		// A board opens with its whole height in view, to pan along its width.
		if (this.annotations.layout === 'board') return { kind: 'fit-height' };
		return this.host.settings.defaultZoomMode === 'actual-size'
			? { kind: 'fixed', zoom: 1 }
			: { kind: 'fit-width' };
	}

	private budget(): CanvasBudget {
		return Platform.isMobile ? MOBILE_BUDGET : DESKTOP_BUDGET;
	}

	private setStatus(message: string | null): void {
		if (message === null) {
			this.statusEl.setText('');
			this.statusEl.hide();
			return;
		}
		this.statusEl.setText(message);
		this.statusEl.show();
	}

}

/** Obsidian's own theme right now, which a tab with no saved theme follows. */
function obsidianTheme(): ThemeName {
	return activeDocument.body.hasClass('theme-dark') ? 'dark' : 'light';
}
