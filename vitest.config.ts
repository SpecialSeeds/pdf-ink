import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		{
			/*
			 * Mirror esbuild's `base64` loader for .ttf. Vite would otherwise hand
			 * back an asset URL, and the bundled font has to arrive as base64 in
			 * tests exactly as it does in the plugin build.
			 */
			name: 'pdf-ink-ttf-base64',
			enforce: 'pre',
			async load(id: string) {
				if (!id.endsWith('.ttf')) return null;
				const bytes = await readFile(id);
				return `export default ${JSON.stringify(bytes.toString('base64'))};`;
			},
		},
	],
	resolve: {
		alias: {
			/*
			 * The `obsidian` package is types-only: it has no runtime to import.
			 * Tests get a minimal stub instead.
			 */
			obsidian: fileURLToPath(
				new URL('./src/test/obsidian-stub.ts', import.meta.url),
			),
		},
	},
	test: {
		/*
		 * Scoped to src/ on purpose. This repo contains self-referential
		 * symlinks — `pdf-ink` at the root, and the dev vault's
		 * `.obsidian/plugins/pdf-ink` — so vitest's default `**` glob walks into
		 * them and discovers every test file three times over.
		 */
		include: ['src/**/*.test.ts', 'tools/**/*.test.ts'],
		exclude: ['node_modules', 'pdf-ink', '.obsidian'],
	},
});
