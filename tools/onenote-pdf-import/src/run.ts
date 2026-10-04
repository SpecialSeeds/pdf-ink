/**
 * Importing a folder of OneNote PDF exports, one note per PDF, as notebooks.
 *
 * Offline: the PDFs are read from disk and the notebooks written beside each
 * other, with nothing fetched from anywhere.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { basePathFor, packBase } from '../../../src/core/base-layer';
import { NOTEBOOK_SUFFIX, serializeInkData } from '../../../src/core/ink-serialization';
import { simplifyPathCommands } from '../../../src/core/path';
import { type Built, buildNotebook } from './build';
import { extractPdf } from './extract';
import { type Canvas, reconstructCanvas } from './reconstruct';

/** Default simplification tolerance, in points: 0.035 mm, invisible at any zoom a note is read at. */
export const DEFAULT_SIMPLIFY = 0.1;

export interface ImportOptions {
	readonly input: string;
	readonly output: string;
	readonly dryRun?: boolean;
	/** Only notes whose name contains this, ignoring case. */
	readonly only?: string;
	/** Douglas–Peucker tolerance in points; 0 keeps every point. */
	readonly simplify?: number;
	readonly now?: number;
	readonly log?: (line: string) => void;
}

export type NoteStatus = 'written' | 'skipped' | 'listed' | 'failed';

export interface NoteResult {
	readonly name: string;
	readonly source: string;
	readonly target: string;
	readonly status: NoteStatus;
	readonly canvas?: Canvas;
	readonly built?: Built;
	/** Bytes of the `.inknote` and of its base layer, as written (or as they would be). */
	readonly sizes?: { readonly notebook: number; readonly base: number };
	readonly error?: string;
}

/**
 * The two files an import writes: the base layer holding everything imported,
 * and the `.inknote` naming it, which starts with no items of its own.
 */
export async function notebookFiles(built: Built): Promise<{ notebook: string; base: Uint8Array }> {
	const { bytes, ref } = await packBase(built.data.pages);
	const notebook = serializeInkData({ ...built.data, pages: {}, base: ref });
	return { notebook, base: bytes };
}

/**
 * A note name from a file name: no extension, none of the characters Obsidian
 * or the file system refuses in a name, and never empty.
 */
export function noteName(fileName: string): string {
	const stem = fileName.replace(/\.pdf$/i, '');
	const cleaned = stem
		// eslint-disable-next-line no-control-regex -- control characters are exactly what is being removed
		.replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^\.+/, '');
	return cleaned.length > 0 ? cleaned : 'Untitled';
}

/** A canvas with its paths simplified to `tolerance` points. */
export function simplifyCanvas(canvas: Canvas, tolerance: number): Canvas {
	if (tolerance <= 0) return canvas;
	return {
		...canvas,
		paths: canvas.paths.map((path) => ({
			...path,
			commands: simplifyPathCommands(path.commands, tolerance),
		})),
	};
}

function kb(bytes: number): string {
	return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function describe(result: NoteResult): string {
	const { canvas, built } = result;
	if (!canvas || !built) return `${result.name}: ${result.status}${result.error ? ` (${result.error})` : ''}`;
	const format =
		canvas.format === 'mac'
			? `Mac export, ${String(canvas.contentPages)} sliced pages, ${String(canvas.duplicates)} duplicates removed`
			: 'iOS export';
	const layout =
		built.layout === 'board' ? 'board (1 page)' : `paginated (${String(built.pageCount)} Letter pages)`;
	const lines = [
		`${result.name}: ${result.status}`,
		`  ${format}`,
		`  canvas ${canvas.width.toFixed(0)} x ${canvas.height.toFixed(0)} pt, ${String(built.pathCount)} paths, ${String(built.textCount)} text runs`,
		`  ${layout}`,
	];
	if (result.sizes) {
		lines.push(
			`  files: ${kb(result.sizes.notebook)} notebook, ${kb(result.sizes.base)} base layer`,
		);
	}
	for (const warning of canvas.warnings) lines.push(`  warning: ${warning}`);
	return lines.join('\n');
}

async function writeAtomically(path: string, data: string | Uint8Array): Promise<void> {
	const temp = `${path}.tmp`;
	await writeFile(temp, data);
	await rename(temp, path);
}

export async function runImport(options: ImportOptions): Promise<NoteResult[]> {
	const log = options.log ?? ((line: string) => console.log(line));
	const tolerance = options.simplify ?? DEFAULT_SIMPLIFY;
	const only = options.only?.toLowerCase();
	const files = (await readdir(options.input))
		.filter((file) => file.toLowerCase().endsWith('.pdf'))
		.sort((a, b) => a.localeCompare(b));

	const results: NoteResult[] = [];
	for (const file of files) {
		const name = noteName(file);
		if (only !== undefined && !name.toLowerCase().includes(only)) continue;
		const source = join(options.input, file);
		const target = join(options.output, `${name}${NOTEBOOK_SUFFIX}`);

		// Rerunning picks up where the last run stopped, and never overwrites.
		if (!options.dryRun && existsSync(target)) {
			const result: NoteResult = { name, source, target, status: 'skipped' };
			results.push(result);
			log(`${name}: skipped, ${target} already exists`);
			continue;
		}

		try {
			const pages = await extractPdf(new Uint8Array(await readFile(source)));
			const canvas = reconstructCanvas(pages);
			const built = buildNotebook(simplifyCanvas(canvas, tolerance), {
				now: options.now ?? Date.now(),
			});
			const files = await notebookFiles(built);
			let status: NoteStatus = 'listed';
			if (!options.dryRun) {
				await mkdir(options.output, { recursive: true });
				// The base first: a notebook must never name a base that is not there.
				await writeAtomically(basePathFor(target), files.base);
				await writeAtomically(target, files.notebook);
				status = 'written';
			}
			const sizes = {
				notebook: new TextEncoder().encode(files.notebook).length,
				base: files.base.length,
			};
			const result: NoteResult = { name, source, target, status, canvas, built, sizes };
			results.push(result);
			log(describe(result));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const result: NoteResult = { name, source, target, status: 'failed', error: message };
			results.push(result);
			log(`${name}: failed, ${message}`);
		}
	}
	if (results.length === 0) log('no matching PDFs');
	return results;
}
