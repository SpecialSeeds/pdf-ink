import type { App, TFile } from 'obsidian';
import { BASE_SUFFIX, type BasePages, type BaseRef, basePathFor, unpackBase } from '../core/base-layer';

export type BaseLookup =
	| {
			readonly pages: BasePages;
			readonly file: TFile;
			/** Outside the notebook's folder: worth offering to move it back. */
			readonly elsewhere: boolean;
	  }
	| 'missing'
	| 'unreadable';

function folderOf(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash < 0 ? '' : path.slice(0, slash + 1);
}

/**
 * The base layer `ref` names, wherever it is. Looked for in order: the file
 * beside the notebook; any base file in the same folder with the right hash,
 * which is what a renamed or duplicated notebook finds; then any base file in
 * the vault with that hash, which is what a notebook moved without its base
 * finds. Never written to.
 */
export async function readBaseLayer(app: App, notebook: TFile, ref: BaseRef): Promise<BaseLookup> {
	const vault = app.vault;
	const expected = basePathFor(notebook.path);
	const folder = folderOf(notebook.path);
	const named = vault.getFileByPath(expected);
	const others = vault.getFiles().filter((f) => f.path !== expected && f.path.endsWith(BASE_SUFFIX));
	const nearby = others.filter((f) => folderOf(f.path) === folder);
	const far = others.filter((f) => folderOf(f.path) !== folder);

	let unreadable = false;
	for (const [candidates, elsewhere] of [
		[named ? [named] : [], false],
		[nearby, false],
		[far, true],
	] as const) {
		for (const candidate of candidates) {
			try {
				const unpacked = await unpackBase(new Uint8Array(await vault.readBinary(candidate)), ref);
				if (unpacked.ok) return { pages: unpacked.pages, file: candidate, elsewhere };
				// Other notebooks' bases are expected among the rest; only the
				// named file being wrong is worth reporting.
				if (candidate === named) unreadable = true;
			} catch (err) {
				console.error(`pdf-ink: could not read ${candidate.path}`, err);
			}
		}
	}
	return unreadable ? 'unreadable' : 'missing';
}
