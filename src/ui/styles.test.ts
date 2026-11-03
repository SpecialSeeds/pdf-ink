import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const css = readFileSync(join(root, 'styles.css'), 'utf8');

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
		else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(path);
	}
	return out;
}

/** Every `--pdf-ink-*` property the UI writes through setCssProps. */
function propertiesSetInCode(): Set<string> {
	const found = new Set<string>();
	for (const path of sourceFiles(join(root, 'src'))) {
		const text = readFileSync(path, 'utf8');
		for (const match of text.matchAll(/'(--pdf-ink-[a-z0-9-]+)'/g)) {
			const name = match[1];
			if (name) found.add(name);
		}
	}
	return found;
}

/**
 * The swatch colour arrives as a custom property set from script and consumed by a
 * rule in styles.css. When the two drift apart the swatches silently render
 * colourless, which is exactly what happened once — so it is worth asserting.
 */
describe('styles.css and the code agree on custom properties', () => {
	it('every property the code sets is read somewhere in the stylesheet', () => {
		const unused: string[] = [];
		for (const property of propertiesSetInCode()) {
			if (!css.includes(`var(${property}`)) unused.push(property);
		}
		expect(unused).toEqual([]);
	});

	it('the colour swatch reads its colour on the fill element', () => {
		expect(css).toMatch(/\.pdf-ink-swatch-fill\s*\{[^}]*var\(--pdf-ink-swatch/);
	});

	it('the swatch button itself claims no background, so themes cannot win', () => {
		const rule = /\.pdf-ink-swatch\s*\{([^}]*)\}/.exec(css);
		expect(rule).not.toBeNull();
		expect(rule?.[1]).toContain('background: none');
	});

	it('the selected swatch is marked by more than colour alone', () => {
		expect(css).toContain('.pdf-ink-swatch.is-active .pdf-ink-swatch-fill');
	});

	it('every class the toolbar creates has a rule', () => {
		for (const cls of [
			'pdf-ink-floating',
			'pdf-ink-colors',
			'pdf-ink-popover',
			'pdf-ink-color-grid',
			'pdf-ink-swatch',
			'pdf-ink-swatch-fill',
			'pdf-ink-color-input',
			'pdf-ink-mode-button',
			'pdf-ink-selection',
			'pdf-ink-handle',
			'pdf-ink-selection-bar',
			'pdf-ink-text-editor',
			'pdf-ink-eraser-cursor',
			'pdf-ink-gap-insert',
			'pdf-ink-body',
			'pdf-ink-sidebar',
			'pdf-ink-sidebar-tab',
			'pdf-ink-sidebar-body',
			'pdf-ink-sidebar-empty',
			'pdf-ink-thumbnails',
			'pdf-ink-thumbnail',
			'pdf-ink-thumbnail-canvas',
			'pdf-ink-thumbnail-label',
			'pdf-ink-outline',
			'pdf-ink-outline-item',
			'pdf-ink-outline-link',
			'pdf-ink-diagnostics',
			'pdf-ink-diagnostics-header',
			'pdf-ink-diagnostics-button',
			'pdf-ink-diagnostics-log',
			'pdf-ink-diagnostics-line',
			'pdf-ink-width-wrap',
			'pdf-ink-width-button',
		]) {
			expect(css, cls).toContain(`.${cls}`);
		}
	});
});
