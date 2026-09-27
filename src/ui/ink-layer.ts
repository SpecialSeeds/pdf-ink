import type { Vec2 } from 'perfect-freehand';
import type { Component } from 'obsidian';
import {
	DEFAULT_PRESSURE,
	clientToCanvasPoint,
	normalizePressure,
	type RectLike,
} from '../core/coords';
import type { ItemRef } from '../core/history';
import { MultiTouchTap, type TapPoint } from '../core/multitouch-tap';
import { PenDoubleTap, isTap } from '../core/pen-double-tap';
import type { PageKey } from '../core/pages';
import type { Bounds } from '../core/hit-test';
import {
	type ItemHitShape,
	hitTestShape,
	itemHitShape,
} from '../core/hit-test';
import type { ItemStore } from '../core/ink-store';
import type {
	Box,
	Item,
	ShapeItem,
	Stroke,
	StrokeSample,
	TextItem,
} from '../core/items';
import {
	SizedEraseSession,
	radiusToPdf,
} from '../core/erase-session';
import {
	SELECT_TOLERANCE_PX,
	TAP_SLOP_PX,
	closeLoop,
	isTapGesture,
	selectByLasso,
	selectByPoint,
	selectionBounds,
} from '../core/lasso';
import { constrainShapeBox } from '../core/shapes';
import { textHeightFor } from '../core/text-layout';
import {
	IDENTITY_TRANSFORM,
	type SelectionTransform,
	isIdentity,
	mapPoint,
	transformItem,
} from '../core/transform';
import {
	FLAT_PRESSURE,
	createStroke,
	createStrokeId,
	type ToolPreset,
} from '../core/stroke';
import type {
	EraserMode,
	ShapeToolSettings,
	TextToolSettings,
	ToolKind,
} from '../core/tools';
import type { PageRecord } from '../types/view';
import { InkPainter, isDrawable } from './ink-painter';
import {
	type SelectionHandle,
	SelectionOverlay,
	type SelectionOverlayCallbacks,
} from './selection-overlay';

/**
 * Bit 5 of `PointerEvent.buttons`: the stylus eraser. Reported by an Apple
 * Pencil's eraser end and by tablet pens with an eraser tip, and it overrides
 * whichever tool is selected for as long as it is held.
 */
const ERASER_BUTTON = 32;

interface ActiveStroke {
	readonly pointerId: number;
	readonly record: PageRecord;
	readonly stroke: Stroke;
	/** The same samples in canvas CSS px, so the live stroke needs no reprojection. */
	readonly canvasSamples: StrokeSample[];
	readonly captureEl: HTMLElement;
	/** For spotting a tap: when it began, and where, in client px. */
	readonly startedAt: number;
	readonly startX: number;
	readonly startY: number;
	/** Furthest the tip has strayed from where it landed. */
	travelPx: number;
	readonly pointerType: string;
}

/** A committed stroke that might yet turn out to be half of a double tap. */
interface TapStroke {
	readonly pageKey: PageKey;
	readonly id: string;
}

interface ActiveErase {
	readonly pointerId: number;
	readonly record: PageRecord;
	/**
	 * Strokes hit so far. They stop being painted immediately for feedback, but
	 * are removed from the store as one undoable operation on release.
	 */
	readonly pending: Set<Item>;
	readonly captureEl: HTMLElement;
}

interface ActiveTextDrag {
	readonly pointerId: number;
	readonly record: PageRecord;
	readonly anchorX: number;
	readonly anchorY: number;
	current: [number, number];
	readonly captureEl: HTMLElement;
}

interface ActiveLasso {
	readonly pointerId: number;
	readonly record: PageRecord;
	/** The loop so far, in PDF space. */
	readonly points: Vec2[];
	/** The same points in canvas CSS px, for drawing the loop. */
	readonly canvasPoints: Vec2[];
	readonly captureEl: HTMLElement;
}

interface ActiveSelectionDrag {
	readonly pointerId: number;
	readonly record: PageRecord;
	readonly handle: SelectionHandle;
	/** Where the gesture began, in PDF space. */
	readonly startX: number;
	readonly startY: number;
	/** The selection's bounds when the gesture began. */
	readonly bounds: Bounds;
	readonly captureEl: HTMLElement;
	transform: SelectionTransform;
}

interface ActiveSizedErase {
	readonly pointerId: number;
	readonly record: PageRecord;
	readonly session: SizedEraseSession;
	readonly captureEl: HTMLElement;
	/** Surviving fragments, recomputed as the gesture proceeds. */
	preview: readonly Item[];
}

interface ActiveShape {
	readonly pointerId: number;
	readonly record: PageRecord;
	/** Drag anchor, in PDF user space. */
	readonly anchorX: number;
	readonly anchorY: number;
	readonly settings: ShapeToolSettings;
	/** The item being dragged out, updated in place as the pointer moves. */
	item: ShapeItem;
	readonly captureEl: HTMLElement;
}

export interface InkLayerOptions {
	resolveRecord(target: EventTarget | null): PageRecord | undefined;
	/** The selected tool. */
	tool(): ToolKind;
	/** Stroke settings for the selected freehand tool, or null otherwise. */
	preset(): ToolPreset | null;
	/** Colour, width and kind for the shape tool. */
	shape(): ShapeToolSettings;
	/** Colour, size and default width for the text tool. */
	text(): TextToolSettings;
	/** Open the editor on this box; it is not in the store yet if `isNew`. */
	editText(record: PageRecord, item: TextItem, isNew: boolean): void;
	/** Whether a text box is currently being edited. */
	isEditingText(): boolean;
	/** Commit and close the open editor. */
	stopEditingText(): void;
	/** Stroke-mode hit radius, in PDF points. */
	eraserRadius(): number;
	/** Which eraser behaviour the Pencil button and the tool both use. */
	eraserMode(): EraserMode;
	/** Sized-mode radius, in screen pixels. */
	eraserRadiusPx(): number;
	/** Whether touches stop drawing once a pen has been seen. */
	palmRejection(): boolean;
	/**
	 * A quick two-finger tap, nothing dragged.
	 *
	 * The stand-in for the Apple Pencil's own double-tap, which WKWebView does not
	 * expose to the page at all.
	 */
	multiTouchTap(fingers: number): void;
	/** Whether tapping the pen tip twice switches tool. */
	penDoubleTap(): boolean;
	/** The pen tip was tapped twice in one place. */
	penDoubleTapped(): void;
	/** Record an input event, when diagnostics are switched on. */
	traceInput(event: string, fields: Record<string, string | number | boolean>): void;
	/** Whether anything is listening, so nothing is formatted needlessly. */
	tracingInput(): boolean;
	/** Whether a stylus has ever been used here, remembered across tabs. */
	penSeen(): boolean;
	/** Record that a stylus has now been seen. */
	notePenSeen(): void;
	/** The live record for a page, for placing the selection box. */
	recordForPage(pageKey: PageKey): PageRecord | undefined;
	/** The current selection, owned by the controller. */
	selection(): readonly ItemRef[];
	/** Replace the selection, after a lasso or a commit. */
	setSelection(refs: readonly ItemRef[]): void;
	/** Commit the transform as one undoable operation. */
	commitTransform(t: SelectionTransform): void;
	deleteSelection(): void;
	duplicateSelection(): void;
	bringSelectionForward(): void;
	sendSelectionBack(): void;
}

/**
 * Pointer capture for drawing and erasing.
 *
 * Listeners are delegated onto the shared pages container rather than attached per
 * page, because page records are rebuilt on every file switch and per-canvas
 * listeners registered against the view's lifetime would pile up. Capture is taken
 * on the specific ink canvas the gesture started on, which keeps samples arriving
 * when a stroke runs off the edge of the page and still lets events bubble here.
 */
/**
 * Whether a touch was made by a stylus rather than a finger.
 *
 * `Touch.touchType` is WebKit's, and it is the only way to tell an Apple Pencil
 * from a finger *inside a touch event* — where the pointer type is not available
 * and the scroll still has to be refused. Guarded because no other engine sets it.
 */
function isStylusTouch(touch: Touch): boolean {
	return touch.touchType === 'stylus';
}

export class InkLayer {
	/**
	 * Palm rejection: once a pen has been seen, touches are for scrolling. A
	 * stylus normally hovers before it lands, so this usually flips before the
	 * palm reaches the glass — and the answer is remembered across tabs, because
	 * relearning it per view meant the first palm of every tab drew a blob.
	 */
	private penSeen = false;
	/**
	 * The pointer type that started the gesture in flight.
	 *
	 * Needed to tell a palm from a second finger: while a pen is drawing, another
	 * touch is a hand resting on the glass, not a pinch.
	 */
	private gesturePointerType: string | null = null;
	private readonly tap = new MultiTouchTap();
	private readonly penTap = new PenDoubleTap();
	/** The stroke the pending first tap left behind, to remove if a pair forms. */
	private pendingTapStroke: TapStroke | null = null;
	private active: ActiveStroke | null = null;
	private erasing: ActiveErase | null = null;
	private shaping: ActiveShape | null = null;
	private sizedErase: ActiveSizedErase | null = null;
	/** Follows the pointer at the eraser's true radius. */
	private cursorEl: HTMLElement | null = null;
	private lasso: ActiveLasso | null = null;
	private textDrag: ActiveTextDrag | null = null;
	private selectionDrag: ActiveSelectionDrag | null = null;
	private readonly overlay: SelectionOverlay;
	/** Last tap, for spotting a double tap on a text box. */
	private lastTap: { time: number; itemId: string } | null = null;
	private readonly painter: InkPainter;

	/**
	 * Erase-test shapes, in PDF space. Scale-independent, because item geometry
	 * and widths are both in PDF points, so these survive zooming.
	 */
	private readonly hitShapes = new WeakMap<Item, ItemHitShape>();

	constructor(
		private readonly component: Component,
		/** Carries the pen-seen class that switches touch-action. */
		private readonly rootEl: HTMLElement,
		private readonly pagesEl: HTMLElement,
		private readonly store: ItemStore,
		private readonly options: InkLayerOptions,
	) {
		this.painter = new InkPainter(store);
		const overlayCallbacks: SelectionOverlayCallbacks = {
			delete: () => {
				this.options.deleteSelection();
			},
			duplicate: () => {
				this.options.duplicateSelection();
			},
			bringForward: () => {
				this.options.bringSelectionForward();
			},
			sendBack: () => {
				this.options.sendSelectionBack();
			},
		};
		this.overlay = new SelectionOverlay(component, overlayCallbacks);
	}

	/** Re-place the selection box, after a zoom, a commit or a new selection. */
	refreshSelection(): void {
		const refs = this.options.selection();
		const bounds = selectionBounds(refs);
		const first = refs[0];
		if (!bounds || !first) {
			this.overlay.hide();
			return;
		}
		const record = this.recordForPage(first.pageKey);
		if (!record || !isDrawable(record)) {
			this.overlay.hide();
			return;
		}
		this.overlay.show(record, bounds);
	}

	clearSelection(): void {
		this.options.setSelection([]);
		this.overlay.hide();
	}

	attach(): void {
		// Armed from the start when a stylus has been used here before, so the first
		// palm of a new tab is rejected rather than teaching the view what a pen is.
		if (this.options.penSeen()) this.applyPenSeen();

		// passive: false — down/move/up all call preventDefault to stop the webview
		// turning a pen drag into a scroll or a text selection.
		this.component.registerDomEvent(
			this.pagesEl,
			'pointerdown',
			(evt) => {
				this.onPointerDown(evt);
			},
			{ passive: false },
		);
		this.component.registerDomEvent(
			this.pagesEl,
			'pointermove',
			(evt) => {
				this.onPointerMove(evt);
			},
			{ passive: false },
		);
		this.component.registerDomEvent(
			this.pagesEl,
			'pointerup',
			(evt) => {
				this.onPointerUp(evt);
			},
			{ passive: false },
		);
		this.component.registerDomEvent(this.pagesEl, 'pointercancel', (evt) => {
			this.onPointerCancel(evt);
		});
		// A pen hovering is enough to know a stylus is in use, before any contact.
		this.component.registerDomEvent(this.pagesEl, 'pointerenter', (evt) => {
			if (evt.pointerType === 'pen') this.markPenSeen();
		});
		// Belt and braces: some WebKit builds report an Apple Pencil as a touch
		// pointer, and the touch event is the one place that still says otherwise.
		this.component.registerDomEvent(this.pagesEl, 'touchstart', (evt) => {
			for (const touch of Array.from(evt.changedTouches)) {
				if (isStylusTouch(touch)) {
					this.markPenSeen();
					return;
				}
			}
		});
		/*
		 * The pencil must not scroll the page.
		 *
		 * `touch-action` cannot distinguish a stylus from a finger, so once a pen has
		 * been seen the ink canvas is set to `pan-x pan-y` to let fingers scroll —
		 * and on iPadOS the Pencil is a scrolling pointer too, so it panned the
		 * document instead of drawing, or scrolled away mid-stroke and left a dot.
		 *
		 * preventDefault on `pointerdown` does not stop that: WebKit decides
		 * scrolling from the touch event, so the refusal has to happen here. Only
		 * stylus touches are claimed, so fingers still scroll normally.
		 */
		this.component.registerDomEvent(
			this.pagesEl,
			'touchstart',
			(evt) => {
				/*
				 * A second finger is a pinch-zoom — unless a pen is drawing, in which
				 * case it is the hand resting on the page. Cancelling on it was what
				 * broke every stroke into a dot: a palm almost always reaches the
				 * glass while writing, and each landing abandoned the stroke.
				 */
				if (evt.touches.length >= 2 && !this.penIsDrawing) {
					this.cancelActive();
				}
				if (this.claimsTouch(evt)) evt.preventDefault();
			},
			{ passive: false },
		);
		this.component.registerDomEvent(
			this.pagesEl,
			'touchmove',
			(evt) => {
				// Refused on every move as well: a scroll that has not started yet can
				// still be started by a later move in the same gesture.
				if (this.claimsTouch(evt)) evt.preventDefault();
			},
			{ passive: false },
		);

		/*
		 * Tap detection listens on the whole scrolling area, not just the pages.
		 *
		 * A two-finger tap lands wherever the hand happens to be — in the margin
		 * beside the page as often as on it — and listeners confined to the pages
		 * container simply never saw those.
		 */
		const tapEl =
			this.rootEl.querySelector<HTMLElement>('.pdf-ink-scroll') ?? this.rootEl;
		this.component.registerDomEvent(tapEl, 'touchstart', (evt) => {
			this.trackTap(evt, 'start');
		});
		this.component.registerDomEvent(tapEl, 'touchmove', (evt) => {
			this.trackTap(evt, 'move');
		});
		this.component.registerDomEvent(tapEl, 'touchend', (evt) => {
			const outcome = this.tap.end(evt.touches.length, evt.timeStamp);
			if (this.options.tracingInput() && outcome.kind !== 'pending') {
				this.options.traceInput('tap', {
					outcome: outcome.kind,
					reason: outcome.kind === 'rejected' ? outcome.reason : '-',
					fingers: outcome.fingers,
					remaining: evt.touches.length,
				});
			}
			// One finger is an ordinary tap on the page; leave it alone.
			if (outcome.kind === 'tap' && outcome.fingers >= 2) {
				this.options.multiTouchTap(outcome.fingers);
			}
		});
		this.component.registerDomEvent(tapEl, 'touchcancel', () => {
			this.tap.cancel();
			this.options.traceInput('touchcancel', { note: 'tap abandoned' });
		});

		this.component.register(() => {
			this.cancelActive();
		});
	}

	/** Feed the tap recogniser, which only ever sees fingers. */
	private trackTap(evt: TouchEvent, phase: 'start' | 'move'): void {
		if (phase === 'start' && this.options.tracingInput()) {
			const first = evt.touches.item(0);
			this.options.traceInput('touchstart', {
				touches: evt.touches.length,
				kind: first?.touchType ?? 'unknown',
				penDrawing: this.penIsDrawing,
				target:
					evt.target instanceof Element ? evt.target.className : 'non-element',
			});
		}
		// A pen on the glass means the fingers are a resting hand, not a gesture.
		if (this.penIsDrawing) {
			this.tap.cancel();
			return;
		}
		const points: TapPoint[] = Array.from(evt.touches)
			.filter((touch) => !isStylusTouch(touch))
			.map((touch) => ({
				id: touch.identifier,
				x: touch.clientX,
				y: touch.clientY,
			}));
		if (points.length === 0) {
			this.tap.cancel();
			return;
		}
		if (phase === 'start') this.tap.start(points, evt.timeStamp);
		else this.tap.update(points, evt.timeStamp);
	}

	/** Repaint a page's ink. Called whenever its canvases were resized/cleared. */
	redraw(record: PageRecord): void {
		this.paint(record);
	}

	/** Abandon anything in progress without committing it. */
	cancelActive(): void {
		this.gesturePointerType = null;
		if (this.selectionDrag) this.finishSelectionDrag(false);
		if (this.lasso) {
			const lasso = this.lasso;
			this.lasso = null;
			this.releaseCapture(lasso.captureEl, lasso.pointerId);
			this.paint(lasso.record);
		}

		const sized = this.sizedErase;
		if (sized) {
			this.sizedErase = null;
			this.releaseCapture(sized.captureEl, sized.pointerId);
			this.paint(sized.record);
		}

		const shaping = this.shaping;
		if (shaping) {
			this.shaping = null;
			this.releaseCapture(shaping.captureEl, shaping.pointerId);
			this.paint(shaping.record);
		}

		const erasing = this.erasing;
		if (erasing) {
			this.erasing = null;
			this.releaseCapture(erasing.captureEl, erasing.pointerId);
			this.paint(erasing.record);
		}
		this.finishStroke(false);
	}

	/**
	 * Whether this touch belongs to us rather than to the scroller.
	 *
	 * A stylus touch is always ours: it is either drawing now or about to. A finger
	 * is only ours when it would draw, which is when palm rejection is off or no pen
	 * has been seen — and in that case `touch-action: none` has already refused the
	 * scroll, so there is nothing left to claim.
	 */
	private claimsTouch(evt: TouchEvent): boolean {
		for (const touch of Array.from(evt.changedTouches)) {
			if (isStylusTouch(touch)) return true;
		}
		// An in-flight gesture keeps its claim even if a later move reports nothing,
		// so a stroke cannot be scrolled out from under itself half way through.
		return this.hasActiveGesture && this.penSeen;
	}

	/**
	 * True while a pen gesture is in flight.
	 *
	 * Read through the live gesture rather than from the stored pointer type alone,
	 * so a stale value left over from a finished stroke cannot suppress a pinch.
	 */
	private get penIsDrawing(): boolean {
		return this.hasActiveGesture && this.gesturePointerType === 'pen';
	}

	/** True while any pointer gesture of ours is running. */
	private get hasActiveGesture(): boolean {
		return (
			this.active !== null ||
			this.erasing !== null ||
			this.shaping !== null ||
			this.sizedErase !== null ||
			this.lasso !== null ||
			this.selectionDrag !== null ||
			this.textDrag !== null
		);
	}

	/** A stylus has just been seen for the first time here. */
	private markPenSeen(): void {
		if (this.penSeen) return;
		this.applyPenSeen();
		this.options.notePenSeen();
	}

	private applyPenSeen(): void {
		this.penSeen = true;
		if (!this.options.palmRejection()) return;
		// Flips the ink canvas from `touch-action: none` to panning, so touches
		// scroll the document instead of drawing on it. The pencil is kept out of
		// that by refusing its touch events; see claimsTouch.
		this.rootEl.addClass('is-pen-seen');
	}

	/** The tool this event should use, honouring a stylus eraser button. */
	private toolFor(evt: PointerEvent): ToolKind {
		if ((evt.buttons & ERASER_BUTTON) !== 0) return 'eraser';
		return this.options.tool();
	}

	private beginSelectionDrag(evt: PointerEvent, handle: SelectionHandle): void {
		const bounds = selectionBounds(this.options.selection());
		const record = this.options.resolveRecord(evt.target);
		if (!bounds || !record || !isDrawable(record)) return;

		evt.preventDefault();
		const captureEl = record.inkCanvasEl;
		this.takeCapture(captureEl, evt.pointerId);
		const [startX, startY] = this.toPdf(
			evt,
			record,
			captureEl.getBoundingClientRect(),
		);
		this.selectionDrag = {
			pointerId: evt.pointerId,
			record,
			handle,
			startX,
			startY,
			bounds,
			captureEl,
			transform: IDENTITY_TRANSFORM,
		};
	}

	private onPointerDown(evt: PointerEvent): void {
		if (this.options.tracingInput()) {
			this.options.traceInput('pointerdown', {
				type: evt.pointerType,
				pressure: evt.pressure.toFixed(2),
				buttons: evt.buttons,
				penSeen: this.penSeen,
				palmRejection: this.options.palmRejection(),
			});
		}
		if (evt.pointerType === 'pen') this.markPenSeen();
		// Palm rejection: let the scroll container have this touch. Off means every
		// touch draws, which is what a device with no stylus wants.
		if (
			evt.pointerType === 'touch' &&
			this.penSeen &&
			this.options.palmRejection()
		) {
			return;
		}
		// Left button only; middle and right are for panning and context menus.
		if (evt.pointerType === 'mouse' && evt.button !== 0) return;
		// A second pointer mid-gesture is a palm or a pinch.
		if (
			this.active ||
			this.erasing ||
			this.shaping ||
			this.sizedErase ||
			this.lasso ||
			this.selectionDrag ||
			this.textDrag
		) {
			return;
		}

		/*
		 * A press anywhere off an open editor just dismisses it. Without this, the
		 * same press would also start a fresh text box, so clicking away from one
		 * box immediately created another.
		 *
		 * Presses on the textarea itself never reach here: the editor stops their
		 * propagation so the caret survives.
		 */
		if (this.options.isEditingText()) {
			this.options.stopEditingText();
			return;
		}

		// Anything on the selection box takes priority over starting a new gesture.
		if (this.overlay.containsTarget(evt.target)) {
			const handle = this.overlay.handleFor(evt.target);
			if (!handle) {
				// The context bar. Leave the selection alone so the button's click,
				// which arrives after pointerup, still has something to act on.
				return;
			}
			this.beginSelectionDrag(evt, handle);
			return;
		}



		const record = this.options.resolveRecord(evt.target);
		if (!record || !isDrawable(record)) return;

		evt.preventDefault();
		this.gesturePointerType = evt.pointerType;
		const captureEl = record.inkCanvasEl;
		this.takeCapture(captureEl, evt.pointerId);
		const rect = captureEl.getBoundingClientRect();
		const tool = this.toolFor(evt);

		if (tool === 'eraser' && this.options.eraserMode() === 'sized') {
			const session = new SizedEraseSession(this.sizedRadius(record));
			this.sizedErase = {
				pointerId: evt.pointerId,
				record,
				session,
				captureEl,
				preview: [],
			};
			this.sizedSample(evt, rect);
			return;
		}

		if (tool === 'eraser') {
			this.erasing = {
				pointerId: evt.pointerId,
				record,
				pending: new Set(),
				captureEl,
			};
			this.eraseAt(evt, rect);
			return;
		}

		// Double tap on an existing box opens it for editing, with either tool.
		if (tool === 'text' || tool === 'lasso') {
			const existing = this.textItemAt(record, evt, rect);
			if (existing && this.isDoubleTap(existing.id)) {
				evt.preventDefault();
				this.releaseCapture(captureEl, evt.pointerId);
				this.options.editText(record, existing, false);
				return;
			}
			if (existing) this.noteTap(existing.id);
		}

		if (tool === 'text') {
			evt.preventDefault();
			const [x, y] = this.toPdf(evt, record, rect);
			this.textDrag = {
				pointerId: evt.pointerId,
				record,
				anchorX: x,
				anchorY: y,
				current: [x, y],
				captureEl,
			};
			return;
		}

		if (tool === 'lasso') {
			const [x, y] = this.toPdf(evt, record, rect);
			const canvas = clientToCanvasPoint(
				rect,
				evt.clientX,
				evt.clientY,
				record.cssWidth,
				record.cssHeight,
			);
			this.lasso = {
				pointerId: evt.pointerId,
				record,
				points: [[x, y]],
				canvasPoints: [canvas],
				captureEl,
			};
			// Starting a new loop drops whatever was selected.
			this.clearSelection();
			this.paint(record);
			return;
		}

		if (tool === 'shape') {
			const settings = this.options.shape();
			const [anchorX, anchorY] = this.toPdf(evt, record, rect);
			this.shaping = {
				pointerId: evt.pointerId,
				record,
				anchorX,
				anchorY,
				settings,
				item: createShapeItem(settings, anchorX, anchorY),
				captureEl,
			};
			this.paint(record);
			return;
		}

		const preset = this.options.preset();
		if (!preset) return;
		this.active = {
			pointerId: evt.pointerId,
			record,
			stroke: createStroke(preset),
			canvasSamples: [],
			captureEl,
			startedAt: evt.timeStamp,
			startX: evt.clientX,
			startY: evt.clientY,
			travelPx: 0,
			pointerType: evt.pointerType,
		};
		this.addSample(evt, rect);
		this.paint(record);
	}

	private onPointerMove(evt: PointerEvent): void {
		if (evt.pointerType === 'pen') this.markPenSeen();
		this.updateCursor(evt);

		const drag = this.selectionDrag;
		if (drag && evt.pointerId === drag.pointerId) {
			evt.preventDefault();
			const rect = drag.record.inkCanvasEl.getBoundingClientRect();
			const [x, y] = this.toPdf(evt, drag.record, rect);
			drag.transform = selectionTransformFor(drag, x, y, evt.shiftKey);
			this.overlay.show(drag.record, transformBounds(drag.bounds, drag.transform));
			this.paint(drag.record);
			return;
		}

		const textDrag = this.textDrag;
		if (textDrag && evt.pointerId === textDrag.pointerId) {
			evt.preventDefault();
			const rect = textDrag.record.inkCanvasEl.getBoundingClientRect();
			textDrag.current = this.toPdf(evt, textDrag.record, rect);
			return;
		}

		const lasso = this.lasso;
		if (lasso && evt.pointerId === lasso.pointerId) {
			evt.preventDefault();
			const rect = lasso.record.inkCanvasEl.getBoundingClientRect();
			for (const sample of coalescedEvents(evt)) {
				const [x, y] = this.toPdf(sample, lasso.record, rect);
				lasso.points.push([x, y]);
				lasso.canvasPoints.push(
					clientToCanvasPoint(
						rect,
						sample.clientX,
						sample.clientY,
						lasso.record.cssWidth,
						lasso.record.cssHeight,
					),
				);
			}
			this.paint(lasso.record);
			return;
		}

		const sized = this.sizedErase;
		if (sized && evt.pointerId === sized.pointerId) {
			evt.preventDefault();
			const rect = sized.record.inkCanvasEl.getBoundingClientRect();
			// Every coalesced sample feeds the session, so a fast swipe is a
			// continuous path rather than a few disconnected discs.
			for (const sample of coalescedEvents(evt)) {
				this.sizedSample(sample, rect);
			}
			return;
		}

		const erasing = this.erasing;
		if (erasing && evt.pointerId === erasing.pointerId) {
			evt.preventDefault();
			const rect = erasing.record.inkCanvasEl.getBoundingClientRect();
			for (const sample of coalescedEvents(evt)) {
				this.eraseAt(sample, rect);
			}
			return;
		}

		const shaping = this.shaping;
		if (shaping && evt.pointerId === shaping.pointerId) {
			evt.preventDefault();
			const rect = shaping.record.inkCanvasEl.getBoundingClientRect();
			const [x, y] = this.toPdf(evt, shaping.record, rect);
			const raw: Box = {
				x: shaping.anchorX,
				y: shaping.anchorY,
				w: x - shaping.anchorX,
				h: y - shaping.anchorY,
			};
			// Shift is read per move, so holding it and moving re-applies the
			// constraint; the triangle's lock applies either way.
			shaping.item = {
				...shaping.item,
				box: constrainShapeBox(shaping.settings.kind, raw, evt.shiftKey),
			};
			this.paint(shaping.record);
			return;
		}

		const active = this.active;
		if (!active || evt.pointerId !== active.pointerId) return;
		evt.preventDefault();
		// One layout read per event rather than per coalesced sample.
		const rect = active.record.inkCanvasEl.getBoundingClientRect();
		for (const sample of coalescedEvents(evt)) {
			this.addSample(sample, rect);
		}
		this.paint(active.record);
	}

	private onPointerUp(evt: PointerEvent): void {
		if (this.selectionDrag?.pointerId === evt.pointerId) {
			evt.preventDefault();
			this.finishSelectionDrag(true);
			return;
		}

		if (this.textDrag?.pointerId === evt.pointerId) {
			evt.preventDefault();
			this.finishTextDrag();
			return;
		}

		if (this.lasso?.pointerId === evt.pointerId) {
			evt.preventDefault();
			this.finishLasso();
			return;
		}

		const sized = this.sizedErase;
		if (sized && evt.pointerId === sized.pointerId) {
			evt.preventDefault();
			this.finishSizedErase(true);
			return;
		}

		const erasing = this.erasing;
		if (erasing && evt.pointerId === erasing.pointerId) {
			evt.preventDefault();
			this.commitErase();
			return;
		}

		const shaping = this.shaping;
		if (shaping && evt.pointerId === shaping.pointerId) {
			evt.preventDefault();
			this.finishShape(true);
			return;
		}

		const active = this.active;
		if (!active || evt.pointerId !== active.pointerId) return;
		evt.preventDefault();
		this.addSample(evt, active.record.inkCanvasEl.getBoundingClientRect());
		this.finishStroke(true, evt.timeStamp);
	}

	private onPointerCancel(evt: PointerEvent): void {
		this.options.traceInput('pointercancel', {
			type: evt.pointerType,
			wasDrawing: this.hasActiveGesture,
		});
		if (this.selectionDrag?.pointerId === evt.pointerId) {
			this.finishSelectionDrag(false);
			return;
		}
		if (this.textDrag?.pointerId === evt.pointerId) {
			this.textDrag = null;
			return;
		}
		if (this.lasso?.pointerId === evt.pointerId) {
			this.finishLasso();
			return;
		}
		if (this.sizedErase?.pointerId === evt.pointerId) {
			// The fragments are already on screen, so committing is less surprising
			// than silently restoring what looked erased.
			this.finishSizedErase(true);
			return;
		}
		if (this.shaping?.pointerId === evt.pointerId) {
			this.finishShape(false);
			return;
		}
		if (this.erasing?.pointerId === evt.pointerId) {
			// The strokes are already hidden, so silently restoring them would be
			// more surprising than committing the erase.
			this.commitErase();
			return;
		}
		if (this.active?.pointerId === evt.pointerId) this.finishStroke(false);
	}

	private eraseAt(evt: PointerEvent, rect: RectLike): void {
		const erasing = this.erasing;
		if (!erasing) return;
		const { record } = erasing;

		const [cssX, cssY] = clientToCanvasPoint(
			rect,
			evt.clientX,
			evt.clientY,
			record.cssWidth,
			record.cssHeight,
		);
		const [pdfX, pdfY] = record.viewport.convertToPdfPoint(cssX, cssY);
		// The radius is in PDF points, matching the stored outlines.
		const radius = this.options.eraserRadius();

		let hitAny = false;
		for (const item of this.store.itemsFor(record.geom.key)) {
			if (erasing.pending.has(item)) continue;
			const shape = this.shapeFor(item);
			if (!shape) continue;
			if (hitTestShape(shape, pdfX, pdfY, radius)) {
				erasing.pending.add(item);
				hitAny = true;
			}
		}
		if (hitAny) this.paint(record);
	}

	private commitErase(): void {
		const erasing = this.erasing;
		if (!erasing) return;
		this.erasing = null;
		this.releaseCapture(erasing.captureEl, erasing.pointerId);

		if (erasing.pending.size > 0) {
			const pageKey = erasing.record.geom.key;
			const refs: ItemRef[] = [];
			// Indices are read before anything is removed, so undo can put every
			// item back exactly where it was.
			this.store.itemsFor(pageKey).forEach((item, index) => {
				if (erasing.pending.has(item)) {
					refs.push({ pageKey, index, item });
				}
			});
			// One operation for the whole gesture, so one undo restores it.
			this.store.removeItems(refs);
		}
		this.paint(erasing.record);
	}

	/** The topmost text box under the pointer, if any. */
	private textItemAt(
		record: PageRecord,
		evt: PointerEvent,
		rect: RectLike,
	): TextItem | null {
		const [x, y] = this.toPdf(evt, record, rect);
		const items = this.store.itemsFor(record.geom.key);
		// Reverse: the last drawn is the one on top.
		for (let i = items.length - 1; i >= 0; i--) {
			const item = items[i];
			if (!item || item.type !== 'text') continue;
			const left = Math.min(item.box.x, item.box.x + item.box.w);
			const right = Math.max(item.box.x, item.box.x + item.box.w);
			const bottom = Math.min(item.box.y, item.box.y + item.box.h);
			const top = Math.max(item.box.y, item.box.y + item.box.h);
			if (x >= left && x <= right && y >= bottom && y <= top) return item;
		}
		return null;
	}

	private isDoubleTap(itemId: string): boolean {
		const last = this.lastTap;
		const now = Date.now();
		const isDouble =
			last !== null && last.itemId === itemId && now - last.time <= DOUBLE_TAP_MS;
		if (isDouble) this.lastTap = null;
		return isDouble;
	}

	private noteTap(itemId: string): void {
		this.lastTap = { time: Date.now(), itemId };
	}

	private finishTextDrag(): void {
		const drag = this.textDrag;
		if (!drag) return;
		this.textDrag = null;
		this.releaseCapture(drag.captureEl, drag.pointerId);

		const settings = this.options.text();
		const [x, y] = drag.current;
		const dragged =
			Math.abs(x - drag.anchorX) > MIN_TEXT_DRAG ||
			Math.abs(y - drag.anchorY) > MIN_TEXT_DRAG;

		// A tap takes the default width and one line's height; a drag is sized.
		const width = dragged ? Math.abs(x - drag.anchorX) : settings.defaultWidth;
		const height = dragged
			? Math.abs(y - drag.anchorY)
			: textHeightFor(1, settings.fontSize);
		const left = dragged ? Math.min(drag.anchorX, x) : drag.anchorX;
		const top = dragged ? Math.max(drag.anchorY, y) : drag.anchorY;

		const item: TextItem = {
			type: 'text',
			id: createStrokeId(),
			color: settings.color,
			opacity: 1,
			rotation: 0,
			z: 0,
			updatedAt: Date.now(),
			// Stored with a positive height measured down from the tap point.
			box: { x: left, y: top - height, w: width, h: height },
			text: '',
			fontSize: settings.fontSize,
		};
		this.options.editText(drag.record, item, true);
	}

	private finishLasso(): void {
		const lasso = this.lasso;
		if (!lasso) return;
		this.lasso = null;
		this.releaseCapture(lasso.captureEl, lasso.pointerId);

		const pageKey = lasso.record.geom.key;
		const items = this.store.itemsFor(pageKey);
		const scale = lasso.record.viewport.scale;
		// Slop and tolerance are set in screen pixels, so both feel the same at
		// any zoom.
		const slop = scale > 0 ? TAP_SLOP_PX / scale : TAP_SLOP_PX;
		const tolerance =
			scale > 0 ? SELECT_TOLERANCE_PX / scale : SELECT_TOLERANCE_PX;

		let refs: ItemRef[] = [];
		const start = lasso.points[0];
		if (isTapGesture(lasso.points, slop) && start) {
			// A click picks the one item under the pointer; empty space deselects.
			const hit = selectByPoint(items, start[0], start[1], tolerance, pageKey);
			if (hit) refs = [hit];
		} else {
			refs = selectByLasso(items, closeLoop(lasso.points), pageKey);
		}

		this.options.setSelection(refs);
		this.refreshSelection();
		this.paint(lasso.record);
	}

	private finishSelectionDrag(commit: boolean): void {
		const drag = this.selectionDrag;
		if (!drag) return;
		this.selectionDrag = null;
		this.releaseCapture(drag.captureEl, drag.pointerId);

		if (commit && !isIdentity(drag.transform)) {
			// One transform operation for the whole gesture.
			this.options.commitTransform(drag.transform);
		}
		this.refreshSelection();
		this.paint(drag.record);
	}

	private recordForPage(pageKey: PageKey): PageRecord | undefined {
		return this.options.recordForPage(pageKey);
	}

	/** The eraser radius in PDF units, from its screen-pixel setting. */
	private sizedRadius(record: PageRecord): number {
		return radiusToPdf(this.options.eraserRadiusPx(), record.viewport.scale);
	}

	private sizedSample(evt: PointerEvent, rect: RectLike): void {
		const sized = this.sizedErase;
		if (!sized) return;
		const [x, y] = this.toPdf(evt, sized.record, rect);
		const pageKey = sized.record.geom.key;
		const candidates: ItemRef[] = this.store
			.itemsFor(pageKey)
			.map((item, index) => ({ pageKey, index, item }));

		if (!sized.session.sample(x, y, candidates)) return;
		sized.preview = sized.session.preview(createStrokeId);
		this.paint(sized.record);
	}

	private finishSizedErase(commit: boolean): void {
		const sized = this.sizedErase;
		if (!sized) return;
		this.sizedErase = null;
		this.releaseCapture(sized.captureEl, sized.pointerId);

		if (commit && !sized.session.isEmpty) {
			const { removed, added } = sized.session.commit(createStrokeId);
			// One operation for the whole gesture: one undo puts it all back.
			this.store.replaceItems(removed, added);
		}
		this.paint(sized.record);
	}

	/** Position and size the circle cursor at the eraser's true radius. */
	private updateCursor(evt: PointerEvent): void {
		const wanted =
			this.options.tool() === 'eraser' &&
			this.options.eraserMode() === 'sized';
		if (!wanted) {
			this.hideCursor();
			return;
		}
		const cursorEl = this.cursorEl ?? this.createCursor();
		const radius = this.options.eraserRadiusPx();
		const rect = this.pagesEl.getBoundingClientRect();
		cursorEl.setCssProps({
			'--pdf-ink-cursor-size': `${String(radius * 2)}px`,
			'--pdf-ink-cursor-x': `${String(evt.clientX - rect.left)}px`,
			'--pdf-ink-cursor-y': `${String(evt.clientY - rect.top)}px`,
		});
		cursorEl.removeClass('is-hidden');
	}

	private createCursor(): HTMLElement {
		const cursorEl = this.pagesEl.createDiv({ cls: 'pdf-ink-eraser-cursor' });
		this.cursorEl = cursorEl;
		this.component.register(() => {
			cursorEl.remove();
			this.cursorEl = null;
		});
		return cursorEl;
	}

	private hideCursor(): void {
		this.cursorEl?.addClass('is-hidden');
	}

	private finishShape(commit: boolean): void {
		const shaping = this.shaping;
		if (!shaping) return;
		this.shaping = null;
		this.releaseCapture(shaping.captureEl, shaping.pointerId);

		// A click with no drag would store an invisible zero-sized shape.
		const { box } = shaping.item;
		if (commit && !isDegenerate(box, shaping.settings.width)) {
			this.store.addItem(shaping.record.geom.key, shaping.item);
		}
		this.paint(shaping.record);
	}

	private toPdf(
		evt: PointerEvent,
		record: PageRecord,
		rect: RectLike,
	): [number, number] {
		const [cssX, cssY] = clientToCanvasPoint(
			rect,
			evt.clientX,
			evt.clientY,
			record.cssWidth,
			record.cssHeight,
		);
		return record.viewport.convertToPdfPoint(cssX, cssY);
	}

	private shapeFor(item: Item): ItemHitShape | null {
		const cached = this.hitShapes.get(item);
		if (cached) return cached;
		const shape = itemHitShape(item);
		if (shape) this.hitShapes.set(item, shape);
		return shape;
	}

	private finishStroke(commit: boolean, endedAt = 0): void {
		const active = this.active;
		if (!active) return;
		this.active = null;
		this.releaseCapture(active.captureEl, active.pointerId);

		if (commit && active.stroke.points.length > 0) {
			this.store.addItem(active.record.geom.key, active.stroke);
			this.considerPenTap(active, endedAt);
		} else if (!commit) {
			// An abandoned stroke is not a tap, and breaks a pending pair.
			this.penTap.reset();
			this.pendingTapStroke = null;
		}
		this.paint(active.record);
	}

	/**
	 * A stylus stroke has landed. If it was a tap, and the second of a pair, treat
	 * it as the gesture rather than as ink.
	 *
	 * The two dots the taps left are removed together, so switching tool does not
	 * also draw on the page. They are removed rather than withheld because holding
	 * a dot back until the pair could be ruled out would make every full stop
	 * appear a third of a second late.
	 */
	private considerPenTap(active: ActiveStroke, endedAt: number): void {
		if (!this.options.penDoubleTap()) return;
		if (active.pointerType !== 'pen') return;

		const pageKey = active.record.geom.key;
		const candidate = {
			x: active.startX,
			y: active.startY,
			at: endedAt,
			durationMs: endedAt - active.startedAt,
			travelPx: active.travelPx,
		};
		const previous = this.pendingTapStroke;
		const paired = this.penTap.register(candidate);

		if (this.options.tracingInput()) {
			this.options.traceInput('pen-tap', {
				isTap: isTap(candidate),
				durationMs: Math.round(candidate.durationMs),
				travelPx: Math.round(candidate.travelPx),
				paired,
			});
		}

		if (!paired) {
			// Remember it only while it is still a candidate first tap.
			this.pendingTapStroke = isTap(candidate)
				? { pageKey, id: active.stroke.id }
				: null;
			return;
		}

		this.pendingTapStroke = null;
		this.removeStrokes([
			...(previous ? [previous] : []),
			{ pageKey, id: active.stroke.id },
		]);
		this.options.penDoubleTapped();
	}

	/** Remove committed strokes by id, as one undoable step. */
	private removeStrokes(targets: readonly TapStroke[]): void {
		const refs: ItemRef[] = [];
		for (const target of targets) {
			const items = this.store.itemsFor(target.pageKey);
			const index = items.findIndex((item) => item.id === target.id);
			const item = items[index];
			if (index >= 0 && item) {
				refs.push({ pageKey: target.pageKey, index, item });
			}
		}
		if (refs.length > 0) this.store.removeItems(refs);
	}

	private takeCapture(el: HTMLElement, pointerId: number): void {
		try {
			el.setPointerCapture(pointerId);
		} catch {
			// The pointer can already be gone; carry on without capture rather
			// than dropping the gesture.
		}
	}

	private releaseCapture(el: HTMLElement, pointerId: number): void {
		if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
	}

	private addSample(evt: PointerEvent, rect: RectLike): void {
		const active = this.active;
		if (!active) return;
		const { record } = active;

		active.travelPx = Math.max(
			active.travelPx,
			Math.hypot(evt.clientX - active.startX, evt.clientY - active.startY),
		);

		const [cssX, cssY] = clientToCanvasPoint(
			rect,
			evt.clientX,
			evt.clientY,
			record.cssWidth,
			record.cssHeight,
		);
		// A highlighter is a flat chisel: its width must not track pressure.
		const previous = active.stroke.points[active.stroke.points.length - 1];
		const pressure =
			active.stroke.tool === 'highlighter'
				? FLAT_PRESSURE
				: normalizePressure(
						evt.pressure,
						evt.pointerType,
						// A dropout mid-stroke continues at the last known pressure
						// rather than jumping to the default and beading the line.
						previous?.[2] ?? DEFAULT_PRESSURE,
					);

		active.canvasSamples.push([cssX, cssY, pressure]);
		// Stored in PDF user space, so the stroke is independent of zoom, device
		// pixel ratio and page rotation.
		const [pdfX, pdfY] = record.viewport.convertToPdfPoint(cssX, cssY);
		active.stroke.points.push([pdfX, pdfY, pressure]);
	}

	private paint(record: PageRecord): void {
		const active = this.active;
		const shaping = this.shaping;
		const live =
			active && active.record === record
				? { item: active.stroke, samples: active.canvasSamples }
				: shaping && shaping.record === record
					? { item: shaping.item }
					: null;

		let hidden: ReadonlySet<Item> | null =
			this.erasing?.record === record ? this.erasing.pending : null;
		let previewOnThisPage: readonly Item[] | undefined;

		const sized = this.sizedErase;
		if (sized && sized.record === record) {
			// Items the sized erase has bitten into are hidden; their survivors are
			// drawn from the preview instead.
			hidden = hiddenItems(this.store.itemsFor(record.geom.key), sized.session);
			previewOnThisPage = sized.preview;
		}

		const drag = this.selectionDrag;
		if (drag && drag.record === record && !isIdentity(drag.transform)) {
			// The selection is previewed transformed, with the originals hidden,
			// until the gesture commits.
			const refs = this.options.selection();
			hidden = new Set(refs.map((ref) => ref.item));
			previewOnThisPage = refs.map((ref) =>
				transformItem(ref.item, drag.transform),
			);
		}

		this.painter.paint(record, live, hidden, previewOnThisPage);

		const lasso = this.lasso;
		if (lasso && lasso.record === record) {
			this.painter.paintLasso(record, lasso.canvasPoints);
		}
	}
}

/** Items the session has started erasing, which the cached layer must skip. */
function hiddenItems(
	items: readonly Item[],
	session: SizedEraseSession,
): ReadonlySet<Item> {
	const ids = session.hitIds();
	const hidden = new Set<Item>();
	for (const item of items) {
		if (ids.has(item.id)) hidden.add(item);
	}
	return hidden;
}

/** How long two taps can be apart and still count as a double tap. */
const DOUBLE_TAP_MS = 400;

/** Below this, a text gesture is a tap rather than a drag, in PDF points. */
const MIN_TEXT_DRAG = 4;

/** The transform a drag of `handle` implies, given where the pointer now is. */
function selectionTransformFor(
	drag: ActiveSelectionDrag,
	x: number,
	y: number,
	shift: boolean,
): SelectionTransform {
	const { bounds, handle, startX, startY } = drag;
	const centreX = (bounds.minX + bounds.maxX) / 2;
	const centreY = (bounds.minY + bounds.maxY) / 2;

	if (handle === 'body') {
		return { ...IDENTITY_TRANSFORM, dx: x - startX, dy: y - startY };
	}

	if (handle === 'rotate') {
		const before = Math.atan2(startY - centreY, startX - centreX);
		const after = Math.atan2(y - centreY, x - centreX);
		// Clockwise degrees, matching ItemBase.rotation.
		let degrees = ((before - after) * 180) / Math.PI;
		// Shift snaps to 15 degrees, as the shape tools do.
		if (shift) degrees = Math.round(degrees / 15) * 15;
		return { ...IDENTITY_TRANSFORM, pivotX: centreX, pivotY: centreY, degrees };
	}

	// A corner scales about the opposite corner, so that corner stays put.
	const pivotX = handle === 'nw' || handle === 'sw' ? bounds.maxX : bounds.minX;
	const pivotY = handle === 'nw' || handle === 'ne' ? bounds.minY : bounds.maxY;
	const fromX = startX - pivotX;
	const fromY = startY - pivotY;
	let sx = Math.abs(fromX) < 1e-6 ? 1 : (x - pivotX) / fromX;
	let sy = Math.abs(fromY) < 1e-6 ? 1 : (y - pivotY) / fromY;
	if (shift) {
		// Uniform scale keeps the selection's proportions.
		const uniform = (Math.abs(sx) + Math.abs(sy)) / 2;
		sx = Math.sign(sx || 1) * uniform;
		sy = Math.sign(sy || 1) * uniform;
	}
	return { ...IDENTITY_TRANSFORM, pivotX, pivotY, sx, sy };
}

/** Where the selection box lands under a preview transform. */
function transformBounds(bounds: Bounds, t: SelectionTransform): Bounds {
	const corners: Vec2[] = [
		[bounds.minX, bounds.minY],
		[bounds.maxX, bounds.minY],
		[bounds.maxX, bounds.maxY],
		[bounds.minX, bounds.maxY],
	];
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const [cx, cy] of corners) {
		const [x, y] = mapPoint(cx, cy, t);
		minX = Math.min(minX, x);
		minY = Math.min(minY, y);
		maxX = Math.max(maxX, x);
		maxY = Math.max(maxY, y);
	}
	return { minX, minY, maxX, maxY };
}

function createShapeItem(
	settings: ShapeToolSettings,
	x: number,
	y: number,
): ShapeItem {
	return {
		type: 'shape',
		id: createStrokeId(),
		kind: settings.kind,
		color: settings.color,
		opacity: 1,
		rotation: 0,
		// z is assigned by the store when the item is added.
		z: 0,
		updatedAt: Date.now(),
		box: { x, y, w: 0, h: 0 },
		width: settings.width,
		fill: null,
	};
}

/** Too small to see, and so not worth storing. */
function isDegenerate(box: Box, width: number): boolean {
	const minimum = Math.max(width, 1);
	return Math.abs(box.w) < minimum && Math.abs(box.h) < minimum;
}

/**
 * Every sample the browser merged into this frame's event.
 *
 * A 240 Hz pen produces far more samples than there are frames; without this the
 * stroke is built from one point per frame and looks faceted.
 */
function coalescedEvents(evt: PointerEvent): PointerEvent[] {
	if (typeof evt.getCoalescedEvents === 'function') {
		const events = evt.getCoalescedEvents();
		if (events.length > 0) return events;
	}
	return [evt];
}
