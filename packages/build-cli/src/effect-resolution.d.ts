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
 * Marks one admitted BUILD.ts URL for ES-module evaluation.
 *
 * @category loading
 * @since 0.1.0
 * @slop
 */
export declare const buildModuleUrl: (url: string) => string
