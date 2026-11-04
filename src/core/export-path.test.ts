import { describe, expect, it } from 'vitest';
import { exportPathFor, imagePathFor, parentFolder } from './export-path';

describe('exportPathFor', () => {
	it('puts the export in an "annotated" folder beside the PDF', () => {
		expect(exportPathFor('APMA/Worksheets/Wkst 9-28.pdf', ' (annotated)')).toBe(
			'APMA/Worksheets/annotated/Wkst 9-28 (annotated).pdf',
		);
	});

	it('puts a variant after the suffix, the default one included', () => {
		expect(exportPathFor('notes/paper.pdf', ' (annotated)', ' (original pages)')).toBe(
			'notes/annotated/paper (annotated) (original pages).pdf',
		);
		expect(exportPathFor('paper.pdf', '  ', ' (original pages)')).toBe(
			'annotated/paper (annotated) (original pages).pdf',
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

describe('imagePathFor', () => {
	const none = () => false;

	it('puts a picture in an "images" folder beside the file', () => {
		expect(imagePathFor('APMA/Worksheets/Wkst 9-28.pdf', 'Photo', 'png', none)).toBe(
			'APMA/Worksheets/images/Photo.png',
		);
		expect(imagePathFor('Notes.inknote', 'Photo', 'jpg', none)).toBe('images/Photo.jpg');
	});

	it('numbers a name that is taken rather than replace a picture', () => {
		const taken = new Set(['a/images/Photo.png', 'a/images/Photo 1.png']);
		expect(imagePathFor('a/b.pdf', 'Photo', 'png', (path) => taken.has(path))).toBe(
			'a/images/Photo 2.png',
		);
	});
});
