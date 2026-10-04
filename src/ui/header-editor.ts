import type { Component } from 'obsidian';
import { HEADER_TITLE_SIZE, headerLayout } from '../core/header';
import type { PageTheme } from '../core/theme';
import type { PageRecord } from '../types/view';
import { TEXT_FONT_STACK } from './item-renderers';

/**
 * A one-line input over a notebook's title, for renaming it in place.
 *
 * Enter or leaving the field commits; Escape puts the title back. What is
 * committed is a request to rename the file: the title shown afterwards is
 * always the file's name, so a refused rename simply shows the old one again.
 */
export class HeaderEditor {
	private inputEl: HTMLInputElement | null = null;
	private closing = false;

	constructor(
		private readonly component: Component,
		private readonly rename: (title: string) => void,
	) {}

	get isOpen(): boolean {
		return this.inputEl !== null;
	}

	open(record: PageRecord, theme: PageTheme): void {
		this.close(false);
		const source = record.geom.source;
		if (source.kind !== 'inserted' || !source.header) return;

		const layout = headerLayout(source.page);
		const scale = record.viewport.scale;
		const [left, baseline] = record.viewport.convertToViewportPoint(layout.x, layout.titleBaseline);
		const [right] = record.viewport.convertToViewportPoint(layout.ruleX2, layout.titleBaseline);
		const size = HEADER_TITLE_SIZE * scale;

		const inputEl = record.wrapperEl.createEl('input', {
			cls: 'pdf-ink-header-editor',
			type: 'text',
		});
		inputEl.value = source.header.title;
		inputEl.setCssProps({
			'--pdf-ink-header-x': `${String(left)}px`,
			// The line box sits so its baseline meets the drawn title's.
			'--pdf-ink-header-y': `${String(baseline - size * 1.05)}px`,
			'--pdf-ink-header-w': `${String(Math.max(size * 4, right - left))}px`,
			'--pdf-ink-header-size': `${String(size)}px`,
			'--pdf-ink-header-color': theme.baseInk,
			'--pdf-ink-header-font': TEXT_FONT_STACK,
		});
		this.inputEl = inputEl;
		this.closing = false;

		this.component.registerDomEvent(inputEl, 'keydown', (evt) => {
			evt.stopPropagation();
			if (evt.key === 'Enter') {
				evt.preventDefault();
				this.close(true);
			} else if (evt.key === 'Escape') {
				evt.preventDefault();
				this.close(false);
			}
		});
		this.component.registerDomEvent(inputEl, 'blur', () => {
			this.close(true);
		});
		// A press inside the field moves the caret; it must not reach the page.
		this.component.registerDomEvent(inputEl, 'pointerdown', (evt) => {
			evt.stopPropagation();
		});
		inputEl.focus({ preventScroll: true });
		inputEl.select();
	}

	close(commit: boolean): void {
		const inputEl = this.inputEl;
		if (!inputEl || this.closing) return;
		this.closing = true;
		const title = inputEl.value;
		this.inputEl = null;
		inputEl.remove();
		if (commit) this.rename(title);
	}
}
