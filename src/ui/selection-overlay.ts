import { type Component, setIcon } from 'obsidian';
import { sameColor } from '../core/color';
import type { Bounds } from '../core/hit-test';
import type { ColorLayer, LayerColor } from '../core/selection';
import {
	type NamedColor,
	SELECTION_HIGHLIGHT_COLORS,
	SELECTION_INK_COLORS,
} from '../core/tools';
import type { PageRecord } from '../types/view';

/** Which part of the selection box a pointer landed on. */
export type SelectionHandle = 'nw' | 'ne' | 'se' | 'sw' | 'rotate' | 'body';

const CORNERS: SelectionHandle[] = ['nw', 'ne', 'se', 'sw'];

export interface SelectionOverlayCallbacks {
	delete(): void;
	duplicate(): void;
	bringForward(): void;
	sendBack(): void;
	recolor(layer: ColorLayer, color: string): void;
}

const LAYER_COLORS: Record<ColorLayer, readonly NamedColor[]> = {
	ink: SELECTION_INK_COLORS,
	highlight: SELECTION_HIGHLIGHT_COLORS,
};

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
	private barEl: HTMLElement | null = null;
	private palettesEl: HTMLElement | null = null;
	/** The layers the palettes were last built for, so a refresh can reuse them. */
	private paletteKey = '';
	private readonly swatches: {
		layer: ColorLayer;
		color: string;
		el: HTMLElement;
	}[] = [];

	constructor(
		private readonly component: Component,
		private readonly callbacks: SelectionOverlayCallbacks,
	) {}

	/**
	 * Show the box on `record`, moving it between pages if needed, with one
	 * colour palette per layer in `layers` (ink above, highlighter below). Without
	 * `layers`, as mid-drag, the palettes stay as they were.
	 */
	show(record: PageRecord, bounds: Bounds, layers?: readonly LayerColor[]): void {
		if (this.host !== record) {
			this.hide();
			this.boxEl = this.build(record);
			this.host = record;
		}
		this.place(record, bounds);
		if (layers) this.updatePalettes(layers);
	}

	hide(): void {
		this.boxEl?.remove();
		this.boxEl = null;
		this.barEl = null;
		this.palettesEl = null;
		this.paletteKey = '';
		this.swatches.length = 0;
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

	/** Whether an event landed on the context bar's buttons. */
	isBarTarget(target: EventTarget | null): boolean {
		return (
			target instanceof Element &&
			target.closest('.pdf-ink-selection-bar') !== null
		);
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
		this.barEl = barEl;
		const actionsEl = barEl.createDiv({ cls: 'pdf-ink-selection-actions' });
		this.addAction(actionsEl, 'trash-2', 'Delete', () => {
			this.callbacks.delete();
		});
		this.addAction(actionsEl, 'copy', 'Duplicate', () => {
			this.callbacks.duplicate();
		});
		this.addAction(actionsEl, 'bring-to-front', 'Bring forward', () => {
			this.callbacks.bringForward();
		});
		this.addAction(actionsEl, 'send-to-back', 'Send back', () => {
			this.callbacks.sendBack();
		});

		return boxEl;
	}

	/**
	 * One unlabelled row of swatches per layer the selection has. Rebuilt only when
	 * the set of layers changes; otherwise just the active swatch moves.
	 */
	private updatePalettes(layers: readonly LayerColor[]): void {
		const barEl = this.barEl;
		if (!barEl) return;
		const key = layers.map((entry) => entry.layer).join(',');
		if (key !== this.paletteKey) {
			this.paletteKey = key;
			this.palettesEl?.remove();
			this.swatches.length = 0;
			this.palettesEl = barEl.createDiv({ cls: 'pdf-ink-selection-palettes' });
			for (const { layer } of layers) {
				const rowEl = this.palettesEl.createDiv({
					cls: 'pdf-ink-selection-palette',
				});
				for (const color of LAYER_COLORS[layer]) {
					this.swatches.push({
						layer,
						color: color.value,
						el: this.addSwatch(rowEl, layer, color),
					});
				}
			}
		}
		for (const swatch of this.swatches) {
			const current = layers.find((entry) => entry.layer === swatch.layer)?.color;
			swatch.el.toggleClass(
				'is-active',
				current != null && sameColor(current, swatch.color),
			);
		}
	}

	/** A div, not a button, for the same reason as the palette's swatches. */
	private addSwatch(
		parentEl: HTMLElement,
		layer: ColorLayer,
		color: NamedColor,
	): HTMLElement {
		const swatchEl = parentEl.createDiv({
			cls: 'pdf-ink-swatch',
			attr: {
				role: 'button',
				tabindex: '0',
				'aria-label': color.name,
				title: color.name,
			},
		});
		const fillEl = swatchEl.createSpan({ cls: 'pdf-ink-swatch-fill' });
		fillEl.setCssProps({ '--pdf-ink-swatch': color.value });
		const choose = (): void => {
			this.callbacks.recolor(layer, color.value);
		};
		this.component.registerDomEvent(swatchEl, 'click', choose);
		this.component.registerDomEvent(swatchEl, 'keydown', (evt) => {
			if (evt.key !== 'Enter' && evt.key !== ' ') return;
			evt.preventDefault();
			choose();
		});
		return swatchEl;
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
