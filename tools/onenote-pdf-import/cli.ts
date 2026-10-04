/**
 * npm run import-onenote -- <input folder> [output folder] [options]
 *
 * Turns each OneNote PDF export in the input folder into a `.inknote` notebook
 * named after the file. The output folder defaults to the input folder.
 *
 *   --dry-run          list the notes found, their canvas size, path counts and
 *                      whether each becomes a board or Letter pages; write nothing
 *   --only <text>      only notes whose name contains <text>
 *   --simplify <pt>    simplification tolerance in points (default 0.1; 0 keeps
 *                      every point exactly as exported)
 *
 * Notes already written are skipped, so a rerun picks up where the last stopped.
 */

import { DEFAULT_SIMPLIFY, runImport } from './src/run';

function usage(message?: string): never {
	if (message) console.error(message);
	console.error('usage: import-onenote <input folder> [output folder] [--dry-run] [--only <text>] [--simplify <pt>]');
	process.exit(2);
}

const positional: string[] = [];
let dryRun = false;
let only: string | undefined;
let simplify = DEFAULT_SIMPLIFY;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
	const arg = args[i] ?? '';
	if (arg === '--dry-run') dryRun = true;
	else if (arg === '--only') {
		only = args[++i];
		if (only === undefined) usage('--only needs a value');
	} else if (arg === '--simplify') {
		simplify = Number(args[++i]);
		if (!Number.isFinite(simplify) || simplify < 0) usage('--simplify needs a number of points, 0 or more');
	} else if (arg.startsWith('--')) usage(`unknown option ${arg}`);
	else positional.push(arg);
}

const [input, output] = positional;
if (input === undefined || positional.length > 2) usage();

const results = await runImport({ input, output: output ?? input, dryRun, only, simplify });
if (results.some((r) => r.status === 'failed')) process.exit(1);
