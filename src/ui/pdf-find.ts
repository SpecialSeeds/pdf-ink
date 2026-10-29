import { type Component, setIcon } from 'obsidian';
import type { BlockBox } from '../core/blocks';
import { type FindHit, findInPage, foldQuery } from '../core/pdf-find';
import type { PdfPageData } from '../pdf/page-data';
import type { PageGeometry, PageRecord } from '../types/view';

/** What the find bar needs from the view. */
export interface FindHost {
	/** The open PDF's text, or null for a notebook. */
	pageData(): PdfPageData | null;
	/** The page of the source document nearest the top of the view, 0-based. */
	currentPdfIndex(): number;
	/** The live record showing source page `pdfIndex`, if it is displayed. */
	recordForPdfIndex(pdfIndex: number): PageRecord | undefined;
	/** Scroll a box on source page `pdfIndex` into the middle of the view. */
	revealBox(pdfIndex: number, box: BlockBox): void;
}

interface Result {
	readonly pdfIndex: number;
	readonly hit: FindHit;
	/** Its highlights, one per box. */
	readonly els: readonly HTMLElement[];
}

/** Past this many matches the rest are not shown; the count says so. */
const MAX_RESULTS = 5000;
/** Typing pauses this long before a search starts. */
const SEARCH_DELAY_MS = 250;

/**
 * Ctrl/Cmd+F for a PDF: a bar to type in, every match highlighted on its page,
 * and Enter to step through them.
 *
 * The search runs page by page from the start of the document and jumps to the
 * first match at or after the page in view as soon as it is found, so a long
 * document does not keep you waiting for the count to finish.
 */
export class PdfFind {
	private readonly barEl: HTMLElement;
	private readonly inputEl: HTMLInputElement;
	private readonly statusEl: HTMLElement;
	private results: Result[] = [];
	private current = -1;
	/** The query the results are for, folded. */
	private searched = '';
	private searching = false;
	private capped = false;
	/** Bumped by every new search and by close, so a stale one stops. */
	private epoch = 0;
	private timer = 0;

	constructor(
		parentEl: HTMLElement,
		private readonly component: Component,
		private readonly host: FindHost,
	) {
		this.barEl = parentEl.createDiv({ cls: 'pdf-ink-find is-hidden' });
		this.inputEl = this.barEl.createEl('input', {
			cls: 'pdf-ink-find-input',
			attr: {
				type: 'search',
				placeholder: 'Find in PDF',
				'aria-label': 'Find in PDF',
				enterkeyhint: 'search',
				autocapitalize: 'off',
				autocorrect: 'off',
				spellcheck: 'false',
			},
		});
		this.statusEl = this.barEl.createSpan({ cls: 'pdf-ink-find-status' });
		this.addButton('chevron-up', 'Previous match', () => {
			this.step(-1);
		});
		this.addButton('chevron-down', 'Next match', () => {
			this.step(1);
		});
		this.addButton('x', 'Close', () => {
			this.close();
		});

		component.registerDomEvent(this.inputEl, 'input', () => {
			this.schedule();
		});
		component.registerDomEvent(this.inputEl, 'keydown', (evt) => {
			if (evt.key === 'Escape') {
				evt.preventDefault();
				this.close();
			} else if (evt.key === 'Enter') {
				evt.preventDefault();
				// Enter on a query not yet searched searches it; after that it steps.
				if (foldQuery(this.inputEl.value) !== this.searched) this.search();
				else this.step(evt.shiftKey ? -1 : 1);
			}
		});
		component.register(() => {
			this.cancelTimer();
		});
	}

	get isOpen(): boolean {
		return !this.barEl.hasClass('is-hidden');
	}

	/** Show the bar with its text selected, ready to type over. */
	open(): void {
		this.barEl.removeClass('is-hidden');
		this.inputEl.focus();
		this.inputEl.select();
	}

	close(): void {
		this.barEl.addClass('is-hidden');
		this.inputEl.blur();
		this.cancelTimer();
		this.epoch += 1;
		this.searching = false;
		this.clear();
		this.searched = '';
		this.statusEl.setText('');
	}

	/** The document changed: what was found belongs to the old one. */
	reset(): void {
		this.inputEl.value = '';
		this.close();
	}

	private schedule(): void {
		this.cancelTimer();
		this.timer = window.setTimeout(() => {
			this.timer = 0;
			this.search();
		}, SEARCH_DELAY_MS);
	}

	private cancelTimer(): void {
		if (this.timer !== 0) window.clearTimeout(this.timer);
		this.timer = 0;
	}

	private search(): void {
		this.cancelTimer();
		void this.run(foldQuery(this.inputEl.value));
	}

	private async run(query: string): Promise<void> {
		const epoch = ++this.epoch;
		this.clear();
		this.searched = query;
		this.capped = false;
		const data = this.host.pageData();
		if (query.length === 0 || !data) {
			this.searching = false;
			this.statusEl.setText('');
			return;
		}

		this.searching = true;
		this.showStatus();
		const from = this.host.currentPdfIndex();
		for (let pdfIndex = 0; pdfIndex < data.pageCount; pdfIndex++) {
			const text = await data.textFor(pdfIndex);
			if (epoch !== this.epoch) return;
			const firstOnPage = this.results.length;
			for (const hit of findInPage(text, query)) {
				if (this.results.length >= MAX_RESULTS) {
					this.capped = true;
					break;
				}
				const record = this.host.recordForPdfIndex(pdfIndex);
				this.results.push({ pdfIndex, hit, els: record ? this.paint(record, hit, false) : [] });
			}
			// The first match at or after the page in view is shown at once.
			if (this.current < 0 && pdfIndex >= from && this.results.length > firstOnPage) {
				this.select(firstOnPage);
			}
			if (pdfIndex % 10 === 9) this.showStatus();
			if (this.capped) break;
		}
		this.searching = false;
		// Every match was before the page in view: wrap round to the first.
		if (this.current < 0 && this.results.length > 0) this.select(0);
		this.showStatus();
	}

	private step(delta: number): void {
		if (foldQuery(this.inputEl.value) !== this.searched) {
			this.search();
			return;
		}
		const count = this.results.length;
		if (count === 0) return;
		this.select((((this.current + delta) % count) + count) % count);
		this.showStatus();
	}

	private select(index: number): void {
		const previous = this.results[this.current];
		if (previous) for (const el of previous.els) el.removeClass('is-current');
		this.current = index;
		const result = this.results[index];
		if (!result) return;
		for (const el of result.els) el.addClass('is-current');
		this.host.revealBox(result.pdfIndex, union(result.hit.boxes));
		this.showStatus();
	}

	private showStatus(): void {
		const count = this.results.length;
		const more = this.searching ? '…' : this.capped ? '+' : '';
		if (count === 0) {
			this.statusEl.setText(this.searching ? 'Searching…' : 'No matches');
			return;
		}
		const at = this.current >= 0 ? `${String(this.current + 1)} of ` : '';
		this.statusEl.setText(`${at}${String(count)}${more}`);
	}

	private clear(): void {
		for (const result of this.results) for (const el of result.els) el.remove();
		this.results = [];
		this.current = -1;
	}

	/** Highlights for one match, placed as fractions of the page so a zoom moves them too. */
	private paint(record: PageRecord, hit: FindHit, current: boolean): HTMLElement[] {
		return hit.boxes.map((box) => {
			const el = record.wrapperEl.createDiv({ cls: 'pdf-ink-find-hit' });
			if (current) el.addClass('is-current');
			const [left, top, width, height] = fractionOfPage(record.geom, box);
			el.setCssProps({
				'--pdf-ink-find-x': `${String(left * 100)}%`,
				'--pdf-ink-find-y': `${String(top * 100)}%`,
				'--pdf-ink-find-w': `${String(width * 100)}%`,
				'--pdf-ink-find-h': `${String(height * 100)}%`,
			});
			return el;
		});
	}

	private addButton(icon: string, label: string, onClick: () => void): void {
		const buttonEl = this.barEl.createEl('button', {
			cls: 'clickable-icon pdf-ink-find-button',
			attr: { 'aria-label': label, type: 'button' },
		});
		setIcon(buttonEl, icon);
		this.component.registerDomEvent(buttonEl, 'click', onClick);
	}
}

/** The box around several boxes. */
function union(boxes: readonly BlockBox[]): BlockBox {
	let x1 = Infinity;
	let y1 = Infinity;
	let x2 = -Infinity;
	let y2 = -Infinity;
	for (const [x, y, w, h] of boxes) {
		x1 = Math.min(x1, x);
		y1 = Math.min(y1, y);
		x2 = Math.max(x2, x + w);
		y2 = Math.max(y2, y + h);
	}
	return Number.isFinite(x1) ? [x1, y1, x2 - x1, y2 - y1] : [0, 0, 0, 0];
}

/** A PDF-space box as [left, top, width, height] fractions of the displayed page. */
function fractionOfPage(geom: PageGeometry, box: BlockBox): [number, number, number, number] {
	const [x, y, w, h] = box;
	const viewport = geom.baseViewport;
	const [ax = 0, ay = 0] = viewport.convertToViewportPoint(x, y);
	const [bx = 0, by = 0] = viewport.convertToViewportPoint(x + w, y + h);
	const width = viewport.width || 1;
	const height = viewport.height || 1;
	return [
		Math.min(ax, bx) / width,
		Math.min(ay, by) / height,
		Math.abs(bx - ax) / width,
		Math.abs(by - ay) / height,
	];
}
