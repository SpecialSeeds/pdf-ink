import { describe, expect, it, vi } from 'vitest';
import type { Item, PathItem, ShapeItem, TextItem } from '../core/items';
import { pathCommands } from '../core/path';
import { syntheticViewport } from '../core/page-viewport';
import { DEFAULT_PAGE_THEMES } from '../core/theme';
import { DEFAULT_PEN, createStroke } from '../core/stroke';
import { HIGHLIGHTER_OPACITY } from '../core/tools';
import { ITEM_RENDERERS, layerFor, rendererFor } from './item-renderers';

const pen: Item = createStroke(DEFAULT_PEN, 'pen');
const highlighter: Item = createStroke(
	{ tool: 'highlighter', color: '#ffe066', width: 16, opacity: HIGHLIGHTER_OPACITY },
	'hl',
);
const shape: ShapeItem = {
	type: 'shape',
	id: 's',
	color: '#000',
	opacity: 1,
	rotation: 0,
	z: 0,
	updatedAt: 0,
	kind: 'rect',
	box: { x: 0, y: 0, w: 1, h: 1 },
	width: 1,
	fill: null,
};
const text: TextItem = {
	type: 'text',
	id: 't',
	color: '#000',
	opacity: 1,
	rotation: 0,
	z: 0,
	updatedAt: 0,
	box: { x: 0, y: 0, w: 1, h: 1 },
	text: 'hi',
	fontSize: 12,
};

describe('layerFor', () => {
	it('puts highlighter ink on the multiply layer', () => {
		expect(layerFor(highlighter)).toBe('highlight');
	});

	it('puts pen ink on the opaque layer', () => {
		expect(layerFor(pen)).toBe('ink');
	});

	it('defaults other item types to the opaque layer', () => {
		expect(layerFor(shape)).toBe('ink');
		expect(layerFor(text)).toBe('ink');
	});
});

describe('per-type renderer dispatch', () => {
	it('resolves a renderer for strokes', () => {
		expect(typeof rendererFor(pen)).toBe('function');
		expect(typeof rendererFor(highlighter)).toBe('function');
	});

	it('resolves a renderer for shapes', () => {
		expect(typeof rendererFor(shape)).toBe('function');
	});

	it('resolves a renderer for text', () => {
		expect(typeof rendererFor(text)).toBe('function');
	});

	it('covers every item type in the schema', () => {
		expect(Object.keys(ITEM_RENDERERS).sort()).toEqual([
			'path',
			'shape',
			'stroke',
			'text',
		]);
	});
});

describe('path rendering', () => {
	/** Records the commands a Path2D receives. */
	class RecordingPath {
		readonly ops: [string, ...number[]][] = [];
		moveTo(x: number, y: number): void {
			this.ops.push(['M', x, y]);
		}
		lineTo(x: number, y: number): void {
			this.ops.push(['L', x, y]);
		}
		bezierCurveTo(...n: number[]): void {
			this.ops.push(['C', ...n]);
		}
		closePath(): void {
			this.ops.push(['Z']);
		}
	}

	interface Recorded {
		matrix: number[];
		fills: { path: RecordingPath; style: string; alpha: number }[];
		strokes: { path: RecordingPath; width: number }[];
	}

	function recordingContext(): { ctx: CanvasRenderingContext2D; recorded: Recorded } {
		const recorded: Recorded = { matrix: [1, 0, 0, 1, 0, 0], fills: [], strokes: [] };
		const state = { fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1 };
		const ctx = {
			...state,
			save: () => undefined,
			restore: () => undefined,
			transform: (...m: number[]) => {
				recorded.matrix = m;
			},
			fill(this: typeof state, path: RecordingPath) {
				recorded.fills.push({ path, style: this.fillStyle, alpha: this.globalAlpha });
			},
			stroke(this: typeof state, path: RecordingPath) {
				recorded.strokes.push({ path, width: this.lineWidth });
			},
		};
		return { ctx: ctx as unknown as CanvasRenderingContext2D, recorded };
	}

	const path: PathItem = {
		type: 'path',
		id: 'p',
		color: '#000000',
		opacity: 0.8,
		rotation: 0,
		z: 0,
		updatedAt: 0,
		d: 'M100 700L200 700C220 720 240 740 260 760Z',
	};

	it('draws the stored geometry exactly where the viewport puts it', () => {
		vi.stubGlobal('Path2D', RecordingPath);
		try {
			const viewport = syntheticViewport(612, 792, 1.5);
			const { ctx, recorded } = recordingContext();
			rendererFor(path)?.(path, { ctx, viewport, scale: 1.5, theme: DEFAULT_PAGE_THEMES.light });

			expect(recorded.fills).toHaveLength(1);
			const fill = recorded.fills[0];
			expect(fill?.alpha).toBe(0.8);
			// Base ink takes the theme's ink colour.
			expect(fill?.style).toBe(DEFAULT_PAGE_THEMES.light.baseInk);

			// Every point, sent through the recorded matrix, lands where the
			// viewport itself would put it.
			const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = recorded.matrix;
			const apply = (x: number, y: number): [number, number] => [a * x + c * y + e, b * x + d * y + f];
			const expected = pathCommands(path).flatMap((command) => {
				if (command.op === 'close') return [];
				const points: [number, number][] =
					command.op === 'cubic'
						? [[command.x1, command.y1], [command.x2, command.y2], [command.x, command.y]]
						: [[command.x, command.y]];
				return points.map(([x, y]) => viewport.convertToViewportPoint(x, y));
			});
			const drawn = (fill?.path.ops ?? []).flatMap(([, ...n]) => {
				const out: [number, number][] = [];
				for (let i = 0; i + 1 < n.length; i += 2) out.push(apply(n[i] ?? 0, n[i + 1] ?? 0));
				return out;
			});
			expect(drawn).toHaveLength(expected.length);
			drawn.forEach(([x, y], i) => {
				expect(x).toBeCloseTo(expected[i]?.[0] ?? NaN, 6);
				expect(y).toBeCloseTo(expected[i]?.[1] ?? NaN, 6);
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('strokes an outline path at its width in PDF points', () => {
		vi.stubGlobal('Path2D', RecordingPath);
		try {
			const { ctx, recorded } = recordingContext();
			const outline = { ...path, strokeWidth: 2.5 };
			rendererFor(outline)?.(outline, {
				ctx,
				viewport: syntheticViewport(612, 792, 2),
				scale: 2,
				theme: DEFAULT_PAGE_THEMES.dark,
			});
			expect(recorded.fills).toHaveLength(0);
			expect(recorded.strokes.map((s) => s.width)).toEqual([2.5]);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('puts highlighter paths on the highlight layer', () => {
		expect(layerFor(path)).toBe('ink');
		expect(layerFor({ ...path, highlight: true })).toBe('highlight');
	});
});
