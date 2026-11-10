import { expect, test } from "bun:test";
import { join, relative } from "node:path";
import ts from "typescript";

const root = join(import.meta.dir, "..");
const domClasses = new Set(["Document", "Element", "EventTarget", "HTMLElement", "Node", "Navigator", "Window"]);
const namedGlobals = new Set([
  "ResizeObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "matchMedia",
  "IntersectionObserver",
  "MutationObserver",
  "getComputedStyle",
]);

const propertyName = (node: ts.Expression): string | undefined => {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    const argument = node.argumentExpression;
    if (ts.isStringLiteralLike(argument)) return argument.text;
  }
};

const propertyOwner = (node: ts.Expression): ts.Expression | undefined =>
  ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? node.expression : undefined;

const isDomClass = (name: string) => domClasses.has(name) || /^HTML.*Element$/.test(name) || /^SVG.*Element$/.test(name);

const isDomPrototype = (node: ts.Expression) => {
  const owner = propertyOwner(node);
  return propertyName(node) === "prototype" && !!owner && ts.isIdentifier(owner) && isDomClass(owner.text);
};

const isGlobalTarget = (node: ts.Expression) => ts.isIdentifier(node)
  && ["globalThis", "window", "document", "navigator", "performance"].includes(node.text);

const isNamedGlobalAssignment = (node: ts.Expression) => {
  const owner = propertyOwner(node);
  const name = propertyName(node);
  if (!owner || !name || !ts.isIdentifier(owner)) return false;
  if ((owner.text === "globalThis" || owner.text === "window") && namedGlobals.has(name)) return true;
  return (owner.text === "performance" && name === "now") || (owner.text === "navigator" && name === "clipboard");
};

const usesRawDomShim = (source: ts.SourceFile) => {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && node.arguments[0]) {
      const owner = propertyOwner(node.expression);
      const method = propertyName(node.expression);
      if (owner && ts.isIdentifier(owner)
        && (owner.text === "Object" || owner.text === "Reflect")
        && (method === "defineProperty" || method === "defineProperties")
        && (isDomPrototype(node.arguments[0]) || isGlobalTarget(node.arguments[0]))) found = true;
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && (isDomPrototype(propertyOwner(node.left as ts.Expression) ?? node.left as ts.Expression)
        || isNamedGlobalAssignment(node.left as ts.Expression))) found = true;
    else if (ts.isDeleteExpression(node)
      && (isDomPrototype(propertyOwner(node.expression) ?? node.expression) || isNamedGlobalAssignment(node.expression))) found = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

test("test DOM shims use the shared helper and register its alarm", async () => {
  const failures: string[] = [];
  for await (const path of new Bun.Glob("{packages,apps}/**/*.{test,spec}.{ts,tsx}").scan({ cwd: root, absolute: true })) {
    const source = await Bun.file(path).text();
    const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    if (usesRawDomShim(parsed)) failures.push(`${relative(root, path)} uses a raw DOM shim; use test-support/dom-shim.ts`);
    if (source.includes("test-support/dom-shim") && !source.includes("domShimAlarm(import.meta.path)")) {
      failures.push(`${relative(root, path)} imports the DOM shim helper without domShimAlarm(import.meta.path)`);
    }
  }
  expect(failures).toEqual([]);
});
