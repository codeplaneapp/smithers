import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import ts from "typescript";

const packageRoot = resolve(import.meta.dir, "..");

function exportedNames(relativePath, scriptKind) {
	const sourceFile = ts.createSourceFile(
		relativePath,
		readFileSync(resolve(packageRoot, relativePath), "utf8"),
		ts.ScriptTarget.Latest,
		true,
		scriptKind,
	);
	const names = [];

	for (const statement of sourceFile.statements) {
		if (ts.isExportDeclaration(statement) && ts.isNamedExports(statement.exportClause)) {
			for (const element of statement.exportClause.elements) {
				names.push((element.propertyName ?? element.name).text);
			}
			continue;
		}
		if (!statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)) continue;
		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
			}
			continue;
		}
		if (
			ts.isFunctionDeclaration(statement) ||
			ts.isClassDeclaration(statement) ||
			ts.isInterfaceDeclaration(statement) ||
			ts.isTypeAliasDeclaration(statement) ||
			ts.isEnumDeclaration(statement)
		) {
			if (statement.name) names.push(statement.name.text);
		}
	}

	return names;
}

describe("Cloudflare declarations", () => {
	test("committed declarations include every runtime source export", () => {
		const runtimeExports = exportedNames("src/index.js", ts.ScriptKind.JS);
		const declarationExports = new Set(exportedNames("src/index.d.ts", ts.ScriptKind.TS));

		expect(runtimeExports.length).toBeGreaterThan(0);
		for (const name of runtimeExports) expect(declarationExports.has(name)).toBe(true);
	});
});
