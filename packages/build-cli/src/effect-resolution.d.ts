/**
 * Public declarations for the CLI's single-instance Effect resolver.
 *
 * @since 0.1.0
 */

/**
 * Installs the CLI's single-instance Effect module resolver.
 *
 * @category loading
 * @since 0.1.0
 * @slop
 */
export declare const installEffectResolution: () => void

/**
 * Evaluates one declaration module through tsx with the CLI's resolver in
 * front of tsx's namespace loader, so the module and the CLI share one Effect
 * instance.
 *
 * @category loading
 * @since 0.1.0
 * @slop
 */
export declare const importDeclarationModule: (url: string, parentURL: string) => Promise<unknown>

/**
 * Marks one admitted BUILD.ts URL for ES-module evaluation.
 *
 * @category loading
 * @since 0.1.0
 * @slop
 */
export declare const buildModuleUrl: (url: string) => string
