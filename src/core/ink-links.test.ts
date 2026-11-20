import { describe, expect, it } from 'vitest';
import {
	countLinkpaths,
	displayText,
	documentLinkpaths,
	inkLinkAt,
	layoutLinkedText,
	linkAreas,
	linkText,
	parseInkLinks,
	rewriteLinks,
} from './ink-links';
import type { Item, TextItem } from './items';

/** Every character one point wide: easy arithmetic for positions. */
const mono = (text: string): number => text.length;

function textItem(text: string, extra: Partial<TextItem> = {}): TextItem {
	return {
		id: `t-${text}`,
		type: 'text',
		color: '#000000',
		opacity: 1,
		rotation: 0,
		z: 0,
		updatedAt: 1,
		box: { x: 0, y: 0, w: 200, h: 20 },
		text,
		fontSize: 10,
		...extra,
	};
}

describe('parseInkLinks', () => {
	it('reads paths, subpaths, aliases and display text', () => {
		const links = parseInkLinks(
			'See [[Note]], [[file.pdf]], [[file.pdf#page=3]] and [[Folder/Note.md#Heading|the heading]].',
		);
		expect(links.map((l) => [l.linkpath, l.subpath, l.alias, l.display])).toEqual([
			['Note', '', null, 'Note'],
			['file.pdf', '', null, 'file.pdf'],
			['file.pdf', '#page=3', null, 'file.pdf'],
			['Folder/Note.md', '#Heading', 'the heading', 'the heading'],
		]);
		expect(linkText(links[2]!)).toBe('file.pdf#page=3');
	});

	it('keeps the exact span of each link, an embed mark included', () => {
		const text = 'a ![[x]] b';
		const [link] = parseInkLinks(text);
		expect(text.slice(link!.start, link!.end)).toBe('![[x]]');
	});

	it('ignores empty and unclosed brackets and links across lines', () => {
		expect(parseInkLinks('[[]] [[ ]] [[open\nclose]] [[never')).toEqual([]);
	});

	it('shows a link to a heading in the same file by its heading', () => {
		expect(parseInkLinks('[[#Intro]]')[0]?.display).toBe('Intro');
	});

	it('handles a name with commas and spaces', () => {
		const [link] = parseInkLinks('[[WS 09-16 Existence and Uniqueness, Intersecting Graphs.pdf]]');
		expect(link?.linkpath).toBe('WS 09-16 Existence and Uniqueness, Intersecting Graphs.pdf');
	});
});

describe('displayText', () => {
	it('replaces each link with its display text and records where it went', () => {
		const shown = displayText('go [[a/Note|here]] or [[b.pdf]]!');
		expect(shown.text).toBe('go here or b.pdf!');
		expect(shown.spans.map((s) => shown.text.slice(s.start, s.end))).toEqual(['here', 'b.pdf']);
	});

	it('leaves text without links alone', () => {
		expect(displayText('plain')).toEqual({ text: 'plain', spans: [] });
	});
});

describe('layoutLinkedText', () => {
	it('splits a line into plain and link runs at their measured positions', () => {
		const [line] = layoutLinkedText('see [[Note]] now', { x: 10, y: 0, w: 100, h: 20 }, 10, mono);
		expect(line?.runs.map((r) => [r.text, r.x, r.width, r.link?.linkpath ?? null])).toEqual([
			['see ', 10, 4, null],
			['Note', 14, 4, 'Note'],
			[' now', 18, 4, null],
		]);
	});

	it('wraps the display text, not the brackets, and splits a wrapped link', () => {
		const lines = layoutLinkedText('ab [[x|cd ef]] gh', { x: 0, y: 0, w: 5, h: 20 }, 10, mono);
		expect(lines.map((l) => l.runs.map((r) => `${r.link ? '*' : ''}${r.text}`))).toEqual([
			['ab ', '*cd'],
			['*ef', ' gh'],
		]);
	});
});

describe('inkLinkAt', () => {
	const item = textItem('see [[Note]] now', { box: { x: 0, y: 0, w: 100, h: 20 } });
	// First baseline: 0.8 * fontSize below the top edge (y = 20).
	const baseline = 20 - 8;

	it('finds the link under a point and nothing beside it', () => {
		expect(inkLinkAt(item, 6, baseline + 2, 0, mono)?.linkpath).toBe('Note');
		expect(inkLinkAt(item, 2, baseline + 2, 0, mono)).toBeNull();
		expect(inkLinkAt(item, 2, baseline + 2, 3, mono)?.linkpath).toBe('Note');
	});

	it('hits a rotated box where its text is drawn', () => {
		const turned = { ...item, rotation: 180 };
		// Turned half a turn about (50, 10), the run at x 4..8 lands at x 92..96.
		expect(inkLinkAt(turned, 94, 20 - (baseline + 2), 0, mono)?.linkpath).toBe('Note');
		expect(inkLinkAt(turned, 6, baseline + 2, 0, mono)).toBeNull();
	});

	it('gives link areas whose bounds cover the run', () => {
		const [area] = linkAreas(item, mono);
		expect(area?.rect).toEqual([4, baseline - 2.5, 8, baseline + 8.5]);
	});
});

describe('documentLinkpaths', () => {
	it('reads live text boxes on every page of both layers, skipping self links', () => {
		const deleted = { ...textItem('[[Gone]]'), deletedAt: 5 };
		const pages: Record<string, Item[]> = {
			'pdf:0': [textItem('[[A]] and [[A#x]]'), deleted],
			'ins:1': [textItem('[[#Self]] [[B.pdf]]')],
		};
		const base: Record<string, Item[]> = {
			'pdf:0': [textItem('[[FromBase]]', { id: 'base-1' })],
		};
		expect(documentLinkpaths(pages, base).sort()).toEqual(['A', 'A', 'B.pdf', 'FromBase']);
		expect(countLinkpaths(documentLinkpaths(pages))).toEqual({ A: 2, 'B.pdf': 1 });
	});

	it('lets a user record hide the base item it replaces', () => {
		const base = { 'pdf:0': [textItem('[[Old]]', { id: 'same' })] };
		const pages = { 'pdf:0': [{ ...textItem('[[Old]]', { id: 'same' }), deletedAt: 9 }] };
		expect(documentLinkpaths(pages, base)).toEqual([]);
	});
});

describe('rewriteLinks', () => {
	it('renames matching paths, keeping subpath, alias and embed mark', () => {
		const text = 'a [[Old.pdf#page=2|two]] b ![[Old.pdf]] c [[Other]]';
		const next = rewriteLinks(text, (l) => (l.linkpath === 'Old.pdf' ? 'New.pdf' : null));
		expect(next).toBe('a [[New.pdf#page=2|two]] b ![[New.pdf]] c [[Other]]');
	});

	it('returns null when nothing matches', () => {
		expect(rewriteLinks('[[A]]', () => null)).toBeNull();
		expect(rewriteLinks('[[A]]', () => 'A')).toBeNull();
	});
});
