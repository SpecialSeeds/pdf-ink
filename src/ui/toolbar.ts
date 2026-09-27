import { type Component, setIcon } from 'obsidian';
import type { ZoomMode } from '../types/view';

export interface ToolbarCallbacks {
	toggleSidebar(): void;
	previousPage(): void;
	nextPage(): void;
	zoomOut(): void;
	zoomIn(): void;
	fitWidth(): void;
	fitPage(): void;
	goToPage(pageNumber: number): void;
}

/**
 * The document bar: outline and thumbnails, page navigation, zoom and fit.
 *
 * Deliberately the same controls, in the same order, as Obsidian's own PDF
 * viewer — someone who opens a PDF for annotation should not have to relearn how
 * to move around it. The ink tools live in their own floating palette rather than
 * here, so the two sets never compete for width on a tablet.
 */
export class PdfInkToolbar {
	private readonly sidebarButtonEl: HTMLElement;
	private readonly zoomLabelEl: HTMLElement;
	private readonly pageInputEl: HTMLInputElement;
	private readonly pageTotalEl: HTMLElement;
	private readonly prevButtonEl: HTMLButtonElement;
	private readonly nextButtonEl: HTMLButtonElement;
	private readonly fitWidthButtonEl: HTMLElement;
	private readonly fitPageButtonEl: HTMLElement;
	private pageCount = 0;
	private currentPage = 1;

	constructor(
		parentEl: HTMLElement,
		component: Component,
		callbacks: ToolbarCallbacks,
	) {
		const toolbarEl = parentEl.createDiv({ cls: 'pdf-ink-toolbar' });

		const sidebarGroupEl = toolbarEl.createDiv({
			cls: 'pdf-ink-toolbar-group',
		});
		this.sidebarButtonEl = this.addButton(
			sidebarGroupEl,
			component,
			'panel-left',
			'Toggle thumbnails and outline',
			() => {
				callbacks.toggleSidebar();
			},
		);

		const pageGroupEl = toolbarEl.createDiv({ cls: 'pdf-ink-toolbar-group' });
		this.prevButtonEl = this.addButton(
			pageGroupEl,
			component,
			'chevron-up',
			'Previous page',
			() => {
				callbacks.previousPage();
			},
		);
		this.nextButtonEl = this.addButton(
			pageGroupEl,
			component,
			'chevron-down',
			'Next page',
			() => {
				callbacks.nextPage();
			},
		);
		this.pageInputEl = pageGroupEl.createEl('input', {
			cls: 'pdf-ink-page-input',
			attr: { type: 'number', min: '1', 'aria-label': 'Page number' },
		});
		this.pageTotalEl = pageGroupEl.createSpan({
			cls: 'pdf-ink-toolbar-text',
			text: '/ 0',
		});

		const zoomGroupEl = toolbarEl.createDiv({ cls: 'pdf-ink-toolbar-group' });
		this.addButton(zoomGroupEl, component, 'zoom-out', 'Zoom out', () => {
			callbacks.zoomOut();
		});
		this.zoomLabelEl = zoomGroupEl.createSpan({
			cls: 'pdf-ink-zoom-label',
			text: '100%',
		});
		this.addButton(zoomGroupEl, component, 'zoom-in', 'Zoom in', () => {
			callbacks.zoomIn();
		});

		const fitGroupEl = toolbarEl.createDiv({ cls: 'pdf-ink-toolbar-group' });
		this.fitWidthButtonEl = this.addButton(
			fitGroupEl,
			component,
			'move-horizontal',
			'Fit width',
			() => {
				callbacks.fitWidth();
			},
		);
		this.fitPageButtonEl = this.addButton(
			fitGroupEl,
			component,
			'scan',
			'Fit page',
			() => {
				callbacks.fitPage();
			},
		);

		const submitPage = (): void => {
			const value = Number.parseInt(this.pageInputEl.value, 10);
			if (!Number.isFinite(value)) return;
			const clamped = Math.min(Math.max(1, value), this.pageCount);
			this.pageInputEl.value = String(clamped);
			callbacks.goToPage(clamped);
		};
		component.registerDomEvent(this.pageInputEl, 'change', submitPage);
		component.registerDomEvent(this.pageInputEl, 'keydown', (evt) => {
			if (evt.key !== 'Enter') return;
			evt.preventDefault();
			submitPage();
			this.pageInputEl.blur();
		});
	}

	setZoom(zoom: number, mode: ZoomMode): void {
		const percent = `${String(Math.round(zoom * 100))}%`;
		this.zoomLabelEl.setText(percent);
		this.fitWidthButtonEl.toggleClass('is-active', mode.kind === 'fit-width');
		this.fitPageButtonEl.toggleClass('is-active', mode.kind === 'fit-page');
	}

	setPageCount(count: number): void {
		this.pageCount = count;
		this.pageTotalEl.setText(`/ ${String(count)}`);
		this.pageInputEl.setAttribute('max', String(count));
		this.updateNav();
	}

	setCurrentPage(pageNumber: number): void {
		this.currentPage = pageNumber;
		this.updateNav();
		// Never clobber what the user is mid-way through typing.
		if (this.pageInputEl.doc.activeElement === this.pageInputEl) return;
		this.pageInputEl.value = String(pageNumber);
	}

	setSidebarOpen(open: boolean): void {
		this.sidebarButtonEl.toggleClass('is-active', open);
		this.sidebarButtonEl.setAttribute('aria-pressed', String(open));
	}

	private updateNav(): void {
		this.prevButtonEl.disabled = this.currentPage <= 1;
		this.nextButtonEl.disabled = this.currentPage >= this.pageCount;
	}

	private addButton(
		parentEl: HTMLElement,
		component: Component,
		icon: string,
		label: string,
		onClick: () => void,
	): HTMLButtonElement {
		const buttonEl = parentEl.createEl('button', {
			cls: 'clickable-icon pdf-ink-toolbar-button',
			attr: { 'aria-label': label, type: 'button' },
		});
		setIcon(buttonEl, icon);
		component.registerDomEvent(buttonEl, 'click', onClick);
		return buttonEl;
	}
}
