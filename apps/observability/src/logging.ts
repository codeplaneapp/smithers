type LogAnnotations = Record<string, unknown> | undefined;
export declare function logDebug(message: string, annotations?: LogAnnotations, span?: string): void;
export declare function logInfo(message: string, annotations?: LogAnnotations, span?: string): void;
export declare function logWarning(message: string, annotations?: LogAnnotations, span?: string): void;
export declare function logError(message: string, annotations?: LogAnnotations, span?: string): void;
export {};
