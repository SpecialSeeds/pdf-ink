import type { Item } from './items';
import type { PageKey } from './pages';

/**
 * How finely an export draws ink and how much picture detail it keeps.
 *
 * Export stays vector at every level: quality trades the ink outline's precision
 * and the pictures' resolution for file size. The original PDF's own pages are
 * copied as they are, so a PDF's export never gets smaller than the PDF itself.
 */
export type ExportQuality = 'super-low' | 'low' | 'medium' | 'high' | 'ultra';

/** Lowest to highest, as the export dialog's slider runs. */
export const EXPORT_QUALITIES: readonly ExportQuality[] = [
	'super-low',
	'low',
	'medium',
	'high',
	'ultra',
];

export const DEFAULT_EXPORT_QUALITY: ExportQuality = 'high';

export function isExportQuality(value: unknown): value is ExportQuality {
	return typeof value === 'string' && (EXPORT_QUALITIES as readonly string[]).includes(value);
}

export interface QualityProfile {
	readonly label: string;
	/**
	 * How far, in points, a simplified ink outline may stray from the exact one.
	 * Zero keeps every vertex.
	 */
	readonly inkTolerance: number;
	/** Decimal places written for every ink coordinate; null writes them in full. */
	readonly decimals: number | null;
	/**
	 * The most pixels per inch a picture keeps at the size it is placed, or null
	 * to embed its file exactly as it is.
	 */
	readonly imageDpi: number | null;
	/**
	 * JPEG quality, 0–1, for a picture re-encoded as JPEG. A picture with
	 * transparency always stays PNG, since JPEG cannot carry it.
	 */
	readonly jpegQuality: number;
	/** Whether an opaque PNG is re-encoded as JPEG, which is far smaller for photos. */
	readonly pngToJpeg: boolean;
}

/*
 * A pen nib is about 1.5 pt wide and 0.1 pt is 0.035 mm, so High is lossless to
 * the eye and printer alike. Super low still reads cleanly on screen; its outline
 * wobbles by at most a fifth of a millimetre.
 */
export const QUALITY_PROFILES: Readonly<Record<ExportQuality, QualityProfile>> = {
	'super-low': {
		label: 'Super low',
		inkTolerance: 0.5,
		decimals: 1,
		imageDpi: 72,
		jpegQuality: 0.45,
		pngToJpeg: true,
	},
	low: {
		label: 'Low',
		inkTolerance: 0.25,
		decimals: 1,
		imageDpi: 110,
		jpegQuality: 0.6,
		pngToJpeg: true,
	},
	medium: {
		label: 'Medium',
		inkTolerance: 0.1,
		decimals: 2,
		imageDpi: 150,
		jpegQuality: 0.75,
		pngToJpeg: true,
	},
	high: {
		label: 'High',
		inkTolerance: 0.03,
		decimals: 2,
		imageDpi: 300,
		jpegQuality: 0.9,
		pngToJpeg: false,
	},
	ultra: {
		label: 'Ultra high',
		inkTolerance: 0,
		decimals: null,
		imageDpi: null,
		jpegQuality: 1,
		pngToJpeg: false,
	},
};

/** A number with at most `decimals` places, or in full when that is null. */
export function formatCoordinate(value: number, decimals: number | null): string {
	if (decimals === null) return String(value);
	const factor = 10 ** decimals;
	// `+ 0` turns a rounded -0 into 0, which reads "0" rather than "-0".
	return String(Math.round(value * factor) / factor + 0);
}

/**
 * The largest size, in points, each picture is placed at across these pages: a
 * picture placed twice needs the detail of its larger copy.
 */
export function largestPlacements(
	pages: Readonly<Record<PageKey, readonly Item[]>>,
): Map<string, { readonly w: number; readonly h: number }> {
	const sizes = new Map<string, { w: number; h: number }>();
	for (const items of Object.values(pages)) {
		for (const item of items) {
			if (item.type !== 'image' || item.deletedAt !== undefined) continue;
			const w = Math.abs(item.box.w);
			const h = Math.abs(item.box.h);
			const known = sizes.get(item.src);
			sizes.set(item.src, known ? { w: Math.max(known.w, w), h: Math.max(known.h, h) } : { w, h });
		}
	}
	return sizes;
}

/**
 * The pixel size a picture should be embedded at, or null to keep its own.
 * Only ever shrinks: a picture is never scaled up, and keeps its aspect ratio.
 */
export function targetPixels(
	natural: { readonly width: number; readonly height: number },
	placed: { readonly w: number; readonly h: number },
	dpi: number | null,
): { width: number; height: number } | null {
	if (dpi === null || natural.width <= 0 || natural.height <= 0) return null;
	// Points are 1/72 inch.
	const needW = (placed.w / 72) * dpi;
	const needH = (placed.h / 72) * dpi;
	const scale = Math.max(needW / natural.width, needH / natural.height);
	if (!(scale < 1)) return null;
	return {
		width: Math.max(1, Math.round(natural.width * scale)),
		height: Math.max(1, Math.round(natural.height * scale)),
	};
}

/** A byte count as people read it: 512 B, 84 KB, 2.4 MB. */
export function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${String(bytes)} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${String(Math.round(kb))} KB`;
	const mb = kb / 1024;
	return `${mb < 10 ? mb.toFixed(1) : String(Math.round(mb))} MB`;
}
