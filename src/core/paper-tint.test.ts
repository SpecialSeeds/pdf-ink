import { describe, expect, it } from 'vitest';
import {
	DEFAULT_TINT_COLOR,
	DEFAULT_TINT_STRENGTH,
	type PaperTint,
	clampTintStrength,
	paperTintStyle,
	underTint,
} from './paper-tint';
import { DEFAULT_SETTINGS, mergeSettings } from './settings-schema';

const beige: PaperTint = { enabled: true, color: DEFAULT_TINT_COLOR, strength: 1 };

describe('the paper tint', () => {
	it('turns white paper the tint colour at full strength, and keeps black black', () => {
		expect(underTint('#ffffff', beige)).toBe(DEFAULT_TINT_COLOR);
		expect(underTint('#000000', beige)).toBe('#000000');
	});

	it('shows only part of the tint at lower strength', () => {
		const half = underTint('#ffffff', { ...beige, strength: 0.5 });
		// Between white and the tint, channel by channel.
		expect(half).toBe('#f9f1e3');
	});

	it('warms a colour without changing its hue family', () => {
		const red = underTint('#e71225', beige);
		const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(red.slice(i, i + 2), 16));
		// 231 x 242 / 255: a little darker, and still unmistakably red.
		expect(r).toBe(219);
		expect(r).toBeGreaterThan((g ?? 0) * 5);
		expect(r).toBeGreaterThan((b ?? 0) * 5);
	});

	it('gives the layer its colour and strength, and repairs bad values', () => {
		expect(paperTintStyle({ enabled: true, color: '#ABC', strength: 0.4 })).toEqual({
			'--pdf-ink-tint-color': '#aabbcc',
			'--pdf-ink-tint-strength': '0.4',
		});
		expect(paperTintStyle({ enabled: true, color: 'beige', strength: 5 })).toEqual({
			'--pdf-ink-tint-color': DEFAULT_TINT_COLOR,
			'--pdf-ink-tint-strength': '1',
		});
		expect(clampTintStrength(0)).toBe(0.1);
		expect(clampTintStrength(Number.NaN)).toBe(DEFAULT_TINT_STRENGTH);
	});
});

describe('paper tint settings', () => {
	it('are off by default, in beige at 60%', () => {
		expect(DEFAULT_SETTINGS.paperTint).toBe(false);
		expect(DEFAULT_SETTINGS.paperTintColor).toBe(DEFAULT_TINT_COLOR);
		expect(DEFAULT_SETTINGS.paperTintStrength).toBe(0.6);
	});

	it('keep what was chosen and drop what is not a colour or a strength', () => {
		const merged = mergeSettings({ paperTint: true, paperTintColor: '#FFEEDD', paperTintStrength: 0.35 });
		expect(merged).toMatchObject({ paperTint: true, paperTintColor: '#ffeedd', paperTintStrength: 0.35 });
		const junk = mergeSettings({ paperTint: 'yes', paperTintColor: 'sand', paperTintStrength: 7 });
		expect(junk).toMatchObject({ paperTint: false, paperTintColor: DEFAULT_TINT_COLOR, paperTintStrength: 1 });
	});
});
