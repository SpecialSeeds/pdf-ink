import type { App, TFile } from 'obsidian';
import { imagePathFor, parentFolder } from '../core/export-path';
import type { Item } from '../core/items';
import type { PageKey } from '../core/pages';

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
	const bitmap = await createImageBitmap(blob);
	try {
		const { width, height } = bitmap;
		const direct = DIRECT_TYPES[blob.type];
		const bytes = direct ? await blob.arrayBuffer() : await toPng(bitmap);
		const extension = direct ?? 'png';
		const stem = baseName(name) || 'Image';
		const path = imagePathFor(
			sourcePath,
			stem,
			extension,
			(candidate) => app.vault.getAbstractFileByPath(candidate) !== null,
		);
		const folder = parentFolder(path);
		if (!app.vault.getFolderByPath(folder)) await app.vault.createFolder(folder);
		await app.vault.createBinary(path, bytes);
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
 * Ask for a picture through the system's file chooser: the photo library and
 * camera on a tablet, the file browser on a desktop. Null when nothing is chosen.
 */
export function pickImageFile(doc: Document): Promise<File | null> {
	return new Promise((resolve) => {
		const input = doc.createElement('input');
		input.type = 'file';
		input.accept = 'image/*';
		input.addEventListener('change', () => {
			resolve(input.files?.item(0) ?? null);
		});
		// Never fires on some platforms; an unanswered chooser just resolves nothing.
		input.addEventListener('cancel', () => {
			resolve(null);
		});
		input.click();
	});
}
