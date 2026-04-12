import React from "react";
import { SmithersCtx } from "@smithers/driver/SmithersCtx";
export { SmithersCtx } from "@smithers/driver/SmithersCtx";
export type { SmithersCtxOptions } from "@smithers/driver/SmithersCtx";
export type { OutputSnapshot } from "@smithers/driver/OutputSnapshot";
export declare const SmithersContext: React.Context<SmithersCtx<any> | null>;
export declare function createSmithersContext<Schema>(): {
    SmithersContext: React.Context<SmithersCtx<Schema> | null>;
    useCtx: () => SmithersCtx<Schema>;
};
