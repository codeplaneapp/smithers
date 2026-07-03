/** @jsxImportSource @opentui/react */

/**
 * OpenTUI (@opentui/react) render layer for the interactive init wizard.
 *
 * This module is imported DYNAMICALLY (never statically) — see
 * runInteractiveInitFlow in ./interactiveInit.tsx. Keeping the @opentui/core
 * and @opentui/react imports out of the eager CLI startup path means a platform
 * where the @opentui native binding fails to load only breaks the interactive
 * init path (which degrades to buildDefaultSelections), not every smithers
 * command. Do NOT statically import this file from any code on the startup path.
 *
 * Packaging note: @opentui/core resolves its native .dylib at import time via
 * bun:ffi dlopen. Inside a `bunx smithers-orchestrator` run the platform-native
 * optional dep loads from the bun cache, so dlopen normally succeeds; keeping
 * this import dynamic is what turns a failed dlopen into a graceful degrade
 * rather than a crash of every command.
 */

import React, { useState, useRef } from "react";
import { createCliRenderer, type KeyEvent } from "@opentui/core";
import { createRoot, useKeyboard, useTerminalDimensions } from "@opentui/react";
import type {
    AgentSetupOptionId,
    CheckItem,
    InitSelections,
    WizardStep,
} from "./interactiveInit.js";

function formatRow(label: string, isActive: boolean, isChecked: boolean): string {
    const arrow = isActive ? "▶ " : "  ";
    const box = isChecked ? "[✓] " : "[ ] ";
    return arrow + box + label;
}

type WizardRef = {
    stepIdx: number;
    cursor: number;
    scrollOff: number;
    wfItems: CheckItem[];
    skItems: CheckItem[];
    agentItems: CheckItem[];
    visible: number;
    steps: WizardStep[];
};

type WizardProps = {
    steps: WizardStep[];
    workflowItems: CheckItem[];
    skillItems: CheckItem[];
    agentItems: CheckItem[];
    noAgentsMessage: string;
    onConfirm: (selections: InitSelections) => void;
    onCancel: () => void;
};

function InitWizard({ steps, workflowItems: initWf, skillItems: initSk, agentItems: initAgents, noAgentsMessage, onConfirm, onCancel }: WizardProps) {
    const { height } = useTerminalDimensions();

    const [stepIdx, setStepIdx] = useState(0);
    const [wfItems, setWfItems] = useState<CheckItem[]>(initWf);
    const [skItems, setSkItems] = useState<CheckItem[]>(initSk);
    const [agentItems, setAgentItems] = useState<CheckItem[]>(initAgents);
    const [cursor, setCursor] = useState(0);
    const [scrollOff, setScrollOff] = useState(0);

    const step = steps[stepIdx] ?? "workflows";
    const isLastStep = stepIdx === steps.length - 1;
    const items = step === "workflows" ? wfItems : step === "skills" ? skItems : agentItems;
    // Group headers render as extra rows above their item, so shrink the item
    // window by the headers inside the current slice to avoid overflowing the
    // terminal (two-pass approximation: measure against the raw window).
    const rawVisible = Math.max(5, height - 13);
    const headerRows = items.slice(scrollOff, scrollOff + rawVisible).filter((i) => i.header).length;
    const visible = Math.max(4, rawVisible - headerRows);
    const visibleItems = items.slice(scrollOff, scrollOff + visible);
    const checkedCount = items.filter((i) => i.checked).length;

    // Ref keeps the keyboard handler free of stale closures
    const stateRef = useRef<WizardRef>({ stepIdx, cursor, scrollOff, wfItems, skItems, agentItems, visible, steps });
    stateRef.current = { stepIdx, cursor, scrollOff, wfItems, skItems, agentItems, visible, steps };

    useKeyboard((key: KeyEvent) => {
        const s = stateRef.current;
        const st = s.steps[s.stepIdx] ?? "workflows";

        // Cancel always works
        if (key.name === "escape" || (key.ctrl && key.name === "c")) {
            onCancel();
            return;
        }

        // Agent setup is a single-select list.
        if (st === "agent") {
            if (key.name === "up" || (key.name === "k" && !key.ctrl && !key.meta)) {
                setCursor(Math.max(0, s.cursor - 1));
            } else if (key.name === "down" || (key.name === "j" && !key.ctrl && !key.meta)) {
                setCursor(Math.min(s.agentItems.length - 1, s.cursor + 1));
            } else if (key.name === "space" || key.name === "return") {
                setAgentItems((prev) => prev.map((item, i) => ({ ...item, checked: i === s.cursor })));
                setStepIdx(s.stepIdx + 1);
                setCursor(0);
                setScrollOff(0);
            }
            return;
        }

        const itms = st === "workflows" ? s.wfItems : s.skItems;

        if (key.name === "up" || (key.name === "k" && !key.ctrl && !key.meta)) {
            const next = Math.max(0, s.cursor - 1);
            setCursor(next);
            setScrollOff(next < s.scrollOff ? next : s.scrollOff);
        } else if (key.name === "down" || (key.name === "j" && !key.ctrl && !key.meta)) {
            const next = Math.min(itms.length - 1, s.cursor + 1);
            setCursor(next);
            setScrollOff(next >= s.scrollOff + s.visible ? next - s.visible + 1 : s.scrollOff);
        } else if (key.name === "space") {
            const c = s.cursor;
            if (st === "workflows") {
                setWfItems((prev) => prev.map((item, i) => (i === c ? { ...item, checked: !item.checked } : item)));
            } else {
                setSkItems((prev) => prev.map((item, i) => (i === c ? { ...item, checked: !item.checked } : item)));
            }
        } else if (key.name === "a" && !key.ctrl) {
            if (st === "workflows") {
                setWfItems((prev) => {
                    const allChecked = prev.every((i) => i.checked);
                    return prev.map((i) => ({ ...i, checked: !allChecked }));
                });
            } else {
                setSkItems((prev) => {
                    const allChecked = prev.every((i) => i.checked);
                    return prev.map((i) => ({ ...i, checked: !allChecked }));
                });
            }
        } else if (key.name === "return") {
            if (s.stepIdx < s.steps.length - 1) {
                setStepIdx(s.stepIdx + 1);
                setCursor(0);
                setScrollOff(0);
            } else {
                // Final confirm: collect selections and exit
                const wf = s.wfItems.filter((i) => i.checked).map((i) => i.id);
                const sk = s.skItems
                    .filter((i) => i.id.startsWith("skill:") && i.checked)
                    .map((i) => i.id.slice("skill:".length));
                const docs = s.skItems
                    .filter((i) => i.id.startsWith("doc:") && i.checked)
                    .map((i) => i.id.slice("doc:".length));
                const agent = s.agentItems.find((i) => i.checked)?.id as AgentSetupOptionId | undefined;
                onConfirm({ selectedAgentSetup: agent, selectedWorkflows: wf, selectedSkillTargets: sk, selectedAgentDocs: docs });
            }
        }
    });

    // Agent info screen (no usable agents detected)
    if (step === "agent") {
        const selected = agentItems.find((item, idx) => idx === cursor) ?? agentItems[0];
        return (
            <box width="100%" height="100%" flexDirection="column" padding={2}>
                <text content="smithers init — agent setup" fg="#ffcc00" />
                <text content="" />
                <text content="No coding agent detected on this machine." fg="#ff8888" />
                <text content="" />
                <text content={noAgentsMessage} fg="#cccccc" wrapMode="word" />
                <text content="" />
                {agentItems.map((item, idx) => (
                    <text
                        key={item.id}
                        content={formatRow(item.label, idx === cursor, item.checked)}
                        fg={idx === cursor ? "#ffffff" : "#888888"}
                    />
                ))}
                <text content="" />
                <text content={selected?.label ?? ""} fg="#00cccc" />
                <text content={selected?.detail ?? ""} fg="#cccccc" wrapMode="word" />
                <text content="" />
                <text content="↑↓ / jk navigate   enter choose   esc cancel" fg="#666666" />
            </box>
        );
    }

    // Multiselect screens (workflows / skills)
    const stepTitle = step === "workflows"
        ? `Select workflows to install  (${checkedCount} / ${items.length} selected)`
        : `Select skills + agent docs  (${checkedCount} / ${items.length} selected)`;
    const stepHint = step === "workflows"
        ? "  Installs to .smithers/ in this repo (plus deps via bun install). Everything stays editable."
        : "  Teaches your coding agents to reach for smithers workflows.";

    const scrollInfo = items.length > visible
        ? `  [${scrollOff + 1}–${Math.min(scrollOff + visible, items.length)}/${items.length}]`
        : "";

    const nextLabel = isLastStep ? "✓ confirm" : "→ next";
    const footer = `  ↑↓ / jk navigate   space toggle   a toggle-all   enter ${nextLabel}   esc cancel${scrollInfo}`;

    return (
        <box width="100%" height="100%" flexDirection="column" padding={1}>
            <text content={`  smithers init  —  ${stepTitle}`} fg="#00cccc" />
            <text content={stepHint} fg="#666666" />
            <text content="" />
            {visibleItems.map((item, idx) => {
                const globalIdx = idx + scrollOff;
                return (
                    <React.Fragment key={item.id}>
                        {item.header ? <text content={`  ${item.header}`} fg="#00aaaa" /> : null}
                        <text
                            content={formatRow(item.label, globalIdx === cursor, item.checked)}
                            fg={globalIdx === cursor ? "#ffffff" : "#888888"}
                        />
                    </React.Fragment>
                );
            })}
            <text content="" />
            <text content={footer} fg="#555555" />
        </box>
    );
}

/**
 * Mount the full-screen OpenTUI wizard and resolve with the user's selections
 * (or null on cancel). Rejects if the renderer cannot initialize (non-PTY,
 * missing native binding) — the caller degrades to buildDefaultSelections.
 */
export function renderInitWizard(params: {
    steps: WizardStep[];
    workflowItems: CheckItem[];
    skillItems: CheckItem[];
    agentItems: CheckItem[];
    noAgentsMessage: string;
}): Promise<InitSelections | null> {
    return new Promise<InitSelections | null>((resolve, reject) => {
        createCliRenderer({ exitOnCtrlC: false, clearOnShutdown: true })
            .then((renderer) => {
                const root = createRoot(renderer);

                const handleConfirm = (sels: InitSelections) => {
                    root.unmount();
                    renderer.destroy();
                    resolve(sels);
                };

                const handleCancel = () => {
                    root.unmount();
                    renderer.destroy();
                    resolve(null);
                };

                root.render(
                    <InitWizard
                        steps={params.steps}
                        workflowItems={params.workflowItems}
                        skillItems={params.skillItems}
                        agentItems={params.agentItems}
                        noAgentsMessage={params.noAgentsMessage}
                        onConfirm={handleConfirm}
                        onCancel={handleCancel}
                    />,
                );
            })
            .catch(reject);
    });
}
