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

const isAssignment = (kind: ts.SyntaxKind) => kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;

const rawDomShimLine = (source: ts.SourceFile, checker: ts.TypeChecker) => {
  const isUnbound = (node: ts.Identifier) => !checker.getSymbolAtLocation(node);
  const isProtected = (node: ts.Expression): boolean => {
    node = unwrap(node);
    if (ts.isIdentifier(node)) return globalTargets.has(node.text) && isUnbound(node);
    const owner = propertyOwner(node);
    return !!owner && (
      propertyName(node) === "prototype" && ts.isIdentifier(unwrap(owner))
      || isProtected(owner)
    );
  };
  const mutatesProtectedTarget = (node: ts.Expression) => {
    const owner = propertyOwner(unwrap(node));
    return !!owner && isProtected(owner);
  };
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && node.arguments[0]) {
      const owner = propertyOwner(unwrap(node.expression));
      const method = propertyName(unwrap(node.expression));
      const unwrappedOwner = owner && unwrap(owner);
      const mutator = unwrappedOwner && ts.isIdentifier(unwrappedOwner) && isUnbound(unwrappedOwner) && (
        (unwrappedOwner.text === "Object" && ["defineProperty", "defineProperties", "assign", "setPrototypeOf"].includes(method ?? ""))
        || (unwrappedOwner.text === "Reflect" && ["defineProperty", "set", "setPrototypeOf", "deleteProperty"].includes(method ?? ""))
      );
      if (mutator && isProtected(node.arguments[0])) found = node;
    } else if (ts.isBinaryExpression(node)
      && isAssignment(node.operatorToken.kind)
      && mutatesProtectedTarget(node.left as ts.Expression)
      // React reads this runner configuration globally; it is not a browser API shim.
      && propertyName(unwrap(node.left as ts.Expression)) !== "IS_REACT_ACT_ENVIRONMENT"
      // Assigning the URL hash drives real navigation behavior; it does not replace a browser API.
      && !(propertyName(unwrap(node.left as ts.Expression)) === "hash"
        && isProtected(propertyOwner(unwrap(node.left as ts.Expression)) ?? node.left as ts.Expression))) found = node;
    else if (ts.isDeleteExpression(node) && mutatesProtectedTarget(node.expression)) found = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found && source.getLineAndCharacterOfPosition(found.getStart(source)).line + 1;
};

test("test DOM shims use the shared helper and register its alarm", async () => {
  const paths: string[] = [];
  for await (const path of new Bun.Glob("{packages,apps,scripts,test-support}/**/*.{test,spec}.{ts,tsx}").scan({ cwd: root, absolute: true })) paths.push(path);
  const program = ts.createProgram(paths, { jsx: ts.JsxEmit.ReactJSX, moduleDetection: ts.ModuleDetectionKind.Force, noLib: true, noResolve: true, skipLibCheck: true, target: ts.ScriptTarget.Latest });
  const checker = program.getTypeChecker();
  const failures: string[] = [];
  for (const path of paths) {
    const source = program.getSourceFile(path)!;
    const text = source.getFullText();
    const line = rawDomShimLine(source, checker);
    if (line) failures.push(`${relative(root, path)}:${line} uses a raw DOM shim; use test-support/dom-shim.ts`);
    if (text.includes("test-support/dom-shim") && !text.includes("domShimAlarm(import.meta.path)")) {
      failures.push(`${relative(root, path)} imports the DOM shim helper without domShimAlarm(import.meta.path)`);
    }
    if (text.includes("@happy-dom/global-registrator") && !text.includes("domShimAlarm(import.meta.path)")) {
      failures.push(`${relative(root, path)} uses happy-dom globals without domShimAlarm(import.meta.path)`);
    }
  }
  expect(failures).toEqual([]);
});
