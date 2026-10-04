import { describe, expect, it } from 'vitest';
import {
	HEADER_BAND,
	type NotebookHeader,
	detectTitleHeader,
	formatHeaderDate,
	headerLayout,
	headerText,
	headerTitleBox,
	normalizeTitle,
	parseHeaderDate,
	renameTargetFor,
	reserveHeaderBand,
	titleFromPath,
} from './header';
import { parseInkData, serializeInkData } from './ink-serialization';
import { INK_DATA_VERSION, type TextItem } from './items';
import { insertedGeometry, pagesSignature } from './page-composition';
import type { InsertedPage } from './pages';
import { templateGeometry } from './templates';

const OCT_3_2026_1402 = new Date(2026, 9, 3, 14, 2).getTime();

const page: InsertedPage = {
	id: 'p1',
	afterPdfPage: -1,
	sortKey: 'a0',
	template: 'grid5',
	size: { width: 612, height: 792 },
	updatedAt: 0,
};

function text(id: string, value: string, x: number, top: number, fontSize: number): TextItem {
	return {
		type: 'text',
		id,
		color: '#000000',
		opacity: 1,
		rotation: 0,
		z: 0,
		updatedAt: 0,
		box: { x, y: top - fontSize * 1.2, w: 300, h: fontSize * 1.2 },
		text: value,
		fontSize,
	};
}

describe('header dates', () => {
	it('write OneNote style by default, and ISO when asked', () => {
		expect(formatHeaderDate(OCT_3_2026_1402, 'onenote')).toBe('Saturday, October 3, 2026  2:02 PM');
		expect(formatHeaderDate(OCT_3_2026_1402, 'iso')).toBe('2026-10-03 14:02');
		expect(formatHeaderDate(new Date(2026, 0, 5, 0, 7).getTime(), 'onenote')).toBe('Monday, January 5, 2026  12:07 AM');
		expect(formatHeaderDate(new Date(2026, 0, 5, 12, 0).getTime(), 'onenote')).toBe('Monday, January 5, 2026  12:00 PM');
	});

	it('parse what OneNote and ISO write, as local time', () => {
		expect(parseHeaderDate('Saturday, October 3, 2026 2:02 PM')).toBe(OCT_3_2026_1402);
		expect(parseHeaderDate('Saturday, October 3, 2026  2:02 PM')).toBe(OCT_3_2026_1402);
		expect(parseHeaderDate('October 3, 2026')).toBe(new Date(2026, 9, 3).getTime());
		expect(parseHeaderDate('Wednesday, August 26, 2026 11:15 AM')).toBe(new Date(2026, 7, 26, 11, 15).getTime());
		expect(parseHeaderDate('2026-10-03 14:02')).toBe(OCT_3_2026_1402);
	});

	it('refuse what is not a date', () => {
		expect(parseHeaderDate('Proportionality')).toBeNull();
		expect(parseHeaderDate('Smarch 3, 2026')).toBeNull();
		expect(parseHeaderDate('February 30, 2026')).toBeNull();
		expect(parseHeaderDate('2026-13-01')).toBeNull();
	});
});

describe('the title', () => {
	it('is always the file name', () => {
		expect(titleFromPath('class/Week 2.inknote')).toBe('Week 2');
		const header: NotebookHeader = { createdAt: OCT_3_2026_1402 };
		expect(headerText('class/Week 2.inknote', header, 'iso')).toEqual({ title: 'Week 2', date: '2026-10-03 14:02' });
		// A notebook's own format wins over the setting.
		expect(headerText('a.inknote', { ...header, dateFormat: 'iso' }, 'onenote').date).toBe('2026-10-03 14:02');
	});

	it('follows a rename at once: the first page shows the new name and is rebuilt', () => {
		const header: NotebookHeader = { createdAt: OCT_3_2026_1402 };
		const before = insertedGeometry(page, headerText('class/Old.inknote', header, 'onenote'));
		const after = insertedGeometry(page, headerText('class/New name.inknote', header, 'onenote'));
		expect(after.source.kind === 'inserted' && after.source.header?.title).toBe('New name');
		expect(pagesSignature([after])).not.toBe(pagesSignature([before]));
	});

	it('round-trips its stored part, and never stores the title', () => {
		const data = {
			version: INK_DATA_VERSION,
			pages: {},
			insertedPages: [page],
			header: { createdAt: OCT_3_2026_1402, dateFormat: 'iso' as const },
		};
		const text = serializeInkData(data);
		expect(text).not.toContain('title');
		const parsed = parseInkData(text);
		expect(parsed.ok && parsed.data.header).toEqual(data.header);
		const junk = parseInkData(JSON.stringify({ ...data, header: { createdAt: 'yesterday' } }));
		expect(junk.ok && junk.data.header).toBeUndefined();
	});
});

describe('header layout', () => {
	it('mirrors OneNote: 36 pt in, title and date baselines and a rule near the top', () => {
		const layout = headerLayout(page);
		expect(layout.x).toBe(36);
		expect(layout.titleBaseline).toBeCloseTo(792 - 33.5, 6);
		expect(layout.dateBaseline).toBeCloseTo(792 - 51.1, 6);
		expect(layout.ruleY).toBeLessThan(layout.dateBaseline);
		expect(layout.bandBottom).toBe(792 - HEADER_BAND);
		expect(layout.ruleX2).toBe(612 - 36);
	});

	it('follows a board that has grown downward', () => {
		const grown = { ...page, size: { width: 1000, height: 900 }, origin: { x: 0, y: -300 } };
		expect(headerLayout(grown).titleBaseline).toBeCloseTo(600 - 33.5, 6);
		const box = headerTitleBox(grown);
		expect(box.maxY).toBeGreaterThan(600 - 33.5);
		expect(box.minY).toBeGreaterThan(headerLayout(grown).dateBaseline);
	});

	it('keeps the ruling out of its band, so writing starts below it', () => {
		const ruling = templateGeometry('grid5', 612, 792);
		const band = headerLayout(page).bandBottom;
		const kept = reserveHeaderBand(ruling, band);
		expect(kept.lines.length).toBeGreaterThan(0);
		for (const line of kept.lines) expect(Math.max(line.y1, line.y2)).toBeLessThanOrEqual(band + 1e-9);
		const dots = reserveHeaderBand(templateGeometry('dot', 612, 792), band).dots;
		for (const dot of dots) expect(dot.y).toBeLessThan(band);
	});
});

describe('detectTitleHeader', () => {
	const top = 792;
	const title = text('t', '1.3 Modeling: Building ODEs', 36, top - 15, 20);
	const date = text('d', 'Saturday, October 3, 2026', 36, top - 44, 10);
	const time = text('h', '2:02 PM', 165, top - 44, 10);

	it('finds the title and its date line, in two runs', () => {
		expect(detectTitleHeader([date, time, title], '1.3 Modeling Building ODEs', top)).toEqual({
			createdAt: OCT_3_2026_1402,
			ids: ['t', 'd', 'h'],
		});
	});

	it('compares titles by their letters and digits only', () => {
		expect(normalizeTitle('1.3 Modeling: Building ODEs')).toBe(normalizeTitle('1.3 modeling building odes'));
		expect(normalizeTitle('Section 1')).not.toBe(normalizeTitle('Section 11'));
	});

	it('wants both the title and the date', () => {
		expect(detectTitleHeader([title], '1.3 Modeling Building ODEs', top)).toBeNull();
		expect(detectTitleHeader([title, date, time], 'Something else', top)).toBeNull();
		const notADate = text('n', 'Proportionality', 36, top - 44, 10);
		expect(detectTitleHeader([title, notADate], '1.3 Modeling Building ODEs', top)).toBeNull();
	});

	it('only takes the topmost text, near the top of the page', () => {
		const above = text('a', 'Something first', 36, top - 5, 12);
		expect(detectTitleHeader([above, title, date, time], '1.3 Modeling Building ODEs', top)).toBeNull();
		const low = text('t', 'Section 1', 36, top - 300, 20);
		const lowDate = text('d', 'Wednesday, August 26, 2026', 36, top - 330, 10);
		expect(detectTitleHeader([low, lowDate], 'Section 1', top)).toBeNull();
	});
});

describe('renameTargetFor', () => {
	const taken = new Set(['class/Taken.inknote']);
	const exists = (path: string): boolean => taken.has(path);

	it('renames within the same folder', () => {
		expect(renameTargetFor('class/Old.inknote', '  New name ', exists)).toEqual({ ok: true, path: 'class/New name.inknote' });
		expect(renameTargetFor('Old.inknote', 'New', exists)).toEqual({ ok: true, path: 'New.inknote' });
	});

	it('refuses a name already taken, so the title reverts', () => {
		expect(renameTargetFor('class/Old.inknote', 'Taken', exists)).toEqual({ ok: false, reason: 'exists' });
	});

	it('refuses an empty or unusable name, and does nothing for the same one', () => {
		expect(renameTargetFor('class/Old.inknote', '  ', exists)).toEqual({ ok: false, reason: 'empty' });
		expect(renameTargetFor('class/Old.inknote', 'a/b', exists)).toEqual({ ok: false, reason: 'invalid' });
		expect(renameTargetFor('class/Old.inknote', 'Week #2', exists)).toEqual({ ok: false, reason: 'invalid' });
		expect(renameTargetFor('class/Old.inknote', 'Old', exists)).toEqual({ ok: false, reason: 'unchanged' });
	});

	it('allows a change of case alone', () => {
		const old = new Set(['class/old.inknote']);
		expect(renameTargetFor('class/old.inknote', 'Old', (p) => old.has(p.toLowerCase()))).toEqual({
			ok: true,
			path: 'class/Old.inknote',
		});
	});
});
