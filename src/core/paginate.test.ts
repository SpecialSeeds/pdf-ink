import { describe, expect, it } from 'vitest';
import type { ShapeItem, Stroke, StrokeSample, TextItem } from './items';
import {
	LETTER_HEIGHT,
	LETTER_WIDTH,
	chooseBreak,
	paginate,
	splitColumns,
	itemExtent,
	type PaginatedPage,
} from './paginate';

function stroke(id: string, points: [number, number][], width = 2): Stroke {
	return {
		type: 'stroke',
		id,
		tool: 'pen',
		color: '#111',
		opacity: 1,
		rotation: 0,
		z: 0,
		updatedAt: 0,
		width,
		points: points.map(([x, y]): StrokeSample => [x, y, 0.5]),
	};
}

/** A line of "handwriting": a horizontal stroke from `x0` to `x1` at `y`. */
function textLine(id: string, y: number, x0 = 72, x1 = 540): Stroke {
	return stroke(id, [
		[x0, y],
		[(x0 + x1) / 2, y + 4],
		[x1, y],
	]);
}

/** Lines every `spacing` points from `top` down to `bottom`. */
function paragraph(prefix: string, top: number, bottom: number, spacing = 24, x0?: number, x1?: number): Stroke[] {
	const lines: Stroke[] = [];
	for (let y = top, i = 0; y >= bottom; y -= spacing, i++) {
		lines.push(textLine(`${prefix}${i}`, y, x0, x1));
	}
	return lines;
}

/** A boxed diagram between `bottom` and `top`, with a label and an arrow. */
function diagram(bottom: number, top: number): Stroke[] {
	return [
		stroke('box', [
			[150, bottom],
			[450, bottom],
			[450, top],
			[150, top],
			[150, bottom],
		]),
		stroke('label', [
			[200, top - 20],
			[300, top - 20],
		]),
		stroke('arrow', [
			[200, top - 60],
			[400, bottom + 20],
		]),
		stroke('circle', [
			[300, bottom + 40],
			[330, bottom + 70],
			[300, bottom + 100],
			[270, bottom + 70],
			[300, bottom + 40],
		]),
	];
}

function textBox(id: string, x: number, y: number, w: number, h: number): TextItem {
	return {
		type: 'text',
		id,
		color: '#111',
		opacity: 1,
		rotation: 0,
		z: 0,
		updatedAt: 0,
		box: { x, y, w, h },
		text: 'note',
		fontSize: 12,
	};
}

function rectShape(id: string, x: number, y: number, w: number, h: number): ShapeItem {
	return {
		type: 'shape',
		id,
		kind: 'rect',
		color: '#111',
		opacity: 1,
		rotation: 0,
		z: 0,
		updatedAt: 0,
		box: { x, y, w, h },
		width: 2,
		fill: null,
	};
}

/** The page's mapped copy of stroke `id`. */
function mappedStroke(page: PaginatedPage | undefined, id: string): Stroke | undefined {
	const item = page?.items.find((i) => i.id === id);
	return item?.type === 'stroke' ? item : undefined;
}

function pageOf(result: ReturnType<typeof paginate>, id: string): number {
	return result.pages.findIndex((page) => page.items.some((s) => s.id === id));
}

function allIds(result: ReturnType<typeof paginate>): string[] {
	return result.pages.flatMap((page) => page.items.map((s) => s.id));
}

function expectOnPage(result: ReturnType<typeof paginate>, margin = 36): void {
	for (const page of result.pages) {
		for (const s of page.items) {
			const b = itemExtent(s);
			expect(b).not.toBeNull();
			if (!b) continue;
			expect(b.minX).toBeGreaterThanOrEqual(margin - 1e-6);
			expect(b.maxX).toBeLessThanOrEqual(LETTER_WIDTH - margin + 1e-6);
			expect(b.minY).toBeGreaterThanOrEqual(margin - 1e-6);
			expect(b.maxY).toBeLessThanOrEqual(LETTER_HEIGHT - margin + 1e-6);
		}
	}
}

describe('paginate', () => {
	it('keeps a diagram straddling 792 pt whole on one page', () => {
		// Two letter pages tall. Writing runs down to y = 920, then the diagram
		// spans y = 712..872, right across the naive page line at 792.
		const strokes = [...paragraph('t', 1548, 920), ...diagram(712, 872)];
		const result = paginate(strokes);

		const diagramPage = pageOf(result, 'box');
		expect(diagramPage).toBeGreaterThan(0);
		for (const id of ['label', 'arrow', 'circle']) {
			expect(pageOf(result, id)).toBe(diagramPage);
		}
		for (const s of strokes.filter((s) => s.id.startsWith('t'))) {
			expect(pageOf(result, s.id)).toBe(0);
		}
		expect(result.pages).toHaveLength(2);
		expectOnPage(result);
	});

	it('never splits a stroke and places every stroke exactly once', () => {
		const strokes = [...paragraph('a', 3000, 40, 18), ...diagram(1400, 1700)];
		const result = paginate(strokes);
		const ids = allIds(result);
		expect(ids.sort()).toEqual(strokes.map((s) => s.id).sort());
		for (const page of result.pages) {
			for (const original of strokes) {
				const s = mappedStroke(page, original.id);
				if (s) expect(s.points).toHaveLength(original.points.length);
			}
		}
		expectOnPage(result);
	});

	it('breaks at the widest empty band in the bottom of the page', () => {
		// Lines every 20 pt, but a 60 pt gap low on the page: the break goes there,
		// not at the last line that would fit.
		const strokes = [
			...paragraph('a', 1500, 1000, 20),
			...paragraph('b', 940, 400, 20),
		];
		const result = paginate(strokes);
		const firstPage = result.pages[0]?.items.map((s) => s.id) ?? [];
		expect(firstPage.every((id) => id.startsWith('a'))).toBe(true);
		expect(firstPage).toHaveLength(strokes.filter((s) => s.id.startsWith('a')).length);
	});

	it('starts each page at the top margin', () => {
		const result = paginate([...paragraph('a', 3000, 1000)]);
		for (const page of result.pages) {
			const top = Math.max(...page.items.map((s) => itemExtent(s)?.maxY ?? 0));
			expect(top).toBeCloseTo(LETTER_HEIGHT - 36, 6);
		}
	});

	it('scales content wider than the page uniformly to fit the width', () => {
		const strokes = [textLine('wide', 500, 0, 1224), textLine('narrow', 400, 0, 100)];
		const result = paginate(strokes, { canvasWidth: 1224, columns: false });
		expect(result.pages).toHaveLength(1);
		const page = result.pages[0];
		const scale = page?.scale ?? 0;
		expect(scale).toBeCloseTo(540 / 1226, 6);
		const wide = mappedStroke(page, 'wide');
		expect(wide?.width).toBeCloseTo(2 * scale, 6);
		// Vertical distances scale by the same factor.
		const narrow = mappedStroke(page, 'narrow');
		const dy = (wide?.points[0]?.[1] ?? 0) - (narrow?.points[0]?.[1] ?? 0);
		expect(dy).toBeCloseTo(100 * scale, 6);
		expectOnPage(result);
	});

	it('leaves content that fits where it was on the page', () => {
		const result = paginate([textLine('a', 700)]);
		expect(mappedStroke(result.pages[0], 'a')?.points[0]?.[0]).toBeCloseTo(72, 6);
	});

	it('scales a page down to fit a stroke taller than the page', () => {
		const tall = stroke('tall', [
			[300, 2000],
			[310, 100],
		], 4);
		const result = paginate([tall, textLine('after', 50)], { columns: false });
		expect(allIds(result).sort()).toEqual(['after', 'tall']);

		const page = result.pages[pageOf(result, 'tall')];
		const scale = page?.scale ?? 0;
		expect(scale).toBeCloseTo(720 / 1904, 6);
		const mapped = page?.items.find((i) => i.id === 'tall');
		expect(mapped?.type === 'stroke' && mapped.width).toBeCloseTo(4 * scale, 6);
		expectOnPage(result);
	});

	it('scales a page down to fit a text box taller than the page', () => {
		const result = paginate([textBox('long', 72, 100, 300, 1500)]);
		const page = result.pages[0];
		const scale = page?.scale ?? 0;
		expect(scale).toBeCloseTo(720 / 1500, 6);
		const mapped = page?.items[0];
		expect(mapped?.type === 'text' && mapped.fontSize).toBeCloseTo(12 * scale, 6);
		expectOnPage(result);
	});

	it('skips deleted strokes', () => {
		const gone = { ...textLine('gone', 500), deletedAt: 1 };
		expect(allIds(paginate([gone, textLine('kept', 400)]))).toEqual(['kept']);
	});

	it('is empty for an empty canvas', () => {
		expect(paginate([]).pages).toEqual([]);
	});
});

describe('paginate with text boxes and shapes', () => {
	it('moves a text box straddling a break whole to the next page', () => {
		// Writing down to y = 920, then a text box across the naive line at 792.
		const strokes = paragraph('t', 1548, 920);
		const box = textBox('note', 100, 740, 300, 120);
		const result = paginate([...strokes, box]);
		expect(result.pages).toHaveLength(2);
		expect(pageOf(result, 'note')).toBe(1);
		const mapped = result.pages[1]?.items.find((i) => i.id === 'note');
		expect(mapped?.type === 'text' && mapped.box.h).toBeCloseTo(120, 6);
		expectOnPage(result);
	});

	it('keeps a text box and the ink beside it on the same page', () => {
		// Two sketches with an empty band between them, bridged only by a text
		// box beside them. Were the box not in the profile, the break would fall
		// in that band and part a sketch from its caption.
		// The page window ends near y = 833. The band between the sketches (58 pt)
		// is wider than the one above them (44 pt) and lies wholly inside it.
		const strokes = paragraph('t', 1548, 980);
		const upper = stroke('upper', [
			[350, 950],
			[500, 900],
		]);
		const lower = stroke('lower', [
			[350, 840],
			[500, 700],
		]);
		const box = textBox('caption', 80, 830, 200, 80);
		const result = paginate([...strokes, upper, lower, box]);
		expect(pageOf(result, 'caption')).toBe(1);
		expect(pageOf(result, 'upper')).toBe(1);
		expect(pageOf(result, 'lower')).toBe(1);
		expectOnPage(result);
	});

	it('moves a shape whole and scales its outline with the page', () => {
		const strokes = [textLine('wide', 1500, 0, 1224), ...paragraph('t', 1476, 920, 24, 0, 1224)];
		const shape = rectShape('frame', 100, 700, 400, 200);
		const result = paginate([...strokes, shape], { canvasWidth: 1224, columns: false });
		const page = result.pages[pageOf(result, 'frame')];
		const mapped = page?.items.find((i) => i.id === 'frame');
		expect(mapped?.type === 'shape' && mapped.width).toBeCloseTo(2 * (page?.scale ?? 0), 6);
		expect(mapped?.type === 'shape' && mapped.box.w).toBeCloseTo(400 * (page?.scale ?? 0), 6);
		expect(allIds(result).filter((id) => id === 'frame')).toHaveLength(1);
		expectOnPage(result);
	});
});

describe('chooseBreak', () => {
	it('falls back to the row with the least ink when no row is empty', () => {
		// Two thick bands joined only by a thin stroke through y = 145..155.
		const strokes = [
			stroke('upper', [[0, 165], [100, 199]], 20),
			stroke('waist', [[50, 140], [50, 170]], 1),
			stroke('lower', [[0, 100], [100, 135]], 20),
		];
		const line = chooseBreak(strokes, 200, 100, 1, 0.6);
		expect(line).toBeLessThan(155);
		expect(line).toBeGreaterThan(145);
	});

	it('takes the lower of two equally wide bands', () => {
		// A 100-row page searched from row 65. Stroke b ends on row 65 and c fills
		// rows 75..90, leaving empty runs 66..74 and 91..99: nine rows each.
		const strokes = [
			stroke('a', [[0, 95], [10, 90]]),
			stroke('b', [[0, 70], [10, 36]]),
			stroke('c', [[0, 24], [10, 11]]),
		];
		expect(chooseBreak(strokes, 100, 100, 1, 0.35)).toBeCloseTo(4.5, 6);
	});
});

describe('splitColumns', () => {
	it('splits at a long vertical divider and drops it', () => {
		const divider = stroke('divider', [
			[612, 1500],
			[614, 100],
		]);
		const strokes = [
			...paragraph('L', 1480, 120, 24, 40, 590),
			...paragraph('R', 1480, 120, 24, 634, 1180),
			divider,
		];
		const { columns, dividers } = splitColumns(strokes, { canvasWidth: 1224 });
		expect(dividers.map((s) => s.id)).toEqual(['divider']);
		expect(columns).toHaveLength(2);
		expect(columns[0]?.items.every((s) => s.id.startsWith('L'))).toBe(true);
		expect(columns[1]?.items.every((s) => s.id.startsWith('R'))).toBe(true);
	});

	it('splits at an empty gutter', () => {
		const strokes = [
			...paragraph('L', 800, 100, 24, 40, 500),
			...paragraph('R', 800, 100, 24, 620, 1180),
		];
		const { columns, dividers } = splitColumns(strokes, { canvasWidth: 1224 });
		expect(dividers).toEqual([]);
		expect(columns.map((c) => c.items.length)).toEqual([30, 30]);
	});

	it('does not split at a gap narrower than the gutter', () => {
		const strokes = [
			...paragraph('L', 800, 100, 24, 40, 290),
			...paragraph('R', 800, 100, 24, 310, 560),
		];
		expect(splitColumns(strokes).columns).toHaveLength(1);
	});

	it('does not treat a long line at the edge as a divider', () => {
		const rule = stroke('rule', [
			[20, 800],
			[20, 100],
		]);
		const strokes = [...paragraph('a', 800, 100, 24, 72, 540), rule];
		const { columns, dividers } = splitColumns(strokes);
		expect(dividers).toEqual([]);
		expect(columns).toHaveLength(1);
	});
});

describe('paginate with columns', () => {
	it('paginates the columns left to right', () => {
		const divider = stroke('divider', [
			[612, 2400],
			[612, 100],
		]);
		const strokes = [
			...paragraph('R', 2380, 120, 24, 634, 1180),
			...paragraph('L', 2380, 120, 24, 40, 590),
			divider,
		];
		const result = paginate(strokes, { canvasWidth: 1224 });
		const columnOrder = result.pages.map((p) => p.column);
		expect(columnOrder).toEqual([...columnOrder].sort((a, b) => a - b));
		expect(result.pages[0]?.items[0]?.id.startsWith('L')).toBe(true);
		expect(allIds(result)).not.toContain('divider');
		expect(result.pages.length).toBeGreaterThanOrEqual(6);
		expectOnPage(result);
	});
});

describe('a first page that starts lower', () => {
	it('starts only the first page at the inset, and keeps it inside the page', () => {
		const result = paginate(paragraph('a', 3000, 40, 18), { firstPageInset: 72 });
		const tops = result.pages.map((page) => Math.max(...page.items.map((i) => itemExtent(i)?.maxY ?? 0)));
		expect(tops[0]).toBeCloseTo(792 - 72, 6);
		for (const top of tops.slice(1)) expect(top).toBeCloseTo(792 - 36, 6);
		expectOnPage(result);
	});
});
