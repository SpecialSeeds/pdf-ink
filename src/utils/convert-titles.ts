import type { App, TFile, TFolder } from 'obsidian';
import type { BasePages } from '../core/base-layer';
import { parseInkData, serializeInkData } from '../core/ink-serialization';
import { isNotebookPath } from '../core/new-notebook';
import { titleFromPath } from '../core/header';
import { type SkipReason, checkTitleConversion, convertTitleToHeader } from '../core/title-migration';
import { readBaseLayer } from '../pdf/base-file';

/** One notebook the conversion would change. */
export interface PlannedConversion {
	readonly file: TFile;
	readonly createdAt: number;
	/** The text boxes it replaces. */
	readonly removed: number;
	/** The base layer read while planning, to recompute against at write time. */
	readonly base: BasePages | undefined;
}

/** A notebook the dry run looked at and would leave alone, and why. */
export interface SkippedNotebook {
	readonly file: TFile;
	readonly reason: SkipReason;
}

export interface ConversionPlan {
	readonly matches: PlannedConversion[];
	/** Notebooks looked at that would not be converted, with the reason. */
	readonly skipped: SkippedNotebook[];
	/** Notebooks that could not be read. */
	readonly unreadable: string[];
}

/** Every notebook in `folder` and the folders under it. */
function notebooksIn(app: App, folder: TFolder): TFile[] {
	const prefix = folder.isRoot() ? '' : `${folder.path}/`;
	return app.vault
		.getFiles()
		.filter((file) => isNotebookPath(file.path) && file.path.startsWith(prefix))
		.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The dry run: which notebooks would get a header, and from what date. Reads
 * only; nothing is written.
 */
export async function planTitleConversions(app: App, folder: TFolder): Promise<ConversionPlan> {
	const matches: PlannedConversion[] = [];
	const unreadable: string[] = [];
	const skipped: SkippedNotebook[] = [];
	for (const file of notebooksIn(app, folder)) {
		try {
			const parsed = parseInkData(await app.vault.read(file));
			if (!parsed.ok) {
				unreadable.push(file.path);
				continue;
			}
			let base: BasePages | undefined;
			if (parsed.data.base) {
				const found = await readBaseLayer(app, file, parsed.data.base);
				if (typeof found === 'string') {
					unreadable.push(file.path);
					continue;
				}
				base = found.pages;
			}
			const conversion = checkTitleConversion(parsed.data, base, titleFromPath(file.path), Date.now());
			if ('reason' in conversion) {
				skipped.push({ file, reason: conversion.reason });
				continue;
			}
			matches.push({ file, createdAt: conversion.createdAt, removed: conversion.removed, base });
		} catch (err) {
			console.error(`pdf-ink: could not read ${file.path}`, err);
			unreadable.push(file.path);
		}
	}
	return { matches, skipped, unreadable };
}

/**
 * Write the planned conversions. Each notebook is converted again from what is
 * on disk at that moment, so an edit made since the dry run is kept, and one
 * that no longer matches is left alone. Returns how many were converted.
 */
export async function applyTitleConversions(
	app: App,
	plans: readonly PlannedConversion[],
): Promise<number> {
	let converted = 0;
	for (const plan of plans) {
		try {
			await app.vault.process(plan.file, (current) => {
				const parsed = parseInkData(current);
				if (!parsed.ok) return current;
				const conversion = convertTitleToHeader(
					parsed.data,
					plan.base,
					titleFromPath(plan.file.path),
					Date.now(),
				);
				if (!conversion) return current;
				converted += 1;
				return serializeInkData(conversion.data);
			});
		} catch (err) {
			console.error(`pdf-ink: could not convert ${plan.file.path}`, err);
		}
	}
	return converted;
}
