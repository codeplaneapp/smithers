export type FrameEncoding = "full" | "delta" | "keyframe";
export declare const FRAME_KEYFRAME_INTERVAL = 50;
declare const FRAME_DELTA_VERSION = 1;
type JsonPathSegment = string | number;
export type JsonPath = JsonPathSegment[];
export type FrameDeltaOp = {
    op: "set";
    path: JsonPath;
    value: unknown;
    nodeId?: string;
} | {
    op: "insert";
    path: JsonPath;
    value: unknown;
    nodeId?: string;
} | {
    op: "remove";
    path: JsonPath;
    nodeId?: string;
};
export type FrameDelta = {
    version: typeof FRAME_DELTA_VERSION;
    ops: FrameDeltaOp[];
};
export declare function normalizeFrameEncoding(value: unknown): FrameEncoding;
export declare function parseFrameDelta(deltaJson: string): FrameDelta;
export declare function serializeFrameDelta(delta: FrameDelta): string;
export declare function encodeFrameDelta(previousXmlJson: string, nextXmlJson: string): FrameDelta;
export declare function applyFrameDelta(previousXmlJson: string, delta: FrameDelta): string;
export declare function applyFrameDeltaJson(previousXmlJson: string, deltaJson: string): string;
export {};
