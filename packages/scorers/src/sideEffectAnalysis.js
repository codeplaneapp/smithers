import ts from "typescript";
import { posix } from "node:path";
import { sideEffectRules } from "./sideEffectRules.js";

/**
 * Analyze effect sites and Smithers markings in candidate workflow source.
 * This function is pure: it parses only the supplied string and never reads
 * the filesystem or resolves imports.
 *
 * @param {string} source
 * @param {{ repoRoot?: string }} [options]
 * @returns {{
 *   rulesVersion: number;
 *   effectfulSites: Array<{ kind: string; detail: string; start: number; end: number; line: number; column: number; ownerIds: string[] }>;
 *   markings: Array<{ id: string; kind: "tool" | "task"; name: string; sideEffect: boolean; idempotent: boolean; hasRevert: boolean; revertSafe: boolean; usesIdempotencyKey: boolean; effectSiteIndexes: number[]; start: number; end: number }>;
 * }}
 */
export function sideEffectAnalysis(source, options = {}) {
    const file = ts.createSourceFile("candidate.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const repoRoot = normalizePath(options.repoRoot ?? "/repo");
    const constants = collectConstants(file);
    const functions = collectFunctions(file);
    const tools = collectTools(file, source, functions, constants, repoRoot);
    const tasks = collectTasks(file, source, functions, constants, repoRoot);
    const markings = [...tools, ...tasks];
    const revertRanges = tools.flatMap((tool) => tool.revertNode ? [[tool.revertNode.pos, tool.revertNode.end]] : []);
    const rawSites = [];

    const visit = (node) => {
        if (ts.isCallExpression(node)) {
            const site = classifyCall(node, source, constants, repoRoot);
            if (site && !rangeContainsAny(node.pos, revertRanges)) rawSites.push({ ...site, node });
        } else if (ts.isTaggedTemplateExpression(node)) {
            const tag = expressionName(node.tag);
            if (isShellCallee(tag)) {
                const command = staticString(node.template, constants, file);
                const effect = command ? classifyCommand(command) : null;
                if (effect && !rangeContainsAny(node.pos, revertRanges)) {
                    rawSites.push({ kind: "shell-mutation", detail: effect, node });
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(file);

    const effectfulSites = rawSites.map((site, index) => {
        const ownerIds = markings
            .filter((marking) => ownerContains(marking, site.node))
            .map((marking) => marking.id);
        for (const owner of markings) {
            if (!ownerIds.includes(owner.id)) continue;
            owner.effectSiteIndexes.push(index);
            if (ts.isCallExpression(site.node) && callArgumentsUseIdempotencyKey(site.node)) {
                owner.usesIdempotencyKey = true;
            }
        }
        const location = file.getLineAndCharacterOfPosition(site.node.getStart(file));
        return {
            kind: site.kind,
            detail: site.detail,
            start: site.node.getStart(file),
            end: site.node.end,
            line: location.line + 1,
            column: location.character + 1,
            ownerIds,
        };
    });

    return {
        rulesVersion: sideEffectRules.version,
        effectfulSites,
        markings: markings.map((marking) => ({
            id: marking.id,
            kind: marking.kind,
            name: marking.name,
            sideEffect: marking.sideEffect,
            idempotent: marking.idempotent,
            hasRevert: marking.hasRevert,
            revertSafe: marking.revertSafe,
            usesIdempotencyKey: marking.usesIdempotencyKey,
            effectSiteIndexes: marking.effectSiteIndexes,
            start: marking.node.getStart(file),
            end: marking.node.end,
        })),
    };
}

function classifyCall(node, source, constants, repoRoot) {
    const name = expressionName(node.expression);
    const terminal = name.split(".").at(-1) ?? name;

    if (terminal === "fetch") {
        const method = objectStringProperty(node.arguments[1], "method", constants, node.getSourceFile())?.toUpperCase() ?? "GET";
        return sideEffectRules.networkMutationMethods.includes(method)
            ? { kind: "network-mutation", detail: `fetch ${method}` }
            : null;
    }

    const axiosMethod = /(?:^|\.)(?:axios|ky)\.(post|put|patch|delete)$/i.exec(name);
    if (axiosMethod) return { kind: "network-mutation", detail: `${name} ${axiosMethod[1].toUpperCase()}` };
    if (/(?:^|\.)axios$/i.test(name)) {
        const method = objectStringProperty(node.arguments[0], "method", constants, node.getSourceFile())?.toUpperCase();
        if (method && sideEffectRules.networkMutationMethods.includes(method)) {
            return { kind: "network-mutation", detail: `axios ${method}` };
        }
    }

    if (isShellCallee(name)) {
        const command = commandFromCall(node, constants);
        const effect = command ? classifyCommand(command) : null;
        if (effect) return { kind: "shell-mutation", detail: effect };
    }

    for (const rule of sideEffectRules.sdkMutationPaths) {
        if (rule.pattern.test(name)) return { kind: "sdk-mutation", detail: `${rule.id}: ${name}` };
    }

    const method = name.split(".").at(-1) ?? "";
    const receiver = name.slice(0, Math.max(0, name.length - method.length - 1));
    if (sideEffectRules.databaseMutationMethods.includes(method) && sideEffectRules.databaseReceiverPattern.test(receiver)) {
        return { kind: "database-mutation", detail: name };
    }

    if (sideEffectRules.filesystemWriteCalls.includes(terminal) || name === "Bun.write") {
        const pathIndexes = sideEffectRules.filesystemTwoPathCalls.includes(terminal)
            ? [0, 1]
            : [0];
        for (const index of pathIndexes) {
            const path = staticString(node.arguments[index], constants, node.getSourceFile());
            if (path && isOutOfRepoPath(path, repoRoot)) {
                return { kind: "out-of-repo-write", detail: `${name} ${path}` };
            }
        }
    }

    return null;
}

function commandFromCall(node, constants) {
    const file = node.getSourceFile();
    const name = expressionName(node.expression);
    if (/(?:^|\.)(?:spawn|spawnSync)$/.test(name)) {
        const executable = staticString(node.arguments[0], constants, file);
        const args = staticStringArray(node.arguments[1], constants, file);
        return executable ? [executable, ...(args ?? [])].join(" ") : null;
    }
    return staticString(node.arguments[0], constants, file);
}

function classifyCommand(command) {
    const segments = command
        .split(/(?:&&|\|\||[;\n])/)
        .map((part) => part.trim())
        .filter(Boolean);
    for (const segment of segments) {
        const effect = classifyCommandSegment(segment);
        if (effect) return effect;
    }
    return null;
}

function classifyCommandSegment(segment) {
    const normalized = segment
        .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/, "")
        .replace(/^(?:sudo|env|command|npx|bunx)\s+/, "")
        .trim();
    const words = shellWords(normalized);
    const executable = basename(words[0] ?? "");
    if (!executable || sideEffectRules.shell.exemptExecutables.includes(executable)) return null;
    if (["cd", "pwd", "echo", "printf", "cat", "ls", "true", "false"].includes(executable)) return null;

    if (executable === "gh") {
        const group = words[1]?.toLowerCase() ?? "";
        const verb = words[2]?.toLowerCase() ?? "";
        if (sideEffectRules.shell.ghReadVerbs.includes(verb)) return null;
        const mutation = sideEffectRules.shell.ghMutations.find((path) => path.every(
            (part, index) => words[index + 1]?.toLowerCase() === part,
        ));
        if (mutation) {
            return `gh ${mutation.join(" ")}`;
        }
        if (group === "api") {
            const method = flagValue(words, "-X", "--method")?.toUpperCase() ?? "GET";
            return sideEffectRules.networkMutationMethods.includes(method) ? `gh api ${method}` : null;
        }
        return null;
    }

    if (executable === "curl") {
        const method = flagValue(words, "-X", "--request")?.toUpperCase() ?? "GET";
        return sideEffectRules.networkMutationMethods.includes(method) ? `curl ${method}` : null;
    }

    for (const rule of sideEffectRules.shell.commandMutations) {
        if (executable !== rule.executable) continue;
        const verb = words[1]?.toLowerCase() ?? "";
        if (!rule.verbs.includes(verb)) return null;
        if (rule.dryRunFlags?.some((flag) => words.some((word) => (
            word === flag || word.startsWith(`${flag}=`)
        )))) return null;
        return `${executable} ${verb}`;
    }

    if (executable === "aws") {
        const verb = words[2]?.toLowerCase() ?? words[1]?.toLowerCase() ?? "";
        return sideEffectRules.shell.awsMutationVerbs.some((prefix) => verb === prefix || verb.startsWith(`${prefix}-`))
            ? `aws ${words[1] ?? ""} ${verb}`.trim()
            : null;
    }
    if (executable === "gcloud") {
        const verb = words.slice(1).map((word) => word.toLowerCase()).find((word) => sideEffectRules.shell.gcloudMutationVerbs.includes(word)) ?? "";
        return sideEffectRules.shell.gcloudMutationVerbs.includes(verb) ? `gcloud ${verb}` : null;
    }
    return null;
}

function collectTools(file, source, functions, constants, repoRoot) {
    const result = [];
    let sequence = 0;
    const visit = (node) => {
        if (ts.isCallExpression(node) && expressionName(node.expression).split(".").at(-1) === "defineTool") {
            const object = node.arguments[0];
            if (object && ts.isObjectLiteralExpression(object)) {
                const executeNode = objectPropertyValue(object, "execute");
                const revertNode = objectPropertyValue(object, "revert");
                const sideEffect = booleanProperty(object, "sideEffect") === true;
                const idempotentValue = booleanProperty(object, "idempotent");
                const referencedNodes = executeNode ? expandFunctionReferences([executeNode], functions) : [];
                result.push({
                    id: `tool:${sequence++}`,
                    kind: "tool",
                    name: objectStringProperty(object, "name", new Map(), file) ?? `tool-${sequence}`,
                    node,
                    executeNode,
                    referencedNodes,
                    revertNode,
                    sideEffect,
                    idempotent: idempotentValue ?? !sideEffect,
                    hasRevert: Boolean(revertNode),
                    revertSafe: revertNode
                        ? isVerifyThenUndo(revertNode, referencedNodes, constants, repoRoot)
                        : false,
                    usesIdempotencyKey: false,
                    effectSiteIndexes: [],
                });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return result;
}

function collectTasks(file, source, functions, constants, repoRoot) {
    const result = [];
    let sequence = 0;
    const visit = (node) => {
        if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
            const opening = ts.isJsxElement(node) ? node.openingElement : node;
            if (opening.tagName.getText(file).split(".").at(-1) === "Task") {
                const attributes = opening.attributes.properties;
                const sideEffectAttribute = attributes.find((attribute) => (
                    ts.isJsxAttribute(attribute) && attribute.name.getText(file) === "sideEffect"
                ));
                const value = sideEffectAttribute && ts.isJsxAttribute(sideEffectAttribute)
                    ? jsxAttributeValue(sideEffectAttribute, file)
                    : false;
                const sideEffect = value !== false;
                const idempotent = typeof value === "object" && value !== null && value.idempotent === true;
                const hasRevert = typeof value === "object" && value !== null && value.revertNode !== null;
                const idAttribute = attributes.find((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(file) === "id");
                const computeAttribute = attributes.find((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(file) === "computeFn");
                const referencedNodes = [node];
                if (computeAttribute && ts.isJsxAttribute(computeAttribute) && computeAttribute.initializer && ts.isJsxExpression(computeAttribute.initializer)) {
                    const expression = computeAttribute.initializer.expression;
                    if (expression && ts.isIdentifier(expression) && functions.has(expression.text)) referencedNodes.push(functions.get(expression.text));
                    else if (expression) referencedNodes.push(expression);
                }
                const expandedReferences = expandFunctionReferences(referencedNodes, functions);
                result.push({
                    id: `task:${sequence++}`,
                    kind: "task",
                    name: idAttribute && ts.isJsxAttribute(idAttribute) ? jsxString(idAttribute.initializer, file) ?? `task-${sequence}` : `task-${sequence}`,
                    node,
                    executeNode: node,
                    referencedNodes: expandedReferences,
                    revertNode: typeof value === "object" && value !== null ? value.revertNode : null,
                    sideEffect,
                    idempotent,
                    hasRevert,
                    revertSafe: hasRevert
                        ? isVerifyThenUndo(value.revertNode, expandedReferences, constants, repoRoot)
                        : false,
                    usesIdempotencyKey: false,
                    effectSiteIndexes: [],
                });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return result;
}

function jsxAttributeValue(attribute, file) {
    if (!attribute.initializer) return true;
    if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer.text !== "false";
    if (!ts.isJsxExpression(attribute.initializer) || !attribute.initializer.expression) return false;
    const expression = attribute.initializer.expression;
    if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (!ts.isObjectLiteralExpression(expression)) return true;
    return {
        idempotent: booleanProperty(expression, "idempotent") === true,
        revertNode: objectPropertyValue(expression, "revert"),
    };
}

function collectConstants(file) {
    const constants = new Map();
    const visit = (node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
            constants.set(node.name.text, node.initializer);
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return constants;
}

function collectFunctions(file) {
    const functions = new Map();
    const visit = (node) => {
        if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
            (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
            functions.set(node.name.text, node.initializer);
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return functions;
}

function ownerContains(owner, node) {
    return owner.referencedNodes.some((candidate) => node.pos >= candidate.pos && node.end <= candidate.end);
}

function expandFunctionReferences(seedNodes, functions) {
    const result = [...seedNodes];
    const seen = new Set(seedNodes);
    for (const seed of seedNodes) {
        if (ts.isIdentifier(seed)) {
            const target = functions.get(seed.text);
            if (target && !seen.has(target)) {
                seen.add(target);
                result.push(target);
            }
        }
    }
    for (let index = 0; index < result.length; index += 1) {
        const root = result[index];
        const visit = (node) => {
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
                const target = functions.get(node.expression.text);
                if (target && !seen.has(target)) {
                    seen.add(target);
                    result.push(target);
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(root);
    }
    return result;
}

function isVerifyThenUndo(revertNode, executeNodes, constants, repoRoot) {
    const body = ts.isMethodDeclaration(revertNode)
        || ts.isFunctionDeclaration(revertNode)
        || ts.isFunctionExpression(revertNode)
        || ts.isArrowFunction(revertNode)
        ? revertNode.body
        : null;
    if (!body) return false;
    const effectIdentities = collectEffectIdentities(executeNodes, constants, repoRoot);
    if (effectIdentities.length === 0) return false;
    const existenceVariables = collectExistenceVariables(revertNode);
    const statusVariables = collectEffectStatusVariables(revertNode);
    return effectIdentities.every((effectIdentity) => {
        const context = {
            existenceVariables,
            statusVariables,
            effectIdentity,
            constants,
            repoRoot,
        };
        const scenarios = [
            { status: "succeeded", effectExists: true, undone: false, terminated: false },
            { status: "unknown", effectExists: true, undone: false, terminated: false },
            { status: "unknown", effectExists: false, undone: false, terminated: false },
        ];
        const paths = ts.isBlock(body)
            ? executeStatements(body.statements, scenarios, context)
            : executeExpression(body, scenarios, context);
        const succeeded = paths.filter((path) => path.status === "succeeded");
        const unknownPresent = paths.filter((path) => path.status === "unknown" && path.effectExists);
        const unknownAbsent = paths.filter((path) => path.status === "unknown" && !path.effectExists);
        return succeeded.length > 0
            && unknownPresent.length > 0
            && unknownAbsent.length > 0
            && succeeded.every((path) => path.undone)
            && unknownPresent.every((path) => path.undone)
            && unknownAbsent.every((path) => !path.undone);
    });
}

function databaseReceiver(name) {
    const terminal = name.split(".").at(-1) ?? "";
    return name.slice(0, Math.max(0, name.length - terminal.length - 1));
}

function callNetworkMethod(node, constants) {
    const name = expressionName(node.expression);
    const terminal = name.split(".").at(-1) ?? name;
    if (terminal === "fetch") {
        return objectStringProperty(
            node.arguments[1],
            "method",
            constants,
            node.getSourceFile(),
        )?.toUpperCase() ?? "GET";
    }
    const axiosMethod = /(?:^|\.)(?:axios|ky)\.(post|put|patch|delete)$/i.exec(name);
    if (axiosMethod) return axiosMethod[1].toUpperCase();
    if (/(?:^|\.)axios$/i.test(name)) {
        return objectStringProperty(
            node.arguments[0],
            "method",
            constants,
            node.getSourceFile(),
        )?.toUpperCase() ?? null;
    }
    return null;
}

function callNetworkResource(node, constants) {
    const name = expressionName(node.expression);
    if (/(?:^|\.)axios$/i.test(name)) {
        return objectStringProperty(
            node.arguments[0],
            "url",
            constants,
            node.getSourceFile(),
        );
    }
    return staticString(node.arguments[0], constants, node.getSourceFile());
}

function isResourceIdSegment(segment) {
    return segment === "__dynamic__"
        || /^[:{][^/]+}?$/.test(segment)
        || /^\d+$/.test(segment)
        || /^[0-9a-f]{8,}$/i.test(segment)
        || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment)
        || /(?:^|[-_])(?:\d{3,}|[0-9a-f]{8,})$/i.test(segment);
}

function normalizedResourceSegments(value) {
    if (typeof value !== "string" || value.trim() === "") return [];
    let path = value.trim().replace(/\s+__dynamic__\s+/g, "/__dynamic__/");
    try {
        path = new URL(path, "https://smithers.invalid").pathname;
    } catch {
        path = path.split(/[?#]/, 1)[0];
    }
    return path
        .split("/")
        .map((segment) => {
            try {
                return decodeURIComponent(segment).trim().toLowerCase();
            } catch {
                return segment.trim().toLowerCase();
            }
        })
        .filter((segment) => segment && !isResourceIdSegment(segment));
}

function resourceRoot(segments) {
    return segments.find((segment) => (
        segment !== "api" && !/^v\d+(?:\.\d+)*$/i.test(segment)
    )) ?? null;
}

function isSegmentPrefix(prefix, value) {
    return prefix.length <= value.length
        && prefix.every((segment, index) => value[index] === segment);
}

function pathResourcesAreAffine(effectResource, reversalResource) {
    const effectSegments = normalizedResourceSegments(effectResource);
    const reversalSegments = normalizedResourceSegments(reversalResource);
    if (effectSegments.length === 0 || reversalSegments.length === 0) return false;
    const effectRoot = resourceRoot(effectSegments);
    const reversalRoot = resourceRoot(reversalSegments);
    return isSegmentPrefix(effectSegments, reversalSegments)
        || (effectRoot !== null && effectRoot === reversalRoot);
}

function staticResourceValue(node, constants, file) {
    const value = staticString(node, constants, file);
    if (value !== null) return value;
    if (node && ts.isNumericLiteral(node)) return node.text;
    if (node && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
        return node.getText(file);
    }
    return null;
}

function sdkResourceArgument(node, constants, rule) {
    const argument = node.arguments[0];
    if (!argument) return null;
    const file = node.getSourceFile();
    if (ts.isObjectLiteralExpression(argument)) {
        const entries = [];
        for (const key of rule.resourceKeys ?? []) {
            const property = objectPropertyValue(argument, key);
            const value = staticResourceValue(property, constants, file);
            if (value !== null) entries.push([key.toLowerCase(), value]);
        }
        return entries.length > 0 ? entries : null;
    }
    const value = staticResourceValue(argument, constants, file);
    return value === null ? null : [["$0", value]];
}

function sdkResourcesAreAffine(effectResource, reversalResource) {
    if (effectResource === null || reversalResource === null) return true;
    const reversalByKey = new Map(reversalResource);
    const shared = effectResource.filter(([key]) => reversalByKey.has(key));
    if (shared.length === 0) return false;
    return shared.every(([key, effectValue]) => {
        const reversalValue = reversalByKey.get(key);
        if (key === "$0" || /(?:url|path)$/i.test(key)) {
            const pathLike = /[/?#]/.test(effectValue) || /[/?#]/.test(reversalValue);
            return pathLike
                ? pathResourcesAreAffine(effectValue, reversalValue)
                : effectValue.trim().toLowerCase() === reversalValue.trim().toLowerCase();
        }
        return effectValue.trim().toLowerCase() === reversalValue.trim().toLowerCase();
    });
}

function commandResourceKey(command, effectClass) {
    if (effectClass !== "kubernetes-resource") return null;
    const segment = command
        .split(/(?:&&|\|\||[;\n])/)
        .map((part) => part.trim())
        .find((part) => /\bkubectl\b/.test(part));
    if (!segment) return null;
    const words = shellWords(segment);
    const executableIndex = words.findIndex((word) => basename(word) === "kubectl");
    if (executableIndex < 0) return null;
    const args = words.slice(executableIndex + 2);
    const fileFlagIndex = args.findIndex((word) => word === "-f" || word === "--filename");
    if (fileFlagIndex >= 0 && args[fileFlagIndex + 1]) {
        return `file:${args[fileFlagIndex + 1]}`;
    }
    const resourceParts = args.filter((word) => !word.startsWith("-")).slice(0, 2);
    return resourceParts.length > 0 ? resourceParts.join(":") : null;
}

function shellEffectIdentity(command) {
    const detail = classifyCommand(command);
    if (!detail) return null;
    const rule = sideEffectRules.reversalVerbs.shellRules.find((candidate) => (
        candidate.effects.includes(detail)
    ));
    return rule
        ? {
            effectClass: rule.effectClass,
            resourceClass: rule.matchResource
                ? commandResourceKey(command, rule.effectClass)
                : null,
        }
        : { effectClass: "unknown", resourceClass: detail };
}

function callEffectIdentity(node, constants, repoRoot) {
    const name = expressionName(node.expression);
    const terminal = name.split(".").at(-1) ?? "";
    for (const rule of sideEffectRules.reversalVerbs.callRules) {
        if (rule.effects.some((pattern) => pattern.test(name))) {
            return {
                effectClass: rule.effectClass,
                resourceClass: sdkResourceArgument(node, constants, rule),
            };
        }
    }

    const networkMethod = callNetworkMethod(node, constants);
    if (networkMethod && sideEffectRules.networkMutationMethods.includes(networkMethod)) {
        return {
            effectClass: "http-mutation",
            resourceClass: callNetworkResource(node, constants),
        };
    }

    if (isShellCallee(name)) {
        const command = commandFromCall(node, constants);
        return command ? shellEffectIdentity(command) : null;
    }

    const receiver = databaseReceiver(name);
    if (sideEffectRules.reversalVerbs.databaseCreationVerbs.includes(terminal)
        && sideEffectRules.databaseReceiverPattern.test(receiver)) {
        return { effectClass: "database-record", resourceClass: receiver };
    }

    if (sideEffectRules.reversalVerbs.filesystemCreationVerbs.includes(
        name === "Bun.write" ? name : terminal,
    )) {
        const path = staticString(node.arguments[0], constants, node.getSourceFile());
        if (path && isOutOfRepoPath(path, repoRoot)) {
            return {
                effectClass: "out-of-repo-file",
                resourceClass: normalizePath(path),
            };
        }
    }

    const site = classifyCall(node, "", constants, repoRoot);
    return site
        ? { effectClass: "unknown", resourceClass: site.detail }
        : null;
}

function collectEffectIdentities(nodes, constants, repoRoot) {
    const identities = new Map();
    const visitedCalls = new Set();
    const add = (identity) => {
        if (!identity) return;
        const key = `${identity.effectClass}:${JSON.stringify(identity.resourceClass ?? null)}`;
        identities.set(key, identity);
    };
    const visit = (node) => {
        if (ts.isCallExpression(node) && !visitedCalls.has(node)) {
            visitedCalls.add(node);
            add(callEffectIdentity(node, constants, repoRoot));
        } else if (ts.isTaggedTemplateExpression(node)) {
            const tag = expressionName(node.tag);
            if (isShellCallee(tag)) {
                const command = staticString(node.template, constants, node.getSourceFile());
                if (command && classifyCommand(command)) add(shellEffectIdentity(command));
            }
        }
        ts.forEachChild(node, visit);
    };
    for (const node of nodes) visit(node);
    return [...identities.values()];
}

function isReversalCall(node, effectIdentity, constants) {
    const name = expressionName(node.expression);
    const terminal = name.split(".").at(-1) ?? "";
    const callRule = sideEffectRules.reversalVerbs.callRules.find((rule) => (
        rule.effectClass === effectIdentity.effectClass
    ));
    if (callRule?.reversals.some((pattern) => pattern.test(name))) {
        return sdkResourcesAreAffine(
            effectIdentity.resourceClass,
            sdkResourceArgument(node, constants, callRule),
        );
    }

    if (effectIdentity.effectClass === "http-mutation") {
        if (callNetworkMethod(node, constants) !== "DELETE") return false;
        const reversalResource = callNetworkResource(node, constants);
        return effectIdentity.resourceClass !== null
            && reversalResource !== null
            && pathResourcesAreAffine(effectIdentity.resourceClass, reversalResource);
    }

    if (effectIdentity.effectClass === "database-record") {
        return sideEffectRules.reversalVerbs.databaseReversalVerbs.includes(terminal)
            && databaseReceiver(name) === effectIdentity.resourceClass;
    }

    if (effectIdentity.effectClass === "out-of-repo-file") {
        if (!sideEffectRules.reversalVerbs.filesystemReversalVerbs.includes(terminal)) {
            return false;
        }
        const path = staticString(node.arguments[0], constants, node.getSourceFile());
        return path === null || normalizePath(path) === effectIdentity.resourceClass;
    }

    if (isShellCallee(name)) {
        const command = commandFromCall(node, constants);
        const detail = command ? classifyCommand(command) : null;
        const shellRule = sideEffectRules.reversalVerbs.shellRules.find((rule) => (
            rule.effectClass === effectIdentity.effectClass
        ));
        if (shellRule && detail && shellRule.reversals.includes(detail)) {
            return !shellRule.matchResource
                || effectIdentity.resourceClass === null
                || commandResourceKey(command, shellRule.effectClass) === effectIdentity.resourceClass;
        }
        if (effectIdentity.effectClass !== "unknown") return false;
        return Boolean(detail && /\b(?:delete|destroy|unpublish|deprecate)\b/i.test(detail));
    }

    if (effectIdentity.effectClass !== "unknown") return false;
    if (sideEffectRules.reversalVerbs.effectCreationVerbPattern.test(name)) return false;
    return sideEffectRules.reversalVerbs.unknownDeleteVerbPattern.test(name)
        || sideEffectRules.reversalVerbs.callRules.some((rule) => (
            rule.reversals.some((pattern) => pattern.test(name))
        ));
}

function collectExistenceVariables(node) {
    const names = new Set();
    const visit = (candidate) => {
        if (ts.isVariableDeclaration(candidate)
            && ts.isIdentifier(candidate.name)
            && candidate.initializer
            && containsExistenceCall(candidate.initializer)) {
            names.add(candidate.name.text);
        }
        ts.forEachChild(candidate, visit);
    };
    visit(node);
    return names;
}

function collectEffectStatusVariables(node) {
    const names = new Set();
    const visit = (candidate) => {
        if (ts.isVariableDeclaration(candidate)
            && ts.isIdentifier(candidate.name)
            && candidate.initializer
            && /\beffectStatus\b/.test(candidate.initializer.getText())) {
            names.add(candidate.name.text);
        }
        ts.forEachChild(candidate, visit);
    };
    visit(node);
    return names;
}

function unwrapExpression(node) {
    let current = node;
    while (ts.isParenthesizedExpression(current)
        || ts.isAwaitExpression(current)
        || ts.isAsExpression(current)
        || ts.isNonNullExpression(current)) {
        current = current.expression;
    }
    return current;
}

function staticConditionValue(node, state, context) {
    const expression = unwrapExpression(node);
    if (expression.kind === ts.SyntaxKind.TrueKeyword) return { known: true, value: true };
    if (expression.kind === ts.SyntaxKind.FalseKeyword) return { known: true, value: false };
    if (expression.kind === ts.SyntaxKind.NullKeyword) return { known: true, value: null };
    if (ts.isStringLiteralLike(expression)) return { known: true, value: expression.text };
    if (ts.isIdentifier(expression)) {
        if (context.existenceVariables.has(expression.text)) {
            return { known: true, value: state.effectExists ? "effect-present" : null };
        }
        if (context.statusVariables.has(expression.text)) {
            return { known: true, value: state.status };
        }
        if (expression.text === "undefined") return { known: true, value: undefined };
        return { known: false };
    }
    if (ts.isPropertyAccessExpression(expression)
        && expression.name.text === "effectStatus") {
        return { known: true, value: state.status };
    }
    if (ts.isCallExpression(expression) && containsExistenceCall(expression)) {
        return { known: true, value: state.effectExists ? "effect-present" : null };
    }
    return { known: false };
}

function conditionOutcome(node, state, context) {
    const expression = unwrapExpression(node);
    if (ts.isPrefixUnaryExpression(expression)
        && expression.operator === ts.SyntaxKind.ExclamationToken) {
        const outcome = conditionOutcome(expression.operand, state, context);
        return outcome === null ? null : !outcome;
    }
    if (ts.isBinaryExpression(expression)) {
        if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
            const left = conditionOutcome(expression.left, state, context);
            if (left === false) return false;
            const right = conditionOutcome(expression.right, state, context);
            if (left === true) return right;
            return right === false ? false : null;
        }
        if (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
            const left = conditionOutcome(expression.left, state, context);
            if (left === true) return true;
            const right = conditionOutcome(expression.right, state, context);
            if (left === false) return right;
            return right === true ? true : null;
        }
        if ([
            ts.SyntaxKind.EqualsEqualsToken,
            ts.SyntaxKind.EqualsEqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsToken,
            ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ].includes(expression.operatorToken.kind)) {
            const left = staticConditionValue(expression.left, state, context);
            const right = staticConditionValue(expression.right, state, context);
            if (!left.known || !right.known) return null;
            const equal = left.value === right.value;
            return expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken
                || expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
                ? !equal
                : equal;
        }
    }
    const value = staticConditionValue(expression, state, context);
    return value.known ? Boolean(value.value) : null;
}

function cloneState(state) {
    return { ...state };
}

function markUndo(state) {
    return { ...state, undone: true };
}

function expressionContainsUndo(node, context) {
    let found = false;
    const visit = (candidate) => {
        if (found) return;
        if (candidate !== node
            && (ts.isArrowFunction(candidate)
                || ts.isFunctionExpression(candidate)
                || ts.isFunctionDeclaration(candidate))) {
            return;
        }
        if (ts.isCallExpression(candidate)
            && isReversalCall(candidate, context.effectIdentity, context.constants)) {
            found = true;
            return;
        }
        if (ts.isTaggedTemplateExpression(candidate)) {
            const command = staticString(
                candidate.template,
                context.constants,
                candidate.getSourceFile(),
            );
            const shellRule = sideEffectRules.reversalVerbs.shellRules.find((rule) => (
                rule.effectClass === context.effectIdentity.effectClass
            ));
            const detail = command ? classifyCommand(command) : null;
            if (shellRule
                && detail
                && shellRule.reversals.includes(detail)
                && (!shellRule.matchResource
                    || context.effectIdentity.resourceClass === null
                    || commandResourceKey(command, shellRule.effectClass)
                        === context.effectIdentity.resourceClass)) {
                found = true;
                return;
            }
        }
        ts.forEachChild(candidate, visit);
    };
    visit(node);
    return found;
}

function executeExpression(node, states, context) {
    const expression = unwrapExpression(node);
    if (ts.isConditionalExpression(expression)) {
        return states.flatMap((state) => {
            if (state.terminated) return [state];
            const outcome = conditionOutcome(expression.condition, state, context);
            if (outcome === true) {
                return executeExpression(expression.whenTrue, [state], context);
            }
            if (outcome === false) {
                return executeExpression(expression.whenFalse, [state], context);
            }
            return [
                ...executeExpression(expression.whenTrue, [cloneState(state)], context),
                ...executeExpression(expression.whenFalse, [cloneState(state)], context),
            ];
        });
    }
    if (ts.isBinaryExpression(expression)
        && (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
            || expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
        return states.flatMap((state) => {
            if (state.terminated) return [state];
            const outcome = conditionOutcome(expression.left, state, context);
            const executeRight = expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
                ? outcome !== false
                : outcome === false;
            const skipRight = expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
                ? outcome !== true
                : outcome !== false;
            return [
                ...(executeRight
                    ? executeExpression(expression.right, [cloneState(state)], context)
                    : []),
                ...(skipRight ? [cloneState(state)] : []),
            ];
        });
    }
    if (!expressionContainsUndo(expression, context)) return states;
    return states.map((state) => state.terminated ? state : markUndo(state));
}

function executeStatement(statement, states, context) {
    if (ts.isBlock(statement)) {
        return executeStatements(statement.statements, states, context);
    }
    if (ts.isIfStatement(statement)) {
        return states.flatMap((state) => {
            if (state.terminated) return [state];
            const outcome = conditionOutcome(statement.expression, state, context);
            if (outcome === true) {
                return executeStatement(statement.thenStatement, [state], context);
            }
            if (outcome === false) {
                return statement.elseStatement
                    ? executeStatement(statement.elseStatement, [state], context)
                    : [state];
            }
            return [
                ...executeStatement(statement.thenStatement, [cloneState(state)], context),
                ...(statement.elseStatement
                    ? executeStatement(statement.elseStatement, [cloneState(state)], context)
                    : [cloneState(state)]),
            ];
        });
    }
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
        const afterExpression = statement.expression
            ? executeExpression(statement.expression, states, context)
            : states;
        return afterExpression.map((state) => ({ ...state, terminated: true }));
    }
    if (ts.isExpressionStatement(statement)) {
        return executeExpression(statement.expression, states, context);
    }
    if (ts.isVariableStatement(statement)) {
        let paths = states;
        for (const declaration of statement.declarationList.declarations) {
            if (declaration.initializer) {
                paths = executeExpression(declaration.initializer, paths, context);
            }
        }
        return paths;
    }
    if (ts.isTryStatement(statement)
        || ts.isForStatement(statement)
        || ts.isForOfStatement(statement)
        || ts.isForInStatement(statement)
        || ts.isWhileStatement(statement)
        || ts.isDoStatement(statement)
        || ts.isSwitchStatement(statement)) {
        // Complex control flow is accepted only when every possible path is
        // provably safe. Treat it as unknown branching by preserving a skip
        // path alongside any undo path found inside.
        if (!expressionContainsUndo(statement, context)) return states;
        return states.flatMap((state) => [
            cloneState(state),
            state.terminated ? state : markUndo(cloneState(state)),
        ]);
    }
    return states;
}

function executeStatements(statements, states, context) {
    let paths = states;
    for (const statement of statements) {
        paths = executeStatement(statement, paths, context);
    }
    return paths;
}

function containsExistenceCall(node) {
    let found = false;
    const visit = (candidate) => {
        if (ts.isCallExpression(candidate) && sideEffectRules.existenceCheckPattern.test(expressionName(candidate.expression))) found = true;
        if (!found) ts.forEachChild(candidate, visit);
    };
    visit(node);
    return found;
}

function containsEffectCall(node) {
    let found = false;
    const visit = (candidate) => {
        if (ts.isCallExpression(candidate)) {
            const name = expressionName(candidate.expression);
            const terminal = name.split(".").at(-1) ?? "";
            if (sideEffectRules.sdkMutationPaths.some((rule) => rule.pattern.test(name)) ||
                sideEffectRules.databaseMutationMethods.includes(terminal) ||
                ["delete", "remove", "cancel", "refund", "undo", "revert"].some((word) => terminal.toLowerCase().includes(word))) {
                found = true;
            }
        }
        if (!found) ts.forEachChild(candidate, visit);
    };
    visit(node);
    return found;
}

function callArgumentsUseIdempotencyKey(node) {
    let found = false;
    const visit = (candidate) => {
        if (ts.isPropertyAccessExpression(candidate)
            && ts.isIdentifier(candidate.expression)
            && candidate.expression.text === "ctx"
            && candidate.name.text === "idempotencyKey") {
            found = true;
            return;
        }
        if (!found) ts.forEachChild(candidate, visit);
    };
    for (const argument of node.arguments) {
        visit(argument);
        if (found) return true;
    }
    return false;
}

function staticString(node, constants, file, seen = new Set()) {
    if (!node) return null;
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isParenthesizedExpression(node)) return staticString(node.expression, constants, file, seen);
    if (ts.isIdentifier(node) && constants.has(node.text) && !seen.has(node.text)) {
        seen.add(node.text);
        return staticString(constants.get(node.text), constants, file, seen);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = staticString(node.left, constants, file, new Set(seen));
        const right = staticString(node.right, constants, file, new Set(seen));
        return left !== null && right !== null ? left + right : null;
    }
    if (ts.isTemplateExpression(node)) {
        let value = node.head.text;
        for (const span of node.templateSpans) {
            const expression = staticString(span.expression, constants, file, new Set(seen));
            value += expression ?? " __dynamic__ ";
            value += span.literal.text;
        }
        return value;
    }
    return null;
}

function staticStringArray(node, constants, file) {
    if (!node || !ts.isArrayLiteralExpression(node)) return null;
    const values = node.elements.map((element) => staticString(element, constants, file));
    return values.every((value) => value !== null) ? values : null;
}

function objectStringProperty(node, name, constants, file) {
    if (!node || !ts.isObjectLiteralExpression(node)) return null;
    const value = objectPropertyValue(node, name);
    return staticString(value, constants, file);
}

function booleanProperty(object, name) {
    const value = objectPropertyValue(object, name);
    if (!value) return null;
    if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
    return null;
}

function objectPropertyValue(object, name) {
    const property = object.properties.find((candidate) => propertyName(candidate.name) === name);
    if (!property) return null;
    if (ts.isPropertyAssignment(property)) return property.initializer;
    if (ts.isMethodDeclaration(property)) return property;
    if (ts.isShorthandPropertyAssignment(property)) return property.name;
    return null;
}

function propertyName(node) {
    if (!node) return "";
    return ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : node.getText();
}

function expressionName(node) {
    if (ts.isIdentifier(node)) return node.text;
    if (ts.isPropertyAccessExpression(node)) return `${expressionName(node.expression)}.${node.name.text}`;
    if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) {
        return `${expressionName(node.expression)}.${node.argumentExpression.text}`;
    }
    if (ts.isCallExpression(node)) return expressionName(node.expression);
    return node.getText();
}

function isShellCallee(name) {
    return /(?:^|\.)(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|bash|\$)$/.test(name);
}

function isOutOfRepoPath(path, repoRoot) {
    const normalized = normalizePath(path);
    if (!normalized.startsWith("/")) return false;
    if (normalized === repoRoot || normalized.startsWith(`${repoRoot}/`)) return false;
    return true;
}

function normalizePath(path) {
    const slashed = path.replaceAll("\\", "/");
    const normalized = posix.normalize(slashed).replace(/\/$/, "");
    return normalized || "/";
}

function rangeContainsAny(position, ranges) {
    return ranges.some(([start, end]) => position >= start && position <= end);
}

function basename(value) {
    return value.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
}

function shellWords(command) {
    return [...command.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)].map((match) => match[1] ?? match[2] ?? match[3]);
}

function flagValue(words, ...flags) {
    for (let index = 0; index < words.length; index += 1) {
        if (flags.includes(words[index])) return words[index + 1] ?? "";
        for (const flag of flags) {
            if (words[index].startsWith(`${flag}=`)) return words[index].slice(flag.length + 1);
        }
    }
    return null;
}

function jsxString(initializer, file) {
    if (!initializer) return null;
    if (ts.isStringLiteral(initializer)) return initializer.text;
    if (ts.isJsxExpression(initializer) && initializer.expression && ts.isStringLiteralLike(initializer.expression)) {
        return initializer.expression.text;
    }
    return initializer.getText(file);
}
