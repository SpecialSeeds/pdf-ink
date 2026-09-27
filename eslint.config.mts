import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'**/plugins/hot-reload/**',
		'node_modules',
		'dist',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
		'vitest.config.ts',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		/*
		 * The sidecar writer deletes only its own `.bak` bookkeeping file, never
		 * anything the user made, so routing it through the trash would fill their
		 * deleted-files list on every save. User content is trashed, not deleted.
		 */
		files: ['src/pdf/annotation-store.ts'],
		rules: {
			'obsidianmd/prefer-file-manager-trash-file': 'off',
		},
	},
	{
		// Test doubles run under node, not in an Obsidian window: there is no
		// popout to be compatible with, and faking a TFile is the point.
		files: ['src/**/*.test.ts', 'src/test/**/*.ts'],
		rules: {
			'obsidianmd/prefer-window-timers': 'off',
			'obsidianmd/no-tfile-tfolder-cast': 'off',
			// Tests read fixtures and the stylesheet straight off disk.
			'obsidianmd/no-nodejs-modules': 'off',
		},
	},
);
