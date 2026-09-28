import type { App, Plugin } from 'obsidian';
import { VIEW_TYPE_PDF_INK } from '../constants';

/** The core PDF viewer's view type, for handing `.pdf` back. */
export const CORE_PDF_VIEW_TYPE = 'pdf';

/**
 * The part of Obsidian's view registry this needs. Not in the public typings.
 *
 * `Plugin.registerExtensions` is public, but it throws for an extension that
 * already has a handler — and the core viewer owns `.pdf` — so taking it over
 * means unregistering the core mapping first, which only the registry can do.
 */
interface ViewRegistry {
	typeByExtension: Record<string, string | undefined>;
	registerExtensions(extensions: string[], viewType: string): void;
	unregisterExtensions(extensions: string[]): void;
}

function viewRegistry(app: App): ViewRegistry | null {
	const registry = (app as unknown as { viewRegistry?: Partial<ViewRegistry> })
		.viewRegistry;
	if (
		registry &&
		typeof registry.typeByExtension === 'object' &&
		typeof registry.registerExtensions === 'function' &&
		typeof registry.unregisterExtensions === 'function'
	) {
		return registry as ViewRegistry;
	}
	return null;
}

/**
 * Makes the ink view the handler for `.pdf`, and gives it back.
 *
 * Whatever handled `.pdf` before is remembered and restored — when the setting is
 * turned off and when the plugin unloads — so disabling the plugin never leaves
 * PDFs with no viewer at all.
 */
export class DefaultPdfViewer {
	/** The view type that owned `.pdf` before we took it. */
	private previous: string | null = null;

	constructor(private readonly plugin: Plugin) {
		plugin.register(() => {
			this.apply(false);
		});
	}

	/** The view type to hand a PDF to when leaving the ink view. */
	get plainViewType(): string {
		return this.previous ?? CORE_PDF_VIEW_TYPE;
	}

	apply(enabled: boolean): void {
		const registry = viewRegistry(this.plugin.app);
		// An Obsidian without the registry keeps its own viewer; the ink view is
		// still reachable through the command and the file menu.
		if (!registry) return;
		const current = registry.typeByExtension['pdf'];

		try {
			if (enabled && current !== VIEW_TYPE_PDF_INK) {
				this.previous = current ?? CORE_PDF_VIEW_TYPE;
				if (current !== undefined) registry.unregisterExtensions(['pdf']);
				registry.registerExtensions(['pdf'], VIEW_TYPE_PDF_INK);
			} else if (!enabled && current === VIEW_TYPE_PDF_INK) {
				registry.unregisterExtensions(['pdf']);
				registry.registerExtensions(['pdf'], this.plainViewType);
			}
		} catch (err) {
			console.error('pdf-ink: could not change the default PDF viewer', err);
		}
	}
}
