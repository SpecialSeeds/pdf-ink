/**
 * Paper tint: a sheet of tinted clear plastic laid over the page. Pure.
 *
 * Screen only. Nothing about the PDF, the ink or the export changes: the tint
 * is a layer the browser blends over each page, multiplying, so white paper
 * turns the tint's colour, black stays black, and every colour in between is
 * warmed the way it would be under a real sheet. It takes no input, so the pen
 * writes straight through it.
 */

import { normalizeHex, parseHex } from './color';

/** A warm, pale beige: old paper rather than yellow. */
export const DEFAULT_TINT_COLOR = '#f2e3c6';
/** How much of the tint shows, 0 to 1. */
export const DEFAULT_TINT_STRENGTH = 0.6;
export const TINT_STRENGTH_RANGE = { min: 0.1, max: 1 } as const;

export interface PaperTint {
	readonly enabled: boolean;
	readonly color: string;
	readonly strength: number;
}

export function clampTintStrength(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_TINT_STRENGTH;
	return Math.min(TINT_STRENGTH_RANGE.max, Math.max(TINT_STRENGTH_RANGE.min, value));
}

/** The CSS the tint layer reads. */
export function paperTintStyle(tint: PaperTint): Record<string, string> {
	return {
		'--pdf-ink-tint-color': normalizeHex(tint.color) ?? DEFAULT_TINT_COLOR,
		'--pdf-ink-tint-strength': String(clampTintStrength(tint.strength)),
	};
}

/**
 * What `color` looks like under the tint: the browser's multiply blend at the
 * tint's strength. `#ffffff` gives the paper's new colour.
 */
export function underTint(color: string, tint: PaperTint): string {
	const base = parseHex(color);
	const sheet = parseHex(normalizeHex(tint.color) ?? DEFAULT_TINT_COLOR);
	if (!base || !sheet) return color;
	const s = clampTintStrength(tint.strength);
	const channel = (b: number, t: number): string =>
		Math.round(b + ((b * t) / 255 - b) * s)
			.toString(16)
			.padStart(2, '0');
	return `#${channel(base.r, sheet.r)}${channel(base.g, sheet.g)}${channel(base.b, sheet.b)}`;
}
