import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { segmentBlocks } from '../core/blocks';
import { insertedGeometry } from '../core/page-composition';
import type { InsertedPage } from '../core/pages';
import { DEFAULT_PEN, createStroke } from '../core/stroke';
import { rasterisePage } from './raster';
import type { SourcePage } from './sources';

/** A canvas that records what is drawn on it. */
function fakeCanvas(log: string[]): HTMLCanvasElement {
	const ctx = {
		fillStyle: '',
		strokeStyle: '',
		lineWidth: 1,
		font: '',
		textBaseline: '',
		globalAlpha: 1,
		globalCompositeOperation: 'source-over',
		fillRect: () => log.push('fillRect'),
		strokeRect: () => log.push('strokeRect'),
		fill: () => log.push('fill'),
		fillText: (text: string) => log.push(`text:${text}`),
		measureText: (text: string) => ({ width: text.length * 7 }),
		save: () => undefined,
		restore: () => undefined,
		transform: () => undefined,
		getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(200) }),
		putImageData: () => log.push('grayscale'),
	};
	return { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

class FakePath2D {
	moveTo(): void {}
	lineTo(): void {}
	quadraticCurveTo(): void {}
	closePath(): void {}
}

const page: InsertedPage = {
	id: 'p1',
	afterPdfPage: -1,
	sortKey: 'a0',
	template: 'grid5',
	size: { width: 612, height: 792 },
	updatedAt: 1,
};

function sourcePage(): SourcePage {
	const stroke = createStroke(DEFAULT_PEN, 's1', 1);
	stroke.points.push([100, 700, 1], [200, 705, 1]);
	return { number: 1, key: 'ins:p1', geometry: insertedGeometry(page), items: [stroke] };
}

describe('rasterising a page for transcription', () => {
	let log: string[];
	beforeEach(() => {
		log = [];
		vi.stubGlobal('Path2D', FakePath2D);
		vi.stubGlobal('createEl', () => fakeCanvas(log));
		// The document's own createEl appends to the document, which already has
		// its one element: the real one throws, and so does this one.
		vi.stubGlobal('activeDocument', {
			createEl: () => {
				throw new Error('HierarchyRequestError: Only one element on document allowed.');
			},
		});
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('draws a notebook page at 150 dpi, in grey, with its blocks outlined and labelled', async () => {
		const p = sourcePage();
		const blocks = segmentBlocks(p.items);
		const raster = await rasterisePage(p, { scale: 150 / 72, grayscale: true, blocks });
		expect(raster.canvas.width).toBe(Math.ceil(612 * (150 / 72)));
		expect(raster.canvas.height).toBe(Math.ceil(792 * (150 / 72)));
		expect(log).toContain('fill');
		expect(log).toContain('grayscale');
		expect(log).toContain('strokeRect');
		expect(log).toContain('text:B1');
		// The outlines go on after the page turns grey, so they keep their colour.
		expect(log.indexOf('grayscale')).toBeLessThan(log.indexOf('strokeRect'));
	});

	it('scales down a page too large for the pixel budget, and says by how much', async () => {
		const raster = await rasterisePage(sourcePage(), { scale: 150 / 72, maxPixels: 100_000 });
		expect(raster.canvas.width * raster.canvas.height).toBeLessThanOrEqual(100_000 * 1.01);
		expect(raster.scale).toBeLessThan(150 / 72);
	});
});
