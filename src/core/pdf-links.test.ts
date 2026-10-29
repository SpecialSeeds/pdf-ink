import { describe, expect, it } from 'vitest';
import { destinationTop, linkAt, linksFrom } from './pdf-links';

const ref = { num: 12, gen: 0 };

describe('linksFrom', () => {
	it('reads internal, external and named links, normalising the rect', () => {
		const links = linksFrom([
			{ subtype: 'Link', rect: [200, 120, 100, 100], dest: [ref, { name: 'XYZ' }, 0, 700, null] },
			{ subtype: 'Link', rect: [0, 0, 10, 10], url: 'https://example.com/' },
			{ subtype: 'Link', rect: [0, 0, 10, 10], dest: 'chapter.2' },
			{ subtype: 'Link', rect: [0, 0, 10, 10], action: 'NextPage' },
		]);
		expect(links.map((l) => l.target.kind)).toEqual(['dest', 'url', 'dest', 'named']);
		expect(links[0]?.rect).toEqual([100, 100, 200, 120]);
	});

	it('drops what is not a followable link', () => {
		const links = linksFrom([
			{ subtype: 'Text', rect: [0, 0, 1, 1] },
			{ subtype: 'Link', rect: [0, 0, 1, 1], url: 'javascript:alert(1)' },
			{ subtype: 'Link', rect: [0, 0, 1, 1], url: 'file:///etc/passwd' },
			{ subtype: 'Link', rect: [0, 0, 1, 1], action: 'Print' },
			{ subtype: 'Link', rect: [0, 0, 1], url: 'https://example.com' },
			{ subtype: 'Link', rect: [0, 0, 1, 1] },
			null,
			'Link',
		]);
		expect(links).toEqual([]);
	});

	it('falls back to the unsafe url pdf.js keeps when it will not resolve one', () => {
		const [link] = linksFrom([{ subtype: 'Link', rect: [0, 0, 1, 1], unsafeUrl: 'mailto:a@b.c' }]);
		expect(link?.target).toEqual({ kind: 'url', url: 'mailto:a@b.c' });
	});
});

describe('linkAt', () => {
	const links = linksFrom([
		{ subtype: 'Link', rect: [100, 100, 200, 112], dest: 'a' },
		{ subtype: 'Link', rect: [100, 116, 200, 128], dest: 'b' },
	]);

	it('finds the link under the point', () => {
		expect(linkAt(links, 150, 106, 0)?.target).toEqual({ kind: 'dest', dest: 'a' });
	});

	it('reaches a link just beside a fingertip, within the slop', () => {
		expect(linkAt(links, 205, 106, 6)).not.toBeNull();
		expect(linkAt(links, 220, 106, 6)).toBeNull();
	});

	it('prefers the nearer of two links', () => {
		expect(linkAt(links, 150, 115, 10)?.target).toEqual({ kind: 'dest', dest: 'b' });
	});
});

describe('destinationTop', () => {
	it('reads the top of the destinations that have one', () => {
		expect(destinationTop([ref, { name: 'XYZ' }, 72, 640, 0])).toBe(640);
		expect(destinationTop([ref, { name: 'FitH' }, 500])).toBe(500);
		expect(destinationTop([ref, { name: 'FitBH' }, 480])).toBe(480);
		expect(destinationTop([ref, { name: 'FitR' }, 0, 100, 300, 420])).toBe(420);
	});

	it('is null for a whole page, or a missing top', () => {
		expect(destinationTop([ref, { name: 'Fit' }])).toBeNull();
		expect(destinationTop([ref, { name: 'XYZ' }, null, null, null])).toBeNull();
		expect(destinationTop([ref])).toBeNull();
	});
});
