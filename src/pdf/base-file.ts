import type { App, TFile } from 'obsidian';
import { BASE_SUFFIX, type BasePages, type BaseRef, basePathFor, unpackBase } from '../core/base-layer';

export type BaseLookup = BasePages | 'missing' | 'unreadable';

/**
 * The base layer `ref` names: the file beside the notebook, or else any base
 * file in the same folder with the right hash, which is what a renamed or
 * duplicated notebook finds. Never written to.
 */
export async function readBaseLayer(app: App, notebook: TFile, ref: BaseRef): Promise<BaseLookup> {
	const vault = app.vault;
	const expected = basePathFor(notebook.path);
	const folder = notebook.path.slice(0, notebook.path.length - notebook.name.length);
	const siblings = vault
		.getFiles()
		.filter(
			(f) =>
				f.path !== expected &&
				f.path.endsWith(BASE_SUFFIX) &&
				f.path.startsWith(folder) &&
				!f.path.slice(folder.length).includes('/'),
		);
	const named = vault.getFileByPath(expected);
	const candidates = named ? [named, ...siblings] : siblings;
	let unreadable = false;
	for (const candidate of candidates) {
		try {
			const unpacked = await unpackBase(new Uint8Array(await vault.readBinary(candidate)), ref);
			if (unpacked.ok) return unpacked.pages;
			// Other notebooks' bases are expected among the siblings; only the
			// named file being wrong is worth reporting.
			if (candidate === named) unreadable = true;
		} catch (err) {
			console.error(`pdf-ink: could not read ${candidate.path}`, err);
		}
	}
	return unreadable ? 'unreadable' : 'missing';
}
