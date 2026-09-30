import { type Component, setIcon } from 'obsidian';
import { isRenderCancelled } from '../types/pdfjs';
import type {
	PDFDestination,
	PDFDocumentProxy,
	PDFOutlineNode,
	PDFRef,
} from '../types/pdfjs';
import type { PageGeometry } from '../types/view';
import { paintInsertedPage } from './template-painter';

/** Rendered width of a thumbnail, in CSS px. */
const THUMBNAIL_WIDTH = 116;

/** Above this, a thumbnail sweep costs more than it helps; render on demand only. */
const THUMBNAIL_DPR_CAP = 2;

export interface SidebarCallbacks {
	/** Jump to a page by display index, 0-based. */
	goToIndex(index: number): void;
}

type Tab = 'thumbnails' | 'outline';

interface ThumbnailEntry {
	readonly key: string;
	readonly el: HTMLElement;
	readonly canvasEl: HTMLCanvasElement;
	geom: PageGeometry;
	/** Guards against a second render starting on a canvas pdf.js still owns. */
	rendering: boolean;
	rendered: boolean;
}

/**
 * The document panel: page thumbnails and the PDF's own bookmarks.
 *
 * Thumbnails are rendered lazily, through an observer on the list itself, because
 * a sweep over a 500-page document at open would cost more than the whole viewer.
 * They cover inserted pages too, drawn from the same template geometry the page
 * itself uses, so the panel is a picture of the document as it will export rather
 * than of the source file.
 */
export class PdfSidebar {
	private readonly rootEl: HTMLElement;
	private readonly tabsEl: HTMLElement;
	private readonly thumbsEl: HTMLElement;
	private readonly outlineEl: HTMLElement;
	private readonly tabButtons = new Map<Tab, HTMLElement>();

	private readonly entries = new Map<string, ThumbnailEntry>();
	private readonly byEl = new WeakMap<Element, ThumbnailEntry>();
	private observer: IntersectionObserver | null = null;

	private geometry: readonly PageGeometry[] = [];
	private tab: Tab = 'thumbnails';
	private open = false;
	private activeIndex = 0;
	private outlineLoaded = false;
	/** Bumped on teardown, so a render that lands late cannot touch the DOM. */
	private epoch = 0;

	constructor(
		parentEl: HTMLElement,
		private readonly component: Component,
		private readonly callbacks: SidebarCallbacks,
	) {
		this.rootEl = parentEl.createDiv({ cls: 'pdf-ink-sidebar is-hidden' });
		this.tabsEl = this.rootEl.createDiv({ cls: 'pdf-ink-sidebar-tabs' });
		this.addTab('thumbnails', 'Thumbnails', 'gallery-thumbnails');
		this.addTab('outline', 'Outline', 'list-tree');

		const bodyEl = this.rootEl.createDiv({ cls: 'pdf-ink-sidebar-body' });
		this.thumbsEl = bodyEl.createDiv({ cls: 'pdf-ink-thumbnails' });
		this.outlineEl = bodyEl.createDiv({ cls: 'pdf-ink-outline is-hidden' });

		this.observer = new IntersectionObserver(
			(records) => {
				for (const record of records) {
					if (!record.isIntersecting) continue;
					const entry = this.byEl.get(record.target);
					if (entry) void this.renderThumbnail(entry);
				}
			},
			{ root: bodyEl, rootMargin: '200px', threshold: 0 },
		);
		this.component.register(() => {
			this.dispose();
		});
	}

	get isOpen(): boolean {
		return this.open;
	}

	/**
	 * Forget the current document.
	 *
	 * Required on every file switch, not merely tidy: thumbnails are cached by page
	 * key, and `pdf:0` means a different page in the next PDF — so without this the
	 * panel would show the previous document's pages and its outline.
	 */
	reset(): void {
		// Discards any render still in flight, so it cannot paint over a new page.
		this.epoch += 1;
		for (const entry of this.entries.values()) {
			this.observer?.unobserve(entry.el);
			entry.canvasEl.width = 0;
			entry.canvasEl.height = 0;
			entry.el.remove();
		}
		this.entries.clear();
		this.geometry = [];
		this.activeIndex = 0;
		this.outlineLoaded = false;
		this.outlineEl.empty();
		this.tabButtons.get('outline')?.removeClass('is-empty');
	}

	toggle(): boolean {
		this.setOpen(!this.open);
		return this.open;
	}

	setOpen(open: boolean): void {
		this.open = open;
		this.rootEl.toggleClass('is-hidden', !open);
		// Deferred until the panel is actually on screen: an observer on a hidden
		// element reports nothing, so opening is what starts the first renders.
		if (open) this.refreshVisible();
	}

	/**
	 * Adopt a new page list.
	 *
	 * Entries are matched by page key, exactly as the main page list does, so
	 * inserting a page costs one new thumbnail rather than re-rendering all of them.
	 */
	setPages(geometry: readonly PageGeometry[]): void {
		this.geometry = geometry;
		const leftover = new Map(this.entries);

		geometry.forEach((geom, index) => {
			const existing = leftover.get(geom.key);
			if (existing) {
				leftover.delete(geom.key);
				// An inserted page whose ruling changed must be drawn again.
				if (existing.geom !== geom) {
					existing.geom = geom;
					existing.rendered = false;
				}
				existing.el.dataset.pageNumber = String(index + 1);
				this.setLabel(existing, index);
				this.thumbsEl.appendChild(existing.el);
				return;
			}
			const entry = this.createEntry(geom, index);
			this.entries.set(geom.key, entry);
			this.thumbsEl.appendChild(entry.el);
		});

		for (const [key, entry] of leftover) {
			this.observer?.unobserve(entry.el);
			entry.el.remove();
			this.entries.delete(key);
		}

		this.setActiveIndex(this.activeIndex);
		if (this.open) this.refreshVisible();
	}

	/** Highlight the page currently in view. */
	setActiveIndex(index: number): void {
		this.activeIndex = index;
		this.geometry.forEach((geom, at) => {
			const entry = this.entries.get(geom.key);
			entry?.el.toggleClass('is-active', at === index);
		});
	}

	/** Load the document's bookmarks. Safe to call once per document. */
	async loadOutline(doc: PDFDocumentProxy): Promise<void> {
		if (this.outlineLoaded) return;
		this.outlineLoaded = true;
		const epoch = this.epoch;

		let outline: PDFOutlineNode[] | null = null;
		try {
			outline = await doc.getOutline();
		} catch (err) {
			console.error('pdf-ink: could not read the PDF outline', err);
		}
		if (epoch !== this.epoch) return;

		this.outlineEl.empty();
		if (!outline || outline.length === 0) {
			this.outlineEl.createDiv({
				cls: 'pdf-ink-sidebar-empty',
				text: 'This PDF has no outline.',
			});
			// Nothing to show, so do not offer the tab as if there were.
			this.tabButtons.get('outline')?.addClass('is-empty');
			return;
		}
		this.buildOutline(doc, outline, this.outlineEl, 0);
	}

	private addTab(tab: Tab, label: string, icon: string): void {
		const buttonEl = this.tabsEl.createEl('button', {
			cls: 'pdf-ink-sidebar-tab',
			attr: { type: 'button', 'aria-label': label },
		});
		setIcon(buttonEl, icon);
		buttonEl.createSpan({ text: label });
		buttonEl.toggleClass('is-active', tab === this.tab);
		this.component.registerDomEvent(buttonEl, 'click', () => {
			this.selectTab(tab);
		});
		this.tabButtons.set(tab, buttonEl);
	}

	private selectTab(tab: Tab): void {
		this.tab = tab;
		for (const [kind, buttonEl] of this.tabButtons) {
			buttonEl.toggleClass('is-active', kind === tab);
		}
		this.thumbsEl.toggleClass('is-hidden', tab !== 'thumbnails');
		this.outlineEl.toggleClass('is-hidden', tab !== 'outline');
		if (tab === 'thumbnails') this.refreshVisible();
	}

	private createEntry(geom: PageGeometry, index: number): ThumbnailEntry {
		const el = this.thumbsEl.createDiv({ cls: 'pdf-ink-thumbnail' });
		el.dataset.pageNumber = String(index + 1);
		const canvasEl = el.createEl('canvas', { cls: 'pdf-ink-thumbnail-canvas' });
		canvasEl.width = 0;
		canvasEl.height = 0;
		// Reserve the right box before anything is drawn, so the list does not
		// reflow as thumbnails arrive.
		const ratio = geom.baseHeight / Math.max(1, geom.baseWidth);
		canvasEl.setCssProps({
			'--pdf-ink-thumb-w': `${String(THUMBNAIL_WIDTH)}px`,
			'--pdf-ink-thumb-h': `${String(Math.round(THUMBNAIL_WIDTH * ratio))}px`,
		});
		const labelEl = el.createDiv({ cls: 'pdf-ink-thumbnail-label' });

		const entry: ThumbnailEntry = {
			key: geom.key,
			el,
			canvasEl,
			geom,
			rendering: false,
			rendered: false,
		};
		this.setLabel(entry, index, labelEl);

		this.component.registerDomEvent(el, 'click', () => {
			const at = this.geometry.findIndex((page) => page.key === entry.key);
			if (at >= 0) this.callbacks.goToIndex(at);
		});
		this.byEl.set(el, entry);
		this.observer?.observe(el);
		return entry;
	}

	private setLabel(
		entry: ThumbnailEntry,
		index: number,
		labelEl?: HTMLElement,
	): void {
		const el =
			labelEl ?? entry.el.querySelector<HTMLElement>('.pdf-ink-thumbnail-label');
		el?.setText(String(index + 1));
	}

	/** Kick off renders for anything already on screen. */
	private refreshVisible(): void {
		// The observer only reports changes, and a panel that was hidden when the
		// pages arrived never produced any — so ask directly.
		const bodyRect = this.rootEl.getBoundingClientRect();
		for (const entry of this.entries.values()) {
			if (entry.rendered || entry.rendering) continue;
			const rect = entry.el.getBoundingClientRect();
			if (rect.bottom < bodyRect.top - 200) continue;
			if (rect.top > bodyRect.bottom + 200) continue;
			void this.renderThumbnail(entry);
		}
	}

	private async renderThumbnail(entry: ThumbnailEntry): Promise<void> {
		if (entry.rendered || entry.rendering) return;
		entry.rendering = true;
		const epoch = this.epoch;
		const geom = entry.geom;

		const scale = THUMBNAIL_WIDTH / Math.max(1, geom.baseWidth);
		const dpr = Math.min(
			THUMBNAIL_DPR_CAP,
			entry.el.win.devicePixelRatio || 1,
		);
		const viewport = geom.baseViewport.clone({ scale });
		const cssWidth = Math.max(1, Math.round(viewport.width));
		const cssHeight = Math.max(1, Math.round(viewport.height));
		entry.canvasEl.width = Math.round(cssWidth * dpr);
		entry.canvasEl.height = Math.round(cssHeight * dpr);
		entry.canvasEl.setCssProps({
			'--pdf-ink-thumb-w': `${String(cssWidth)}px`,
			'--pdf-ink-thumb-h': `${String(cssHeight)}px`,
		});

		const ctx = entry.canvasEl.getContext('2d');
		if (!ctx) {
			entry.rendering = false;
			return;
		}

		try {
			if (geom.source.kind === 'inserted') {
				paintInsertedPage(
					ctx,
					viewport,
					geom.source.page,
					cssWidth,
					cssHeight,
					[dpr, 0, 0, dpr, 0, 0],
				);
			} else {
				await geom.source.page.render({
					canvasContext: ctx,
					viewport,
					transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0],
					background: '#ffffff',
					intent: 'display',
				}).promise;
			}
			if (epoch !== this.epoch) return;
			entry.rendered = true;
			entry.el.addClass('is-rendered');
		} catch (err) {
			// Cancellation is normal when a document closes mid-sweep, and a page
			// cleaned up by the main view throws here too. Neither is worth a notice.
			if (!isRenderCancelled(err)) {
				console.error('pdf-ink: could not render a thumbnail', err);
			}
		} finally {
			entry.rendering = false;
		}
	}

	private buildOutline(
		doc: PDFDocumentProxy,
		nodes: readonly PDFOutlineNode[],
		parentEl: HTMLElement,
		depth: number,
	): void {
		for (const node of nodes) {
			const itemEl = parentEl.createDiv({ cls: 'pdf-ink-outline-item' });
			itemEl.setCssProps({ '--pdf-ink-outline-depth': String(depth) });
			const buttonEl = itemEl.createEl('button', {
				cls: 'pdf-ink-outline-link',
				text: node.title || '(untitled)',
				attr: { type: 'button' },
			});
			if (node.bold === true) buttonEl.addClass('is-bold');
			if (node.italic === true) buttonEl.addClass('is-italic');

			// A heading with no destination is a label, not a link.
			if (node.dest === null) buttonEl.disabled = true;
			else {
				this.component.registerDomEvent(buttonEl, 'click', () => {
					void this.goToDestination(doc, node.dest);
				});
			}

			if (node.items.length > 0) {
				this.buildOutline(doc, node.items, parentEl, depth + 1);
			}
		}
	}

	/**
	 * Resolve an outline destination to a page and scroll there.
	 *
	 * A destination is either an array whose first element references a page, or a
	 * name that has to be looked up first. Only the page is honoured — the rest of
	 * the array positions the view within it, and the top of the page is where an
	 * outline entry is expected to land anyway.
	 */
	private async goToDestination(
		doc: PDFDocumentProxy,
		dest: PDFDestination | string | null,
	): Promise<void> {
		if (dest === null) return;
		try {
			const resolved =
				typeof dest === 'string' ? await doc.getDestination(dest) : dest;
			const ref = resolved?.[0];
			if (!isPdfRef(ref)) return;
			const pdfIndex = await doc.getPageIndex(ref);
			// Outline entries name pages of the source document, so the display index
			// has to be looked up: inserted pages may sit before this one.
			const key = `pdf:${String(pdfIndex)}`;
			const at = this.geometry.findIndex((geom) => geom.key === key);
			if (at >= 0) this.callbacks.goToIndex(at);
		} catch (err) {
			console.error('pdf-ink: could not follow an outline entry', err);
		}
	}

	private dispose(): void {
		this.epoch += 1;
		this.observer?.disconnect();
		this.observer = null;
		for (const entry of this.entries.values()) {
			entry.canvasEl.width = 0;
			entry.canvasEl.height = 0;
		}
		this.entries.clear();
	}
}

function isPdfRef(value: unknown): value is PDFRef {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as PDFRef).num === 'number' &&
		typeof (value as PDFRef).gen === 'number'
	);
}
