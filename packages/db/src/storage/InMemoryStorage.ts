import { Layer } from "effect";
import { StorageService, type StorageServiceShape } from "./StorageService.ts";
export declare function makeInMemoryStorageService(): StorageServiceShape;
export declare const InMemoryStorageLive: Layer.Layer<StorageService, never, never>;
