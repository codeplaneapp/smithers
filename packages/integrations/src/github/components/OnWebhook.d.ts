import { GitHubSugarListenerProps as GitHubSugarListenerProps$1, OnWebhookProps as OnWebhookProps$1 } from './OnWebhookProps.js';
import * as zod_v4_core from 'zod/v4/core';
import * as zod from 'zod';
import React__default from 'react';

/**
 * Correlation id for a GitHub listener: most specific form the props allow.
 * @param {string | undefined} repo
 * @param {number | undefined} number
 * @returns {string | undefined}
 */
declare function githubCorrelationId(repo: string | undefined, number: number | undefined): string | undefined;
/**
 * Generic declarative GitHub listener (Signal.js pattern over WaitForEvent).
 * Waits durably for `integration:github:<event>[.<action>]` with the most
 * specific correlation the props allow; the webhook source emits one signal
 * per (name, correlation) variant, so every combination of
 * `event`/`action`/`repo`/`number` has a matching signal.
 *
 * @template {import("zod").ZodObject<import("zod").ZodRawShape>} Schema
 * @param {OnWebhookProps<Schema>} props
 */
declare function OnWebhook<Schema extends zod.ZodObject<zod.ZodRawShape>>(props: OnWebhookProps<Schema>): React__default.FunctionComponentElement<{
    id: string;
    event: string;
    correlationId?: string;
    output: string | zod.ZodObject<Readonly<{
        [k: string]: zod_v4_core.$ZodType<unknown, unknown, zod_v4_core.$ZodTypeInternals<unknown, unknown>>;
    }>, zod_v4_core.$strip> | {
        $inferSelect: Record<string, unknown>;
    };
    outputSchema?: zod.ZodObject<zod.ZodRawShape>;
    timeoutMs?: number;
    onTimeout?: "fail" | "skip" | "continue";
    async?: boolean;
    skipIf?: boolean;
    dependsOn?: string[];
    needs?: Record<string, string>;
    label?: string;
    meta?: Record<string, unknown>;
    key?: string;
}> | React__default.FunctionComponentElement<React__default.FragmentProps> | null;
/**
 * Wait for a `pull_request` event (optionally a specific `action`, repo, PR).
 * @template {import("zod").ZodObject<import("zod").ZodRawShape>} Schema
 * @param {GitHubSugarListenerProps<Schema> & { action?: string }} props
 */
declare function OnPullRequest<Schema extends zod.ZodObject<zod.ZodRawShape>>(props: GitHubSugarListenerProps<Schema> & {
    action?: string;
}): React__default.FunctionComponentElement<{
    id: string;
    event: string;
    correlationId?: string;
    output: string | zod.ZodObject<Readonly<{
        [k: string]: zod_v4_core.$ZodType<unknown, unknown, zod_v4_core.$ZodTypeInternals<unknown, unknown>>;
    }>, zod_v4_core.$strip> | {
        $inferSelect: Record<string, unknown>;
    };
    outputSchema?: zod.ZodObject<zod.ZodRawShape>;
    timeoutMs?: number;
    onTimeout?: "fail" | "skip" | "continue";
    async?: boolean;
    skipIf?: boolean;
    dependsOn?: string[];
    needs?: Record<string, string>;
    label?: string;
    meta?: Record<string, unknown>;
    key?: string;
}> | React__default.FunctionComponentElement<React__default.FragmentProps> | null;
/**
 * Wait for `issues.opened`.
 * @template {import("zod").ZodObject<import("zod").ZodRawShape>} Schema
 * @param {GitHubSugarListenerProps<Schema>} props
 */
declare function OnIssueOpened<Schema extends zod.ZodObject<zod.ZodRawShape>>(props: GitHubSugarListenerProps<Schema>): React__default.FunctionComponentElement<{
    id: string;
    event: string;
    correlationId?: string;
    output: string | zod.ZodObject<Readonly<{
        [k: string]: zod_v4_core.$ZodType<unknown, unknown, zod_v4_core.$ZodTypeInternals<unknown, unknown>>;
    }>, zod_v4_core.$strip> | {
        $inferSelect: Record<string, unknown>;
    };
    outputSchema?: zod.ZodObject<zod.ZodRawShape>;
    timeoutMs?: number;
    onTimeout?: "fail" | "skip" | "continue";
    async?: boolean;
    skipIf?: boolean;
    dependsOn?: string[];
    needs?: Record<string, string>;
    label?: string;
    meta?: Record<string, unknown>;
    key?: string;
}> | React__default.FunctionComponentElement<React__default.FragmentProps> | null;
/**
 * Wait for an issue/PR comment (`issue_comment`, default action `created`).
 * @template {import("zod").ZodObject<import("zod").ZodRawShape>} Schema
 * @param {GitHubSugarListenerProps<Schema> & { action?: string }} props
 */
declare function OnIssueComment<Schema extends zod.ZodObject<zod.ZodRawShape>>(props: GitHubSugarListenerProps<Schema> & {
    action?: string;
}): React__default.FunctionComponentElement<{
    id: string;
    event: string;
    correlationId?: string;
    output: string | zod.ZodObject<Readonly<{
        [k: string]: zod_v4_core.$ZodType<unknown, unknown, zod_v4_core.$ZodTypeInternals<unknown, unknown>>;
    }>, zod_v4_core.$strip> | {
        $inferSelect: Record<string, unknown>;
    };
    outputSchema?: zod.ZodObject<zod.ZodRawShape>;
    timeoutMs?: number;
    onTimeout?: "fail" | "skip" | "continue";
    async?: boolean;
    skipIf?: boolean;
    dependsOn?: string[];
    needs?: Record<string, string>;
    label?: string;
    meta?: Record<string, unknown>;
    key?: string;
}> | React__default.FunctionComponentElement<React__default.FragmentProps> | null;
/**
 * Wait for a `push` event (push deliveries carry no `action`).
 * @template {import("zod").ZodObject<import("zod").ZodRawShape>} Schema
 * @param {GitHubSugarListenerProps<Schema>} props
 */
declare function OnPush<Schema extends zod.ZodObject<zod.ZodRawShape>>(props: GitHubSugarListenerProps<Schema>): React__default.FunctionComponentElement<{
    id: string;
    event: string;
    correlationId?: string;
    output: string | zod.ZodObject<Readonly<{
        [k: string]: zod_v4_core.$ZodType<unknown, unknown, zod_v4_core.$ZodTypeInternals<unknown, unknown>>;
    }>, zod_v4_core.$strip> | {
        $inferSelect: Record<string, unknown>;
    };
    outputSchema?: zod.ZodObject<zod.ZodRawShape>;
    timeoutMs?: number;
    onTimeout?: "fail" | "skip" | "continue";
    async?: boolean;
    skipIf?: boolean;
    dependsOn?: string[];
    needs?: Record<string, string>;
    label?: string;
    meta?: Record<string, unknown>;
    key?: string;
}> | React__default.FunctionComponentElement<React__default.FragmentProps> | null;
type OnWebhookProps<Schema> = OnWebhookProps$1<Schema>;
type GitHubSugarListenerProps<Schema> = GitHubSugarListenerProps$1<Schema>;

export { type GitHubSugarListenerProps, OnIssueComment, OnIssueOpened, OnPullRequest, OnPush, OnWebhook, type OnWebhookProps, githubCorrelationId };
