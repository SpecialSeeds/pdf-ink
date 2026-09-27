import { type Component, setIcon } from 'obsidian';
import type { ZoomMode } from '../types/view';

export interface ToolbarCallbacks {
	zoomOut(): void;
	zoomIn(): void;
	fitWidth(): void;
	goToPage(pageNumber: number): void;
}

/** Zoom controls, a zoom readout, and a page indicator you can type into. */
export class PdfInkToolbar {
	private readonly zoomLabelEl: HTMLElement;
	private readonly pageInputEl: HTMLInputElement;
	private readonly pageTotalEl: HTMLElement;
	private pageCount = 0;

	constructor(
		parentEl: HTMLElement,
		component: Component,
		callbacks: ToolbarCallbacks,
	) {
		const toolbarEl = parentEl.createDiv({ cls: 'pdf-ink-toolbar' });

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
		this.addButton(
			zoomGroupEl,
			component,
			'move-horizontal',
			'Fit width',
			() => {
				callbacks.fitWidth();
			},
		);

		const pageGroupEl = toolbarEl.createDiv({ cls: 'pdf-ink-toolbar-group' });
		pageGroupEl.createSpan({ cls: 'pdf-ink-toolbar-text', text: 'Page' });
		this.pageInputEl = pageGroupEl.createEl('input', {
			cls: 'pdf-ink-page-input',
			attr: { type: 'number', min: '1', 'aria-label': 'Page number' },
		});
		this.pageTotalEl = pageGroupEl.createSpan({
			cls: 'pdf-ink-toolbar-text',
			text: 'of 0',
		});

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
		this.zoomLabelEl.setText(
			mode.kind === 'fit-width' ? `${percent} (fit)` : percent,
		);
	}

	setPageCount(count: number): void {
		this.pageCount = count;
		this.pageTotalEl.setText(`of ${String(count)}`);
		this.pageInputEl.setAttribute('max', String(count));
	}

	setCurrentPage(pageNumber: number): void {
		// Never clobber what the user is mid-way through typing.
		if (this.pageInputEl.doc.activeElement === this.pageInputEl) return;
		this.pageInputEl.value = String(pageNumber);
	}

	private addButton(
		parentEl: HTMLElement,
		component: Component,
		icon: string,
		label: string,
		onClick: () => void,
	): void {
		const buttonEl = parentEl.createEl('button', {
			cls: 'clickable-icon pdf-ink-toolbar-button',
			attr: { 'aria-label': label, type: 'button' },
		});
		setIcon(buttonEl, icon);
		component.registerDomEvent(buttonEl, 'click', onClick);
	}
}
