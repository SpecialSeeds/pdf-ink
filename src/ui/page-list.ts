import { MAX_RETAINED_PAGES, PAGE_GAP, SETTLE_DELAY_MS } from '../constants';
import type { CssRect } from '../core/detail-region';
import { computeLayout, visibleIndices } from '../core/layout';
import type { PageKey } from '../core/pages';
import type { LayoutResult, PageGeometry, PageRecord } from '../types/view';
import type { PageRenderer } from './page-renderer';

/**
 * Owns the page wrappers, the layout, and the virtualization decision: which
 * pages hold canvases.
 *
 * The page list is not fixed for the life of a document — a page can be inserted
 * or deleted at any time — so {@link PageList.setPages} reconciles against the new
 * order by page key rather than rebuilding. Rebuilding would be far simpler, and
 * would also throw away every rasterised page and the scroll position each time
 * the user adds a sheet.
 */
export class PageList {
	private records: PageRecord[] = [];
	private geometry: readonly PageGeometry[] = [];
	/**
	 * Element to record. Keyed by element identity so the observer callback
	 * needs no index arithmetic and no dataset parsing, which keeps it honest
	 * under noUncheckedIndexedAccess.
	 */
	private readonly byEl = new WeakMap<Element, PageRecord>();
	private readonly byKey = new Map<PageKey, PageRecord>();
	/**
	 * The records currently intersecting the viewport.
	 *
	 * Records rather than display indices: inserting a page renumbers every page
	 * after it, and the observer only re-reports a page whose *intersection* changed
	 * — so a set of indices would silently go stale and evict a visible page.
	 */
	private readonly visible = new Set<PageRecord>();
	private observer: IntersectionObserver | null = null;
	private layout: LayoutResult;
	private dpr = 1;
	private zoom = 1;
	/** Pending detail update; see {@link PageList.scheduleDetails}. */
	private detailTimer = 0;
	private readonly onScroll = (): void => {
		this.scheduleDetails();
	};

	constructor(
		private readonly sizerEl: HTMLElement,
		private readonly pagesEl: HTMLElement,
		private readonly scrollEl: HTMLElement,
		private readonly renderer: PageRenderer,
		private readonly onVisibleChange: (pageNumber: number) => void,
		private readonly bufferPages: number,
	) {
		this.layout = computeLayout([], 1, PAGE_GAP);
	}

	get pageCount(): number {
		return this.records.length;
	}

	getLayout(): LayoutResult {
		return this.layout;
	}

	recordAt(index: number): PageRecord | undefined {
		return this.records[index];
	}

	recordForKey(key: PageKey): PageRecord | undefined {
		return this.byKey.get(key);
	}

	/** Visit every live page record, for a full ink repaint. */
	eachRecord(visit: (record: PageRecord) => void): void {
		for (const record of this.records) visit(record);
	}

	/** The page an event happened on, for delegated pointer handling. */
	recordForTarget(target: EventTarget | null): PageRecord | undefined {
		if (!(target instanceof Element)) return undefined;
		const wrapperEl = target.closest('.pdf-ink-page');
		if (!wrapperEl) return undefined;
		return this.byEl.get(wrapperEl);
	}

	/** Build every wrapper, size it, then start observing. */
	build(
		geometry: readonly PageGeometry[],
		zoom: number,
		dpr: number,
	): void {
		this.dpr = dpr;
		this.zoom = zoom;
		this.startObserving();
		this.setPages(geometry, zoom);
	}

	/**
	 * Adopt a new page order, reusing the records for pages that are still present.
	 *
	 * Matching is by page key, so an insertion costs one new wrapper and a handful
	 * of DOM moves; every other page keeps its bitmaps, its render state and its
	 * place in the observer.
	 */
	setPages(geometry: readonly PageGeometry[], zoom: number): void {
		this.geometry = geometry;
		this.zoom = zoom;

		const leftover = new Map(this.byKey);
		const next: PageRecord[] = [];

		geometry.forEach((geom, index) => {
			const reused = leftover.get(geom.key);
			if (reused) {
				leftover.delete(geom.key);
				// An inserted page's record changes when its template does, so the
				// geometry is replaced even when the key matched — and the page is
				// painted again, or it would keep its old ruling until the next zoom.
				if (templateOf(reused.geom) !== templateOf(geom)) {
					this.renderer.invalidate(reused);
				}
				reused.geom = geom;
				reused.index = index;
				next.push(reused);
				return;
			}
			next.push(this.createRecord(geom, index));
		});

		for (const record of leftover.values()) this.discard(record);

		this.records = next;
		this.byKey.clear();
		for (const record of next) this.byKey.set(record.geom.key, record);

		this.syncDomOrder();
		this.applyLayout();
		this.updateRetainSet();
	}

	/** Re-resolve every box for a new zoom, then re-rasterise what is retained. */
	relayout(zoom: number): void {
		this.zoom = zoom;
		this.applyLayout();
		this.updateRetainSet();
	}

	setDpr(dpr: number): void {
		if (dpr === this.dpr) return;
		this.dpr = dpr;
		// Boxes are unchanged, so no relayout and no anchor work — only the
		// bitmaps are now wrong, and ensure() notices that by itself.
		this.updateRetainSet();
	}

	/**
	 * Paint the matching pages again — after the theme or a template changed —
	 * keeping each old bitmap on screen until its replacement lands.
	 */
	repaint(matches: (record: PageRecord) => boolean): void {
		for (const record of this.records) {
			if (matches(record)) this.renderer.invalidate(record);
		}
		this.updateRetainSet();
	}

	scrollToPage(index: number): void {
		const box = this.layout.pages[index];
		if (!box) return;
		this.scrollEl.scrollTop = box.offsetTop;
		this.updateRetainSet();
	}

	/**
	 * Reconcile canvases against the retain set.
	 *
	 * Called by the observer, and forced synchronously after mount, relayout and
	 * any programmatic scroll — at those points the observer has not delivered
	 * yet, and waiting for it would show a blank flash.
	 */
	updateRetainSet(): void {
		let source: Iterable<number> = [...this.visible].map(
			(record) => record.index,
		);
		if (this.visible.size === 0) {
			const { first, last } = visibleIndices(
				this.layout,
				this.scrollEl.scrollTop,
				this.scrollEl.clientHeight,
			);
			const fallback = new Set<number>();
			for (let i = first; i <= last; i++) fallback.add(i);
			source = fallback;
		}

		const retain = new Set<number>();
		for (const index of source) {
			for (let d = -this.bufferPages; d <= this.bufferPages; d++) {
				const j = index + d;
				if (j >= 0 && j < this.records.length) retain.add(j);
			}
		}

		const kept = this.trimToBudget(retain);

		this.records.forEach((record, index) => {
			const box = this.layout.pages[index];
			if (!box) return;
			if (kept.has(index)) {
				this.renderer.ensure(record, box, this.dpr);
			} else {
				this.renderer.teardown(record);
			}
		});

		this.reportFirstVisible();
		this.scheduleDetails();
	}

	/**
	 * Refresh the sharp drawings of oversized pages once scrolling and zooming
	 * have stopped.
	 *
	 * Debounced rather than per scroll event: a detail of a heavy page can take a
	 * second or more to render, and one started mid-fling is thrown away a frame
	 * later. Until it lands, the whole-page bitmap shows through.
	 */
	private scheduleDetails(): void {
		const win = this.scrollEl.win;
		if (this.detailTimer !== 0) win.clearTimeout(this.detailTimer);
		this.detailTimer = win.setTimeout(() => {
			this.detailTimer = 0;
			this.updateDetails();
		}, SETTLE_DELAY_MS);
	}

	private updateDetails(): void {
		// Measured with getBoundingClientRect, which a preview transform distorts.
		// The zoom commit relayouts, and that schedules another pass.
		if (this.pagesEl.hasClass('is-zooming')) {
			this.scheduleDetails();
			return;
		}

		const inView = new Set<PageRecord>(this.visible);
		if (inView.size === 0) {
			const { first, last } = visibleIndices(
				this.layout,
				this.scrollEl.scrollTop,
				this.scrollEl.clientHeight,
			);
			for (let i = first; i <= last; i++) {
				const record = this.records[i];
				if (record) inView.add(record);
			}
		}

		const bounds = this.scrollEl.getBoundingClientRect();
		const viewLeft = bounds.left + this.scrollEl.clientLeft;
		const viewTop = bounds.top + this.scrollEl.clientTop;

		for (const record of this.records) {
			const box = this.layout.pages[record.index];
			if (!box) continue;
			if (!inView.has(record)) {
				if (record.detail) this.renderer.updateDetail(record, box, this.dpr, null);
				continue;
			}
			const page = record.wrapperEl.getBoundingClientRect();
			const visible: CssRect = {
				x: viewLeft - page.left,
				y: viewTop - page.top,
				w: this.scrollEl.clientWidth,
				h: this.scrollEl.clientHeight,
			};
			this.renderer.updateDetail(record, box, this.dpr, visible);
		}
	}

	async dispose(): Promise<void> {
		this.observer?.disconnect();
		this.observer = null;
		this.scrollEl.removeEventListener('scroll', this.onScroll);
		if (this.detailTimer !== 0) {
			this.scrollEl.win.clearTimeout(this.detailTimer);
			this.detailTimer = 0;
		}
		this.visible.clear();

		for (const record of this.records) this.renderer.teardown(record);
		await Promise.all(
			this.records.map((record) => this.renderer.quiesce(record)),
		);
		for (const record of this.records) this.clearCleanupTimer(record);

		this.records = [];
		this.byKey.clear();
		this.pagesEl.empty();
	}

	private createRecord(geom: PageGeometry, index: number): PageRecord {
		const wrapperEl = this.pagesEl.createDiv({ cls: 'pdf-ink-page is-empty' });
		// The key, not the position: a wrapper's position changes under it, and a
		// discarded wrapper lingers in the DOM until its renderer settles.
		wrapperEl.dataset.pageKey = geom.key;
		if (geom.source.kind === 'inserted') {
			wrapperEl.addClass('is-inserted');
		}

		const renderCanvasEl = wrapperEl.createEl('canvas', {
			cls: 'pdf-ink-render',
		});
		const highlightCanvasEl = wrapperEl.createEl('canvas', {
			cls: 'pdf-ink-highlight',
		});
		const inkCanvasEl = wrapperEl.createEl('canvas', { cls: 'pdf-ink-ink' });
		// A canvas defaults to 300x150; start at zero so an unmounted page costs
		// no backing store.
		for (const canvasEl of [renderCanvasEl, highlightCanvasEl, inkCanvasEl]) {
			canvasEl.width = 0;
			canvasEl.height = 0;
		}

		const record: PageRecord = {
			geom,
			index,
			wrapperEl,
			renderCanvasEl,
			highlightCanvasEl,
			inkCanvasEl,
			viewport: geom.baseViewport,
			cssWidth: 0,
			cssHeight: 0,
			bitmapScale: 0,
			bitmapDpr: 0,
			renderedDensity: 0,
			state: 'blank',
			epoch: 0,
			task: null,
			settled: null,
			cleanupTimer: null,
			detail: null,
			detailSettled: null,
		};
		this.byEl.set(wrapperEl, record);
		this.observer?.observe(wrapperEl);
		return record;
	}

	/** Retire a record whose page is no longer in the document. */
	private discard(record: PageRecord): void {
		this.observer?.unobserve(record.wrapperEl);
		this.visible.delete(record);
		this.clearCleanupTimer(record);
		this.renderer.teardown(record);
		// Detach only once the renderer is finished with the canvases: zeroing one
		// pdf.js still owns corrupts its internal state.
		void this.renderer.quiesce(record).then(() => {
			record.wrapperEl.remove();
		});
	}

	private clearCleanupTimer(record: PageRecord): void {
		if (record.cleanupTimer !== null) {
			record.wrapperEl.win.clearTimeout(record.cleanupTimer);
			record.cleanupTimer = null;
		}
	}

	/**
	 * Put the wrappers in display order, moving only the ones that are out of place.
	 *
	 * Walks our own records rather than trusting child positions: the container also
	 * holds overlays that are not pages — the insert control, the eraser cursor — and
	 * a discarded wrapper stays in the DOM until its renderer settles.
	 */
	private syncDomOrder(): void {
		let expected = this.nextPageEl(this.pagesEl.firstElementChild);
		for (const record of this.records) {
			if (expected === record.wrapperEl) {
				expected = this.nextPageEl(record.wrapperEl.nextElementSibling);
				continue;
			}
			// A null reference appends, which is what the last page wants.
			this.pagesEl.insertBefore(record.wrapperEl, expected);
		}
	}

	/** `from`, or the first page wrapper after it. */
	private nextPageEl(from: Element | null): Element | null {
		let candidate = from;
		while (candidate !== null && !candidate.hasClass('pdf-ink-page')) {
			candidate = candidate.nextElementSibling;
		}
		return candidate;
	}

	private applyLayout(): void {
		this.layout = computeLayout(this.geometry, this.zoom, PAGE_GAP);
		const { contentWidth, contentHeight } = this.layout;
		// The sizer carries the scaled box so the scrollbars stay honest during a
		// transform preview; the pages container carries the unscaled box.
		this.sizerEl.setCssProps({
			'--pdf-ink-sizer-w': `${String(contentWidth)}px`,
			'--pdf-ink-sizer-h': `${String(contentHeight)}px`,
		});
		this.pagesEl.setCssProps({
			'--pdf-ink-content-w': `${String(contentWidth)}px`,
			'--pdf-ink-content-h': `${String(contentHeight)}px`,
		});

		this.records.forEach((record, index) => {
			const box = this.layout.pages[index];
			if (!box) return;
			record.wrapperEl.dataset.pageNumber = String(index + 1);
			record.wrapperEl.setCssProps({
				'--pdf-ink-page-w': `${String(box.cssWidth)}px`,
				'--pdf-ink-page-h': `${String(box.cssHeight)}px`,
			});
		});
	}

	private startObserving(): void {
		// threshold 0 is required, not a default: a page taller than the pane can
		// never reach a higher ratio, so it would never be reported visible and
		// would never render. rootMargin stays 0 because the buffer is counted in
		// pages, and no pixel margin means "one page" when page heights vary.
		this.observer = new IntersectionObserver(
			(entries) => {
				this.onIntersect(entries);
			},
			{ root: this.scrollEl, rootMargin: '0px', threshold: 0 },
		);
		// The observer reports pages entering and leaving view, but a detail also
		// has to follow a pan within one page.
		this.scrollEl.addEventListener('scroll', this.onScroll, { passive: true });
	}

	private onIntersect(entries: IntersectionObserverEntry[]): void {
		for (const entry of entries) {
			const record = this.byEl.get(entry.target);
			if (!record) continue;
			if (entry.isIntersecting) this.visible.add(record);
			else this.visible.delete(record);
		}
		this.updateRetainSet();
	}

	/** Keep the pages nearest the viewport centre when the retain set is large. */
	private trimToBudget(retain: Set<number>): Set<number> {
		if (retain.size <= MAX_RETAINED_PAGES) return retain;
		const centre =
			this.scrollEl.scrollTop + this.scrollEl.clientHeight / 2;
		const ranked = [...retain]
			.map((index) => {
				const box = this.layout.pages[index];
				const middle = box
					? box.offsetTop + box.cssHeight / 2
					: Number.POSITIVE_INFINITY;
				return { index, distance: Math.abs(middle - centre) };
			})
			.sort((a, b) => a.distance - b.distance)
			.slice(0, MAX_RETAINED_PAGES);
		return new Set(ranked.map((entry) => entry.index));
	}

	private reportFirstVisible(): void {
		if (this.records.length === 0) return;
		let first: number;
		if (this.visible.size > 0) {
			first = Math.min(...[...this.visible].map((record) => record.index));
		} else {
			first = visibleIndices(
				this.layout,
				this.scrollEl.scrollTop,
				this.scrollEl.clientHeight,
			).first;
		}
		this.onVisibleChange(Math.min(first, this.records.length - 1) + 1);
	}
}

function templateOf(geom: PageGeometry): string | null {
	return geom.source.kind === 'inserted' ? geom.source.page.template : null;
}
