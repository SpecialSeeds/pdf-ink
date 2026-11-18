import type { App, TFile } from 'obsidian';
import { canvasDataPath, isCanvasPath } from '../core/canvas';
import { imagePathFor, parentFolder } from '../core/export-path';
import type { Item } from '../core/items';
import type { PageKey } from '../core/pages';
import {
	type QualityProfile,
	largestPlacements,
	targetPixels,
} from '../core/export-quality';

/** The picture a vault path names, or, when it has moved, one of the same name. */
export function resolveImageFile(app: App, src: string): TFile | null {
	const exact = app.vault.getFileByPath(src);
	if (exact) return exact;
	// Image items name their picture by path, which a move or rename outdates;
	// Obsidian's own link lookup finds it again by name.
	const name = src.slice(src.lastIndexOf('/') + 1);
	return app.metadataCache.getFirstLinkpathDest(name, '');
}

/** A picture's bytes, or null when it cannot be found. */
export async function readImageBytes(app: App, src: string): Promise<ArrayBuffer | null> {
	// A temporary board's pictures are in its hidden folder, out of the vault's
	// index, and are never looked for anywhere else.
	if (isCanvasPath(src)) {
		const adapter = app.vault.adapter;
		return (await adapter.exists(src)) ? await adapter.readBinary(src) : null;
	}
	const file = resolveImageFile(app, src);
	return file ? await app.vault.readBinary(file) : null;
}

/** The bytes of every picture these pages place, by the path they name it with. */
export async function collectImageBytes(
	app: App,
	pages: Readonly<Record<PageKey, readonly Item[]>>,
): Promise<Map<string, Uint8Array>> {
	const sources = new Set<string>();
	for (const items of Object.values(pages)) {
		for (const item of items) {
			if (item.type === 'image' && item.deletedAt === undefined) sources.add(item.src);
		}
	}
	const images = new Map<string, Uint8Array>();
	for (const src of sources) {
		const bytes = await readImageBytes(app, src);
		if (bytes) images.set(src, new Uint8Array(bytes));
	}
	return images;
}

/**
 * Pictures resampled for an export's quality: shrunk to the resolution it keeps
 * at the size each is placed, and re-encoded as JPEG where that is allowed and the
 * picture has no transparency. A picture keeps its own bytes when the result
 * would not be smaller, or when the device cannot decode it.
 */
export async function imagesForQuality(
	images: ReadonlyMap<string, Uint8Array>,
	pages: Readonly<Record<PageKey, readonly Item[]>>,
	quality: QualityProfile,
): Promise<Map<string, Uint8Array>> {
	if (quality.imageDpi === null) return new Map(images);
	const placements = largestPlacements(pages);
	const out = new Map<string, Uint8Array>();
	for (const [src, bytes] of images) {
		const placed = placements.get(src);
		let resampled: Uint8Array | null = null;
		if (placed) {
			try {
				resampled = await resample(bytes, placed, quality);
			} catch (err) {
				console.warn('pdf-ink: could not resample a picture for export', src, err);
			}
		}
		out.set(src, resampled && resampled.byteLength < bytes.byteLength ? resampled : bytes);
	}
	return out;
}

async function resample(
	bytes: Uint8Array,
	placed: { readonly w: number; readonly h: number },
	quality: QualityProfile,
): Promise<Uint8Array | null> {
	const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
	const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
	if (!isPng && !isJpeg) return null;
	// A PDF ignores a JPEG's orientation tag, so decoding must too, or a
	// re-encoded photo would turn where the original does not.
	const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), {
		imageOrientation: 'none',
	});
	try {
		const natural = { width: bitmap.width, height: bitmap.height };
		const size = targetPixels(natural, placed, quality.imageDpi) ?? natural;
		const canvas = createEl('canvas');
		canvas.width = size.width;
		canvas.height = size.height;
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		if (!ctx) return null;
		ctx.imageSmoothingQuality = 'high';
		ctx.drawImage(bitmap, 0, 0, size.width, size.height);
		const toJpeg = isJpeg || (quality.pngToJpeg && !hasTransparency(ctx, size));
		// Nothing to gain from re-encoding a PNG at the size it already is.
		if (!toJpeg && size === natural) return null;
		const blob = await new Promise<Blob | null>((resolve) => {
			canvas.toBlob(
				resolve,
				toJpeg ? 'image/jpeg' : 'image/png',
				toJpeg ? quality.jpegQuality : undefined,
			);
		});
		return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
	} finally {
		bitmap.close();
	}
}

function hasTransparency(
	ctx: CanvasRenderingContext2D,
	size: { readonly width: number; readonly height: number },
): boolean {
	const { data } = ctx.getImageData(0, 0, size.width, size.height);
	for (let i = 3; i < data.length; i += 4) {
		if ((data[i] ?? 255) < 255) return true;
	}
	return false;
}

/** A picture ready to place: saved in the vault, with its size in pixels. */
export interface SavedImage {
	readonly path: string;
	readonly width: number;
	readonly height: number;
}

const DIRECT_TYPES: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
};

/**
 * Save a picture inserted into `sourcePath` in the `images` folder beside it,
 * as exports go in `annotated`, so a file's pictures travel with it.
 *
 * PNG and JPEG are kept byte for byte. Anything else the device can decode (WebP,
 * GIF, HEIC on an iPad) is converted to PNG first, because those are the two
 * formats a PDF embeds directly, and an export must be able to draw it.
 */
export async function saveImage(
	app: App,
	blob: Blob,
	name: string,
	sourcePath: string,
): Promise<SavedImage> {
	return await encodeAndSave(blob, name, async (stem, extension, bytes) => {
		const path = imagePathFor(
			sourcePath,
			stem,
			extension,
			(candidate) => app.vault.getAbstractFileByPath(candidate) !== null,
		);
		const folder = parentFolder(path);
		if (!app.vault.getFolderByPath(folder)) await app.vault.createFolder(folder);
		await app.vault.createBinary(path, bytes);
		return path;
	});
}

/**
 * Save a picture put on temporary board `boardId`, in the `images` folder of
 * the board's hidden folder, through the adapter, so it goes when the board
 * does. Converted exactly as {@link saveImage} converts.
 */
export async function saveCanvasImage(
	app: App,
	blob: Blob,
	name: string,
	boardId: string,
): Promise<SavedImage> {
	const adapter = app.vault.adapter;
	return await encodeAndSave(blob, name, async (stem, extension, bytes) => {
		const sourcePath = canvasDataPath(boardId);
		const folder = parentFolder(imagePathFor(sourcePath, stem, extension, () => false));
		if (!(await adapter.exists(folder))) await adapter.mkdir(folder);
		const listed = await adapter.list(folder);
		const taken = new Set(listed.files);
		const path = imagePathFor(sourcePath, stem, extension, (candidate) => taken.has(candidate));
		await adapter.writeBinary(path, bytes);
		return path;
	});
}

/**
 * Decode `blob` for its size, keep PNG and JPEG bytes as they are and turn
 * anything else into PNG, then hand the bytes to `write`, which says where it
 * put them.
 */
async function encodeAndSave(
	blob: Blob,
	name: string,
	write: (stem: string, extension: string, bytes: ArrayBuffer) => Promise<string>,
): Promise<SavedImage> {
	const bitmap = await createImageBitmap(blob);
	try {
		const { width, height } = bitmap;
		const direct = DIRECT_TYPES[blob.type];
		const bytes = direct ? await blob.arrayBuffer() : await toPng(bitmap);
		const extension = direct ?? 'png';
		const stem = baseName(name) || 'Image';
		const path = await write(stem, extension, bytes);
		return { path, width, height };
	} finally {
		bitmap.close();
	}
}

/** A file name without its folder or extension, made safe for the vault. */
function baseName(name: string): string {
	const file = name.slice(name.lastIndexOf('/') + 1);
	const dot = file.lastIndexOf('.');
	const stem = dot > 0 ? file.slice(0, dot) : file;
	return stem.replace(/[\\/:*?"<>|#^[\]]/g, '-').trim();
}

async function toPng(bitmap: ImageBitmap): Promise<ArrayBuffer> {
	const canvas = createEl('canvas');
	canvas.width = bitmap.width;
	canvas.height = bitmap.height;
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('No canvas to convert the picture with');
	ctx.drawImage(bitmap, 0, 0);
	const png = await new Promise<Blob | null>((resolve) => {
		canvas.toBlob(resolve, 'image/png');
	});
	if (!png) throw new Error('Could not convert the picture to PNG');
	return await png.arrayBuffer();
}

/**
 * Ask for pictures through the system's file chooser: the photo library and
 * camera on a tablet, the file browser on a desktop. Several may be chosen at
 * once; empty when nothing is.
 */
export function pickImageFiles(doc: Document): Promise<File[]> {
	return new Promise((resolve) => {
		const input = doc.createElement('input');
		input.type = 'file';
		input.accept = 'image/*';
		input.multiple = true;
		input.addEventListener('change', () => {
			resolve(Array.from(input.files ?? []));
		});
		// Never fires on some platforms; an unanswered chooser just resolves nothing.
		input.addEventListener('cancel', () => {
			resolve([]);
		});
		input.click();
	});
}
