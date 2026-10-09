import { type App, type Component, Menu, Platform, setIcon } from 'obsidian';
import { askPagePosition } from './move-page-modal';
import { pageSizes, sizeLookup } from '../core/page-composition';
import {
	type InsertedPage,
	type PageKey,
	createInsertedPage,
	orderPages,
	parsePageKey,
	sizeForInsertion,
} from '../core/pages';
import {
	PAGE_TEMPLATES,
	type PageTemplate,
	TEMPLATE_LABELS,
} from '../core/templates';
import type { AnnotationStore } from '../pdf/annotation-store';
import type { LayoutResult, PageGeometry } from '../types/view';

/**
 * How close to a gap the pointer must come for the insert control to appear, in
 * CSS px. Generous enough to hit without aiming, small enough that it is not
 * hovering over the middle of a page.
 */
const GAP_REACH = 22;

export interface PageEditorHost {
	/** The document's pages in display order. */
	geometry(): readonly PageGeometry[];
	layout(): LayoutResult;
	/** Original page count, which fixes what `afterPdfPage` can mean. */
	pdfPageCount(): number;
	/** Bring a page into view after it is created. */
	scrollToPage(index: number): void;
	/** The ruling the document declares for new pages, or null. */
	documentRuling(): PageTemplate | null;
	/** For the dialogs this opens. */
	app(): App;
}

/**
 * Inserting, moving, deleting and re-ruling pages.
 *
 * Two entry points, because they suit different hardware: a "+" that follows the
 * pointer into the gap between pages, and a context menu on the page itself, which
 * is the only one reachable by long-press on a tablet.
 *
 * Original PDF pages can be annotated and can take inserted pages around them, but
 * cannot themselves be deleted or re-ruled — the source document is never modified,
 * and there is no record in the schema that could represent a missing original page.
 */
export class PageEditor {
	private readonly gapEl: HTMLElement;
	/** The boundary the control currently offers, or null when it is hidden. */
	private gapAt: number | null = null;

	constructor(
		private readonly component: Component,
		pagesEl: HTMLElement,
		private readonly scrollEl: HTMLElement,
		private readonly store: AnnotationStore,
		private readonly host: PageEditorHost,
	) {
		this.gapEl = pagesEl.createDiv({ cls: 'pdf-ink-gap-insert is-hidden' });
		this.gapEl.setAttribute('role', 'button');
		this.gapEl.setAttribute('aria-label', 'Insert page here');
		setIcon(this.gapEl, 'plus');

		this.component.registerDomEvent(this.gapEl, 'pointerdown', (evt) => {
			// The ink layer listens on the same container; a press on the control is
			// not a stroke.
			evt.stopPropagation();
			evt.preventDefault();
		});
		this.component.registerDomEvent(this.gapEl, 'click', (evt) => {
			evt.stopPropagation();
			const at = this.gapAt;
			this.hideGap();
			if (at !== null) this.insertAt(at);
		});

		// Hover is a desktop affordance. On mobile the context menu is the way in,
		// and a control that appeared under the palm would be worse than none.
		if (!Platform.isMobile) {
			this.component.registerDomEvent(pagesEl, 'pointermove', (evt) => {
				this.onPointerMove(evt);
			});
			this.component.registerDomEvent(pagesEl, 'pointerleave', () => {
				this.hideGap();
			});
			// A press anywhere is either a stroke or a drag: get out of the way.
			this.component.registerDomEvent(pagesEl, 'pointerdown', (evt) => {
				if (evt.target !== this.gapEl) this.hideGap();
			});
			this.component.registerDomEvent(scrollEl, 'scroll', () => {
				this.hideGap();
			});
		}

		this.component.registerDomEvent(pagesEl, 'contextmenu', (evt) => {
			this.onContextMenu(evt);
		});
	}

	/** Hide the control after anything that moves the pages under it. */
	hideGap(): void {
		if (this.gapAt === null) return;
		this.gapAt = null;
		this.gapEl.addClass('is-hidden');
	}

	// --- actions ---------------------------------------------------------

	/**
	 * Insert a page at display position `at`, so 0 is before everything.
	 *
	 * Size and ruling are taken from the neighbour above, falling back to the one
	 * below: a page inserted into a lined notebook should be another lined sheet of
	 * the same paper, without the user having to say so.
	 */
	insertAt(at: number): void {
		this.store.insertPage(this.pageFor(at));
		// The list has already been rebuilt by the store's change callback.
		this.host.scrollToPage(at);
	}

	/**
	 * Add a page after the last one, as part of the newest undo step and without
	 * scrolling: a notebook growing under the pen should not yank the page away
	 * from it, and undoing the stroke that grew it should take the page back too.
	 */
	appendPage(): void {
		this.store.insertPage(this.pageFor(this.host.geometry().length), true);
	}

	private pageFor(at: number): InsertedPage {
		const geometry = this.host.geometry();
		const order = orderPages(
			this.host.pdfPageCount(),
			this.store.insertedPages(),
		);
		const sizes = pageSizes(geometry);
		const size = sizeForInsertion(order, at, sizeLookup(sizes));
		return createInsertedPage(order, at, this.templateFor(at), size, Date.now());
	}

	insertAbove(key: PageKey): void {
		const index = this.indexOf(key);
		if (index !== null) this.insertAt(index);
	}

	insertBelow(key: PageKey): void {
		const index = this.indexOf(key);
		if (index !== null) this.insertAt(index + 1);
	}

	/**
	 * Move an inserted page to display position `to` and bring it into view.
	 * Original pages do not move: the source document is never modified.
	 */
	movePage(key: PageKey, to: number): void {
		const parsed = parsePageKey(key);
		if (parsed?.kind !== 'inserted') return;
		if (!this.store.movePage(parsed.id, to, this.host.pdfPageCount())) return;
		// The list has already been rebuilt by the store's change callback.
		const at = this.indexOf(key);
		if (at !== null) this.host.scrollToPage(at);
	}

	/** Ask where to, then move the page there. */
	private async movePageTo(key: PageKey): Promise<void> {
		const at = this.indexOf(key);
		if (at === null) return;
		const to = await askPagePosition(this.host.app(), at, this.host.geometry().length);
		if (to !== null) this.movePage(key, to);
	}

	setTemplate(key: PageKey, template: PageTemplate): void {
		const parsed = parsePageKey(key);
		if (parsed?.kind !== 'inserted') return;
		this.store.setPageTemplate(parsed.id, template);
	}

	deletePage(key: PageKey): void {
		const parsed = parsePageKey(key);
		if (parsed?.kind !== 'inserted') return;
		this.store.deletePage(parsed.id);
	}

	// --- internals -------------------------------------------------------

	private indexOf(key: PageKey): number | null {
		const at = this.host.geometry().findIndex((geom) => geom.key === key);
		return at < 0 ? null : at;
	}

	/**
	 * The ruling a page inserted at `at` should take: its neighbour's, if that
	 * neighbour is an inserted page, and otherwise blank.
	 *
	 * An original PDF page has no template to copy, so a page inserted next to one
	 * takes the ruling the document declares — a PDF made here names its own — and
	 * otherwise starts blank rather than guessing.
	 */
	private templateFor(at: number): PageTemplate {
		const geometry = this.host.geometry();
		for (const geom of [geometry[at - 1], geometry[at]]) {
			if (geom?.source.kind === 'inserted') return geom.source.page.template;
		}
		return this.host.documentRuling() ?? 'blank';
	}

	private onPointerMove(evt: PointerEvent): void {
		// Positions come from the layout, which is only true of the DOM when no
		// preview transform is in flight.
		if (evt.pressure > 0 || evt.buttons !== 0) {
			this.hideGap();
			return;
		}
		const boundary = this.nearestBoundary(evt);
		if (boundary === null) {
			this.hideGap();
			return;
		}
		this.showGap(boundary.at, boundary.top);
	}

	/**
	 * The page boundary nearest the pointer, if it is close enough to offer.
	 *
	 * Boundaries are numbered like insertion positions: 0 above the first page,
	 * `count` below the last.
	 */
	private nearestBoundary(
		evt: PointerEvent,
	): { at: number; top: number } | null {
		const boxes = this.host.layout().pages;
		if (boxes.length === 0) return null;

		const bounds = this.gapEl.parentElement?.getBoundingClientRect();
		if (!bounds || bounds.height === 0) return null;
		const y = evt.clientY - bounds.top;

		let best: { at: number; top: number } | null = null;
		let bestDistance = Number.POSITIVE_INFINITY;
		for (let at = 0; at <= boxes.length; at++) {
			const above = at > 0 ? boxes[at - 1] : undefined;
			const below = boxes[at];
			// Above the first page and below the last, the boundary is the page edge;
			// in between it is the middle of the gap.
			const top =
				above === undefined
					? (below?.offsetTop ?? 0)
					: below === undefined
						? above.offsetTop + above.cssHeight
						: (above.offsetTop + above.cssHeight + below.offsetTop) / 2;
			const distance = Math.abs(y - top);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = { at, top };
			}
		}
		return best !== null && bestDistance <= GAP_REACH ? best : null;
	}

	private showGap(at: number, top: number): void {
		this.gapAt = at;
		this.gapEl.setCssProps({ '--pdf-ink-gap-top': `${String(top)}px` });
		this.gapEl.removeClass('is-hidden');
	}

	private onContextMenu(evt: MouseEvent): void {
		const target = evt.target;
		if (!(target instanceof Element)) return;
		const wrapperEl = target.closest<HTMLElement>('.pdf-ink-page');
		const pageKey = wrapperEl?.dataset.pageKey;
		if (pageKey === undefined) return;
		if (!this.host.geometry().some((page) => page.key === pageKey)) return;

		evt.preventDefault();
		this.buildMenu(pageKey)?.showAtMouseEvent(evt);
	}

	/**
	 * Show the page menu for a key, without a pointer event to anchor it.
	 *
	 * The way in on a tablet: the "+" between pages is a hover affordance, and iOS
	 * does not reliably raise a context menu on long press, so without this there
	 * was no way to add a page on an iPad at all.
	 */
	showMenuFor(pageKey: PageKey, at: { x: number; y: number }): boolean {
		const menu = this.buildMenu(pageKey);
		if (!menu) return false;
		menu.showAtPosition(at);
		return true;
	}

	private buildMenu(pageKey: PageKey): Menu | null {
		const geom = this.host.geometry().find((page) => page.key === pageKey);
		if (!geom) return null;

		const menu = new Menu();
		const key = geom.key;

		menu.addItem((item) =>
			item
				.setTitle('Insert page above')
				.setIcon('arrow-up-to-line')
				.setSection('insert')
				.onClick(() => {
					this.insertAbove(key);
				}),
		);
		menu.addItem((item) =>
			item
				.setTitle('Insert page below')
				.setIcon('arrow-down-to-line')
				.setSection('insert')
				.onClick(() => {
					this.insertBelow(key);
				}),
		);

		if (geom.source.kind === 'inserted') {
			const at = this.indexOf(key) ?? 0;
			const last = this.host.geometry().length - 1;
			menu.addItem((item) =>
				item
					.setTitle('Move page up')
					.setIcon('arrow-up')
					.setSection('move')
					.setDisabled(at === 0)
					.onClick(() => {
						this.movePage(key, at - 1);
					}),
			);
			menu.addItem((item) =>
				item
					.setTitle('Move page down')
					.setIcon('arrow-down')
					.setSection('move')
					.setDisabled(at >= last)
					.onClick(() => {
						this.movePage(key, at + 1);
					}),
			);
			menu.addItem((item) =>
				item
					.setTitle('Move page to…')
					.setIcon('arrow-up-down')
					.setSection('move')
					.setDisabled(last < 1)
					.onClick(() => {
						void this.movePageTo(key);
					}),
			);

			const current = geom.source.page.template;
			// A flat checked group rather than a submenu: Obsidian's Menu has no
			// submenu in the public API, and six items is not worth nesting anyway.
			for (const template of PAGE_TEMPLATES) {
				menu.addItem((item) =>
					item
						.setTitle(TEMPLATE_LABELS[template])
						.setChecked(template === current)
						.setSection('pdf-ink-template')
						.onClick(() => {
							this.setTemplate(key, template);
						}),
				);
			}
			menu.addItem((item) =>
				item
					.setTitle('Delete page')
					.setIcon('trash-2')
					.setSection('danger')
					.setWarning(true)
					.onClick(() => {
						this.deletePage(key);
					}),
			);
		}

		return menu;
	}
}
