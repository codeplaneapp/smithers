import { Context, Effect, Layer } from "effect";
import { SmithersError } from "@smithers/errors/SmithersError";
export type SmithersIdeOverlayType = "chat" | "progress" | "panel";
export type SmithersIdeOverlayOptions = {
    readonly message: string;
    readonly title?: string;
    readonly position?: "top" | "center" | "bottom";
    readonly duration?: number;
    readonly percent?: number;
};
export type SmithersIdeCommandBaseResult = {
    readonly args: readonly string[];
    readonly command: string;
    readonly exitCode: number | null;
    readonly stderr: string;
    readonly stdout: string;
};
export type SmithersIdeOpenFileResult = SmithersIdeCommandBaseResult & {
    readonly column: number | null;
    readonly line: number | null;
    readonly opened: boolean;
    readonly path: string;
};
export type SmithersIdeOpenDiffResult = SmithersIdeCommandBaseResult & {
    readonly opened: boolean;
};
export type SmithersIdeOverlayResult = SmithersIdeCommandBaseResult & {
    readonly overlayId: string | null;
    readonly shown: boolean;
    readonly type: SmithersIdeOverlayType;
};
export type SmithersIdeRunTerminalResult = SmithersIdeCommandBaseResult & {
    readonly cwd: string | null;
    readonly launched: boolean;
    readonly status: string;
    readonly terminalCommand: string;
};
export type SmithersIdeAskUserResult = SmithersIdeCommandBaseResult & {
    readonly overlayId: string | null;
    readonly prompt: string;
    readonly status: "prompted";
};
export type SmithersIdeOpenWebviewResult = SmithersIdeCommandBaseResult & {
    readonly opened: boolean;
    readonly tabId: string | null;
    readonly url: string;
};
export type SmithersIdeAvailability = {
    readonly available: true;
    readonly binaryAvailable: true;
    readonly binaryPath: string;
    readonly environmentActive: true;
    readonly reason: "available";
    readonly signals: readonly string[];
} | {
    readonly available: false;
    readonly binaryAvailable: boolean;
    readonly binaryPath: string | null;
    readonly environmentActive: boolean;
    readonly reason: "binary-missing" | "environment-inactive";
    readonly signals: readonly string[];
};
export type SmithersIdeServiceConfig = {
    readonly command?: string;
    readonly cwd?: string;
    readonly env?: Record<string, string | undefined>;
    readonly idleTimeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly timeoutMs?: number;
};
export type SmithersIdeResolvedConfig = {
    readonly command: string;
    readonly cwd: string;
    readonly env: Record<string, string | undefined>;
    readonly idleTimeoutMs: number;
    readonly maxOutputBytes: number;
    readonly timeoutMs: number;
};
export type SmithersIdeServiceApi = {
    readonly config: SmithersIdeResolvedConfig;
    readonly askUser: (prompt: string) => Effect.Effect<SmithersIdeAskUserResult, SmithersError>;
    readonly detectAvailability: () => Effect.Effect<SmithersIdeAvailability>;
    readonly openDiff: (content: string) => Effect.Effect<SmithersIdeOpenDiffResult, SmithersError>;
    readonly openFile: (path: string, line?: number, column?: number) => Effect.Effect<SmithersIdeOpenFileResult, SmithersError>;
    readonly openWebview: (url: string) => Effect.Effect<SmithersIdeOpenWebviewResult, SmithersError>;
    readonly runTerminal: (command: string, cwd?: string) => Effect.Effect<SmithersIdeRunTerminalResult, SmithersError>;
    readonly showOverlay: (type: SmithersIdeOverlayType, options: SmithersIdeOverlayOptions) => Effect.Effect<SmithersIdeOverlayResult, SmithersError>;
};
declare const SmithersIdeService_base: Context.TagClass<SmithersIdeService, "SmithersIdeService", SmithersIdeServiceApi>;
export declare class SmithersIdeService extends SmithersIdeService_base {
}
export declare function detectSmithersIdeAvailabilityEffect(config?: SmithersIdeServiceConfig): Effect.Effect<SmithersIdeAvailability, never, never>;
export declare function createSmithersIdeService(config?: SmithersIdeServiceConfig): SmithersIdeServiceApi;
export declare function createSmithersIdeLayer(config?: SmithersIdeServiceConfig): Layer.Layer<SmithersIdeService, never, never>;
export declare function openFile(path: string, line?: number, column?: number): Effect.Effect<SmithersIdeOpenFileResult, SmithersError, SmithersIdeService>;
export declare function openDiff(content: string): Effect.Effect<SmithersIdeOpenDiffResult, SmithersError, SmithersIdeService>;
export declare function showOverlay(type: SmithersIdeOverlayType, options: SmithersIdeOverlayOptions): Effect.Effect<SmithersIdeOverlayResult, SmithersError, SmithersIdeService>;
export declare function runTerminal(command: string, cwd?: string): Effect.Effect<SmithersIdeRunTerminalResult, SmithersError, SmithersIdeService>;
export declare function askUser(prompt: string): Effect.Effect<SmithersIdeAskUserResult, SmithersError, SmithersIdeService>;
export declare function openWebview(url: string): Effect.Effect<SmithersIdeOpenWebviewResult, SmithersError, SmithersIdeService>;
export {};
