/**
 * Text wrapping. Pure, and deliberately measurement-agnostic.
 *
 * The screen renderer measures with a canvas context and the exporter measures
 * with the embedded font. Both call this, so a text box wraps identically in
 * Obsidian and in the exported PDF — which is the only way the two can agree.
 */

/** Width of `text` at the item's font size, in PDF points. */
export type MeasureText = (text: string) => number;

/** Line spacing as a multiple of font size. */
export const LINE_HEIGHT = 1.2;

/** Fraction of the font size the first baseline sits below the box top. */
export const BASELINE_RATIO = 0.8;

/** A box narrower than this cannot wrap sensibly. */
const MIN_WRAP_WIDTH = 1;

export function lineHeightFor(fontSize: number): number {
	return fontSize * LINE_HEIGHT;
}

/**
 * Greedy word wrap, preserving explicit newlines.
 *
 * A word too long for the box is broken by character rather than allowed to
 * overflow, because the box is the user's stated bound.
 */
export function wrapText(
	text: string,
	maxWidth: number,
	measure: MeasureText,
): string[] {
	const limit = Math.max(maxWidth, MIN_WRAP_WIDTH);
	const lines: string[] = [];

	// Explicit breaks are honoured first, so an empty line stays an empty line.
	for (const paragraph of text.split('\n')) {
		if (paragraph.length === 0) {
			lines.push('');
			continue;
		}
		lines.push(...wrapParagraph(paragraph, limit, measure));
	}
	return lines;
}

function wrapParagraph(
	paragraph: string,
	limit: number,
	measure: MeasureText,
): string[] {
	const lines: string[] = [];
	let current = '';

	for (const word of paragraph.split(' ')) {
		const candidate = current.length === 0 ? word : `${current} ${word}`;
		if (measure(candidate) <= limit) {
			current = candidate;
			continue;
		}

		if (current.length > 0) {
			lines.push(current);
			current = '';
		}

		// The word alone may still not fit.
		if (measure(word) <= limit) {
			current = word;
			continue;
		}
		const pieces = breakWord(word, limit, measure);
		const last = pieces.pop();
		lines.push(...pieces);
		current = last ?? '';
	}

	if (current.length > 0 || lines.length === 0) lines.push(current);
	return lines;
}

/** Split an over-long word into chunks that each fit. */
function breakWord(
	word: string,
	limit: number,
	measure: MeasureText,
): string[] {
	const pieces: string[] = [];
	let current = '';
	for (const character of word) {
		const candidate = current + character;
		if (current.length > 0 && measure(candidate) > limit) {
			pieces.push(current);
			current = character;
		} else {
			current = candidate;
		}
	}
	if (current.length > 0) pieces.push(current);
	return pieces;
}

export interface TextLine {
	readonly text: string;
	/** Baseline origin in PDF user space, before any rotation. */
	readonly x: number;
	readonly y: number;
}

/**
 * Where each wrapped line's baseline sits, in unrotated PDF space.
 *
 * Lines run downward from the box's top edge, which in PDF's y-up space is its
 * maximum y. Rotation is applied by the caller about the box centre, so that both
 * renderers can use their own rotation primitive.
 */
export function layoutTextLines(
	text: string,
	box: { x: number; y: number; w: number; h: number },
	fontSize: number,
	measure: MeasureText,
): TextLine[] {
	const left = Math.min(box.x, box.x + box.w);
	const top = Math.max(box.y, box.y + box.h);
	const width = Math.abs(box.w);
	const step = lineHeightFor(fontSize);

	return wrapText(text, width, measure).map((line, index) => ({
		text: line,
		x: left,
		y: top - fontSize * BASELINE_RATIO - index * step,
	}));
}

/** The height the wrapped text needs, for sizing a freshly created box. */
export function textHeightFor(lineCount: number, fontSize: number): number {
	return Math.max(1, lineCount) * lineHeightFor(fontSize);
}
