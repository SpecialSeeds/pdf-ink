import type { App, TFile } from 'obsidian';

/**
 * A file's frontmatter as plain data, or undefined when it has none. Obsidian
 * types it loosely; every value read from it is checked where it is used.
 */
export function frontmatterOf(app: App, file: TFile): Readonly<Record<string, unknown>> | undefined {
	const frontmatter: unknown = app.metadataCache.getFileCache(file)?.frontmatter;
	return frontmatter !== null && typeof frontmatter === 'object'
		? (frontmatter as Record<string, unknown>)
		: undefined;
}
