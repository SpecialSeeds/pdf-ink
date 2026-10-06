import type { App, TFile as VaultFile } from 'obsidian';
import { TFile, TFolder } from '../test/obsidian-stub';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeInkData } from '../core/ink-serialization';
import { type InkData, INK_DATA_VERSION, type TextItem } from '../core/items';
import { insertedPageKey } from '../core/pages';
import { renderPagePath } from '../core/transcripts';
import type { Manifest } from './render';
import {
	moveTranscript,
	moveTranscriptFolder,
	syncTranscript,
	transcriptHandlers,
	trashTranscript,
	trashTranscriptFolder,
} from './transcript-sync';

const FOLDER = '_system/transcripts';
const RENDERS = '.pdf-ink-render';

function makeFile(path: string, mtime = 1): VaultFile {
	const file = new TFile();
	file.path = path;
	file.name = path.slice(path.lastIndexOf('/') + 1);
	file.basename = file.name.replace(/\.[^.]+$/, '');
	file.extension = file.name.split('.').pop() ?? '';
	file.stat = { mtime, ctime: 0, size: 0 };
	return file as unknown as VaultFile;
}

function makeFolder(path: string): TFolder {
	const folder = new TFolder();
	folder.path = path;
	return folder;
}

/** A vault of text files and folders, frontmatter kept per file, and a hidden-folder adapter. */
class FakeVault {
	readonly text = new Map<string, string>();
	readonly folders = new Set<string>();
	readonly frontmatter = new Map<string, Record<string, unknown>>();
	/** The adapter's own files: the render folder lives here. */
	readonly hidden = new Map<string, string>();
	readonly ops: string[] = [];

	app(): App {
		// The fake's methods close over the fake itself, not the object they sit on.
		const { text, folders, frontmatter, hidden, ops } = this;
		const vault = { text, folders, frontmatter, hidden, ops };
		return {
			vault: {
				getFileByPath: (p: string) => (vault.text.has(p) ? makeFile(p) : null),
				getFolderByPath: (p: string) => (vault.folders.has(p) ? makeFolder(p) : null),
				getAbstractFileByPath: (p: string) =>
					vault.text.has(p) ? makeFile(p) : vault.folders.has(p) ? makeFolder(p) : null,
				getFiles: () => [...vault.text.keys()].map((p) => makeFile(p)),
				read: (f: VaultFile) => Promise.resolve(vault.text.get(f.path) ?? ''),
				createFolder: (p: string) => {
					vault.folders.add(p);
					vault.ops.push(`mkdir:${p}`);
					return Promise.resolve();
				},
				adapter: {
					exists: (p: string) =>
						Promise.resolve(vault.hidden.has(p) || [...vault.hidden.keys()].some((k) => k.startsWith(`${p}/`))),
					read: (p: string) => Promise.resolve(vault.hidden.get(p) ?? ''),
					write: (p: string, data: string) => {
						vault.hidden.set(p, data);
						return Promise.resolve();
					},
					mkdir: () => Promise.resolve(),
					rmdir: (p: string) => {
						for (const k of [...vault.hidden.keys()]) if (k.startsWith(`${p}/`)) vault.hidden.delete(k);
						vault.ops.push(`rmdir:${p}`);
						return Promise.resolve();
					},
				},
			},
			fileManager: {
				renameFile: (f: { path: string }, to: string) => {
					vault.ops.push(`move:${f.path}->${to}`);
					for (const map of [vault.text, vault.frontmatter] as Map<string, unknown>[]) {
						for (const [k, v] of [...map]) {
							if (k === f.path || k.startsWith(`${f.path}/`)) {
								map.delete(k);
								map.set(to + k.slice(f.path.length), v);
							}
						}
					}
					if (vault.folders.delete(f.path)) vault.folders.add(to);
					return Promise.resolve();
				},
				trashFile: (f: { path: string }) => {
					vault.ops.push(`trash:${f.path}`);
					vault.text.delete(f.path);
					vault.folders.delete(f.path);
					return Promise.resolve();
				},
				processFrontMatter: (f: VaultFile, fn: (fm: Record<string, unknown>) => void) => {
					const fm = vault.frontmatter.get(f.path) ?? {};
					fn(fm);
					vault.frontmatter.set(f.path, fm);
					vault.ops.push(`frontmatter:${f.path}`);
					return Promise.resolve();
				},
			},
			metadataCache: {
				getFileCache: (f: VaultFile) => ({ frontmatter: vault.frontmatter.get(f.path) }),
			},
		} as unknown as App;
	}
}

describe('following a source', () => {
	let vault: FakeVault;
	beforeEach(() => {
		vault = new FakeVault();
		vault.text.set(`${FOLDER}/classes/Notes/Week 1.md`, '…');
		vault.frontmatter.set(`${FOLDER}/classes/Notes/Week 1.md`, { source: 'classes/Notes/Week 1.inknote' });
	});

	it('moves the transcript when the notebook is renamed or moved, and repoints it', async () => {
		const outcome = await moveTranscript(vault.app(), FOLDER, 'classes/Notes/Week 1.inknote', 'archive/Week one.inknote');
		expect(outcome).toBe('moved');
		expect(vault.text.has(`${FOLDER}/archive/Week one.md`)).toBe(true);
		expect(vault.frontmatter.get(`${FOLDER}/archive/Week one.md`)?.['source']).toBe('archive/Week one.inknote');
		expect(vault.folders.has(`${FOLDER}/archive`)).toBe(true);
	});

	it('leaves a transcript already at the destination alone', async () => {
		vault.text.set(`${FOLDER}/archive/Week one.md`, 'someone else');
		expect(await moveTranscript(vault.app(), FOLDER, 'classes/Notes/Week 1.inknote', 'archive/Week one.inknote')).toBe('blocked');
		expect(vault.text.get(`${FOLDER}/archive/Week one.md`)).toBe('someone else');
	});

	it('does nothing for a source without a transcript', async () => {
		expect(await moveTranscript(vault.app(), FOLDER, 'other.inknote', 'moved.inknote')).toBe('none');
		expect(vault.ops).toEqual([]);
	});

	it('moves a folder\'s transcripts with the folder, repointing each', async () => {
		vault.folders.add(`${FOLDER}/classes/Notes`);
		expect(await moveTranscriptFolder(vault.app(), FOLDER, 'classes/Notes', 'classes/APMA')).toBe('moved');
		expect(vault.frontmatter.get(`${FOLDER}/classes/APMA/Week 1.md`)?.['source']).toBe('classes/APMA/Week 1.inknote');
	});

	it('trashes the transcript when the notebook is deleted, and a folder\'s when the folder is', async () => {
		expect(await trashTranscript(vault.app(), FOLDER, 'classes/Notes/Week 1.inknote')).toBe(true);
		expect(vault.ops).toContain(`trash:${FOLDER}/classes/Notes/Week 1.md`);
		vault.folders.add(`${FOLDER}/old`);
		expect(await trashTranscriptFolder(vault.app(), FOLDER, 'old')).toBe(true);
		expect(await trashTranscriptFolder(vault.app(), FOLDER, 'never')).toBe(false);
	});

	it('ignores moves of the transcripts themselves, and of files that are not notebooks or PDFs', async () => {
		const handlers = transcriptHandlers(vault.app(), () => ({
			transcriptFolder: FOLDER,
			renderFolder: RENDERS,
			deleteRendersAfterTranscription: true,
		}));
		handlers.rename(makeFile(`${FOLDER}/x/Week 1.md`), `${FOLDER}/classes/Notes/Week 1.md`);
		handlers.rename(makeFile('notes/new.md'), 'notes/old.md');
		handlers.rename(makeFile('classes/Notes/Week 2.inknote'), 'classes/Notes/Week 1.inknote');
		await vi.waitFor(() => {
			expect(vault.ops.filter((o) => o.startsWith('move:'))).toEqual([
				`move:${FOLDER}/classes/Notes/Week 1.md->${FOLDER}/classes/Notes/Week 2.md`,
			]);
		});
	});
});

describe('when a transcript is written', () => {
	const SOURCE = 'classes/Notes/Week 1.inknote';
	const TRANSCRIPT = `${FOLDER}/classes/Notes/Week 1.md`;
	const PAGE = insertedPageKey('p1');

	function notebook(updatedAt: number): string {
		const item: TextItem = { type: 'text', id: 't', color: '#000', opacity: 1, rotation: 0, z: 0, updatedAt, box: { x: 40, y: 700, w: 100, h: 14 }, text: 'x', fontSize: 12 };
		const data: InkData = {
			version: INK_DATA_VERSION,
			pages: { [PAGE]: [item] },
			insertedPages: [{ id: 'p1', afterPdfPage: -1, sortKey: 'a0', template: 'blank', size: { width: 612, height: 792 }, updatedAt: 1 }],
		};
		return serializeInkData(data);
	}

	function manifest(updatedAt: number): Manifest {
		return {
			version: 1,
			generated: '',
			sources: [
				{
					path: SOURCE,
					pageCount: 1,
					updatedAt,
					transcript: TRANSCRIPT,
					pages: [{ page: 1, image: renderPagePath(SOURCE, RENDERS, 1), width: 612, height: 792, scale: 2.083, blocks: { B1: [40, 700, 100, 14] } }],
				},
			],
		};
	}

	function setup(sourceUpdated: number, current: number): FakeVault {
		const vault = new FakeVault();
		vault.text.set(SOURCE, notebook(current));
		vault.text.set(TRANSCRIPT, '…');
		vault.frontmatter.set(TRANSCRIPT, { source: SOURCE, source_updated: sourceUpdated });
		vault.hidden.set(`${RENDERS}/manifest.json`, JSON.stringify(manifest(sourceUpdated)));
		vault.hidden.set(renderPagePath(SOURCE, RENDERS, 1), 'png');
		return vault;
	}

	const settings = { transcriptFolder: FOLDER, renderFolder: RENDERS, deleteRendersAfterTranscription: true };

	it('copies the source\'s block boxes into its frontmatter, then clears the renders', async () => {
		const vault = setup(500, 500);
		await syncTranscript(vault.app(), settings, makeFile(TRANSCRIPT));
		expect(vault.frontmatter.get(TRANSCRIPT)?.['blocks']).toEqual({ '1': { B1: [40, 700, 100, 14] } });
		expect(vault.hidden.has(renderPagePath(SOURCE, RENDERS, 1))).toBe(false);
		const written = JSON.parse(vault.hidden.get(`${RENDERS}/manifest.json`) ?? '{}') as Manifest;
		expect(written.sources[0]?.pages[0]?.image).toBeNull();
		expect(written.sources[0]?.pages[0]?.blocks).toEqual({ B1: [40, 700, 100, 14] });
	});

	it('writes nothing when the boxes are already there, so its own write is not answered', async () => {
		const vault = setup(500, 500);
		vault.frontmatter.set(TRANSCRIPT, { source: SOURCE, source_updated: 500, blocks: { 1: { B1: [40, 700, 100, 14] } } });
		await syncTranscript(vault.app(), settings, makeFile(TRANSCRIPT));
		expect(vault.ops.filter((o) => o.startsWith('frontmatter:'))).toEqual([]);
	});

	it('keeps the renders when the setting is off, or the notebook changed since', async () => {
		const off = setup(500, 500);
		await syncTranscript(off.app(), { ...settings, deleteRendersAfterTranscription: false }, makeFile(TRANSCRIPT));
		expect(off.hidden.has(renderPagePath(SOURCE, RENDERS, 1))).toBe(true);

		const edited = setup(500, 900);
		await syncTranscript(edited.app(), settings, makeFile(TRANSCRIPT));
		expect(edited.hidden.has(renderPagePath(SOURCE, RENDERS, 1))).toBe(true);
		// The manifest's boxes are for the edit transcribed, so they are still copied.
		expect(edited.frontmatter.get(TRANSCRIPT)?.['blocks']).toEqual({ '1': { B1: [40, 700, 100, 14] } });
	});

	it('works the boxes out from the notebook when the manifest is gone', async () => {
		const vault = setup(500, 500);
		vault.hidden.clear();
		await syncTranscript(vault.app(), settings, makeFile(TRANSCRIPT));
		const blocks = vault.frontmatter.get(TRANSCRIPT)?.['blocks'] as Record<string, Record<string, number[]>> | undefined;
		expect(Object.keys(blocks?.['1'] ?? {})).toEqual(['B1']);
	});
});
