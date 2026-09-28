import { describe, expect, it } from 'vitest';
import { exportPathFor, parentFolder } from './export-path';

describe('exportPathFor', () => {
	it('puts the export in an "annotated" folder beside the PDF', () => {
		expect(exportPathFor('APMA/Worksheets/Wkst 9-28.pdf', ' (annotated)')).toBe(
			'APMA/Worksheets/annotated/Wkst 9-28 (annotated).pdf',
		);
	});

	it('works at the vault root', () => {
		expect(exportPathFor('paper.pdf', '-marked')).toBe('annotated/paper-marked.pdf');
	});

	it('keeps a dot in the folder name out of the extension', () => {
		expect(exportPathFor('v1.2/paper', ' (annotated)')).toBe(
			'v1.2/annotated/paper (annotated).pdf',
		);
	});

	it('falls back to the default suffix when given a blank one', () => {
		expect(exportPathFor('a/b.pdf', '  ')).toBe('a/annotated/b (annotated).pdf');
	});
});

describe('parentFolder', () => {
	it('is the folder part of a path', () => {
		expect(parentFolder('a/b/c.pdf')).toBe('a/b');
		expect(parentFolder('c.pdf')).toBe('');
	});
});
