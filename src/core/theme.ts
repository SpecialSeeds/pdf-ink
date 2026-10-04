/**
 * Page themes: the paper, grid and base-ink colours of notebook and inserted
 * pages, and how a stored colour renders under them. Pure.
 *
 * A theme is applied at render time only — on screen and in export alike — and
 * never rewrites a stored colour. Only "base ink" (near black or near white)
 * changes with the theme; every other colour renders exactly as stored.
 *
 * Original PDF pages are never themed: the page is drawn as the PDF has it
 * (white, as a rule), so ink on it always takes the light mapping.
 */

import { contrastRatio, normalizeHex, parseHex, relativeLuminance } from './color';

export type ThemeName = 'light' | 'dark';

export const THEME_NAMES: readonly ThemeName[] = ['light', 'dark'];

export function isThemeName(value: unknown): value is ThemeName {
	return value === 'light' || value === 'dark';
}

export interface PageTheme {
	/** Page background. */
	readonly paper: string;
	/** Template ruling: lines and dots. */
	readonly grid: string;
	/** What near-black and near-white ink renders as. */
	readonly baseInk: string;
	/** A notebook header's date line: quieter than the title, still legible. */
	readonly headerMuted: string;
}

export type PageThemeKey = keyof PageTheme;

export const PAGE_THEME_KEYS: readonly PageThemeKey[] = ['paper', 'grid', 'baseInk', 'headerMuted'];

export type PageThemes = Readonly<Record<ThemeName, PageTheme>>;

/**
 * The built-in themes. The settings tab can override any value; these are what
 * "reset to default" returns to.
 */
export const DEFAULT_PAGE_THEMES: PageThemes = {
	// The light header grey is OneNote's own date colour.
	light: { paper: '#ffffff', grid: '#d5e1ec', baseInk: '#1a1a1a', headerMuted: '#767676' },
	// Dark grey rather than black, and white rather than grey ink. OneNote's
	// grey would be too faint on dark paper, so the date is lighter there.
	dark: { paper: '#1e1e1e', grid: '#2c3a4a', baseInk: '#ffffff', headerMuted: '#9a9a9a' },
};

/**
 * A colour is near black when every channel is at or below this, and near white
 * when every channel is at or above {@link BASE_INK_MIN_LIGHT}. Per channel, so a
 * pale yellow (`#fff59d`) or a deep navy (`#1f2a60`) keeps its own colour.
 */
export const BASE_INK_MAX_DARK = 0x30;
export const BASE_INK_MIN_LIGHT = 0xe0;

/** WCAG AA for body text: base ink below this against its paper is flagged. */
export const MIN_BASE_INK_CONTRAST = 4.5;

/** Per-theme colour overrides, as stored in settings. Only valid hex survives. */
export type PageThemeOverrides = Record<ThemeName, Partial<Record<PageThemeKey, string>>>;

export function emptyThemeOverrides(): PageThemeOverrides {
	return { light: {}, dark: {} };
}

/**
 * Overrides read from stored settings, keeping only what is a real colour.
 *
 * An invalid value is dropped rather than kept, so the default shows through for
 * that one colour instead of the page rendering in an unparseable style.
 */
export function readThemeOverrides(stored: unknown): PageThemeOverrides {
	const overrides = emptyThemeOverrides();
	if (stored === null || typeof stored !== 'object') return overrides;
	const raw = stored as Record<string, unknown>;
	for (const name of THEME_NAMES) {
		const theme = raw[name];
		if (theme === null || typeof theme !== 'object') continue;
		const values = theme as Record<string, unknown>;
		for (const key of PAGE_THEME_KEYS) {
			const value = values[key];
			const hex = typeof value === 'string' ? normalizeHex(value) : null;
			if (hex !== null) overrides[name][key] = hex;
		}
	}
	return overrides;
}

/** The themes in effect: overrides laid over the defaults, value by value. */
export function effectiveThemes(overrides: unknown): PageThemes {
	const valid = readThemeOverrides(overrides);
	return {
		light: { ...DEFAULT_PAGE_THEMES.light, ...valid.light },
		dark: { ...DEFAULT_PAGE_THEMES.dark, ...valid.dark },
	};
}

/** Near black or near white: the ink a theme swaps for its own base ink. */
export function isBaseInk(color: string): boolean {
	const rgb = parseHex(color);
	if (!rgb) return false;
	const { r, g, b } = rgb;
	if (r <= BASE_INK_MAX_DARK && g <= BASE_INK_MAX_DARK && b <= BASE_INK_MAX_DARK) {
		return true;
	}
	return r >= BASE_INK_MIN_LIGHT && g >= BASE_INK_MIN_LIGHT && b >= BASE_INK_MIN_LIGHT;
}

/** The colour a stored colour is drawn in under `theme`. Never changes the record. */
export function renderColor(stored: string, theme: PageTheme): string {
	return isBaseInk(stored) ? theme.baseInk : stored;
}

/**
 * The theme a page renders under. An original PDF page is always light: its own
 * paper is drawn as the PDF has it, and white ink on it would vanish.
 */
export function themeForPage(kind: 'pdf' | 'inserted', viewTheme: ThemeName): ThemeName {
	return kind === 'pdf' ? 'light' : viewTheme;
}

/**
 * Whether a paper is dark: closer in contrast to white than to black. Decided by
 * luminance rather than by theme name, so a customised paper still gets the right
 * highlighter blend.
 */
export function isDarkPaper(paper: string): boolean {
	const rgb = parseHex(paper);
	if (!rgb) return false;
	const l = relativeLuminance(rgb);
	// Equal contrast against black and white: (1.05)/(l+0.05) = (l+0.05)/0.05.
	return l < Math.sqrt(1.05 * 0.05) - 0.05;
}

export type HighlighterBlend = 'multiply' | 'screen';

/**
 * Multiply darkens, which is how a highlighter reads on light paper; on dark
 * paper it would leave nothing visible, so screen — its lightening mirror — is used.
 */
export function highlighterBlend(paper: string): HighlighterBlend {
	return isDarkPaper(paper) ? 'screen' : 'multiply';
}

/** Whether a theme's base ink is too faint against its own paper. */
export function hasLowContrast(theme: PageTheme): boolean {
	const ratio = contrastRatio(theme.baseInk, theme.paper);
	return ratio !== null && ratio < MIN_BASE_INK_CONTRAST;
}
