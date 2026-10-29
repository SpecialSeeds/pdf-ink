/**
 * Finding text in a PDF page. Pure: pdf.js text runs in, boxes in PDF space out.
 *
 * Matching is case-, accent- and ligature-insensitive ("ﬁ" is "fi", "é" is
 * "e"), and any run of whitespace matches any other, including the break
 * between two lines. Positions within a run are proportional to the characters
 * before them, which is as close as text content gets without the font's own
 * widths, and close enough to land the highlight on the word.
 */

import type { BlockBox } from './blocks';

/** The fields of a pdf.js TextItem this needs. */
export interface TextRun {
	readonly str: string;
	/** [a, b, c, d, e, f]: the run's baseline origin is (e, f), in PDF space. */
	readonly transform: readonly number[];
	/** Advance along the baseline, in PDF space. */
	readonly width: number;
	readonly height: number;
	/** The run ends a line, so a space separates it from the next. */
	readonly hasEOL?: boolean;
}

/** A page's text, folded for matching, with each character's source. */
export interface PageText {
	readonly runs: readonly TextRun[];
	readonly text: string;
	/** Parallel to `text`: which run and code point each character came from. -1 is a line break. */
	readonly runOf: readonly number[];
	readonly charOf: readonly number[];
}

/** One match: a box for each run it touches, in PDF space. */
export interface FindHit {
	readonly boxes: readonly BlockBox[];
}

/** What a character is compared as: no accents, no ligatures, lower case. */
function fold(ch: string): string {
	if (/\s/u.test(ch)) return ' ';
	return ch.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

/** A query folded the way page text is, trimmed, with whitespace collapsed. */
export function foldQuery(query: string): string {
	let out = '';
	for (const ch of query) out += fold(ch);
	return out.replace(/ +/g, ' ').trim();
}

export function pageText(runs: readonly TextRun[]): PageText {
	let text = '';
	const runOf: number[] = [];
	const charOf: number[] = [];
	const push = (folded: string, run: number, char: number): void => {
		for (const out of folded) {
			// Whitespace collapses: one space stands for any run of it.
			if (out === ' ' && (text.length === 0 || text.endsWith(' '))) continue;
			text += out;
			runOf.push(run);
			charOf.push(char);
		}
	};
	runs.forEach((run, r) => {
		Array.from(run.str).forEach((ch, c) => {
			push(fold(ch), r, c);
		});
		if (run.hasEOL === true) push(' ', -1, -1);
	});
	return { runs, text, runOf, charOf };
}

/** Every non-overlapping match of `query` on the page, in reading order. */
export function findInPage(page: PageText, query: string): FindHit[] {
	const needle = foldQuery(query);
	if (needle.length === 0) return [];
	const hits: FindHit[] = [];
	let from = 0;
	for (;;) {
		const at = page.text.indexOf(needle, from);
		if (at < 0) break;
		hits.push({ boxes: boxesFor(page, at, at + needle.length) });
		from = at + needle.length;
	}
	return hits;
}

/** The boxes covering text[start, end), one per run. */
function boxesFor(page: PageText, start: number, end: number): BlockBox[] {
	// First and last code point touched in each run, in run order.
	const spans = new Map<number, { first: number; last: number }>();
	for (let i = start; i < end; i++) {
		const run = page.runOf[i] ?? -1;
		const char = page.charOf[i] ?? -1;
		if (run < 0) continue;
		const span = spans.get(run);
		if (span) span.last = Math.max(span.last, char);
		else spans.set(run, { first: char, last: char });
	}
	const boxes: BlockBox[] = [];
	for (const [r, span] of spans) {
		const run = page.runs[r];
		if (run) boxes.push(runBox(run, span.first, span.last + 1));
	}
	return boxes;
}

/**
 * The box of code points [from, to) of a run.
 *
 * The run's own direction comes from its transform, so rotated text is boxed
 * along its baseline; the result is the upright box around that.
 */
export function runBox(run: TextRun, from: number, to: number): BlockBox {
	const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = run.transform;
	const length = Math.max(1, Array.from(run.str).length);
	const along = Math.hypot(a, b) || 1;
	const up = Math.hypot(c, d) || 1;
	const ux = a / along;
	const uy = b / along;
	const vx = c / up;
	const vy = d / up;
	const height = run.height > 0 ? run.height : up;
	const s0 = (run.width * from) / length;
	const s1 = (run.width * to) / length;
	// Descenders reach about a fifth of the size below the baseline.
	const t0 = -0.2 * height;
	const t1 = height;
	const xs: number[] = [];
	const ys: number[] = [];
	for (const s of [s0, s1]) {
		for (const t of [t0, t1]) {
			xs.push(e + ux * s + vx * t);
			ys.push(f + uy * s + vy * t);
		}
	}
	const x = Math.min(...xs);
	const y = Math.min(...ys);
	return [x, y, Math.max(...xs) - x, Math.max(...ys) - y];
}
