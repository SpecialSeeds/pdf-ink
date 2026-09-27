import { type Component, Menu, setIcon } from 'obsidian';
import type { ShapeKind } from '../core/items';
import {
	EXTRA_COLORS,
	type EraserMode,
	QUICK_COLORS,
	type ToolKind,
	type ToolState,
	activeColor,
	activeWidth,
	widthRangeFor,
	widthUnitFor,
} from '../core/tools';

export interface InkToolbarCallbacks {
	selectTool(tool: ToolKind): void;
	selectShape(kind: ShapeKind): void;
	selectColor(color: string): void;
	setWidth(width: number): void;
	setEraserMode(mode: EraserMode): void;
	undo(): void;
	redo(): void;
}

const TOOLS: { kind: ToolKind; icon: string; label: string }[] = [
	{ kind: 'pen', icon: 'pen', label: 'Pen' },
	{ kind: 'highlighter', icon: 'highlighter', label: 'Highlighter' },
	{ kind: 'text', icon: 'type', label: 'Text' },
	{ kind: 'eraser', icon: 'eraser', label: 'Eraser' },
	{ kind: 'lasso', icon: 'lasso', label: 'Select' },
];

const SHAPES: { kind: ShapeKind; icon: string; label: string }[] = [
	{ kind: 'line', icon: 'minus', label: 'Line' },
	{ kind: 'arrow', icon: 'arrow-up-right', label: 'Arrow' },
	{ kind: 'rect', icon: 'square', label: 'Rectangle' },
	{ kind: 'ellipse', icon: 'circle', label: 'Ellipse' },
	{ kind: 'triangle', icon: 'triangle', label: 'Equilateral triangle' },
	{ kind: 'axes2d_q', icon: 'move-up-right', label: '2D axes (origin at 0.25)' },
	{ kind: 'axes2d_c', icon: 'plus', label: '2D axes (origin at 0.5)' },
	{ kind: 'axes3d_c', icon: 'box', label: '3D axes' },
];

/** The floating tool palette: tools, shapes, colours, width, undo and redo. */
export class InkToolbar {
	private readonly toolButtons = new Map<ToolKind, HTMLElement>();
	private readonly quickSwatches: { color: string; el: HTMLElement }[] = [];
	private readonly extraSwatches: { color: string; el: HTMLElement }[] = [];
	private readonly shapeButtonEl: HTMLButtonElement;
	private readonly colorGroupEl: HTMLElement;
	private readonly colorPopoverEl: HTMLElement;
	private readonly colorInputEl: HTMLInputElement;
	private readonly widthEl: HTMLInputElement;
	private readonly widthLabelEl: HTMLElement;
	private readonly eraserPopoverEl: HTMLElement;
	private readonly eraserModeButtons = new Map<EraserMode, HTMLElement>();
	private readonly eraserRadiusEl: HTMLInputElement;
	private readonly eraserRadiusLabelEl: HTMLElement;
	private readonly undoEl: HTMLButtonElement;
	private readonly redoEl: HTMLButtonElement;

	constructor(
		parentEl: HTMLElement,
		private readonly component: Component,
		private readonly callbacks: InkToolbarCallbacks,
	) {
		const barEl = parentEl.createDiv({ cls: 'pdf-ink-floating' });

		const toolsEl = barEl.createDiv({ cls: 'pdf-ink-floating-group' });
		for (const tool of TOOLS) {
			if (tool.kind === 'eraser' || tool.kind === 'lasso') continue;
			this.toolButtons.set(
				tool.kind,
				this.addButton(toolsEl, tool.icon, tool.label, () => {
					this.callbacks.selectTool(tool.kind);
				}),
			);
		}

		// Shapes: one button that both selects the tool and opens the menu.
		this.shapeButtonEl = this.addButton(
			toolsEl,
			'shapes',
			'Shapes',
			(evt) => {
				this.openShapeMenu(evt);
			},
		);
		this.toolButtons.set('shape', this.shapeButtonEl);

		const eraser = TOOLS.find((tool) => tool.kind === 'eraser');
		const eraserWrapEl = toolsEl.createDiv({ cls: 'pdf-ink-eraser-wrap' });
		if (eraser) {
			this.toolButtons.set(
				'eraser',
				this.addButton(eraserWrapEl, eraser.icon, eraser.label, () => {
					this.callbacks.selectTool('eraser');
				}),
			);
		}
		const eraserChevronEl = this.addButton(
			eraserWrapEl,
			'chevron-up',
			'Eraser options',
			() => {
				this.toggle(this.eraserPopoverEl);
			},
		);
		eraserChevronEl.addClass('pdf-ink-chevron');

		this.eraserPopoverEl = eraserWrapEl.createDiv({
			cls: 'pdf-ink-popover is-hidden',
		});
		const modesEl = this.eraserPopoverEl.createDiv({ cls: 'pdf-ink-mode-row' });
		for (const mode of [
			{ kind: 'stroke' as EraserMode, label: 'Whole stroke' },
			{ kind: 'sized' as EraserMode, label: 'Sized' },
		]) {
			const buttonEl = modesEl.createEl('button', {
				cls: 'pdf-ink-mode-button',
				text: mode.label,
				attr: { type: 'button' },
			});
			this.component.registerDomEvent(buttonEl, 'click', () => {
				this.callbacks.setEraserMode(mode.kind);
			});
			this.eraserModeButtons.set(mode.kind, buttonEl);
		}
		const radiusRowEl = this.eraserPopoverEl.createDiv({
			cls: 'pdf-ink-custom-color',
		});
		radiusRowEl.createSpan({ text: 'Radius', cls: 'pdf-ink-toolbar-text' });
		this.eraserRadiusLabelEl = radiusRowEl.createSpan({
			cls: 'pdf-ink-width-label',
		});
		this.eraserRadiusEl = this.eraserPopoverEl.createEl('input', {
			cls: 'pdf-ink-width',
			attr: { type: 'range', 'aria-label': 'Eraser radius' },
		});
		this.component.registerDomEvent(this.eraserRadiusEl, 'input', () => {
			const value = Number.parseFloat(this.eraserRadiusEl.value);
			if (Number.isFinite(value)) this.callbacks.setWidth(value);
		});

		this.component.registerDomEvent(barEl.doc, 'pointerdown', (evt) => {
			if (this.eraserPopoverEl.hasClass('is-hidden')) return;
			const target = evt.target;
			if (target instanceof Node && eraserWrapEl.contains(target)) return;
			this.eraserPopoverEl.addClass('is-hidden');
		});

		const lasso = TOOLS.find((tool) => tool.kind === 'lasso');
		if (lasso) {
			this.toolButtons.set(
				'lasso',
				this.addButton(toolsEl, lasso.icon, lasso.label, () => {
					this.callbacks.selectTool('lasso');
				}),
			);
		}

		// --- colours -------------------------------------------------------
		const colorGroupEl = barEl.createDiv({
			cls: 'pdf-ink-floating-group pdf-ink-colors',
		});
		this.colorGroupEl = colorGroupEl;
		for (const color of QUICK_COLORS) {
			this.quickSwatches.push({
				color: color.value,
				el: this.addSwatch(colorGroupEl, color.value, color.name),
			});
		}

		const moreEl = colorGroupEl.createDiv({ cls: 'pdf-ink-color-more' });
		const chevronEl = this.addButton(moreEl, 'chevron-up', 'More colours', () => {
			this.toggle(this.colorPopoverEl);
		});
		chevronEl.addClass('pdf-ink-chevron');

		this.colorPopoverEl = moreEl.createDiv({
			cls: 'pdf-ink-popover is-hidden',
		});
		const gridEl = this.colorPopoverEl.createDiv({ cls: 'pdf-ink-color-grid' });
		for (const color of EXTRA_COLORS) {
			this.extraSwatches.push({
				color: color.value,
				el: this.addSwatch(gridEl, color.value, color.name),
			});
		}
		const customEl = this.colorPopoverEl.createDiv({ cls: 'pdf-ink-custom-color' });
		customEl.createSpan({ text: 'Custom', cls: 'pdf-ink-toolbar-text' });
		this.colorInputEl = customEl.createEl('input', {
			cls: 'pdf-ink-color-input',
			attr: { type: 'color', 'aria-label': 'Custom colour' },
		});
		this.component.registerDomEvent(this.colorInputEl, 'input', () => {
			this.callbacks.selectColor(this.colorInputEl.value);
		});

		// Clicking anywhere else dismisses the popover.
		this.component.registerDomEvent(barEl.doc, 'pointerdown', (evt) => {
			if (this.colorPopoverEl.hasClass('is-hidden')) return;
			const target = evt.target;
			if (target instanceof Node && moreEl.contains(target)) return;
			this.colorPopoverEl.addClass('is-hidden');
		});

		// --- width ---------------------------------------------------------
		const widthGroupEl = barEl.createDiv({ cls: 'pdf-ink-floating-group' });
		this.widthEl = widthGroupEl.createEl('input', {
			cls: 'pdf-ink-width',
			attr: { type: 'range', 'aria-label': 'Stroke width' },
		});
		this.widthLabelEl = widthGroupEl.createSpan({ cls: 'pdf-ink-width-label' });
		this.component.registerDomEvent(this.widthEl, 'input', () => {
			const value = Number.parseFloat(this.widthEl.value);
			if (Number.isFinite(value)) this.callbacks.setWidth(value);
		});

		// --- history -------------------------------------------------------
		const historyEl = barEl.createDiv({ cls: 'pdf-ink-floating-group' });
		this.undoEl = this.addButton(historyEl, 'undo', 'Undo', () => {
			this.callbacks.undo();
		});
		this.redoEl = this.addButton(historyEl, 'redo', 'Redo', () => {
			this.callbacks.redo();
		});
	}

	update(state: ToolState, canUndo: boolean, canRedo: boolean): void {

		for (const [kind, buttonEl] of this.toolButtons) {
			buttonEl.toggleClass('is-active', state.active === kind);
		}

		const shape = SHAPES.find((entry) => entry.kind === state.shape.kind);
		if (shape) {
			setIcon(this.shapeButtonEl, shape.icon);
			this.shapeButtonEl.setAttribute('aria-label', `Shapes: ${shape.label}`);
		}

		// The eraser has no colour, so the swatches are not meaningful for it.
		const selected = activeColor(state);
		// Hides the whole colour group, swatches and chevron alike.
		this.colorGroupEl.toggleClass('is-hidden', selected === null);
		if (selected === null) this.colorPopoverEl.addClass('is-hidden');
		for (const swatch of [...this.quickSwatches, ...this.extraSwatches]) {
			swatch.el.toggleClass(
				'is-active',
				selected !== null && sameColor(swatch.color, selected),
			);
		}
		if (selected !== null) this.colorInputEl.value = normalizeHex(selected);

		// The eraser is the only tool whose slider changes meaning with its mode.
		const range = widthRangeFor(state);
		const width = activeWidth(state);
		const unit = widthUnitFor(state);
		for (const sliderEl of [this.widthEl, this.eraserRadiusEl]) {
			sliderEl.min = String(range.min);
			sliderEl.max = String(range.max);
			sliderEl.step = String(range.step);
			sliderEl.value = String(width);
		}
		this.widthLabelEl.setText(`${String(width)} ${unit}`);
		// The slider is the font size while the text tool is active.
		this.widthEl.setAttribute(
			'aria-label',
			state.active === 'text' ? 'Font size' : 'Stroke width',
		);
		this.eraserRadiusLabelEl.setText(`${String(width)} ${unit}`);

		for (const [mode, buttonEl] of this.eraserModeButtons) {
			buttonEl.toggleClass('is-active', state.eraser.mode === mode);
		}
		if (state.active !== 'eraser') this.eraserPopoverEl.addClass('is-hidden');

		this.undoEl.disabled = !canUndo;
		this.redoEl.disabled = !canRedo;
	}

	private openShapeMenu(evt: MouseEvent): void {
		const menu = new Menu();
		for (const shape of SHAPES) {
			menu.addItem((item) =>
				item
					.setTitle(shape.label)
					.setIcon(shape.icon)
					.onClick(() => {
						this.callbacks.selectShape(shape.kind);
					}),
			);
		}
		menu.showAtMouseEvent(evt);
	}

	private toggle(popoverEl: HTMLElement): void {
		popoverEl.toggleClass('is-hidden', !popoverEl.hasClass('is-hidden'));
	}

	private addSwatch(
		parentEl: HTMLElement,
		color: string,
		label: string,
	): HTMLElement {
		/*
		 * Deliberately a div and not a <button>.
		 *
		 * Obsidian styles `button` through selectors that outrank a single plugin
		 * class, and on mobile it also gives every button a minimum touch size — which
		 * stretched the 20x20 swatch into a grey ellipse, because a 50% radius on a
		 * non-square box is an ellipse. A div carries none of that, so the swatch is
		 * exactly the circle it is meant to be on every platform.
		 */
		const swatchEl = parentEl.createDiv({
			cls: 'pdf-ink-swatch',
			attr: {
				role: 'button',
				tabindex: '0',
				'aria-label': label,
				title: label,
			},
		});
		// The colour goes on an inner span, which nothing else styles at all.
		const fillEl = swatchEl.createSpan({ cls: 'pdf-ink-swatch-fill' });
		fillEl.setCssProps({ '--pdf-ink-swatch': color });

		const choose = (): void => {
			this.callbacks.selectColor(color);
		};
		this.component.registerDomEvent(swatchEl, 'click', choose);
		// A div has no built-in keyboard activation, so it has to be given one.
		this.component.registerDomEvent(swatchEl, 'keydown', (evt) => {
			if (evt.key !== 'Enter' && evt.key !== ' ') return;
			evt.preventDefault();
			choose();
		});
		return swatchEl;
	}

	private addButton(
		parentEl: HTMLElement,
		icon: string,
		label: string,
		onClick: (evt: MouseEvent) => void,
	): HTMLButtonElement {
		const buttonEl = parentEl.createEl('button', {
			cls: 'clickable-icon pdf-ink-floating-button',
			attr: { 'aria-label': label, type: 'button' },
		});
		setIcon(buttonEl, icon);
		this.component.registerDomEvent(buttonEl, 'click', onClick);
		return buttonEl;
	}
}

/** Case-insensitive hex comparison, so #FFF and #fff match. */
function sameColor(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}

/** `<input type="color">` only accepts lowercase #rrggbb. */
function normalizeHex(color: string): string {
	const value = color.trim().toLowerCase();
	if (/^#[0-9a-f]{6}$/.test(value)) return value;
	const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(value);
	if (short) return `#${short[1] ?? ''}${short[1] ?? ''}${short[2] ?? ''}${short[2] ?? ''}${short[3] ?? ''}${short[3] ?? ''}`;
	return '#000000';
}
