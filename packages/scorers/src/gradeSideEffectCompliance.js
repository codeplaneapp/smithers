import { sideEffectAnalysis } from "./sideEffectAnalysis.js";

/**
 * Grade whether a candidate workflow marks every detected external mutation.
 *
 * `requireIdempotencyKey` and `requireRevert` are scenario requirements. The
 * base marking rules are always enforced.
 *
 * @param {string} source
 * @param {{ requireIdempotencyKey?: boolean; requireRevert?: boolean; repoRoot?: string }} [expectation]
 * @returns {{ passed: boolean; score: number; violations: Array<{ kind: "unmarked-effect" | "over-marked-pure" | "missing-idempotency-key" | "missing-revert" | "revert-without-side-effect"; detail: string; line?: number; column?: number }> }}
 */
export function gradeSideEffectCompliance(source, expectation = {}) {
    const analysis = sideEffectAnalysis(source, { repoRoot: expectation.repoRoot });
    const markingsById = new Map(analysis.markings.map((marking) => [marking.id, marking]));
    const violations = [];

    for (const site of analysis.effectfulSites) {
        const owners = site.ownerIds.map((id) => markingsById.get(id)).filter(Boolean);
        if (owners.length === 0) {
            violations.push({
                kind: "unmarked-effect",
                detail: `${site.detail} is not covered by sideEffect:true.`,
                line: site.line,
                column: site.column,
            });
            continue;
        }
        for (const owner of owners.filter((candidate) => !candidate.sideEffect)) {
            violations.push({
                kind: "unmarked-effect",
                detail: `${site.detail} is called by unmarked ${owner.kind} "${owner.name}".`,
                line: site.line,
                column: site.column,
            });
        }
    }

    for (const marking of analysis.markings) {
        if (marking.sideEffect && marking.effectSiteIndexes.length === 0) {
            violations.push({
                kind: "over-marked-pure",
                detail: `${marking.kind} "${marking.name}" is marked sideEffect but contains no detected external mutation.`,
            });
        }
        if (marking.hasRevert && !marking.sideEffect) {
            violations.push({
                kind: "revert-without-side-effect",
                detail: `${marking.kind} "${marking.name}" declares revert without sideEffect:true.`,
            });
        }
    }

    const effectfulMarkedOwners = analysis.markings.filter((marking) => (
        marking.sideEffect && marking.effectSiteIndexes.length > 0
    ));
    if (expectation.requireIdempotencyKey) {
        for (const marking of effectfulMarkedOwners) {
            if (!marking.usesIdempotencyKey) {
                violations.push({
                    kind: "missing-idempotency-key",
                    detail: `${marking.kind} "${marking.name}" does not thread ctx.idempotencyKey.`,
                });
            }
        }
    }
    if (expectation.requireRevert) {
        for (const marking of effectfulMarkedOwners) {
            if (!marking.hasRevert || !marking.revertSafe) {
                violations.push({
                    kind: "missing-revert",
                    detail: `${marking.kind} "${marking.name}" must declare a verify-then-undo revert handler.`,
                });
            }
        }
    }

    const failedRules = new Set(violations.map((violation) => violation.kind)).size;
    return {
        passed: violations.length === 0,
        score: (5 - failedRules) / 5,
        violations,
    };
}
