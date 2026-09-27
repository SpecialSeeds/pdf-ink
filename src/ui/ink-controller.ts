import { type App, type Component, Scope } from 'obsidian';
import type { ItemRef } from '../core/history';
import type { ShapeKind, TextItem } from '../core/items';
import type { PageKey } from '../core/pages';
import { recolorChanges } from '../core/selection';
import { createStrokeId } from '../core/stroke';
import { TextEditor } from './text-editor';
import {
	type SelectionTransform,
	duplicateItems,
	transformChanges,
	zChanges,
} from '../core/transform';
import {
	type ToolKind,
	type ToolState,
	colouredTool,
	defaultToolState,
	toggleEraserMode,
	eraserRadius,
	presetFor,
	setActiveColor,
	setActiveWidth,
} from '../core/tools';
import type { PdfInkHost } from '../settings';
import type { AnnotationStore } from '../pdf/annotation-store';
import type { PageRecord } from '../types/view';
import { InkLayer } from './ink-layer';
import { InkToolbar } from './ink-toolbar';

export interface InkControllerOptions {
	resolveRecord(target: EventTarget | null): PageRecord | undefined;
	recordForPage(pageKey: PageKey): PageRecord | undefined;
	/** Repaint every live page, after an undo, redo or load. */
	repaint(): void;
}

/**
 * Owns everything to do with inking: the tool state, the floating palette, the
 * pointer capture layer, and the view-local undo hotkeys.
 *
 * Split out of the view so the view stays about the PDF lifecycle.
 */
export class InkController {
	private readonly toolState: ToolState = defaultToolState();
	/**
	 * Items a colour click would recolour. Nothing populates this yet — there is no
	 * select tool — so the recolour path is present and correct but unreachable.
	 */
	private selection: readonly ItemRef[] = [];
	private readonly textEditor: TextEditor;
	/** Boxes not yet in the store, so an empty commit discards rather than deletes. */
	private newTextIds: ReadonlySet<string> = new Set();
	/** The page the open editor belongs to. */
	/** The page the open text editor belongs to. Empty when nothing is open. */
	private editingPage: PageKey = '';
	private readonly layer: InkLayer;
	private readonly toolbar: InkToolbar;

	/**
	 * Assign to `View.scope`. Mod+Z means "undo a stroke" only while this view has
	 * focus, so it never shadows the editor's own undo — which is why this is a
	 * scope rather than a default hotkey on the commands.
	 */
	readonly scope: Scope;

	constructor(
		component: Component,
		app: App,
		rootEl: HTMLElement,
		pagesEl: HTMLElement,
		private readonly store: AnnotationStore,
		private readonly host: PdfInkHost,
		private readonly options: InkControllerOptions,
	) {
		// Restore each tool's last colour from settings.
		this.toolState.pen.color = host.settings.toolColors.pen;
		this.toolState.highlighter.color = host.settings.toolColors.highlighter;
		this.toolState.shape.color = host.settings.toolColors.shape;
		this.toolState.text.color = host.settings.toolColors.text;
		this.toolState.pen.width = host.settings.toolWidths.pen;
		this.toolState.highlighter.width = host.settings.toolWidths.highlighter;
		this.toolState.shape.width = host.settings.toolWidths.shape;
		this.toolState.text.fontSize = host.settings.textFontSize;
		this.toolState.eraser.mode = host.settings.eraserMode;
		this.toolState.eraser.radiusPx = host.settings.eraserRadiusPx;
		this.toolState.eraser.width = host.settings.eraserWidth;

		this.textEditor = new TextEditor(component, {
			commit: (item, text) => {
				this.commitText(item, text);
			},
			discard: (item) => {
				this.discardText(item);
			},
		});

		this.layer = new InkLayer(component, rootEl, pagesEl, store, {
			resolveRecord: (target) => this.options.resolveRecord(target),
			tool: () => this.toolState.active,
			preset: () => presetFor(this.toolState),
			shape: () => this.toolState.shape,
			text: () => this.toolState.text,
			editText: (record, item, isNew) => {
				this.editingPage = record.geom.key;
				if (isNew) this.newTextIds = new Set([...this.newTextIds, item.id]);
				this.textEditor.open(record, item);
			},
			isEditingText: () => this.textEditor.isOpen,
			stopEditingText: () => {
				this.textEditor.close(true);
			},
			eraserRadius: () => eraserRadius(this.toolState),
			eraserMode: () => this.toolState.eraser.mode,
			eraserRadiusPx: () => this.toolState.eraser.radiusPx,
			palmRejection: () => this.host.settings.palmRejection,
			recordForPage: (pageKey) => this.options.recordForPage(pageKey),
			selection: () => this.selection,
			setSelection: (refs) => {
				this.selection = refs;
			},
			commitTransform: (transform) => {
				this.applyTransform(transform);
			},
			deleteSelection: () => {
				this.deleteSelection();
			},
			duplicateSelection: () => {
				this.duplicateSelection();
			},
			bringSelectionForward: () => {
				this.changeZ('front');
			},
			sendSelectionBack: () => {
				this.changeZ('back');
			},
		});
		this.layer.attach();

		this.toolbar = new InkToolbar(rootEl, component, {
			selectTool: (tool) => {
				this.selectTool(tool);
			},
			selectShape: (kind) => {
				this.selectShape(kind);
			},
			selectColor: (color) => {
				this.applyColor(color);
			},
			setWidth: (width) => {
				setActiveWidth(this.toolState, width);
				this.persistWidth();
				this.refresh();
			},
			setEraserMode: (mode) => {
				this.toolState.eraser.mode = mode;
				this.persistEraser();
				this.refresh();
			},
			undo: () => {
				this.undo();
			},
			redo: () => {
				this.redo();
			},
		});

		this.scope = new Scope(app.scope);
		this.scope.register(['Mod'], 'z', () => {
			this.undo();
			return false;
		});
		this.scope.register(['Mod', 'Shift'], 'z', () => {
			this.redo();
			return false;
		});
		// Mod+Shift+E rather than Mod+E, which Obsidian already uses.
		this.scope.register([], 'Escape', () => {
			// The editor handles its own Escape; this is for the selection.
			if (this.selection.length === 0) return;
			this.layer.clearSelection();
			this.refresh();
			return false;
		});
		this.scope.register(['Mod', 'Shift'], 'e', () => {
			this.toggleEraser();
			return false;
		});

		this.refresh();
	}

	get canUndo(): boolean {
		return this.store.canUndo;
	}

	get canRedo(): boolean {
		return this.store.canRedo;
	}

	undo(): void {
		if (this.store.undo()) this.options.repaint();
	}

	redo(): void {
		if (this.store.redo()) this.options.repaint();
	}

	selectTool(tool: ToolKind): void {
		// Committing first, so switching tools never loses what was typed.
		this.textEditor.close(true);
		this.toolState.active = tool;
		this.refresh();
	}

	/** Flip between whole-item and sized erasing, selecting the eraser too. */
	toggleEraser(): void {
		toggleEraserMode(this.toolState);
		this.toolState.active = 'eraser';
		this.persistEraser();
		this.refresh();
	}

	/** Store whichever size the active tool's slider just changed. */
	private persistWidth(): void {
		const settings = this.host.settings;
		switch (this.toolState.active) {
			case 'pen':
			case 'highlighter':
			case 'shape':
				settings.toolWidths[this.toolState.active] =
					this.toolState[this.toolState.active].width;
				break;
			case 'text':
				settings.textFontSize = this.toolState.text.fontSize;
				break;
			case 'eraser':
				if (this.toolState.eraser.mode === 'sized') {
					settings.eraserRadiusPx = this.toolState.eraser.radiusPx;
				} else {
					settings.eraserWidth = this.toolState.eraser.width;
				}
				break;
			case 'lasso':
				return;
		}
		void this.host.saveSettings();
	}

	private persistEraser(): void {
		this.host.settings.eraserMode = this.toolState.eraser.mode;
		this.host.settings.eraserRadiusPx = this.toolState.eraser.radiusPx;
		void this.host.saveSettings();
	}

	/** Choosing a shape also switches to the shape tool. */
	selectShape(kind: ShapeKind): void {
		this.toolState.shape.kind = kind;
		this.toolState.active = 'shape';
		this.refresh();
	}

	/**
	 * Replace what the items a colour click would affect.
	 *
	 * For a future select tool: pass the refs it has selected, or an empty array to
	 * clear.
	 */
	setSelection(refs: readonly ItemRef[]): void {
		this.selection = refs;
	}

	/**
	 * A colour click always retargets the active tool, and additionally recolours
	 * the selection when there is one — as a single undoable operation.
	 */
	private applyColor(color: string): void {
		setActiveColor(this.toolState, color);

		const tool = colouredTool(this.toolState);
		if (tool !== null) {
			this.host.settings.toolColors[tool] = color;
			void this.host.saveSettings();
		}

		if (this.selection.length > 0) {
			const changes = recolorChanges(this.selection, color);
			if (changes.length > 0) {
				this.store.transformItems(changes);
				// The refs now hold stale items, so re-point them at the new ones.
				this.selection = changes.map((change) => ({
					pageKey: change.pageKey,
					index:
						this.selection.find((ref) => ref.item.id === change.after.id)
							?.index ?? 0,
					item: change.after,
				}));
				this.options.repaint();
			}
		}

		this.refresh();
	}

	/** Bring the palette back in sync with the tool state and history. */
	refresh(): void {
		this.toolbar.update(this.toolState, this.store.canUndo, this.store.canRedo);
	}

	redraw(record: PageRecord): void {
		this.layer.redraw(record);
	}

	/** The items a colour click or a transform would affect. */
	get selectedItems(): readonly ItemRef[] {
		return this.selection;
	}

	/**
	 * Forget a selection whose page is no longer in the document.
	 *
	 * Without this a deleted page leaves refs pointing at tombstoned items, and the
	 * next colour click or nudge would silently do nothing.
	 */
	pruneSelection(): void {
		if (this.selection.length === 0) return;
		const present = this.selection.every(
			(ref) => this.options.recordForPage(ref.pageKey) !== undefined,
		);
		if (present) return;
		this.layer.clearSelection();
	}

	/** Re-place the selection box and any open editor, after a zoom. */
	refreshSelectionBox(): void {
		this.layer.refreshSelection();
		this.textEditor.reposition();
	}

	/** Commit any open editor, so a tool change or close does not lose text. */
	flushText(): void {
		this.textEditor.close(true);
	}

	private commitText(item: TextItem, text: string): void {
		const isNew = this.newTextIds.has(item.id);
		this.forgetNewText(item.id);
		const pageKey = this.editingPage;
		const next: TextItem = { ...item, text };

		if (isNew) {
			this.store.addItem(pageKey, next);
		} else {
			this.store.transformItems([
				{ pageKey, before: item, after: next },
			]);
		}
		this.options.repaint();
	}

	private discardText(item: TextItem): void {
		const wasNew = this.newTextIds.has(item.id);
		this.forgetNewText(item.id);

		// A box that was never typed into simply never existed. An existing one
		// emptied out is deleted, at its real position so undo restores it there.
		if (!wasNew) {
			const pageKey = this.editingPage;
			const index = this.store
				.itemsFor(pageKey)
				.findIndex((candidate) => candidate.id === item.id);
			if (index >= 0) {
				this.store.removeItems([{ pageKey, index, item }]);
			}
		}
		this.options.repaint();
	}

	private forgetNewText(id: string): void {
		const remaining = new Set(this.newTextIds);
		remaining.delete(id);
		this.newTextIds = remaining;
	}

	private applyTransform(transform: SelectionTransform): void {
		const changes = transformChanges(this.selection, transform);
		if (changes.length === 0) return;
		this.store.transformItems(changes);
		// The refs held stale items; re-point them at the transformed ones.
		this.selection = this.selection.map((ref, index) => {
			const change = changes[index];
			return change ? { ...ref, item: change.after } : ref;
		});
		this.options.repaint();
	}

	private deleteSelection(): void {
		if (this.selection.length === 0) return;
		this.store.removeItems(this.selection);
		this.layer.clearSelection();
		this.options.repaint();
		this.refresh();
	}

	private duplicateSelection(): void {
		if (this.selection.length === 0) return;
		const copies = duplicateItems(this.selection, createStrokeId);
		const pageKey = this.selection[0]?.pageKey;
		if (pageKey === undefined) return;
		const added: ItemRef[] = copies.map((item, offset) => ({
			pageKey,
			index: this.store.itemsFor(pageKey).length + offset,
			item,
		}));
		// One operation, and the copies become the new selection.
		this.store.replaceItems([], added);
		this.selection = added;
		this.layer.refreshSelection();
		this.options.repaint();
	}

	private changeZ(direction: 'front' | 'back'): void {
		if (this.selection.length === 0) return;
		const pageKey = this.selection[0]?.pageKey;
		if (pageKey === undefined) return;
		const changes = zChanges(
			this.selection,
			this.store.itemsFor(pageKey),
			direction,
		);
		if (changes.length === 0) return;
		this.store.transformItems(changes);
		this.selection = changes.map((change, index) => ({
			pageKey: change.pageKey,
			index: this.selection[index]?.index ?? 0,
			item: change.after,
		}));
		this.options.repaint();
	}

	cancelActive(): void {
		this.textEditor.close(true);
		this.layer.cancelActive();
	}
}

