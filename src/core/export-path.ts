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
 * result is a `.pdf`, and an empty one falls back to the default.
 */
export function exportPathFor(pdfPath: string, suffix: string): string {
	const safe = suffix.trim().length > 0 ? suffix : ' (annotated)';
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
