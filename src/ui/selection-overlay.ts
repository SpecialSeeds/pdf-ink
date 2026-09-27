import { type Component, setIcon } from 'obsidian';
import type { Bounds } from '../core/hit-test';
import type { PageRecord } from '../types/view';

/** Which part of the selection box a pointer landed on. */
export type SelectionHandle = 'nw' | 'ne' | 'se' | 'sw' | 'rotate' | 'body';

const CORNERS: SelectionHandle[] = ['nw', 'ne', 'se', 'sw'];

export interface SelectionOverlayCallbacks {
	delete(): void;
	duplicate(): void;
	bringForward(): void;
	sendBack(): void;
}

/**
 * The dashed selection box, its handles, and its context bar.
 *
 * Lives inside the page wrapper so it scrolls and zooms with the page. It only
 * draws and reports what was grabbed; the gesture maths belongs with the pointer
 * handling in InkLayer, which already owns the screen-to-PDF conversion.
 */
export class SelectionOverlay {
	private boxEl: HTMLElement | null = null;
	private host: PageRecord | null = null;

	constructor(
		private readonly component: Component,
		private readonly callbacks: SelectionOverlayCallbacks,
	) {}

	/** Show the box on `record`, moving it between pages if needed. */
	show(record: PageRecord, bounds: Bounds): void {
		if (this.host !== record) {
			this.hide();
			this.boxEl = this.build(record);
			this.host = record;
		}
		this.place(record, bounds);
	}

	hide(): void {
		this.boxEl?.remove();
		this.boxEl = null;
		this.host = null;
	}

	get isVisible(): boolean {
		return this.boxEl !== null;
	}

	/**
	 * Whether an event landed anywhere on the overlay, context bar included.
	 *
	 * Separate from {@link handleFor} because the bar is part of the overlay but is
	 * not a drag target: the caller must still refuse to start a new gesture there,
	 * or the button's click would arrive after the selection had been cleared.
	 */
	containsTarget(target: EventTarget | null): boolean {
		if (!(target instanceof Element)) return false;
		return target.closest('.pdf-ink-selection') !== null;
	}

	/** The handle an event landed on, or null when it is not a drag target. */
	handleFor(target: EventTarget | null): SelectionHandle | null {
		if (!(target instanceof Element)) return null;
		// Context-bar buttons have their own click handlers.
		if (target.closest('.pdf-ink-selection-bar')) return null;
		const handleEl = target.closest('.pdf-ink-handle');
		if (handleEl instanceof HTMLElement) {
			const kind = handleEl.dataset.handle;
			return isHandle(kind) ? kind : null;
		}
		return target.closest('.pdf-ink-selection') ? 'body' : null;
	}

	private place(record: PageRecord, bounds: Bounds): void {
		const boxEl = this.boxEl;
		if (!boxEl) return;
		// PDF space is y-up, so the box's top-left in CSS px comes from its
		// maximum y.
		const [left, top] = record.viewport.convertToViewportPoint(
			bounds.minX,
			bounds.maxY,
		);
		const [right, bottom] = record.viewport.convertToViewportPoint(
			bounds.maxX,
			bounds.minY,
		);
		boxEl.setCssProps({
			'--pdf-ink-sel-x': `${String(Math.min(left, right))}px`,
			'--pdf-ink-sel-y': `${String(Math.min(top, bottom))}px`,
			'--pdf-ink-sel-w': `${String(Math.abs(right - left))}px`,
			'--pdf-ink-sel-h': `${String(Math.abs(bottom - top))}px`,
		});
	}

	private build(record: PageRecord): HTMLElement {
		const boxEl = record.wrapperEl.createDiv({ cls: 'pdf-ink-selection' });
		boxEl.dataset.handle = 'body';

		for (const corner of CORNERS) {
			const handleEl = boxEl.createDiv({
				cls: `pdf-ink-handle pdf-ink-handle-${corner}`,
			});
			handleEl.dataset.handle = corner;
		}
		const rotateEl = boxEl.createDiv({
			cls: 'pdf-ink-handle pdf-ink-handle-rotate',
		});
		rotateEl.dataset.handle = 'rotate';
		setIcon(rotateEl, 'rotate-cw');

		const barEl = boxEl.createDiv({ cls: 'pdf-ink-selection-bar' });
		this.addAction(barEl, 'trash-2', 'Delete', () => {
			this.callbacks.delete();
		});
		this.addAction(barEl, 'copy', 'Duplicate', () => {
			this.callbacks.duplicate();
		});
		this.addAction(barEl, 'bring-to-front', 'Bring forward', () => {
			this.callbacks.bringForward();
		});
		this.addAction(barEl, 'send-to-back', 'Send back', () => {
			this.callbacks.sendBack();
		});

		return boxEl;
	}

	private addAction(
		parentEl: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void,
	): void {
		const buttonEl = parentEl.createEl('button', {
			cls: 'clickable-icon pdf-ink-selection-action',
			attr: { type: 'button', 'aria-label': label, title: label },
		});
		setIcon(buttonEl, icon);
		this.component.registerDomEvent(buttonEl, 'click', onClick);
	}
}

function isHandle(value: string | undefined): value is SelectionHandle {
	return (
		value === 'nw' ||
		value === 'ne' ||
		value === 'se' ||
		value === 'sw' ||
		value === 'rotate' ||
		value === 'body'
	);
}
