import { expect, test } from "bun:test";
import { join, relative } from "node:path";
import ts from "typescript";

const root = join(import.meta.dir, "..");
const globalTargets = new Set(["globalThis", "window", "self", "document", "navigator", "performance", "location"]);

const propertyName = (node: ts.Expression): string | undefined => {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    const argument = node.argumentExpression;
    if (ts.isStringLiteralLike(argument)) return argument.text;
  }
};

const propertyOwner = (node: ts.Expression): ts.Expression | undefined =>
  ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? node.expression : undefined;

const unwrap = (node: ts.Expression): ts.Expression => {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
    || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
};

const isProtectedTarget = (node: ts.Expression) => {
  node = unwrap(node);
  if (ts.isIdentifier(node)) return globalTargets.has(node.text);
  const owner = propertyOwner(node);
  return propertyName(node) === "prototype" && !!owner && ts.isIdentifier(unwrap(owner));
};

const mutatesProtectedTarget = (node: ts.Expression) => {
  const owner = propertyOwner(unwrap(node));
  return !!owner && isProtectedTarget(owner);
};

// React reads this runner configuration globally; it is not a browser API shim.
const isReactTestConfiguration = (node: ts.Expression) => propertyName(unwrap(node)) === "IS_REACT_ACT_ENVIRONMENT";
// Assigning the URL hash drives real navigation behavior; it does not replace a browser API.
const isBrowserInteraction = (node: ts.Expression) => propertyName(unwrap(node)) === "hash"
  && isProtectedTarget(propertyOwner(unwrap(node)) ?? node);

const rawDomShimLine = (source: ts.SourceFile) => {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && node.arguments[0]) {
      const owner = propertyOwner(unwrap(node.expression));
      const method = propertyName(unwrap(node.expression));
      const unwrappedOwner = owner && unwrap(owner);
      const mutator = unwrappedOwner && ts.isIdentifier(unwrappedOwner) && (
        (unwrappedOwner.text === "Object" && ["defineProperty", "defineProperties", "assign"].includes(method ?? ""))
        || (unwrappedOwner.text === "Reflect" && ["defineProperty", "set"].includes(method ?? ""))
      );
      if (mutator && isProtectedTarget(node.arguments[0])) found = node;
    } else if (ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      && mutatesProtectedTarget(node.left as ts.Expression)
      && !isReactTestConfiguration(node.left as ts.Expression)
      && !isBrowserInteraction(node.left as ts.Expression)) found = node;
    else if (ts.isDeleteExpression(node) && mutatesProtectedTarget(node.expression)) found = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found && source.getLineAndCharacterOfPosition(found.getStart(source)).line + 1;
};

test("test DOM shims use the shared helper and register its alarm", async () => {
  const failures: string[] = [];
  for await (const path of new Bun.Glob("{packages,apps,scripts,test-support}/**/*.{test,spec}.{ts,tsx}").scan({ cwd: root, absolute: true })) {
    const source = await Bun.file(path).text();
    const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const line = rawDomShimLine(parsed);
    if (line) failures.push(`${relative(root, path)}:${line} uses a raw DOM shim; use test-support/dom-shim.ts`);
    if (source.includes("test-support/dom-shim") && !source.includes("domShimAlarm(import.meta.path)")) {
      failures.push(`${relative(root, path)} imports the DOM shim helper without domShimAlarm(import.meta.path)`);
    }
  }
  expect(failures).toEqual([]);
});
