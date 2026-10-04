/**
 * Reading a OneNote PDF export with pdf.js: every painted path and every run of
 * typed text, in page space, with the colour and blend it was drawn in.
 *
 * Node only. This runs on the desktop as a one-off import tool, never inside the
 * plugin, which uses Obsidian's own pdf.js.
 */

import { OPS, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Bounds } from '../../../src/core/hit-test';
import type { PathCommand } from '../../../src/core/shapes';

/** `[a, b, c, d, e, f]`: x' = ax + cy + e, y' = bx + dy + f. */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m` applied after `n`: the matrix for "n, then m". */
export function multiply(m: Matrix, n: Matrix): Matrix {
	return [
		n[0] * m[0] + n[1] * m[2],
		n[0] * m[1] + n[1] * m[3],
		n[2] * m[0] + n[3] * m[2],
		n[2] * m[1] + n[3] * m[3],
		n[4] * m[0] + n[5] * m[2] + m[4],
		n[4] * m[1] + n[5] * m[3] + m[5],
	];
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
	return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** One painted path, already in page space. */
export interface RawPath {
	readonly commands: PathCommand[];
	readonly paint: 'fill' | 'stroke';
	/** `#rrggbb`, exactly as exported. */
	readonly color: string;
	readonly alpha: number;
	/** Stroke width in page units; 0 for a fill. */
	readonly lineWidth: number;
	/** Drawn with a darken or multiply blend: OneNote's highlighter. */
	readonly highlight: boolean;
	/** The clip in force, as a page-space box, or null for none. */
	readonly clip: Bounds | null;
	readonly bounds: Bounds;
}

/** One run of typed text: a single `showText`. */
export interface RawText {
	readonly text: string;
	/** The baseline origin, in page space. */
	readonly x: number;
	readonly y: number;
	/** Effective font size in page units. */
	readonly fontSize: number;
	/** Approximate advance width in page units. */
	readonly width: number;
	readonly color: string;
	/**
	 * The scale the graphics state applied to the text, x and y. OneNote's Mac
	 * export draws its whole canvas scaled down to fit the page, and says so only
	 * here: its ink is pre-scaled, with no transform of its own.
	 */
	readonly ctmScale: [number, number];
}

export interface RawPage {
	readonly width: number;
	readonly height: number;
	readonly paths: RawPath[];
	readonly texts: RawText[];
}

interface GraphicsState {
	ctm: Matrix;
	fill: string;
	stroke: string;
	alpha: number;
	lineWidth: number;
	blend: string;
	clip: Bounds | null;
}

function boundsOf(commands: readonly PathCommand[]): Bounds {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	const add = (x: number, y: number): void => {
		minX = Math.min(minX, x);
		minY = Math.min(minY, y);
		maxX = Math.max(maxX, x);
		maxY = Math.max(maxY, y);
	};
	for (const c of commands) {
		if (c.op === 'close') continue;
		add(c.x, c.y);
		if (c.op === 'cubic') {
			add(c.x1, c.y1);
			add(c.x2, c.y2);
		}
	}
	return { minX, minY, maxX, maxY };
}

function intersect(a: Bounds | null, b: Bounds): Bounds {
	if (!a) return b;
	return {
		minX: Math.max(a.minX, b.minX),
		minY: Math.max(a.minY, b.minY),
		maxX: Math.min(a.maxX, b.maxX),
		maxY: Math.min(a.maxY, b.maxY),
	};
}

/**
 * pdf.js packs a path as one flat array: 0 move (x, y), 1 line (x, y), 2 cubic
 * (6 numbers), 3 quadratic (4 numbers), 4 close.
 */
function decodePath(data: ArrayLike<number>, ctm: Matrix): PathCommand[] {
	const commands: PathCommand[] = [];
	let current: [number, number] = [0, 0];
	let i = 0;
	const next = (): number => data[i++] ?? 0;
	while (i < data.length) {
		const op = next();
		if (op === 0 || op === 1) {
			const raw: [number, number] = [next(), next()];
			const [x, y] = apply(ctm, raw[0], raw[1]);
			commands.push({ op: op === 0 ? 'move' : 'line', x, y });
			current = raw;
		} else if (op === 2) {
			const n = [next(), next(), next(), next(), next(), next()];
			const [x1, y1] = apply(ctm, n[0] ?? 0, n[1] ?? 0);
			const [x2, y2] = apply(ctm, n[2] ?? 0, n[3] ?? 0);
			const [x, y] = apply(ctm, n[4] ?? 0, n[5] ?? 0);
			commands.push({ op: 'cubic', x1, y1, x2, y2, x, y });
			current = [n[4] ?? 0, n[5] ?? 0];
		} else if (op === 3) {
			// Raise the quadratic to a cubic, which is exact.
			const [qx, qy, ex, ey] = [next(), next(), next(), next()];
			const c1: [number, number] = [current[0] + (2 / 3) * (qx - current[0]), current[1] + (2 / 3) * (qy - current[1])];
			const c2: [number, number] = [ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey)];
			const [x1, y1] = apply(ctm, ...c1);
			const [x2, y2] = apply(ctm, ...c2);
			const [x, y] = apply(ctm, ex, ey);
			commands.push({ op: 'cubic', x1, y1, x2, y2, x, y });
			current = [ex, ey];
		} else if (op === 4) {
			commands.push({ op: 'close' });
		} else {
			break;
		}
	}
	return commands;
}

const FILLS = new Set<number>([
	OPS.fill,
	OPS.eoFill,
	OPS.fillStroke,
	OPS.eoFillStroke,
	OPS.closeFillStroke,
	OPS.closeEOFillStroke,
]);
const STROKES = new Set<number>([
	OPS.stroke,
	OPS.closeStroke,
	OPS.fillStroke,
	OPS.eoFillStroke,
	OPS.closeFillStroke,
	OPS.closeEOFillStroke,
]);

interface Glyph {
	readonly unicode?: string;
	readonly width?: number;
}

/** Every page of the PDF in `bytes`. */
export async function extractPdf(bytes: Uint8Array): Promise<RawPage[]> {
	const task = getDocument({ data: bytes.slice(), verbosity: 0 });
	const doc = await task.promise;
	const pages: RawPage[] = [];
	try {
		for (let number = 1; number <= doc.numPages; number++) {
			const page = await doc.getPage(number);
			const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = page.view;
			const list = await page.getOperatorList();
			pages.push({
				width: x1 - x0,
				height: y1 - y0,
				...walk(list.fnArray, list.argsArray as unknown[][]),
			});
			page.cleanup();
		}
	} finally {
		await task.destroy();
	}
	return pages;
}

function walk(
	fnArray: readonly number[],
	argsArray: readonly unknown[][],
): { paths: RawPath[]; texts: RawText[] } {
	const paths: RawPath[] = [];
	const texts: RawText[] = [];
	let state: GraphicsState = {
		ctm: IDENTITY,
		fill: '#000000',
		stroke: '#000000',
		alpha: 1,
		lineWidth: 1,
		blend: 'normal',
		clip: null,
	};
	const stack: GraphicsState[] = [];
	let clipPending = false;
	let textMatrix: Matrix = IDENTITY;
	let lineMatrix: Matrix = IDENTITY;
	let fontSize = 1;
	let charSpacing = 0;

	fnArray.forEach((fn, index) => {
		const args = argsArray[index] ?? [];
		switch (fn) {
			case OPS.save:
				stack.push({ ...state });
				break;
			case OPS.restore:
				state = stack.pop() ?? state;
				break;
			case OPS.transform:
				state.ctm = multiply(state.ctm, args as Matrix);
				break;
			case OPS.setFillRGBColor:
				state.fill = String(args[0]);
				break;
			case OPS.setStrokeRGBColor:
				state.stroke = String(args[0]);
				break;
			case OPS.setLineWidth:
				state.lineWidth = Number(args[0]);
				break;
			case OPS.setGState:
				for (const [key, value] of args[0] as [string, unknown][]) {
					if (key === 'BM') state.blend = String(value).toLowerCase();
					if (key === 'ca') state.alpha = Number(value);
				}
				break;
			case OPS.clip:
			case OPS.eoClip:
				clipPending = true;
				break;
			case OPS.constructPath: {
				const paint = args[0] as number;
				const data = (args[1] as ArrayLike<number>[])[0] ?? [];
				const commands = decodePath(data, state.ctm);
				if (commands.length === 0) break;
				const bounds = boundsOf(commands);
				if (clipPending) {
					state.clip = intersect(state.clip, bounds);
					clipPending = false;
				}
				const base = {
					commands,
					alpha: state.alpha,
					highlight: state.blend === 'darken' || state.blend === 'multiply',
					clip: state.clip,
					bounds,
				};
				if (FILLS.has(paint)) {
					paths.push({ ...base, paint: 'fill', color: state.fill, lineWidth: 0 });
				}
				if (STROKES.has(paint)) {
					const [a, b, c, d] = state.ctm;
					const scale = Math.sqrt(Math.abs(a * d - b * c));
					paths.push({
						...base,
						paint: 'stroke',
						color: state.stroke,
						lineWidth: state.lineWidth * scale,
					});
				}
				break;
			}
			case OPS.beginText:
				textMatrix = IDENTITY;
				lineMatrix = IDENTITY;
				break;
			case OPS.setTextMatrix: {
				const m = (Array.from(args[0] as ArrayLike<number>) as Matrix);
				textMatrix = m;
				lineMatrix = m;
				break;
			}
			case OPS.moveText: {
				const [tx = 0, ty = 0] = args as number[];
				lineMatrix = multiply(lineMatrix, [1, 0, 0, 1, tx, ty]);
				textMatrix = lineMatrix;
				break;
			}
			case OPS.setFont:
				fontSize = Number(args[1]);
				break;
			case OPS.setCharSpacing:
				charSpacing = Number(args[0]);
				break;
			case OPS.showText: {
				const glyphs = args[0] as (Glyph | number)[];
				let text = '';
				let advance = 0;
				for (const glyph of glyphs) {
					if (typeof glyph === 'number') {
						advance -= (glyph / 1000) * fontSize;
						continue;
					}
					const unicode = glyph.unicode ?? '';
					// OneNote encodes its spaces as tabs.
					text += unicode === '\t' ? ' ' : unicode;
					advance += ((glyph.width ?? 0) / 1000) * fontSize + charSpacing;
				}
				if (text.trim().length === 0) break;
				const full = multiply(state.ctm, textMatrix);
				const [x, y] = apply(full, 0, 0);
				const scaleX = Math.hypot(full[0], full[1]);
				const scaleY = Math.hypot(full[2], full[3]);
				texts.push({
					text: text.replace(/\s+$/, ''),
					x,
					y,
					fontSize: fontSize * scaleY,
					width: advance * scaleX,
					color: state.fill,
					ctmScale: [Math.hypot(state.ctm[0], state.ctm[1]), Math.hypot(state.ctm[2], state.ctm[3])],
				});
				textMatrix = multiply(textMatrix, [1, 0, 0, 1, advance, 0]);
				break;
			}
			default:
				break;
		}
	});
	return { paths, texts };
}
