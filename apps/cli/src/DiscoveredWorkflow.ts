import type { WorkflowSourceType } from "./WorkflowSourceType.ts";

export type DiscoveredWorkflow = {
    id: string;
    metadataVersion: 1;
    displayName: string;
    sourceType: WorkflowSourceType;
    description: string;
    tags: string[];
    aliases: string[];
    entryFile: string;
    path: string;
};
