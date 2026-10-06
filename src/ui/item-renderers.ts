import type { PointConverter } from '../core/coords';
import {
	type Item,
	type ItemType,
	type PathItem,
	type ShapeItem,
	type Stroke,
	type StrokeSample,
	type TextItem,
} from '../core/items';
import { pathGeometry } from '../core/path';
import { type PathSegment, shapeGeometry } from '../core/shapes';
import { layoutTextLines } from '../core/text-layout';
import { type PageTheme, renderColor } from '../core/theme';
import type { Vec2 } from 'perfect-freehand';
import {
	MIN_VISIBLE_STROKE_CSS,
	outlineToPathData,
	strokeOutline,
	strokeOutlinePdf,
} from '../core/stroke';

/** Everything a renderer needs to put one item on a canvas. */
export interface RenderTarget {
	readonly ctx: CanvasRenderingContext2D;
	/** PDF user space to canvas CSS pixels. */
	readonly viewport: PointConverter;
	/** CSS pixels per PDF point. */
	readonly scale: number;
	/** The page's theme: base ink renders in its colour. Stored colours are untouched. */
	readonly theme: PageTheme;
}

/**
 * Draws one item. Registered per item type so a new tool only has to supply a
 * function here, rather than touch the painter's page loop.
 */
export type ItemRenderer<T extends Item = Item> = (
	item: T,
	target: RenderTarget,
) => void;

/** Which canvas an item belongs on. Highlighter ink is multiplied; ink is opaque. */
export type LayerName = 'highlight' | 'ink';

export function layerFor(item: Item): LayerName {
	if (item.type === 'path') return item.highlight === true ? 'highlight' : 'ink';
	return item.type === 'stroke' && item.tool === 'highlighter'
		? 'highlight'
		: 'ink';
}

function paintStrokeOutline(
	stroke: Stroke,
	samples: readonly StrokeSample[],
	target: RenderTarget,
	complete: boolean,
): void {
	// Nib width is stored in PDF points, so it scales with the page.
	const outline = strokeOutline(
		samples,
		stroke.width * target.scale,
		complete,
		stroke.tool,
		// Ends cut by the eraser are blunt, not tapered.
		{ start: stroke.cutStart, end: stroke.cutEnd },
	);
	if (outline.length === 0) return;

	const path = new Path2D(outlineToPathData(outline));
	const { ctx } = target;
	ctx.save();
	ctx.globalAlpha = stroke.opacity;
	ctx.fillStyle = renderColor(stroke.color, target.theme);
	ctx.fill(path);
	ctx.restore();
}

/**
 * Each committed stroke's outline as a canvas path in PDF space, built once.
 *
 * Working the outline out again on every repaint is what used to make each
 * new stroke stall the page: a full page of handwriting is over a thousand
 * outlines. Built once, a stroke is redrawn at any zoom through the viewport's
 * transform, as path items are. Rebuilt only when the screen's minimum width
 * is what sets the stroke's width, which depends on the zoom.
 */
const strokePaths = new WeakMap<Stroke, { readonly floor: string; readonly path: Path2D }>();

function strokePath(stroke: Stroke, scale: number): Path2D {
	const minWidth = scale > 0 ? MIN_VISIBLE_STROKE_CSS / scale : 0;
	const floor = stroke.width < minWidth ? minWidth.toFixed(4) : 'nib';
	const cached = strokePaths.get(stroke);
	if (cached && cached.floor === floor) return cached.path;
	const path = outlinePath(strokeOutlinePdf(stroke, minWidth));
	strokePaths.set(stroke, { floor, path });
	return path;
}

/** A closed outline as a canvas path, smoothed as {@link outlineToPathData} smooths it. */
function outlinePath(outline: readonly Vec2[]): Path2D {
	const path = new Path2D();
	const first = outline[0];
	if (!first) return path;
	path.moveTo(first[0], first[1]);
	// A single tap still has to leave a mark.
	if (outline.length === 1) path.lineTo(first[0] + 0.01, first[1]);
	for (let i = 0; i < outline.length; i++) {
		const a = outline[i];
		const b = outline[(i + 1) % outline.length];
		if (!a || !b) continue;
		path.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
	}
	path.closePath();
	return path;
}

const renderStroke: ItemRenderer<Stroke> = (stroke, target) => {
	const path = strokePath(stroke, target.scale);
	const { ctx } = target;
	ctx.save();
	ctx.transform(...viewportMatrix(target.viewport));
	ctx.globalAlpha = stroke.opacity;
	ctx.fillStyle = renderColor(stroke.color, target.theme);
	ctx.fill(path);
	ctx.restore();
};

/**
 * The in-progress stroke, drawn from canvas-space samples captured this gesture
 * rather than reprojected from PDF space, and told it is not finished so
 * perfect-freehand does not close its tail.
 */
export function renderLiveStroke(
	stroke: Stroke,
	samples: readonly StrokeSample[],
	target: RenderTarget,
): void {
	paintStrokeOutline(stroke, samples, target, false);
}

/**
 * Build a canvas path from PDF-space commands.
 *
 * Every point goes through the viewport, so a shape is described once in PDF space
 * and drawn correctly at any zoom, on any page rotation.
 */
function buildPath(segment: PathSegment, target: RenderTarget): Path2D {
	const path = new Path2D();
	for (const command of segment.commands) {
		if (command.op === 'close') {
			path.closePath();
			continue;
		}
		const [x, y] = target.viewport.convertToViewportPoint(command.x, command.y);
		if (command.op === 'move') {
			path.moveTo(x, y);
		} else if (command.op === 'line') {
			path.lineTo(x, y);
		} else {
			const [x1, y1] = target.viewport.convertToViewportPoint(
				command.x1,
				command.y1,
			);
			const [x2, y2] = target.viewport.convertToViewportPoint(
				command.x2,
				command.y2,
			);
			path.bezierCurveTo(x1, y1, x2, y2, x, y);
		}
	}
	return path;
}

const renderShape: ItemRenderer<ShapeItem> = (shape, target) => {
	const { ctx, scale, theme } = target;
	const geometry = shapeGeometry(shape.kind, shape.box, shape.width);
	const color = renderColor(shape.color, theme);

	for (const segment of geometry.segments) {
		const path = buildPath(segment, target);
		ctx.save();
		ctx.globalAlpha = shape.opacity;

		if (segment.fill === true) {
			// Arrowheads are solid in the outline colour.
			ctx.fillStyle = color;
			ctx.fill(path);
		} else {
			if (shape.fill !== null) {
				ctx.fillStyle = renderColor(shape.fill, theme);
				ctx.fill(path);
			}
			ctx.strokeStyle = color;
			// Width is in PDF points, so it scales with the page.
			ctx.lineWidth = Math.max(0.5, shape.width * scale);
			ctx.lineJoin = 'round';
			ctx.lineCap = 'round';
			if (segment.dash) {
				ctx.setLineDash(segment.dash.map((length) => length * scale));
			}
			ctx.stroke(path);
		}
		ctx.restore();
	}
};

/**
 * A path's canvas path in PDF space, built once per item.
 *
 * Imported handwriting runs to hundreds of thousands of points, so rather than
 * send every point through the viewport on each paint, the path is built in PDF
 * space and drawn under the viewport's own affine transform.
 */
const pathCache = new WeakMap<PathItem, Path2D>();

function pdfSpacePath(item: PathItem): Path2D {
	const cached = pathCache.get(item);
	if (cached) return cached;
	const path = new Path2D();
	for (const segment of pathGeometry(item).segments) {
		for (const command of segment.commands) {
			if (command.op === 'move') path.moveTo(command.x, command.y);
			else if (command.op === 'line') path.lineTo(command.x, command.y);
			else if (command.op === 'cubic') {
				path.bezierCurveTo(command.x1, command.y1, command.x2, command.y2, command.x, command.y);
			} else path.closePath();
		}
	}
	pathCache.set(item, path);
	return path;
}

/** The viewport as an affine matrix, probed from three points. */
function viewportMatrix(viewport: PointConverter): [number, number, number, number, number, number] {
	const [e, f] = viewport.convertToViewportPoint(0, 0);
	const [ax, ay] = viewport.convertToViewportPoint(1, 0);
	const [cx, cy] = viewport.convertToViewportPoint(0, 1);
	return [ax - e, ay - f, cx - e, cy - f, e, f];
}

const renderPath: ItemRenderer<PathItem> = (item, target) => {
	const { ctx } = target;
	const path = pdfSpacePath(item);
	const color = renderColor(item.color, target.theme);
	ctx.save();
	ctx.transform(...viewportMatrix(target.viewport));
	ctx.globalAlpha = item.opacity;
	if (item.strokeWidth === undefined) {
		ctx.fillStyle = color;
		ctx.fill(path);
	} else {
		// In PDF points: the context is in PDF space here.
		ctx.strokeStyle = color;
		ctx.lineWidth = item.strokeWidth;
		ctx.lineJoin = 'round';
		ctx.lineCap = 'round';
		ctx.stroke(path);
	}
	ctx.restore();
};

/**
 * The font the on-screen renderer measures and draws with.
 *
 * It must be the same family the exporter embeds, or the two would wrap
 * differently. Obsidian has no Noto Sans, so this falls back through close
 * metric matches — see the export notes for the consequence.
 */
export const TEXT_FONT_STACK =
	"'Noto Sans', 'Inter', 'Helvetica Neue', Arial, sans-serif";

const renderText: ItemRenderer<TextItem> = (item, target) => {
	const { ctx, scale } = target;
	const fontPx = item.fontSize * scale;
	ctx.save();
	ctx.font = `${String(fontPx)}px ${TEXT_FONT_STACK}`;
	ctx.textBaseline = 'alphabetic';
	ctx.globalAlpha = item.opacity;
	ctx.fillStyle = renderColor(item.color, target.theme);

	// Measure in PDF points, so wrapping is zoom-independent and matches export.
	const lines = layoutTextLines(item.text, item.box, item.fontSize, (text) =>
		scale > 0 ? ctx.measureText(text).width / scale : 0,
	);

	if (item.rotation !== 0) {
		const [cx, cy] = target.viewport.convertToViewportPoint(
			item.box.x + item.box.w / 2,
			item.box.y + item.box.h / 2,
		);
		ctx.translate(cx, cy);
		// Canvas y grows downward, so a positive angle already reads clockwise.
		ctx.rotate((item.rotation * Math.PI) / 180);
		ctx.translate(-cx, -cy);
	}

	for (const line of lines) {
		if (line.text.length === 0) continue;
		const [x, y] = target.viewport.convertToViewportPoint(line.x, line.y);
		ctx.fillText(line.text, x, y);
	}
	ctx.restore();
};

/**
 * Per-type renderers.
 *
/** Every item type has a renderer. */
export const ITEM_RENDERERS: Partial<Record<ItemType, ItemRenderer>> = {
	stroke: renderStroke as ItemRenderer,
	shape: renderShape as ItemRenderer,
	text: renderText as ItemRenderer,
	path: renderPath as ItemRenderer,
};

export function rendererFor(item: Item): ItemRenderer | undefined {
	return ITEM_RENDERERS[item.type];
}
