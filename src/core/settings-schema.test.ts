import { describe, expect, it } from 'vitest';
import {
	DEFAULT_EXPORT_SUFFIX,
	DEFAULT_SETTINGS,
	SIZED_TOOLS,
	mergeSettings,
} from './settings-schema';
import { COLOURED_TOOLS } from './tools';

describe('mergeSettings', () => {
	it('returns the defaults for a first run', () => {
		expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
		expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
		expect(mergeSettings({})).toEqual(DEFAULT_SETTINGS);
	});

	it('keeps a stored per-tool colour', () => {
		const merged = mergeSettings({
			toolColors: {
				pen: '#ff0000',
				highlighter: '#00ff00',
				shape: '#0000ff',
				text: '#123456',
			},
		});
		expect(merged.toolColors).toEqual({
			pen: '#ff0000',
			highlighter: '#00ff00',
			shape: '#0000ff',
			text: '#123456',
		});
	});

	it('fills in a tool the stored file predates, rather than dropping it', () => {
		// A settings file written before the shape tool existed.
		const merged = mergeSettings({ toolColors: { pen: '#ff0000' } });
		expect(merged.toolColors.pen).toBe('#ff0000');
		expect(merged.toolColors.highlighter).toBe(
			DEFAULT_SETTINGS.toolColors.highlighter,
		);
		expect(merged.toolColors.shape).toBe(DEFAULT_SETTINGS.toolColors.shape);
		expect(merged.toolColors.text).toBe(DEFAULT_SETTINGS.toolColors.text);
	});

	it('covers every coloured tool', () => {
		const merged = mergeSettings({});
		for (const tool of COLOURED_TOOLS) {
			expect(typeof merged.toolColors[tool]).toBe('string');
		}
	});

	it('ignores junk values instead of storing them', () => {
		const merged = mergeSettings({
			defaultZoomMode: 'sideways',
			bufferPages: 'many',
			toolColors: { pen: 42, highlighter: '', shape: null },
		});
		expect(merged).toEqual(DEFAULT_SETTINGS);
	});

	it('clamps bufferPages into range', () => {
		expect(mergeSettings({ bufferPages: 99 }).bufferPages).toBe(3);
		expect(mergeSettings({ bufferPages: -5 }).bufferPages).toBe(0);
		expect(mergeSettings({ bufferPages: 2 }).bufferPages).toBe(2);
	});

	it('accepts both zoom modes', () => {
		expect(mergeSettings({ defaultZoomMode: 'actual-size' }).defaultZoomMode).toBe(
			'actual-size',
		);
		expect(mergeSettings({ defaultZoomMode: 'fit-width' }).defaultZoomMode).toBe(
			'fit-width',
		);
	});

	it('does not alias the defaults, so a later edit cannot corrupt them', () => {
		const merged = mergeSettings({});
		merged.toolColors.pen = '#abcdef';
		expect(DEFAULT_SETTINGS.toolColors.pen).not.toBe('#abcdef');
	});
});

describe('eraser settings', () => {
	it('defaults to whole-stroke mode', () => {
		expect(DEFAULT_SETTINGS.eraserMode).toBe('stroke');
	});

	it('keeps a stored mode', () => {
		expect(mergeSettings({ eraserMode: 'sized' }).eraserMode).toBe('sized');
		expect(mergeSettings({ eraserMode: 'stroke' }).eraserMode).toBe('stroke');
	});

	it('ignores an unknown mode', () => {
		expect(mergeSettings({ eraserMode: 'nibble' }).eraserMode).toBe('stroke');
	});

	it('keeps a stored radius and clamps it to the slider range', () => {
		expect(mergeSettings({ eraserRadiusPx: 30 }).eraserRadiusPx).toBe(30);
		expect(mergeSettings({ eraserRadiusPx: 500 }).eraserRadiusPx).toBe(60);
		expect(mergeSettings({ eraserRadiusPx: 0 }).eraserRadiusPx).toBe(4);
	});

	it('ignores a non-numeric radius', () => {
		expect(mergeSettings({ eraserRadiusPx: 'wide' }).eraserRadiusPx).toBe(
			DEFAULT_SETTINGS.eraserRadiusPx,
		);
	});
});

describe('tool widths', () => {
	it('defaults to one per sized tool', () => {
		for (const tool of SIZED_TOOLS) {
			expect(typeof DEFAULT_SETTINGS.toolWidths[tool]).toBe('number');
		}
	});

	it('keeps a stored width', () => {
		expect(mergeSettings({ toolWidths: { pen: 6 } }).toolWidths.pen).toBe(6);
	});

	it('fills in a tool the stored file predates', () => {
		const merged = mergeSettings({ toolWidths: { pen: 6 } });
		expect(merged.toolWidths.highlighter).toBe(
			DEFAULT_SETTINGS.toolWidths.highlighter,
		);
	});

	it('clamps a width to its tool range', () => {
		// The pen tops out at 12 and the highlighter starts at 8.
		expect(mergeSettings({ toolWidths: { pen: 999 } }).toolWidths.pen).toBe(12);
		expect(
			mergeSettings({ toolWidths: { highlighter: 1 } }).toolWidths.highlighter,
		).toBe(8);
	});

	it('clamps the text size and the eraser reach', () => {
		expect(mergeSettings({ textFontSize: 500 }).textFontSize).toBe(72);
		expect(mergeSettings({ textFontSize: 1 }).textFontSize).toBe(6);
		expect(mergeSettings({ eraserWidth: 999 }).eraserWidth).toBe(48);
	});
});

describe('export settings', () => {
	it('defaults to flattening with the standard suffix', () => {
		expect(DEFAULT_SETTINGS.exportMode).toBe('flatten');
		expect(DEFAULT_SETTINGS.exportSuffix).toBe(DEFAULT_EXPORT_SUFFIX);
	});

	it('keeps a stored mode and rejects nonsense', () => {
		expect(mergeSettings({ exportMode: 'native' }).exportMode).toBe('native');
		expect(mergeSettings({ exportMode: 'sideways' }).exportMode).toBe('flatten');
	});

	it('keeps a stored suffix', () => {
		expect(mergeSettings({ exportSuffix: '-marked' }).exportSuffix).toBe('-marked');
	});

	it('refuses an empty suffix, which would overwrite the original', () => {
		for (const suffix of ['', '	  ']) {
			expect(mergeSettings({ exportSuffix: suffix }).exportSuffix).toBe(
				DEFAULT_EXPORT_SUFFIX,
			);
		}
	});
});

describe('palm rejection', () => {
	it('is on by default', () => {
		expect(DEFAULT_SETTINGS.palmRejection).toBe(true);
	});

	it('can be turned off, and ignores non-booleans', () => {
		expect(mergeSettings({ palmRejection: false }).palmRejection).toBe(false);
		expect(mergeSettings({ palmRejection: 'yes' }).palmRejection).toBe(true);
	});
});

describe('penSeen', () => {
	it('starts false, so touch drawing works before a stylus appears', () => {
		expect(DEFAULT_SETTINGS.penSeen).toBe(false);
		expect(mergeSettings({}).penSeen).toBe(false);
	});

	it('is remembered once a stylus has been used', () => {
		// The point of persisting it: palm rejection can only arm after a pen has
		// been seen, and relearning that per tab let the first palm draw a blob.
		expect(mergeSettings({ penSeen: true }).penSeen).toBe(true);
	});

	it('ignores a non-boolean', () => {
		expect(mergeSettings({ penSeen: 'yes' }).penSeen).toBe(false);
		expect(mergeSettings({ penSeen: 1 }).penSeen).toBe(false);
	});
});

describe('inputDiagnostics', () => {
	it('is off by default', () => {
		expect(DEFAULT_SETTINGS.inputDiagnostics).toBe(false);
		expect(mergeSettings({}).inputDiagnostics).toBe(false);
	});

	it('round-trips', () => {
		expect(mergeSettings({ inputDiagnostics: true }).inputDiagnostics).toBe(true);
	});

	it('ignores a non-boolean', () => {
		expect(mergeSettings({ inputDiagnostics: 'on' }).inputDiagnostics).toBe(
			false,
		);
	});
});

describe('toolbarSide', () => {
	it('defaults to the left', () => {
		expect(DEFAULT_SETTINGS.toolbarSide).toBe('left');
		expect(mergeSettings({}).toolbarSide).toBe('left');
	});

	it('accepts either edge', () => {
		expect(mergeSettings({ toolbarSide: 'right' }).toolbarSide).toBe('right');
		expect(mergeSettings({ toolbarSide: 'left' }).toolbarSide).toBe('left');
	});

	it('ignores anything else', () => {
		for (const side of ['top', 'bottom', '', 3, null]) {
			expect(mergeSettings({ toolbarSide: side }).toolbarSide).toBe('left');
		}
	});
});

describe('openByDefault', () => {
	it('defaults to on', () => {
		expect(DEFAULT_SETTINGS.openByDefault).toBe(true);
		expect(mergeSettings({}).openByDefault).toBe(true);
	});

	it('keeps a stored choice', () => {
		expect(mergeSettings({ openByDefault: false }).openByDefault).toBe(false);
		expect(mergeSettings({ openByDefault: true }).openByDefault).toBe(true);
	});

	it('ignores anything that is not a boolean', () => {
		for (const value of ['false', 0, null, {}]) {
			expect(mergeSettings({ openByDefault: value }).openByDefault).toBe(true);
		}
	});
});

describe('zoomLocked', () => {
	it('defaults to unlocked', () => {
		expect(DEFAULT_SETTINGS.zoomLocked).toBe(false);
		expect(mergeSettings({}).zoomLocked).toBe(false);
	});

	it('keeps a stored choice', () => {
		expect(mergeSettings({ zoomLocked: true }).zoomLocked).toBe(true);
	});

	it('ignores anything that is not a boolean', () => {
		for (const value of ['true', 1, null]) {
			expect(mergeSettings({ zoomLocked: value }).zoomLocked).toBe(false);
		}
	});
});
