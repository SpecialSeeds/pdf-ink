import type { Component } from 'obsidian';
import type { TextItem } from '../core/items';
import { LINE_HEIGHT } from '../core/text-layout';
import { TEXT_FONT_STACK } from './item-renderers';
import type { PageRecord } from '../types/view';

export interface TextEditorCallbacks {
	/** The user finished: `text` is what they typed, trimmed of nothing. */
	commit(item: TextItem, text: string): void;
	/** They left without typing anything into a brand-new box. */
	discard(item: TextItem): void;
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

		areaEl.focus();
		areaEl.setSelectionRange(areaEl.value.length, areaEl.value.length);
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
			'--pdf-ink-text-color': item.color,
			'--pdf-ink-text-rotate': `${String(item.rotation)}deg`,
			'--pdf-ink-text-font': TEXT_FONT_STACK,
		});
	}
}
