/**
 * Hex colours: parsing, luminance and contrast. Pure.
 *
 * Stored colours are `#rrggbb` strings (the presets and `<input type="color">`
 * both produce that), though `#rgb` is accepted too. Everything here is total: a
 * string that is not a colour parses to null and callers pick their own fallback.
 */

export interface Rgb {
	/** 0–255. */
	readonly r: number;
	readonly g: number;
	readonly b: number;
}

/** `#rgb` or `#rrggbb`, case-insensitive, to 0–255 channels. Null otherwise. */
export function parseHex(color: string): Rgb | null {
	const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
	const hex = match?.[1];
	if (hex === undefined) return null;
	const full =
		hex.length === 3
			? hex
					.split('')
					.map((c) => c + c)
					.join('')
			: hex;
	return {
		r: parseInt(full.slice(0, 2), 16),
		g: parseInt(full.slice(2, 4), 16),
		b: parseInt(full.slice(4, 6), 16),
	};
}

/** Lower-case `#rrggbb`, or null for anything that is not a colour. */
export function normalizeHex(color: string): string | null {
	const rgb = parseHex(color);
	if (!rgb) return null;
	const hex = (n: number): string => n.toString(16).padStart(2, '0');
	return `#${hex(rgb.r)}${hex(rgb.g)}${hex(rgb.b)}`;
}

/** Whether two strings name the same colour, however they are spelled. */
export function sameColor(a: string, b: string): boolean {
	const na = normalizeHex(a);
	return na !== null ? na === normalizeHex(b) : a === b;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(rgb: Rgb): number {
	const channel = (value: number): number => {
		const c = value / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** WCAG contrast ratio between two colours, 1 to 21. Null if either is not a colour. */
export function contrastRatio(a: string, b: string): number | null {
	const ra = parseHex(a);
	const rb = parseHex(b);
	if (!ra || !rb) return null;
	const la = relativeLuminance(ra);
	const lb = relativeLuminance(rb);
	const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
	return (hi + 0.05) / (lo + 0.05);
}
