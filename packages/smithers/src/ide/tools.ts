import { Cli } from "incur";
import { type SmithersIdeServiceConfig } from "./SmithersIdeService";
export declare const SMITHERS_IDE_TOOL_NAMES: readonly ["smithers_ide_open_file", "smithers_ide_open_diff", "smithers_ide_show_overlay", "smithers_ide_run_terminal", "smithers_ide_ask_user", "smithers_ide_open_webview"];
export declare function createSmithersIdeCli(config?: SmithersIdeServiceConfig): Cli.Cli<{
    smithers_ide_open_file: {
        args: {
            path: string;
            line?: number | undefined;
            col?: number | undefined;
        };
        options: {};
    };
} & {
    smithers_ide_open_diff: {
        args: {
            content: string;
        };
        options: {};
    };
} & {
    smithers_ide_show_overlay: {
        args: {
            type: "progress" | "panel" | "chat";
            message: string;
            title?: string | undefined;
            position?: "center" | "top" | "bottom" | undefined;
            duration?: number | undefined;
            percent?: number | undefined;
        };
        options: {};
    };
} & {
    smithers_ide_run_terminal: {
        args: {
            cmd: string;
            cwd?: string | undefined;
        };
        options: {};
    };
} & {
    smithers_ide_ask_user: {
        args: {
            prompt: string;
        };
        options: {};
    };
} & {
    smithers_ide_open_webview: {
        args: {
            url: string;
        };
        options: {};
    };
}, undefined, undefined>;
