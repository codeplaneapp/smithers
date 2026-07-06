type SafeParseSuccess<T> = {
    success: true;
    data: T;
};
type SafeParseFailure = {
    success: false;
    error: {
        issues: unknown[];
    };
};
type SafeSchema<T = unknown> = {
    safeParse(value: unknown): SafeParseSuccess<T> | SafeParseFailure;
};
type FakeAgentCall = {
    readonly args: Record<string, unknown>;
    readonly prompt: unknown;
    readonly rootDir?: string;
    readonly taskContext?: unknown;
};
type FakeAgentFiles = Record<string, string | Uint8Array>;
type FakeAgentResult<T> = {
    output?: T;
    text?: string;
    files?: FakeAgentFiles;
};
type FakeAgentScriptFn<T> = (args: Record<string, unknown>) => FakeAgentResult<T> | T | AutoMock | Promise<FakeAgentResult<T> | T | AutoMock>;
type FakeAgentScript<T> = AutoMock | FakeAgentResult<T> | T | FakeAgentScriptFn<T>;
type FakeAgentOptions = {
    id?: string;
    model?: string;
    supportsNativeStructuredOutput?: boolean;
};
type FakeAgent<T> = {
    id: string;
    model: string;
    tools: Record<string, unknown>;
    supportsNativeStructuredOutput: boolean;
    calls: FakeAgentCall[];
    generate(args?: Record<string, unknown>): Promise<FakeAgentResult<T>>;
    lastPrompt(): unknown;
    reset(): void;
};
declare const autoMarker: unique symbol;
type AutoMock = {
    readonly [autoMarker]: true;
};
declare const auto: AutoMock;
declare function isAuto(value: unknown): value is AutoMock;
declare function buildFakeAgent<T>(schema: SafeSchema<T>, script: FakeAgentScript<T>, options?: FakeAgentOptions): FakeAgent<T>;
declare function buildSequenceAgent<T>(schema: SafeSchema<T>, entries: readonly (FakeAgentResult<T> | T | AutoMock)[], options?: FakeAgentOptions): FakeAgent<T>;
declare const fakeAgent: typeof buildFakeAgent & {
    sequence: typeof buildSequenceAgent;
};

export { type AutoMock, type FakeAgent, type FakeAgentCall, type FakeAgentFiles, type FakeAgentOptions, type FakeAgentResult, type FakeAgentScript, type SafeSchema, auto, fakeAgent, isAuto };
