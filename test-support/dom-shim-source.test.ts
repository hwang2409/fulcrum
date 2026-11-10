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

const protectedBindings = (source: ts.SourceFile, checker: ts.TypeChecker) => {
  const bindings = new Set<ts.Symbol>();
  const symbol = (node: ts.Identifier) => checker.getSymbolAtLocation(node);
  const protect = (node: ts.Identifier) => {
    const binding = symbol(node);
    if (!binding || bindings.has(binding)) return false;
    bindings.add(binding);
    return true;
  };
  const isProtected = (node: ts.Expression): boolean => {
    node = unwrap(node);
    if (ts.isIdentifier(node)) return globalTargets.has(node.text) || bindings.has(symbol(node)!);
    const owner = propertyOwner(node);
    return !!owner && (propertyName(node) === "prototype" && ts.isIdentifier(unwrap(owner)) || isProtected(owner));
  };
  const protectAll = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node)) return protect(node);
    let changed = false;
    ts.forEachChild(node, (child) => { changed = protectAll(child) || changed; });
    return changed;
  };
  const objectValue = (value: ts.Expression, name: string): ts.Expression | undefined => {
    value = unwrap(value);
    if (!ts.isObjectLiteralExpression(value)) return;
    for (const property of value.properties) {
      if (ts.isPropertyAssignment(property) && propertyNameFromNode(property.name) === name) return property.initializer;
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) return property.name;
    }
  };
  const propertyNameFromNode = (node: ts.PropertyName) => {
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
  };
  const protectTarget = (target: ts.Node, value: ts.Expression): boolean => {
    if (ts.isExpression(target)) target = unwrap(target);
    if (ts.isIdentifier(target)) return isProtected(value) && protect(target);
    if (ts.isBindingElement(target)) return protectTarget(target.name, value);
    if (ts.isArrayBindingPattern(target) || ts.isArrayLiteralExpression(target)) {
      const values = ts.isArrayLiteralExpression(unwrap(value)) ? unwrap(value).elements : undefined;
      let changed = false;
      target.elements.forEach((element, index) => {
        if (ts.isOmittedExpression(element)) return;
        const selected = values?.[index];
        if (selected && ts.isExpression(selected)) changed = protectTarget(element, selected) || changed;
        else if (isProtected(value)) changed = protectAll(element) || changed;
      });
      return changed;
    }
    if (ts.isObjectBindingPattern(target) || ts.isObjectLiteralExpression(target)) {
      let changed = false;
      for (const element of target.elements ?? target.properties) {
        if (ts.isSpreadAssignment(element) || ts.isSpreadElement(element)) {
          if (isProtected(value)) changed = protectAll(element.expression) || changed;
          continue;
        }
        const name = ts.isBindingElement(element)
          ? propertyNameFromNode(element.propertyName ?? element.name as ts.PropertyName)
          : ts.isShorthandPropertyAssignment(element) || ts.isPropertyAssignment(element)
            ? propertyNameFromNode(element.name)
            : undefined;
        const destination = ts.isBindingElement(element) ? element.name
          : ts.isShorthandPropertyAssignment(element) ? element.name
          : ts.isPropertyAssignment(element) ? element.initializer
          : undefined;
        if (!destination || !name) continue;
        const selected = objectValue(value, name);
        if (selected) changed = protectTarget(destination, selected) || changed;
        else if (isProtected(value) || name === "prototype" && ts.isIdentifier(unwrap(value))) {
          changed = protectAll(destination) || changed;
        }
      }
      return changed;
    }
    return false;
  };
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) changed = protectTarget(node.name, node.initializer) || changed;
      else if (ts.isBinaryExpression(node) && isAssignment(node.operatorToken.kind)) {
        changed = protectTarget(node.left, node.right) || changed;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { bindings, isProtected };
};

// React reads this runner configuration globally; it is not a browser API shim.
const isReactTestConfiguration = (node: ts.Expression) => propertyName(unwrap(node)) === "IS_REACT_ACT_ENVIRONMENT";
// Assigning the URL hash drives real navigation behavior; it does not replace a browser API.
const isBrowserInteraction = (node: ts.Expression, isProtected: (node: ts.Expression) => boolean) => propertyName(unwrap(node)) === "hash"
  && isProtected(propertyOwner(unwrap(node)) ?? node);

const rawDomShimLine = (source: ts.SourceFile, checker: ts.TypeChecker) => {
  const { isProtected } = protectedBindings(source, checker);
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
      const mutator = unwrappedOwner && ts.isIdentifier(unwrappedOwner) && (
        (unwrappedOwner.text === "Object" && ["defineProperty", "defineProperties", "assign", "setPrototypeOf"].includes(method ?? ""))
        || (unwrappedOwner.text === "Reflect" && ["defineProperty", "set", "setPrototypeOf", "deleteProperty"].includes(method ?? ""))
      );
      if (mutator && isProtected(node.arguments[0])) found = node;
    } else if (ts.isBinaryExpression(node)
      && isAssignment(node.operatorToken.kind)
      && mutatesProtectedTarget(node.left as ts.Expression)
      && !isReactTestConfiguration(node.left as ts.Expression)
      && !isBrowserInteraction(node.left as ts.Expression, isProtected)) found = node;
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
  }
  expect(failures).toEqual([]);
});
