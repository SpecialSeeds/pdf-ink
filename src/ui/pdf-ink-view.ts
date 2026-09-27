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
import { composePages, pagesSignature } from '../core/page-composition';
import type { PageKey } from '../core/pages';
import { readInkViewState, writeInkViewState } from '../core/view-state';
import { AnnotationStore } from '../pdf/annotation-store';
import { type PdfInkDocument, openPdfDocument } from '../pdf/document';
import { getPdfJs } from '../pdf/pdfjs';
import { type PdfInkHost } from '../settings';
import type { ToolKind } from '../core/tools';
import type { PageGeometry, ZoomMode } from '../types/view';
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

/**
 * A PDF viewer with an ink layer stacked over every page.
 *
 * Registered with `registerView` only, never `registerExtensions`: the core PDF
 * viewer stays the default handler for `.pdf` and this view is reached solely
 * through its command, its file-menu item, or a restored workspace.
 */
export class PdfInkView extends FileView implements ZoomHost {
	scrollEl!: HTMLElement;
	sizerEl!: HTMLElement;
	pagesEl!: HTMLElement;

	private statusEl!: HTMLElement;
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

	constructor(
		leaf: WorkspaceLeaf,
		private readonly host: PdfInkHost,
	) {
		super(leaf);
		this.icon = PDF_INK_ICON;
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

	/**
	 * Not dead code despite extension routing never reaching this view: Obsidian
	 * consults it when putting a file into an existing leaf of this type, such as
	 * back/forward navigation. Returning false would make the leaf silently swap
	 * itself back to another view type.
	 */
	override canAcceptExtension(extension: string): boolean {
		return extension.toLowerCase() === 'pdf';
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
		);
		this.zoom = new ZoomController(this, this);
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
				}
			}),
		);
		this.ready = true;
	}

	override async onLoadFile(file: TFile): Promise<void> {
		const epoch = ++this.epoch;
		await this.releaseDocument();
		if (epoch !== this.epoch) return;

		this.setStatus('Loading PDF…');
		try {
			const pdfjs = await getPdfJs();
			if (epoch !== this.epoch) return;

			const loaded = await openPdfDocument(this.app, file, pdfjs);
			if (epoch !== this.epoch) {
				await loaded.loadingTask.destroy();
				return;
			}

			this.document = loaded;
			// Before mounting: the first render then paints committed strokes with
			// no blank flash.
			await this.annotations.load(file);
			if (epoch !== this.epoch) return;
			this.mountDocument(loaded);
			this.repaintInk();
			this.setStatus(null);
		} catch (err) {
			if (epoch !== this.epoch) return;
			console.error('pdf-ink: could not open PDF', err);
			this.setStatus('Could not open this PDF.');
			new Notice('Could not open this PDF.');
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
		this.ink?.applySettings();
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
		);
		this.composedSignature = pagesSignature(this.composed);
		this.toolbar.setPageCount(this.composed.length);
		this.sidebar.setPages(this.composed);
		void this.sidebar.loadOutline(loaded.doc);

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

	/**
	 * Open the page menu for whatever page is in view.
	 *
	 * Anchored to the middle of the document rather than to a pointer, because the
	 * command can be run from the palette or from a mobile toolbar where there is no
	 * pointer to anchor to.
	 */
	openPageMenu(): void {
		const key = this.currentPageKey();
		if (key === null) return;
		const box = this.scrollEl.getBoundingClientRect();
		this.pageEditor?.showMenuFor(key, {
			x: box.left + box.width / 2,
			y: box.top + Math.min(box.height / 2, 200),
		});
	}

	/** Insert a page immediately after the one in view. */
	insertPageBelowCurrent(): void {
		const key = this.currentPageKey();
		if (key !== null) this.pageEditor?.insertBelow(key);
	}

	/** Insert a page immediately before the one in view. */
	insertPageAboveCurrent(): void {
		const key = this.currentPageKey();
		if (key !== null) this.pageEditor?.insertAbove(key);
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

		const loaded = this.document;
		this.document = null;
		if (loaded) {
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
