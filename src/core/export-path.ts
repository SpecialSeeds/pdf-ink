/**
 * Where an export is written. Pure.
 */

/** The folder, beside the source PDF, that exports go into. */
export const EXPORT_FOLDER = 'annotated';

/**
 * `notes/paper.pdf` becomes `notes/annotated/paper (annotated).pdf`.
 *
 * Exports get a folder of their own so they do not pile up beside the PDFs and
 * their annotation files. The suffix still goes before the extension, so the
 * result is a `.pdf`, and an empty one falls back to the default. A `variant`
 * follows the suffix, so a differently made export does not replace the usual one.
 */
export function exportPathFor(pdfPath: string, suffix: string, variant = ''): string {
	const safe = (suffix.trim().length > 0 ? suffix : ' (annotated)') + variant;
	const slash = pdfPath.lastIndexOf('/');
	const folder = slash < 0 ? '' : pdfPath.slice(0, slash + 1);
	const name = pdfPath.slice(slash + 1);
	const dot = name.lastIndexOf('.');
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const extension = dot > 0 ? name.slice(dot) : '.pdf';
	return `${folder}${EXPORT_FOLDER}/${stem}${safe}${extension}`;
}

/** The folder part of a vault path, or '' at the vault root. */
export function parentFolder(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash < 0 ? '' : path.slice(0, slash);
}

/** What an export of the original pages alone adds to its name. */
export const ORIGINAL_PAGES_VARIANT = ' (original pages)';

/** The folder, beside the PDF or notebook, that inserted pictures go into. */
export const IMAGE_FOLDER = 'images';

/**
 * Where a picture inserted into `sourcePath` is saved: `notes/paper.pdf` puts
 * `Photo.png` at `notes/images/Photo.png`, or `notes/images/Photo 1.png` and so on
 * when that name is taken, so an earlier picture is never replaced.
 */
export function imagePathFor(
	sourcePath: string,
	stem: string,
	extension: string,
	taken: (path: string) => boolean,
): string {
	const folder = parentFolder(sourcePath);
	const base = `${folder ? `${folder}/` : ''}${IMAGE_FOLDER}/${stem}`;
	let path = `${base}.${extension}`;
	for (let n = 1; taken(path); n++) path = `${base} ${n}.${extension}`;
	return path;
}
