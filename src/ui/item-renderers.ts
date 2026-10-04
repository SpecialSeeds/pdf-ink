import type { PointConverter } from '../core/coords';
import {
	type Item,
	type ItemType,
	type ShapeItem,
	type Stroke,
	type StrokeSample,
	type TextItem,
} from '../core/items';
import { type PathSegment, shapeGeometry } from '../core/shapes';
import { layoutTextLines } from '../core/text-layout';
import { type PageTheme, renderColor } from '../core/theme';
import {
	outlineToPathData,
	strokeOutline,
	toCanvasSamples,
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

const renderStroke: ItemRenderer<Stroke> = (stroke, target) => {
	paintStrokeOutline(
		stroke,
		toCanvasSamples(stroke, target.viewport),
		target,
		true,
	);
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
};

export function rendererFor(item: Item): ItemRenderer | undefined {
	return ITEM_RENDERERS[item.type];
}
