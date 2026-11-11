import { describe, expect, it } from 'vitest';
import {
	EXPORT_QUALITIES,
	QUALITY_PROFILES,
	formatCoordinate,
	formatFileSize,
	isExportQuality,
	largestPlacements,
	targetPixels,
} from './export-quality';
import { simplifyRing } from './path';
import type { ImageItem } from './items';

function image(id: string, src: string, w: number, h: number, deleted = false): ImageItem {
	return {
		type: 'image',
		id,
		src,
		box: { x: 0, y: 0, w, h },
		color: '#000000',
		opacity: 1,
		rotation: 0,
		z: 0,
		updatedAt: 1,
		...(deleted ? { deletedAt: 2 } : {}),
	};
}

describe('quality levels', () => {
	it('run from super low to ultra high, each coarser than the next', () => {
		expect(EXPORT_QUALITIES[0]).toBe('super-low');
		expect(EXPORT_QUALITIES[EXPORT_QUALITIES.length - 1]).toBe('ultra');
		for (let i = 1; i < EXPORT_QUALITIES.length; i++) {
			const lower = QUALITY_PROFILES[EXPORT_QUALITIES[i - 1] ?? 'ultra'];
			const higher = QUALITY_PROFILES[EXPORT_QUALITIES[i] ?? 'ultra'];
			expect(higher.inkTolerance).toBeLessThan(lower.inkTolerance);
			expect(higher.jpegQuality).toBeGreaterThan(lower.jpegQuality);
		}
	});

	it('ultra keeps everything exactly', () => {
		const ultra = QUALITY_PROFILES.ultra;
		expect(ultra.inkTolerance).toBe(0);
		expect(ultra.decimals).toBeNull();
		expect(ultra.imageDpi).toBeNull();
	});

	it('recognises only its own names', () => {
		expect(isExportQuality('medium')).toBe(true);
		expect(isExportQuality('max')).toBe(false);
		expect(isExportQuality(3)).toBe(false);
	});
});

describe('formatCoordinate', () => {
	it('rounds to the places asked for, or writes the number in full', () => {
		expect(formatCoordinate(12.3456, 2)).toBe('12.35');
		expect(formatCoordinate(12.3456, 1)).toBe('12.3');
		expect(formatCoordinate(12.3456, null)).toBe('12.3456');
		expect(formatCoordinate(-0.001, 2)).toBe('0');
	});
});

describe('targetPixels', () => {
	it('shrinks a picture to the resolution its placed size needs', () => {
		// 144 pt is two inches: 300 px at 150 dpi.
		expect(targetPixels({ width: 3000, height: 1500 }, { w: 144, h: 72 }, 150)).toEqual({
			width: 300,
			height: 150,
		});
	});

	it('never scales a picture up, and keeps it whole at ultra', () => {
		expect(targetPixels({ width: 100, height: 100 }, { w: 720, h: 720 }, 150)).toBeNull();
		expect(targetPixels({ width: 4000, height: 4000 }, { w: 10, h: 10 }, null)).toBeNull();
	});

	it('keeps the aspect ratio, sized by the side that needs the most detail', () => {
		// Placed stretched: the width needs 300 px, the height only 75.
		const size = targetPixels({ width: 1000, height: 1000 }, { w: 144, h: 36 }, 150);
		expect(size).toEqual({ width: 300, height: 300 });
	});
});

describe('largestPlacements', () => {
	it('takes the largest placement of a picture placed twice, ignoring deleted ones', () => {
		const sizes = largestPlacements({
			'pdf:0': [image('a', 'p.png', 100, 50), image('b', 'p.png', 40, 80)],
			'pdf:1': [image('c', 'p.png', 900, 900, true), image('d', 'q.jpg', 10, 10)],
		});
		expect(sizes.get('p.png')).toEqual({ w: 100, h: 80 });
		expect(sizes.get('q.jpg')).toEqual({ w: 10, h: 10 });
	});
});

describe('simplifyRing', () => {
	it('drops vertices on a straight edge and keeps the corners', () => {
		const square: [number, number][] = [
			[0, 0], [5, 0], [10, 0], [10, 5], [10, 10], [5, 10], [0, 10], [0, 5],
		];
		expect(simplifyRing(square, 0.1)).toEqual([[0, 0], [10, 0], [10, 10], [0, 10]]);
	});

	it('leaves a ring alone at zero tolerance, and never collapses a dot', () => {
		const ring: [number, number][] = [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01]];
		expect(simplifyRing(ring, 0)).toEqual(ring);
		expect(simplifyRing(ring, 5).length).toBeGreaterThanOrEqual(3);
	});
});

describe('formatFileSize', () => {
	it('reads as people read sizes', () => {
		expect(formatFileSize(512)).toBe('512 B');
		expect(formatFileSize(84 * 1024)).toBe('84 KB');
		expect(formatFileSize(2.4 * 1024 * 1024)).toBe('2.4 MB');
		expect(formatFileSize(37 * 1024 * 1024)).toBe('37 MB');
	});
});
