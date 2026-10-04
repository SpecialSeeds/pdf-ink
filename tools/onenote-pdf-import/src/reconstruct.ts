/**
 * Turning an extracted OneNote export back into the note's one canvas, in points.
 *
 * Two export formats exist:
 *
 * - iOS: one page holding the whole canvas, unsliced.
 * - Mac: the canvas sliced into Letter pages. Every page holds nearly all of the
 *   note's ink, shifted so that its own slice falls in a clip window, so the
 *   canvas is recovered by finding each page's shift and dropping the copies.
 *
 * Both draw in CSS pixels at OneNote's own scale (a 20 pt title is 26.67 units),
 * and the Mac export additionally scales the whole canvas down to fit the page.
 * The scale is read from the transform the export puts on its text, and undone,
 * so the canvas comes out in points at the size the note really has.
 */

import type { Bounds } from '../../../src/core/hit-test';
import type { PathCommand } from '../../../src/core/shapes';
import type { RawPage, RawPath, RawText } from './extract';

/** CSS pixels to points. */
export const PX_TO_PT = 0.75;

export const LETTER = { width: 612, height: 792 };

export type ExportFormat = 'ios' | 'mac';

/**
 * Said for every Mac export imported. Compared with an iPad export of the same
 * note, the Mac one leaves strokes out entirely, so it is the worse source.
 */
export const MAC_EXPORT_WARNING = 'Mac OneNote exports can drop ink; prefer iPad exports.';

/** The note's canvas, in points, origin at its bottom-left corner. */
export interface Canvas {
	readonly format: ExportFormat;
	readonly width: number;
	readonly height: number;
	readonly paths: RawPath[];
	readonly texts: RawText[];
	/** Pages in the export that held anything. */
	readonly contentPages: number;
	/** Each content page's shift onto the first, in export units (Mac only). */
	readonly offsets: [number, number][];
	/** Copies of a path or text run dropped as duplicates (Mac only). */
	readonly duplicates: number;
	/** Export units to points, x and y. */
	readonly scale: [number, number];
	/** Anything worth telling the user. */
	readonly warnings: string[];
}

/** A Mac export: more than one page, every one of them Letter. */
export function isSlicedExport(pages: readonly RawPage[]): boolean {
	return (
		pages.length > 1 &&
		pages.every(
			(page) =>
				Math.abs(page.width - LETTER.width) < 1 && Math.abs(page.height - LETTER.height) < 1,
		)
	);
}

export function reconstructCanvas(pages: readonly RawPage[]): Canvas {
	return isSlicedExport(pages) ? reconstructMac(pages) : reconstructIos(pages);
}

/** Every point of a path, control points included, flattened as x, y, x, y… */
export function pathNumbers(commands: readonly PathCommand[]): number[] {
	const out: number[] = [];
	for (const c of commands) {
		if (c.op === 'close') continue;
		if (c.op === 'cubic') out.push(c.x1, c.y1, c.x2, c.y2);
		out.push(c.x, c.y);
	}
	return out;
}

function shapeKey(path: RawPath): string {
	return `${path.paint}|${path.color}|${path.commands.map((c) => c.op[0]).join('')}`;
}

/** Shape key plus geometry relative to the first point, for finding a shift. */
function relativeSignature(path: RawPath): string {
	const n = pathNumbers(path.commands);
	const x0 = n[0] ?? 0;
	const y0 = n[1] ?? 0;
	const rel: string[] = [];
	for (let i = 0; i < n.length; i += 2) {
		rel.push(`${((n[i] ?? 0) - x0).toFixed(2)},${((n[i + 1] ?? 0) - y0).toFixed(2)}`);
	}
	return `${shapeKey(path)}|${rel.join(' ')}`;
}

function translatePath(path: RawPath, dx: number, dy: number): RawPath {
	const move = (b: Bounds): Bounds => ({
		minX: b.minX + dx,
		minY: b.minY + dy,
		maxX: b.maxX + dx,
		maxY: b.maxY + dy,
	});
	return {
		...path,
		commands: path.commands.map((c): PathCommand => {
			if (c.op === 'close') return c;
			if (c.op === 'cubic') {
				return { op: 'cubic', x1: c.x1 + dx, y1: c.y1 + dy, x2: c.x2 + dx, y2: c.y2 + dy, x: c.x + dx, y: c.y + dy };
			}
			return { op: c.op, x: c.x + dx, y: c.y + dy };
		}),
		bounds: move(path.bounds),
		clip: path.clip ? move(path.clip) : null,
	};
}

/**
 * A page's background: a white fill over (nearly) the whole page. OneNote paints
 * one under its iOS canvas; it is paper, not ink.
 */
function isBackground(path: RawPath, page: RawPage): boolean {
	if (path.paint !== 'fill' || path.color.toLowerCase() !== '#ffffff') return false;
	const b = path.bounds;
	return (b.maxX - b.minX) * (b.maxY - b.minY) >= 0.95 * page.width * page.height;
}

/** Export units to points, from the scale on the export's text. */
function unitScale(texts: readonly RawText[], warnings: string[]): [number, number] {
	const first = texts[0];
	if (!first) {
		warnings.push('no typed text to read the export scale from; assuming none');
		return [PX_TO_PT, PX_TO_PT];
	}
	return [PX_TO_PT / first.ctmScale[0], PX_TO_PT / first.ctmScale[1]];
}

function union(a: Bounds | null, b: Bounds): Bounds {
	if (!a) return b;
	return {
		minX: Math.min(a.minX, b.minX),
		minY: Math.min(a.minY, b.minY),
		maxX: Math.max(a.maxX, b.maxX),
		maxY: Math.max(a.maxY, b.maxY),
	};
}

/** Shift the canvas to the origin and convert it to points. */
function finish(
	format: ExportFormat,
	frame: Bounds,
	paths: RawPath[],
	texts: RawText[],
	scale: [number, number],
	rest: Pick<Canvas, 'contentPages' | 'offsets' | 'duplicates' | 'warnings'>,
): Canvas {
	const [sx, sy] = scale;
	const mx = (x: number): number => (x - frame.minX) * sx;
	const my = (y: number): number => (y - frame.minY) * sy;
	const widthScale = Math.sqrt(sx * sy);
	const mapBounds = (b: Bounds): Bounds => ({ minX: mx(b.minX), minY: my(b.minY), maxX: mx(b.maxX), maxY: my(b.maxY) });
	return {
		format,
		width: (frame.maxX - frame.minX) * sx,
		height: (frame.maxY - frame.minY) * sy,
		paths: paths.map((p) => ({
			...p,
			commands: p.commands.map((c): PathCommand => {
				if (c.op === 'close') return c;
				if (c.op === 'cubic') {
					return { op: 'cubic', x1: mx(c.x1), y1: my(c.y1), x2: mx(c.x2), y2: my(c.y2), x: mx(c.x), y: my(c.y) };
				}
				return { op: c.op, x: mx(c.x), y: my(c.y) };
			}),
			lineWidth: p.lineWidth * widthScale,
			bounds: mapBounds(p.bounds),
			clip: p.clip ? mapBounds(p.clip) : null,
		})),
		texts: texts.map((t) => ({
			...t,
			x: mx(t.x),
			y: my(t.y),
			fontSize: t.fontSize * sy,
			width: t.width * sx,
			ctmScale: [1, 1],
		})),
		scale,
		...rest,
	};
}

function reconstructIos(pages: readonly RawPage[]): Canvas {
	const warnings: string[] = [];
	const page = pages[0];
	if (!page) {
		return { format: 'ios', width: 0, height: 0, paths: [], texts: [], contentPages: 0, offsets: [], duplicates: 0, scale: [1, 1], warnings: ['the PDF has no pages'] };
	}
	if (pages.length > 1) warnings.push(`${String(pages.length)} pages that are not Letter; importing the first only`);
	const paths = page.paths.filter((p) => !isBackground(p, page));
	let frame: Bounds = { minX: 0, minY: 0, maxX: page.width, maxY: page.height };
	for (const p of paths) frame = union(frame, p.bounds);
	return finish('ios', frame, paths, page.texts, unitScale(page.texts, warnings), {
		contentPages: 1,
		offsets: [[0, 0]],
		duplicates: 0,
		warnings,
	});
}

/** The most common clip among a page's ink: its slice window. */
function sliceWindow(page: RawPage): Bounds | null {
	const counts = new Map<string, { clip: Bounds; n: number }>();
	for (const p of page.paths) {
		if (!p.clip) continue;
		const key = [p.clip.minX, p.clip.minY, p.clip.maxX, p.clip.maxY].map((v) => v.toFixed(2)).join(',');
		const entry = counts.get(key) ?? { clip: p.clip, n: 0 };
		entry.n += 1;
		counts.set(key, entry);
	}
	let best: { clip: Bounds; n: number } | null = null;
	for (const entry of counts.values()) if (!best || entry.n > best.n) best = entry;
	return best?.clip ?? null;
}

/** Tolerance for two paths being the same after translation, in export units. */
const SAME_GEOMETRY = 0.02;

function sameGeometry(a: RawPath, b: RawPath): boolean {
	if (shapeKey(a) !== shapeKey(b)) return false;
	const na = pathNumbers(a.commands);
	const nb = pathNumbers(b.commands);
	if (na.length !== nb.length) return false;
	for (let i = 0; i < na.length; i++) {
		if (Math.abs((na[i] ?? 0) - (nb[i] ?? 0)) > SAME_GEOMETRY) return false;
	}
	return true;
}

/** Buckets by shape and coarse start point, so duplicates are found in O(n). */
class PathIndex {
	private readonly buckets = new Map<string, RawPath[]>();

	private static key(path: RawPath, dx = 0, dy = 0): string {
		const n = pathNumbers(path.commands);
		const cell = (v: number): number => Math.round(v / 0.5);
		return `${shapeKey(path)}|${String(cell((n[0] ?? 0) + dx))},${String(cell((n[1] ?? 0) + dy))}`;
	}

	add(path: RawPath): void {
		const key = PathIndex.key(path);
		const list = this.buckets.get(key) ?? [];
		list.push(path);
		this.buckets.set(key, list);
	}

	/** Whether an identical path is already present. Checks neighbouring cells too. */
	has(path: RawPath): boolean {
		for (const dx of [-0.5, 0, 0.5]) {
			for (const dy of [-0.5, 0, 0.5]) {
				const list = this.buckets.get(PathIndex.key(path, dx, dy));
				if (list?.some((other) => sameGeometry(other, path))) return true;
			}
		}
		return false;
	}
}

function sameText(a: RawText, b: RawText): boolean {
	return (
		a.text === b.text &&
		Math.abs(a.x - b.x) <= SAME_GEOMETRY &&
		Math.abs(a.y - b.y) <= SAME_GEOMETRY &&
		Math.abs(a.fontSize - b.fontSize) <= SAME_GEOMETRY
	);
}

/**
 * The shift that carries `page` onto the canvas built so far: the commonest
 * difference between start points of paths with the same relative geometry.
 */
function findOffset(
	page: RawPage,
	signatures: ReadonlyMap<string, [number, number]>,
): { offset: [number, number]; matches: number } | null {
	const votes = new Map<string, { sum: [number, number]; n: number }>();
	for (const path of page.paths) {
		const start = signatures.get(relativeSignature(path));
		if (!start) continue;
		const n = pathNumbers(path.commands);
		const dx = start[0] - (n[0] ?? 0);
		const dy = start[1] - (n[1] ?? 0);
		const key = `${dx.toFixed(1)},${dy.toFixed(1)}`;
		const vote = votes.get(key) ?? { sum: [0, 0], n: 0 };
		vote.sum = [vote.sum[0] + dx, vote.sum[1] + dy];
		vote.n += 1;
		votes.set(key, vote);
	}
	let best: { sum: [number, number]; n: number } | null = null;
	for (const vote of votes.values()) if (!best || vote.n > best.n) best = vote;
	if (!best) return null;
	return { offset: [best.sum[0] / best.n, best.sum[1] / best.n], matches: best.n };
}

function reconstructMac(pages: readonly RawPage[]): Canvas {
	const warnings: string[] = [MAC_EXPORT_WARNING];
	const content = pages.filter((p) => p.paths.length > 0 || p.texts.length > 0);
	const paths: RawPath[] = [];
	const texts: RawText[] = [];
	const index = new PathIndex();
	const signatures = new Map<string, [number, number]>();
	const offsets: [number, number][] = [];
	let frame: Bounds | null = null;
	let duplicates = 0;
	let previous: [number, number] = [0, 0];
	let previousWindow: Bounds | null = null;

	content.forEach((page, k) => {
		let offset: [number, number] = [0, 0];
		if (k > 0) {
			const found = findOffset(page, signatures);
			if (found && found.matches >= 3) {
				offset = found.offset;
			} else {
				// No ink in common: stack this slice under the last one.
				const height = previousWindow ? previousWindow.maxY - previousWindow.minY : LETTER.height;
				offset = [previous[0], previous[1] - height];
				warnings.push(`page ${String(k + 1)} shares no ink with the pages before it; placed below them by its clip window`);
			}
		}
		offsets.push(offset);
		previous = offset;
		const window = sliceWindow(page);
		previousWindow = window;
		if (window) {
			frame = union(frame, {
				minX: window.minX + offset[0],
				minY: window.minY + offset[1],
				maxX: window.maxX + offset[0],
				maxY: window.maxY + offset[1],
			});
		}

		for (const raw of page.paths) {
			const path = translatePath(raw, offset[0], offset[1]);
			if (index.has(path)) {
				duplicates += 1;
				continue;
			}
			index.add(path);
			paths.push(path);
			frame = union(frame, path.bounds);
			const n = pathNumbers(path.commands);
			const signature = relativeSignature(path);
			if (!signatures.has(signature)) signatures.set(signature, [n[0] ?? 0, n[1] ?? 0]);
		}
		for (const raw of page.texts) {
			const text = { ...raw, x: raw.x + offset[0], y: raw.y + offset[1] };
			if (texts.some((t) => sameText(t, text))) {
				duplicates += 1;
				continue;
			}
			texts.push(text);
		}
	});

	const resolved: Bounds = frame ?? { minX: 0, minY: 0, maxX: LETTER.width, maxY: LETTER.height };
	return finish('mac', resolved, paths, texts, unitScale(texts, warnings), {
		contentPages: content.length,
		offsets,
		duplicates,
		warnings,
	});
}
