/**
 * Wikilinks typed into text boxes. Pure: text in, links, display text and
 * link geometry out.
 *
 * A text box stores exactly what was typed, `[[...]]` and all; nothing about a
 * link is stored anywhere else. Everything here is derived from that text, so
 * the screen, the exporter and the vault's link index cannot disagree about
 * what a box links to.
 */

import { layerItems } from './base-layer';
import { type Item, isLive, isText } from './items';
import { type MeasureText, layoutTextLines } from './text-layout';

/** One `[[...]]` in a text box. */
export interface InkLink {
	/** Where the whole `[[...]]` (and a leading `!`) sits in the stored text. */
	readonly start: number;
	readonly end: number;
	/** The file part: `Note`, `folder/file.pdf`. Empty for a link to a heading in the same file. */
	readonly linkpath: string;
	/** `#Heading` or `#page=3`, with its `#`; empty when there is none. */
	readonly subpath: string;
	/** After `|`, or null. */
	readonly alias: string | null;
	/** What the box shows in place of the brackets. */
	readonly display: string;
}

/** `[[`, anything but brackets and line breaks, `]]`, optionally embedded with `!`. */
const WIKILINK = /!?\[\[([^[\]\n]+?)\]\]/g;

/** The link text Obsidian opens: the path and its subpath together. */
export function linkText(link: InkLink): string {
	return `${link.linkpath}${link.subpath}`;
}

/** The last path segment, without `.md`: what a link shows when it has no alias. */
function displayName(linkpath: string, subpath: string): string {
	const name = linkpath.slice(linkpath.lastIndexOf('/') + 1);
	const shown = name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name;
	// A link to a heading in the same file has no path to show.
	return shown.length > 0 ? shown : subpath.replace(/^#+/, '');
}

/** Every wikilink in `text`, in order. */
export function parseInkLinks(text: string): InkLink[] {
	const links: InkLink[] = [];
	for (const match of text.matchAll(WIKILINK)) {
		const inner = match[1] ?? '';
		const bar = inner.indexOf('|');
		const target = (bar < 0 ? inner : inner.slice(0, bar)).trim();
		const rawAlias = bar < 0 ? null : inner.slice(bar + 1).trim();
		const hash = target.indexOf('#');
		const linkpath = (hash < 0 ? target : target.slice(0, hash)).trim();
		const subpath = hash < 0 ? '' : target.slice(hash).trim();
		if (linkpath.length === 0 && subpath.length === 0) continue;
		const alias = rawAlias !== null && rawAlias.length > 0 ? rawAlias : null;
		const start = match.index;
		links.push({
			start,
			end: start + match[0].length,
			linkpath,
			subpath,
			alias,
			display: alias ?? displayName(linkpath, subpath),
		});
	}
	return links;
}

/** A link's place in the display text. */
export interface DisplaySpan {
	readonly start: number;
	readonly end: number;
	readonly link: InkLink;
}

/** A box's text as shown: each `[[...]]` replaced by its display text. */
export interface DisplayText {
	readonly text: string;
	readonly spans: readonly DisplaySpan[];
}

export function displayText(text: string): DisplayText {
	const links = parseInkLinks(text);
	if (links.length === 0) return { text, spans: [] };
	let out = '';
	let from = 0;
	const spans: DisplaySpan[] = [];
	for (const link of links) {
		out += text.slice(from, link.start);
		const start = out.length;
		out += link.display;
		spans.push({ start, end: out.length, link });
		from = link.end;
	}
	out += text.slice(from);
	return { text: out, spans };
}

/** A run of one line: plain text, or (part of) a link. */
export interface TextRun {
	readonly text: string;
	/** Left edge in unrotated PDF space. */
	readonly x: number;
	readonly width: number;
	readonly link: InkLink | null;
}

export interface LinkedLine {
	/** Baseline origin in unrotated PDF space, as {@link layoutTextLines} gives it. */
	readonly x: number;
	readonly y: number;
	readonly runs: readonly TextRun[];
}

/**
 * The display text laid out in lines, each split into plain and link runs.
 *
 * Wrapped exactly as {@link layoutTextLines} wraps the display text, so a box
 * with links wraps the way it reads, not the way its brackets would. A link
 * that wraps is split across the lines it falls on.
 */
export function layoutLinkedText(
	text: string,
	box: { x: number; y: number; w: number; h: number },
	fontSize: number,
	measure: MeasureText,
): LinkedLine[] {
	const shown = displayText(text);
	const lines = layoutTextLines(shown.text, box, fontSize, measure);
	const out: LinkedLine[] = [];
	// Every wrapped line is a substring of the display text, in order: wrapping
	// only drops the spaces it breaks at. Finding each from where the last ended
	// recovers its offset, and with it which links it holds.
	let cursor = 0;
	for (const line of lines) {
		const at = line.text.length === 0 ? cursor : shown.text.indexOf(line.text, cursor);
		const offset = at < 0 ? cursor : at;
		cursor = offset + line.text.length;
		out.push({ x: line.x, y: line.y, runs: runsOf(line.text, offset, line.x, shown.spans, measure) });
	}
	return out;
}

function runsOf(
	line: string,
	offset: number,
	left: number,
	spans: readonly DisplaySpan[],
	measure: MeasureText,
): TextRun[] {
	const end = offset + line.length;
	const cuts = new Set<number>([offset, end]);
	for (const span of spans) {
		if (span.end <= offset || span.start >= end) continue;
		cuts.add(Math.max(span.start, offset));
		cuts.add(Math.min(span.end, end));
	}
	const points = [...cuts].sort((a, b) => a - b);
	const runs: TextRun[] = [];
	for (let i = 0; i + 1 < points.length; i++) {
		const from = points[i] ?? offset;
		const to = points[i + 1] ?? end;
		if (to <= from) continue;
		const span = spans.find((s) => s.start <= from && s.end >= to);
		const text = line.slice(from - offset, to - offset);
		runs.push({
			text,
			// Measured from the line's start, so kerning across a run boundary
			// lands each run where the whole line would put it.
			x: left + measure(line.slice(0, from - offset)),
			width: measure(text),
			link: span?.link ?? null,
		});
	}
	return runs;
}

/** Below the baseline an underline sits, as a fraction of the font size. */
export const UNDERLINE_OFFSET = 0.12;
/** An underline's thickness, as a fraction of the font size. */
export const UNDERLINE_WIDTH = 0.06;

/** A link run's clickable area in unrotated PDF space: [x1, y1, x2, y2]. */
export type RunRect = readonly [number, number, number, number];

/** The area of a run: from just below the descenders to just above the capitals. */
export function runRect(line: LinkedLine, run: TextRun, fontSize: number): RunRect {
	return [run.x, line.y - fontSize * 0.25, run.x + run.width, line.y + fontSize * 0.85];
}

/** A link's area on the page, after the box's rotation: a quadrilateral and its bounds. */
export interface LinkArea {
	readonly link: InkLink;
	/** Corners in PDF space, counter-clockwise from bottom-left of the unrotated run. */
	readonly quad: readonly (readonly [number, number])[];
	/** Axis-aligned bounds of {@link quad}: [x1, y1, x2, y2]. */
	readonly rect: RunRect;
}

/** Rotate a PDF-space point clockwise by `degrees` about (cx, cy), as ItemBase.rotation does. */
export function rotateClockwise(
	x: number,
	y: number,
	cx: number,
	cy: number,
	degrees: number,
): [number, number] {
	if (degrees === 0) return [x, y];
	const r = (degrees * Math.PI) / 180;
	const dx = x - cx;
	const dy = y - cy;
	return [cx + dx * Math.cos(r) + dy * Math.sin(r), cy - dx * Math.sin(r) + dy * Math.cos(r)];
}

/** Every link run of a text box, placed on the page. */
export function linkAreas(
	item: { text: string; box: { x: number; y: number; w: number; h: number }; fontSize: number; rotation: number },
	measure: MeasureText,
): LinkArea[] {
	if (!item.text.includes('[[')) return [];
	const cx = item.box.x + item.box.w / 2;
	const cy = item.box.y + item.box.h / 2;
	const areas: LinkArea[] = [];
	for (const line of layoutLinkedText(item.text, item.box, item.fontSize, measure)) {
		for (const run of line.runs) {
			if (!run.link) continue;
			const [x1, y1, x2, y2] = runRect(line, run, item.fontSize);
			const quad = [
				[x1, y1],
				[x2, y1],
				[x2, y2],
				[x1, y2],
			].map(([x = 0, y = 0]) => rotateClockwise(x, y, cx, cy, item.rotation));
			const xs = quad.map((p) => p[0]);
			const ys = quad.map((p) => p[1]);
			areas.push({
				link: run.link,
				quad,
				rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
			});
		}
	}
	return areas;
}

/**
 * The link under a point, allowing `slop` points around each run.
 *
 * Tested in the box's own frame, so a rotated box is hit where its text is
 * drawn rather than anywhere in its tilted bounds. The nearest run wins.
 */
export function inkLinkAt(
	item: { text: string; box: { x: number; y: number; w: number; h: number }; fontSize: number; rotation: number },
	x: number,
	y: number,
	slop: number,
	measure: MeasureText,
): InkLink | null {
	if (!item.text.includes('[[')) return null;
	const cx = item.box.x + item.box.w / 2;
	const cy = item.box.y + item.box.h / 2;
	// Undo the box's rotation: the point, turned back, against unrotated runs.
	const [px, py] = rotateClockwise(x, y, cx, cy, -item.rotation);
	let best: InkLink | null = null;
	let bestDistance = Infinity;
	for (const line of layoutLinkedText(item.text, item.box, item.fontSize, measure)) {
		for (const run of line.runs) {
			if (!run.link) continue;
			const [x1, y1, x2, y2] = runRect(line, run, item.fontSize);
			const distance = Math.hypot(Math.max(x1 - px, 0, px - x2), Math.max(y1 - py, 0, py - y2));
			if (distance <= slop && distance < bestDistance) {
				best = run.link;
				bestDistance = distance;
			}
		}
	}
	return best;
}

/** Every link in the live text boxes of some items, in order. */
export function linksInItems(items: readonly Item[]): InkLink[] {
	const links: InkLink[] = [];
	for (const item of items) {
		if (!isText(item) || !isLive(item) || !item.text.includes('[[')) continue;
		links.push(...parseInkLinks(item.text));
	}
	return links;
}

/**
 * `text` with each link's path replaced where `rename` returns a new one,
 * keeping its subpath, alias and embed mark. Null when nothing changed.
 */
export function rewriteLinks(text: string, rename: (link: InkLink) => string | null): string | null {
	const links = parseInkLinks(text);
	let out = '';
	let from = 0;
	let changed = false;
	for (const link of links) {
		const next = rename(link);
		if (next === null || next === link.linkpath) continue;
		const raw = text.slice(link.start, link.end);
		const embed = raw.startsWith('!') ? '!' : '';
		const alias = link.alias !== null ? `|${link.alias}` : '';
		out += text.slice(from, link.start) + `${embed}[[${next}${link.subpath}${alias}]]`;
		from = link.end;
		changed = true;
	}
	return changed ? out + text.slice(from) : null;
}

/** Counts per link path: how a source's links go into the vault's link index. */
export function countLinkpaths(linkpaths: readonly string[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const path of linkpaths) counts[path] = (counts[path] ?? 0) + 1;
	return counts;
}

/**
 * The link paths of a document's live text boxes, both layers, every page:
 * what the vault's link index records for it. Self links (`[[#Heading]]`)
 * point nowhere else and are left out.
 */
export function documentLinkpaths(
	pages: Readonly<Record<string, readonly Item[]>>,
	base?: Readonly<Record<string, readonly Item[]>>,
): string[] {
	const keys = new Set([...Object.keys(base ?? {}), ...Object.keys(pages)]);
	const out: string[] = [];
	for (const key of keys) {
		for (const link of linksInItems(layerItems(base?.[key], pages[key] ?? []))) {
			if (link.linkpath.length > 0) out.push(link.linkpath);
		}
	}
	return out;
}
