import { type SmithersIdeAvailability, type SmithersIdeServiceConfig } from "./SmithersIdeService";
export { askUser, createSmithersIdeLayer, createSmithersIdeService, detectSmithersIdeAvailabilityEffect, openDiff, openFile, openWebview, runTerminal, showOverlay, SmithersIdeService, type SmithersIdeAskUserResult, type SmithersIdeAvailability, type SmithersIdeCommandBaseResult, type SmithersIdeOpenDiffResult, type SmithersIdeOpenFileResult, type SmithersIdeOpenWebviewResult, type SmithersIdeOverlayOptions, type SmithersIdeOverlayResult, type SmithersIdeOverlayType, type SmithersIdeResolvedConfig, type SmithersIdeRunTerminalResult, type SmithersIdeServiceApi, type SmithersIdeServiceConfig, } from "./SmithersIdeService";
export { createSmithersIdeCli, SMITHERS_IDE_TOOL_NAMES, } from "./tools";
export declare function isSmithersIdeAvailable(config?: SmithersIdeServiceConfig): any;
export declare function getSmithersIdeAvailability(config?: SmithersIdeServiceConfig): Promise<SmithersIdeAvailability>;
export declare function createAvailableSmithersIdeCli(config?: SmithersIdeServiceConfig): unknown;
