import { describe, expect, it } from 'vitest';
import { syntheticViewport } from '../core/page-viewport';
import type { InsertedPage } from '../core/pages';
import { templateGeometry, templateSpacing } from '../core/templates';
import { DEFAULT_PAGE_THEMES } from '../core/theme';
import { paintInsertedPage } from './template-painter';

/** Counts the lines each stroke() draws, and the alpha it drew them at. */
function recordingContext(): { ctx: CanvasRenderingContext2D; strokes: { lines: number; alpha: number }[] } {
	const strokes: { lines: number; alpha: number }[] = [];
	let pending = 0;
	const ctx = {
		globalAlpha: 1,
		setTransform: () => undefined,
		fillRect: () => undefined,
		save: () => undefined,
		restore: () => undefined,
		beginPath: () => {
			pending = 0;
		},
		moveTo: () => {
			pending += 1;
		},
		lineTo: () => undefined,
		arc: () => undefined,
		fill: () => undefined,
		stroke(this: { globalAlpha: number }) {
			strokes.push({ lines: pending, alpha: this.globalAlpha });
		},
	};
	return { ctx: ctx as unknown as CanvasRenderingContext2D, strokes };
}

const page: InsertedPage = {
	id: 'p',
	afterPdfPage: -1,
	sortKey: 'a0',
	template: 'grid5',
	size: { width: 612, height: 792 },
	updatedAt: 0,
};

function paintAt(scale: number): { lines: number; alpha: number }[] {
	const { ctx, strokes } = recordingContext();
	const viewport = syntheticViewport(612, 792, scale);
	paintInsertedPage(ctx, viewport, page, 612 * scale, 792 * scale, [1, 0, 0, 1, 0, 0], DEFAULT_PAGE_THEMES.light);
	return strokes;
}

describe('grid level of detail on screen', () => {
	const all = templateGeometry('grid5', 612, 792).lines;
	const majors = all.filter((l) => l.major).length;
	const spacing = templateSpacing('grid5');

	it('draws only the major lines when the grid is 8 px apart or closer', () => {
		expect(paintAt(6 / spacing)).toEqual([{ lines: majors, alpha: 1 }]);
	});

	it('fades the minor lines in as the page is zoomed', () => {
		expect(paintAt(12 / spacing)).toEqual([
			{ lines: majors, alpha: 1 },
			{ lines: all.length - majors, alpha: expect.closeTo(0.5, 6) as number },
		]);
	});

	it('draws every line at full strength once they are far enough apart', () => {
		expect(paintAt(2)).toEqual([
			{ lines: majors, alpha: 1 },
			{ lines: all.length - majors, alpha: 1 },
		]);
	});
});

describe('the notebook header on screen', () => {
	function paintWithHeader(theme: 'light' | 'dark'): { texts: [string, string][]; strokes: number } {
		const texts: [string, string][] = [];
		let strokes = 0;
		const ctx = {
			globalAlpha: 1,
			fillStyle: '',
			strokeStyle: '',
			lineWidth: 1,
			font: '',
			textBaseline: '',
			setTransform: () => undefined,
			fillRect: () => undefined,
			save: () => undefined,
			restore: () => undefined,
			beginPath: () => undefined,
			moveTo: () => undefined,
			lineTo: () => undefined,
			arc: () => undefined,
			fill: () => undefined,
			stroke: () => {
				strokes += 1;
			},
			fillText(this: { fillStyle: string }, text: string) {
				texts.push([text, this.fillStyle]);
			},
		};
		paintInsertedPage(
			ctx as unknown as CanvasRenderingContext2D,
			syntheticViewport(612, 792, 1.5),
			{ ...page, template: 'blank' },
			918,
			1188,
			[1, 0, 0, 1, 0, 0],
			DEFAULT_PAGE_THEMES[theme],
			{ title: 'Week 2', date: 'Saturday, October 3, 2026  2:02 PM' },
		);
		return { texts, strokes };
	}

	it('draws the title in base ink, the date muted, and a rule, in either theme', () => {
		for (const theme of ['light', 'dark'] as const) {
			const { texts, strokes } = paintWithHeader(theme);
			expect(texts).toEqual([
				['Week 2', DEFAULT_PAGE_THEMES[theme].baseInk],
				['Saturday, October 3, 2026  2:02 PM', DEFAULT_PAGE_THEMES[theme].headerMuted],
			]);
			// A blank page has no ruling: the one stroke is the header's rule.
			expect(strokes).toBe(1);
		}
	});
});
