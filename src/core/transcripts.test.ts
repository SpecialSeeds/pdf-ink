import { describe, expect, it } from 'vitest';
import type { InkData } from './items';
import {
	blockBoxFrom,
	isRenderStale,
	isTranscriptCurrent,
	isTranscriptPath,
	latestUpdatedAt,
	normalizeFolder,
	parseInkSubpath,
	parseTranscript,
	renderPagePath,
	resolveRedirect,
	shouldDeleteRenders,
	transcriptPathFor,
	transcriptionInstructions,
} from './transcripts';

const FOLDER = '_system/transcripts';

const TRANSCRIPT = `---
source: classes/Notes/1.3 Modeling.inknote
source_updated: 1700
---
## Page 1
[B1] Proportionality
[B2] If A and B are proportional, then $A = \\pm kB$
[B2] growth or decay?

## Page 2
[B1] Newton's law of cooling: $\\frac{dT}{dt} = -k(T - T_0)$
untagged aside
[B4] [diagram: tank with inflow F_in]
`;

describe('transcript paths', () => {
	it('mirror the source under the transcript folder', () => {
		expect(transcriptPathFor('classes/APMA 2130/Notes/1.3 Modeling Building ODEs.inknote', FOLDER)).toBe(
			'_system/transcripts/classes/APMA 2130/Notes/1.3 Modeling Building ODEs.md',
		);
		expect(transcriptPathFor('Paper.pdf', FOLDER)).toBe('_system/transcripts/Paper.pdf.md');
	});

	it('tell transcripts from the instructions and from everything else', () => {
		expect(isTranscriptPath('_system/transcripts/a/b.md', FOLDER)).toBe(true);
		expect(isTranscriptPath('_system/transcripts/TRANSCRIBE.md', FOLDER)).toBe(false);
		expect(isTranscriptPath('notes/b.md', FOLDER)).toBe(false);
	});

	it('put renders under the render folder, and clean up folder settings', () => {
		expect(renderPagePath('a/b.inknote', '.pdf-ink-render', 3)).toBe('.pdf-ink-render/a/b.inknote/page-3.png');
		expect(normalizeFolder(' /_system//transcripts/ ', 'x')).toBe('_system/transcripts');
		expect(normalizeFolder('', 'x')).toBe('x');
	});
});

describe('staleness', () => {
	it('renders again when there is no render, or the source changed since', () => {
		expect(isRenderStale(null, [5])).toBe(true);
		expect(isRenderStale(10, [5, 9])).toBe(false);
		expect(isRenderStale(10, [5, 11])).toBe(true);
	});

	it('takes the newest edit anywhere in the document', () => {
		const data: InkData = {
			version: 5,
			pages: { 'ins:a': [{ type: 'text', id: 't', color: '#000', opacity: 1, rotation: 0, z: 0, updatedAt: 50, deletedAt: 70, box: { x: 0, y: 0, w: 1, h: 1 }, text: '', fontSize: 1 }] },
			insertedPages: [{ id: 'a', afterPdfPage: -1, sortKey: 'a0', template: 'blank', size: { width: 1, height: 1 }, updatedAt: 60 }],
		};
		expect(latestUpdatedAt(data)).toBe(70);
		expect(latestUpdatedAt(data, { 'ins:a': [{ type: 'text', id: 'b', color: '#000', opacity: 1, rotation: 0, z: 0, updatedAt: 90, box: { x: 0, y: 0, w: 1, h: 1 }, text: '', fontSize: 1 }] })).toBe(90);
	});

	it('calls a transcript current only when its source_updated matches', () => {
		expect(isTranscriptCurrent(1700, 1700)).toBe(true);
		expect(isTranscriptCurrent('1700', 1700)).toBe(true);
		expect(isTranscriptCurrent(1699, 1700)).toBe(false);
		expect(isTranscriptCurrent(undefined, 1700)).toBe(false);
	});

	it('deletes renders only once transcribed, and only when asked to', () => {
		expect(shouldDeleteRenders(true, 1700, 1700)).toBe(true);
		expect(shouldDeleteRenders(false, 1700, 1700)).toBe(false);
		expect(shouldDeleteRenders(true, 1600, 1700)).toBe(false);
	});
});

describe('reading a transcript', () => {
	it('tags every line with its page and block', () => {
		const lines = parseTranscript(TRANSCRIPT);
		expect(lines.map((l) => [l.page, l.block, l.text.slice(0, 15)])).toEqual([
			[1, 'B1', 'Proportionality'],
			[1, 'B2', 'If A and B are '],
			[1, 'B2', 'growth or decay'],
			[2, 'B1', "Newton's law of"],
			[2, null, 'untagged aside'],
			[2, 'B4', '[diagram: tank '],
		]);
	});
});

describe('resolveRedirect', () => {
	it('lands on the block of the cursor\'s line', () => {
		// Line 7 is "[B2] growth or decay?".
		expect(resolveRedirect(TRANSCRIPT, 7)).toEqual({ page: 1, block: 'B2' });
		expect(resolveRedirect(TRANSCRIPT, 10)).toEqual({ page: 2, block: 'B1' });
	});

	it('takes the nearest tagged line on the page for an untagged one', () => {
		// "untagged aside" sits between B1 and B4, nearer B1.
		expect(resolveRedirect(TRANSCRIPT, 11)).toEqual({ page: 2, block: 'B1' });
	});

	it('falls back to the page of the heading above, then to page 1', () => {
		expect(resolveRedirect('## Page 3\nnothing tagged here\n', 1)).toEqual({ page: 3 });
		expect(resolveRedirect('no headings at all', 0)).toEqual({ page: 1 });
		// In the frontmatter: the first block.
		expect(resolveRedirect(TRANSCRIPT, 1)).toEqual({ page: 1, block: 'B1' });
	});
});

describe('links into the handwriting', () => {
	it('read a page, and a page and block', () => {
		expect(parseInkSubpath('#page=3')).toEqual({ page: 3 });
		expect(parseInkSubpath('#page=3&block=B12')).toEqual({ page: 3, block: 'B12' });
		expect(parseInkSubpath('page=2&block=B1')).toEqual({ page: 2, block: 'B1' });
	});

	it('ignore what is not a page, and a block that is not an id', () => {
		expect(parseInkSubpath('#Heading')).toBeNull();
		expect(parseInkSubpath('#page=0')).toBeNull();
		expect(parseInkSubpath('#page=2&block=evil')).toEqual({ page: 2 });
	});

	it('find a block\'s box in the frontmatter field', () => {
		const field = { 1: { B1: [10, 20, 30, 40] }, '2': { B3: ['1', '2', '3', '4'] } };
		expect(blockBoxFrom(field, 1, 'B1')).toEqual([10, 20, 30, 40]);
		expect(blockBoxFrom(field, 2, 'B3')).toEqual([1, 2, 3, 4]);
		expect(blockBoxFrom(field, 3, 'B1')).toBeNull();
		expect(blockBoxFrom({ 1: { B1: [1, 2] } }, 1, 'B1')).toBeNull();
	});
});

describe('the instructions for Claudian', () => {
	it('are the given text, with the folders as configured', () => {
		const text = transcriptionInstructions('.pdf-ink-render', '_system/transcripts');
		expect(text.startsWith('Transcription instructions. Run when asked to "transcribe notes".\n1. Read .pdf-ink-render/manifest.json.')).toBe(true);
		expect(text).toContain('$\\frac{dT}{dt} =');
		expect(text).toContain('6. When answering questions about my notes, search _system/transcripts and');
		expect(text).toContain('[[<source>#page=N&block=BX]]');
		expect(transcriptionInstructions('.r', 'notes/t')).toContain('1. Read .r/manifest.json.');
	});
});
