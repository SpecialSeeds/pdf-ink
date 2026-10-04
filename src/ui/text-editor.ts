import type { Component } from 'obsidian';

/** Long enough for the on-screen keyboard to finish animating in, in ms. */
const KEYBOARD_SETTLE_MS = 350;
import type { TextItem } from '../core/items';
import { renderColor } from '../core/theme';
import { LINE_HEIGHT } from '../core/text-layout';
import { TEXT_FONT_STACK } from './item-renderers';
import type { PageTheme } from '../core/theme';
import type { PageRecord } from '../types/view';

export interface TextEditorCallbacks {
	/** The user finished: `text` is what they typed, trimmed of nothing. */
	commit(item: TextItem, text: string): void;
	/** They left without typing anything into a brand-new box. */
	discard(item: TextItem): void;
	/** The theme of the page being edited, so typed text shows as it will render. */
	pageTheme(record: PageRecord): PageTheme;
}

/**
 * A textarea overlaid exactly on a text box, at the current zoom.
 *
 * A real textarea rather than a contenteditable canvas hack: it brings the
 * caret, selection, IME and mobile keyboard with it. Its font size and width
 * match the box, so its wrapping matches what the renderer will draw.
 */
export class TextEditor {
	private areaEl: HTMLTextAreaElement | null = null;
	private editing: TextItem | null = null;
	private record: PageRecord | null = null;
	/** Guards against blur and Escape both committing the same edit. */
	private closing = false;
	/** Pending scroll restore while the on-screen keyboard animates in. */
	private settleTimer: number | null = null;

	constructor(
		private readonly component: Component,
		private readonly callbacks: TextEditorCallbacks,
	) {}

	get isOpen(): boolean {
		return this.areaEl !== null;
	}

	get item(): TextItem | null {
		return this.editing;
	}

	open(record: PageRecord, item: TextItem): void {
		this.close(true);
		this.clearSettleTimer();

		const areaEl = record.wrapperEl.createEl('textarea', {
			cls: 'pdf-ink-text-editor',
		});
		areaEl.value = item.text;
		this.areaEl = areaEl;
		this.editing = item;
		this.record = record;
		this.closing = false;
		this.place(record, item);

		this.component.registerDomEvent(areaEl, 'blur', () => {
			this.close(true);
		});
		this.component.registerDomEvent(areaEl, 'keydown', (evt) => {
			if (evt.key === 'Escape') {
				evt.preventDefault();
				// Escape commits too: the box is the document, not a dialog.
				this.close(true);
			}
			// Everything else, including Enter, belongs to the textarea.
			evt.stopPropagation();
		});
		// Keep pointer gestures on the page from stealing the caret.
		this.component.registerDomEvent(areaEl, 'pointerdown', (evt) => {
			evt.stopPropagation();
		});

		this.focusInPlace(areaEl, record);
	}

	/**
	 * Focus the textarea without moving the document.
	 *
	 * Focusing an element scrolls it into view, and the scroll container here is the
	 * whole PDF — so creating a box threw the view somewhere else entirely. iOS goes
	 * further and scrolls again when the keyboard animates in, which `preventScroll`
	 * does not cover, so the position is captured and put back: once immediately,
	 * once on the next frame, and once after the keyboard has settled.
	 */
	private focusInPlace(
		areaEl: HTMLTextAreaElement,
		record: PageRecord,
	): void {
		const scrollEl = record.wrapperEl.closest<HTMLElement>('.pdf-ink-scroll');
		const top = scrollEl?.scrollTop ?? 0;
		const left = scrollEl?.scrollLeft ?? 0;

		areaEl.focus({ preventScroll: true });
		areaEl.setSelectionRange(areaEl.value.length, areaEl.value.length);
		if (!scrollEl) return;

		const restore = (): void => {
			// Only while this editor is still the open one, so a later deliberate
			// scroll by the user is never undone.
			if (this.areaEl !== areaEl) return;
			if (scrollEl.scrollTop !== top) scrollEl.scrollTop = top;
			if (scrollEl.scrollLeft !== left) scrollEl.scrollLeft = left;
		};

		restore();
		const win = areaEl.win;
		win.requestAnimationFrame(restore);
		// Long enough for the on-screen keyboard to finish animating in.
		this.settleTimer = win.setTimeout(restore, KEYBOARD_SETTLE_MS);
	}

	private clearSettleTimer(): void {
		if (this.settleTimer === null) return;
		this.areaEl?.win.clearTimeout(this.settleTimer);
		this.settleTimer = null;
	}

	/** Re-place the textarea after a zoom. */
	reposition(): void {
		if (this.record && this.editing) this.place(this.record, this.editing);
	}

	close(commit: boolean): void {
		const areaEl = this.areaEl;
		const item = this.editing;
		if (!areaEl || !item || this.closing) return;
		this.closing = true;
		this.clearSettleTimer();

		const text = areaEl.value;
		this.areaEl = null;
		this.editing = null;
		this.record = null;
		areaEl.remove();

		if (!commit || text.length === 0) this.callbacks.discard(item);
		else this.callbacks.commit(item, text);
	}

	private place(record: PageRecord, item: TextItem): void {
		const areaEl = this.areaEl;
		if (!areaEl) return;
		const scale = record.viewport.scale;
		const [left, top] = record.viewport.convertToViewportPoint(
			Math.min(item.box.x, item.box.x + item.box.w),
			Math.max(item.box.y, item.box.y + item.box.h),
		);
		areaEl.setCssProps({
			'--pdf-ink-text-x': `${String(left)}px`,
			'--pdf-ink-text-y': `${String(top)}px`,
			'--pdf-ink-text-w': `${String(Math.abs(item.box.w) * scale)}px`,
			'--pdf-ink-text-h': `${String(Math.abs(item.box.h) * scale)}px`,
			'--pdf-ink-text-size': `${String(item.fontSize * scale)}px`,
			'--pdf-ink-text-line': String(LINE_HEIGHT),
			'--pdf-ink-text-color': renderColor(
				item.color,
				this.callbacks.pageTheme(record),
			),
			'--pdf-ink-text-rotate': `${String(item.rotation)}deg`,
			'--pdf-ink-text-font': TEXT_FONT_STACK,
		});
	}
}
