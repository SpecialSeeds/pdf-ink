import { describe, expect, it } from 'vitest';
import { contrastRatio, normalizeHex, parseHex, sameColor } from './color';
import {
	DEFAULT_PAGE_THEMES,
	effectiveThemes,
	hasLowContrast,
	highlighterBlend,
	isBaseInk,
	isDarkPaper,
	readThemeOverrides,
	renderColor,
	themeForPage,
} from './theme';

describe('parseHex', () => {
	it('reads long and short hex', () => {
		expect(parseHex('#ff8000')).toEqual({ r: 255, g: 128, b: 0 });
		expect(parseHex('#F80')).toEqual({ r: 255, g: 136, b: 0 });
	});

	it('refuses anything else', () => {
		expect(parseHex('red')).toBeNull();
		expect(parseHex('#12345')).toBeNull();
		expect(parseHex('')).toBeNull();
	});

	it('normalises and compares spellings', () => {
		expect(normalizeHex('#ABC')).toBe('#aabbcc');
		expect(sameColor('#ABC', '#aabbcc')).toBe(true);
		expect(sameColor('#abc', '#abd')).toBe(false);
	});

	it('computes WCAG contrast', () => {
		expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
		expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
		expect(contrastRatio('nope', '#fff')).toBeNull();
	});
});

describe('isBaseInk', () => {
	it('catches near black and near white', () => {
		for (const c of ['#000000', '#1f1f1f', '#1a1a1a', '#303030', '#ffffff', '#e0e0e0', '#f5f5f0']) {
			expect(isBaseInk(c)).toBe(true);
		}
	});

	it('leaves real colours alone', () => {
		for (const c of ['#ff0000', '#e6b800', '#fff59d', '#1f2a60', '#313131', '#808080', '#dfdfdf']) {
			expect(isBaseInk(c)).toBe(false);
		}
	});
});

describe('renderColor', () => {
	const { light, dark } = DEFAULT_PAGE_THEMES;

	it('maps base ink to the theme base ink', () => {
		expect(renderColor('#000000', dark)).toBe('#ffffff');
		expect(renderColor('#ffffff', light)).toBe('#1a1a1a');
		expect(renderColor('#1f1f1f', light)).toBe('#1a1a1a');
	});

	it('renders every other colour exactly as stored', () => {
		expect(renderColor('#E53935', dark)).toBe('#E53935');
		expect(renderColor('#e6b800', light)).toBe('#e6b800');
	});

	it('keeps PDF pages light whatever the view says', () => {
		expect(themeForPage('pdf', 'dark')).toBe('light');
		expect(themeForPage('inserted', 'dark')).toBe('dark');
		expect(themeForPage('inserted', 'light')).toBe('light');
	});
});

describe('theme overrides', () => {
	it('is the defaults with nothing stored', () => {
		expect(effectiveThemes(undefined)).toEqual(DEFAULT_PAGE_THEMES);
		expect(effectiveThemes({})).toEqual(DEFAULT_PAGE_THEMES);
	});

	it('lays a partial override over the defaults', () => {
		const themes = effectiveThemes({ dark: { paper: '#101820' } });
		expect(themes.dark).toEqual({ ...DEFAULT_PAGE_THEMES.dark, paper: '#101820' });
		expect(themes.light).toEqual(DEFAULT_PAGE_THEMES.light);
	});

	it('falls back to the default for an invalid hex', () => {
		const themes = effectiveThemes({
			light: { paper: 'white', grid: '#12', baseInk: '#222222' },
		});
		expect(themes.light.paper).toBe(DEFAULT_PAGE_THEMES.light.paper);
		expect(themes.light.grid).toBe(DEFAULT_PAGE_THEMES.light.grid);
		expect(themes.light.baseInk).toBe('#222222');
	});

	it('stores only valid, normalised values', () => {
		expect(
			readThemeOverrides({ light: { paper: '#FFF', grid: 7 }, dark: 'x', other: {} }),
		).toEqual({ light: { paper: '#ffffff' }, dark: {} });
	});
});

describe('highlighter blend', () => {
	it('multiplies on light paper and screens on dark paper', () => {
		expect(highlighterBlend(DEFAULT_PAGE_THEMES.light.paper)).toBe('multiply');
		expect(highlighterBlend(DEFAULT_PAGE_THEMES.dark.paper)).toBe('screen');
	});

	it('goes by luminance, not by which theme the paper belongs to', () => {
		expect(highlighterBlend('#f4ecd8')).toBe('multiply'); // sepia "dark" paper choice
		expect(highlighterBlend('#2a2a40')).toBe('screen');
		expect(isDarkPaper('#808080')).toBe(false);
		expect(isDarkPaper('#606060')).toBe(true);
	});
});

describe('hasLowContrast', () => {
	it('is fine for the defaults and flags a faint ink', () => {
		expect(hasLowContrast(DEFAULT_PAGE_THEMES.light)).toBe(false);
		expect(hasLowContrast(DEFAULT_PAGE_THEMES.dark)).toBe(false);
		expect(hasLowContrast({ paper: '#1e1e1e', grid: '#000', baseInk: '#444444' })).toBe(true);
	});
});
