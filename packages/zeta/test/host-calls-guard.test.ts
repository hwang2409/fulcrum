import { expect, test } from "bun:test";
import ts from "typescript";

// Keeps host calls behind their owners without a reviewer grep. The test parses store.ts and client.ts and checks every
// call and `new`. A call is host code unless its callee is (i) a function, arrow, or class declared in the same file,
// (ii) an implementation in the package's own modules (a relative import; an interface method is host code), or
// (iii) a platform function on the short list below. Any other call, including a function read from a Set, a Map, a
// parameter, or `options`, whatever its name, must run inside an owner as an AST ancestor (its body, or an inline
// function passed to it), or sit on a line marked `// host code: outside; README row "<row>"` (an "outside" row of the
// README table). An async or generator function never counts as owned: code after its first await, or all of a
// generator's body, runs after the owner's try has returned.
// shortcut: exotic forms stay uncaught: a tagged template (`fn\`x\``), `set.forEach(Function.prototype.call as never)`,
// and a host function cast `as never` (it hides the call signature, as in `new Promise(listener as never)`). Upgrade
// if one of them shows up in review.
type Rule = { file: string; readme: string; owners: string[] };
const rules: Rule[] = [
  { file: "packages/core/src/store.ts", readme: "packages/core/README.md", owners: ["call", "sink"] },
  { file: "packages/zeta/src/client.ts", readme: "packages/zeta/README.md", owners: ["call", "deliver", "sink"] },
];
const root = new URL("../../../", import.meta.url).pathname;

// (iii) Platform code that runs no host code by itself. Globals by name; methods by the lib interface that declares
// them. A method is platform only on a receiver that does not start at a parameter of the file's exported factory
// (`transport.ready.then` is host code), and a function handed to it must be one of (i) or (ii). shortcut: a platform
// conversion (`String(value)`, `JSON.stringify`) can still run a host value's getters or toString; the guard does not
// see that, so core keeps those reads in errorMessage() and its README table.
const platformGlobals = new Set([
  "Math", "JSON", "Object", "Array", "Map", "Set", "Promise", "Number", "String", "Error", "RangeError", "setTimeout",
  "clearTimeout", "AbortController", "structuredClone", "TextEncoder", "atob", "Uint8Array", "ArrayBuffer", "Blob",
]);
const platformTypes = new Set(["Array", "ReadonlyArray", "Map", "Set", "Promise", "PromiseConstructor", "String", "AbortController", "TextEncoder"]);

// Platform functions and methods that call a function handed to them.
const callers = new Set([
  "forEach", "map", "filter", "find", "findIndex", "some", "every", "reduce", "flatMap", "sort", "then", "catch", "finally",
  "setTimeout", "addEventListener", "Promise",
]);
const options: ts.CompilerOptions = {
  strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  lib: ["lib.es2022.d.ts", "lib.esnext.iterator.d.ts", "lib.dom.d.ts"], types: [], noEmit: true,
};
let previous: ts.Program | undefined;
// Type information decides what a callee is; the file's text can be replaced to plant a call.
function program(file: string, text: string) {
  const host = ts.createCompilerHost(options, true);
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (name, version, onError) => name === root + file
    ? ts.createSourceFile(name, text, version, true) : getSourceFile(name, version, onError);
  previous = ts.createProgram({ rootNames: [root + file], options, host, oldProgram: previous });
  return previous;
}

function scan(text: string, rule: Rule): string[] {
  const built = program(rule.file, text);
  const checker = built.getTypeChecker();
  const file = built.getSourceFile(root + rule.file)!;
  const lines = text.split("\n");
  const own = root + rule.file.replace(/[^/]+$/, "");
  const unwrap = (node: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) ? unwrap(node.expression) : node;
  const symbolOf = (node: ts.Node) => {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  };
  const isFunction = (node: ts.Expression) => ts.isArrowFunction(unwrap(node)) || ts.isFunctionExpression(unwrap(node));
  const isImplementation = (declaration: ts.Declaration): boolean => {
    if (ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration)) return true;
    if (ts.isMethodDeclaration(declaration)) return !!declaration.body;
    if (ts.isPropertyAssignment(declaration)) return isFunction(declaration.initializer);
    if (ts.isShorthandPropertyAssignment(declaration)) {
      const target = checker.getShorthandAssignmentValueSymbol(declaration)?.valueDeclaration;
      return !!target && isImplementation(target);
    }
    return ts.isVariableDeclaration(declaration) && !!declaration.initializer && !!(declaration.parent.flags & ts.NodeFlags.Const) &&
      isFunction(declaration.initializer);
  };
  // (i) and (ii): a function or class implemented in this file or in a sibling module.
  const isLocal = (node: ts.Expression) => {
    node = unwrap(node);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true;
    const declaration = symbolOf(node)?.valueDeclaration;
    const path = declaration?.getSourceFile().fileName ?? "";
    return !!declaration && path.startsWith(own) && !path.endsWith(".d.ts") && isImplementation(declaration);
  };
  const factoryParameters = new Set<ts.Symbol>();
  for (const statement of file.statements)
    if (ts.isFunctionDeclaration(statement) && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
      for (const parameter of statement.parameters) factoryParameters.add(checker.getSymbolAtLocation(parameter.name)!);
  const roots = (node: ts.Expression): ts.Expression[] => {
    node = unwrap(node);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node)) return roots(node.expression);
    if (ts.isConditionalExpression(node)) return [...roots(node.whenTrue), ...roots(node.whenFalse)];
    return [node];
  };
  const isPlatformGlobal = (node: ts.Expression) => {
    if (!ts.isIdentifier(node) || !platformGlobals.has(node.text)) return false;
    const declaration = symbolOf(node)?.valueDeclaration;
    return !declaration || built.isSourceFileDefaultLibrary(declaration.getSourceFile());
  };
  // A function value typed by a platform signature: the resolve and reject of a `new Promise` executor.
  const hasPlatformSignature = (node: ts.Expression) => checker.getTypeAtLocation(node).getCallSignatures().some((signature) => {
    for (let at: ts.Node | undefined = signature.getDeclaration(); at; at = at.parent)
      if (ts.isInterfaceDeclaration(at)) return built.isSourceFileDefaultLibrary(at.getSourceFile()) && platformTypes.has(at.name.text);
    return false;
  });
  const isPlatform = (callee: ts.Expression) => {
    if (ts.isIdentifier(callee)) return isPlatformGlobal(callee) || hasPlatformSignature(callee);
    if (!ts.isPropertyAccessExpression(callee)) return false;
    const starts = roots(callee.expression);
    if (starts.every(isPlatformGlobal)) return true;
    if (starts.some((start) => ts.isIdentifier(start) && factoryParameters.has(checker.getSymbolAtLocation(start)!))) return false;
    const declarations = symbolOf(callee.name)?.declarations ?? [];
    return declarations.length > 0 && declarations.every((declaration) => {
      const container = declaration.parent;
      return built.isSourceFileDefaultLibrary(declaration.getSourceFile()) &&
        (ts.isInterfaceDeclaration(container) || ts.isClassDeclaration(container)) && platformTypes.has(container.name!.text);
    });
  };
  // Why a call may reach host code, or undefined.
  const hostCallee = (call: ts.CallExpression | ts.NewExpression): string | undefined => {
    let callee = unwrap(call.expression);
    if (callee.kind === ts.SyntaxKind.SuperKeyword) return undefined;
    if (ts.isPropertyAccessExpression(callee) && ["call", "apply", "bind"].includes(callee.name.text) && !isPlatform(callee)) callee = unwrap(callee.expression);
    if (isLocal(callee)) return undefined;
    if (!isPlatform(callee)) return callee.getText(file);
    const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : callee.getText(file);
    if (!callers.has(name)) return undefined;
    const handed = call.arguments?.find((argument) => checker.getTypeAtLocation(argument).getCallSignatures().length > 0 && !isLocal(argument) && !hasPlatformSignature(argument));
    return handed && `${callee.getText(file)} handed ${handed.getText(file)}`;
  };
  const isOwner = (node: ts.Expression) => ts.isIdentifier(node) && rule.owners.includes(node.text) && isLocal(node);
  // Inside an owner as an AST ancestor: its body, or an inline function passed straight to it (it runs inside its try).
  // A function on the way up that is not an owner keeps the call owned only as an inline callback of a platform call
  // that runs it synchronously.
  const owned = (node: ts.Node) => {
    for (let current = node.parent; !ts.isSourceFile(current); current = current.parent) {
      if (!ts.isFunctionLike(current)) continue;
      if (ts.getCombinedModifierFlags(current as ts.Declaration) & ts.ModifierFlags.Async || "asteriskToken" in current && current.asteriskToken) return false;
      const parent = current.parent;
      if (ts.isVariableDeclaration(parent) && isOwner(parent.name as ts.Identifier)) return true;
      if (!ts.isCallExpression(parent)) return false;
      if (isOwner(parent.expression)) return true;
      const callee = unwrap(parent.expression);
      const sync = ["forEach", "map", "filter", "find", "findIndex", "some", "every", "reduce", "flatMap", "sort"];
      if (!(ts.isPropertyAccessExpression(callee) && sync.includes(callee.name.text) && isPlatform(callee))) return false;
    }
    return false;
  };
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const host = hostCallee(node);
      const line = file.getLineAndCharacterOfPosition(node.expression.getEnd()).line;
      if (host !== undefined && !owned(node) && !lines[line]!.includes("// host code: outside"))
        found.push(`${rule.file}:${line + 1}: host callback invoked outside its owner: \`${host}\` in \`${lines[line]!.trim()}\`. ` +
          `Call it through ${rule.owners.filter((name) => name !== "sink").map((name) => `${name}()`).join(" or ")}.`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}
const read = (rule: Rule) => Bun.file(root + rule.file).text();

test.each(rules)("every host callback in $file runs through its owner", async (rule) => {
  expect(scan(await read(rule), rule)).toEqual([]);
}, 30_000);

// The guard's own proof: each planted form, inserted at an anchor line outside every owner, fails at its own line with
// a message that names the owner to use.
const planted: { rule: Rule; anchor: string; forms: string[] }[] = [
  {
    rule: rules[0]!,
    anchor: "  const report = () => {",
    forms: [
      "  options.onError?.(new Error(\"boom\"));",
      "  onError?.(new Error(\"boom\"));",
      "  for (const l of listeners) l();",
      "  diagnosticsListeners.forEach((listener) => listener.call(null));",
      "  call(async () => { await 0; for (const l of listeners) l(); });",
    ],
  },
  {
    rule: rules[1]!,
    anchor: "  const onSessionGrantsChanged = ",
    forms: [
      "  for (const l of closeListeners) l(closedError);",
      "  { const event = {} as SessionGrantsChanged; const fn = sessionGrantsListeners.values().next().value!; fn(event); }",
      "  { const handler = [...closeListeners][0]!; handler.call(null, closedError); }",
      "  closeListeners.forEach((listener) => listener.apply(null, [closedError]));",
      "  closeListeners.forEach((listener) => listener.bind(null, closedError)());",
      "  [...closeListeners].map((f) => f(closedError));",
      "  options.hostCommands?.(\"session\");",
      "  transport.send(\"frame\");",
      "  call(() => {}); for (const l of closeListeners) l(closedError);",
      "  setTimeout([...closeListeners][0]!, 0);",
      "  Promise.resolve(closedError).then([...closeListeners][0]);",
      "  call(() => { setTimeout(() => { for (const l of closeListeners) l(closedError); }, 0); });",
      "  call(async () => { await closedError; for (const l of closeListeners) l(closedError); });",
      "  call(async () => { for (const l of closeListeners) l(closedError); });",
      "  call(function* () { for (const l of closeListeners) l(closedError); });",
    ],
  },
];
test.each(planted)("each planted direct host call in $rule.file fails the guard", async ({ rule, anchor, forms }) => {
  const lines = (await read(rule)).split("\n");
  const at = lines.findIndex((line) => line.startsWith(anchor));
  expect(at).toBeGreaterThan(0);
  const message = rule.owners.length === 2 ? "Call it through call()." : "Call it through call() or deliver().";
  for (const form of forms) {
    const found = scan([...lines.slice(0, at), form, ...lines.slice(at)].join("\n"), rule);
    expect(found.length).toBeGreaterThan(0);
    for (const violation of found) {
      expect(violation).toStartWith(`${rule.file}:${at + 1}: host callback invoked outside its owner`);
      expect(violation).toEndWith(message);
    }
  }
}, 60_000);

// The type of call() refuses an async function too, so tsc stops it before the guard runs.
test.each(planted)("an async function passed to call() in $rule.file does not type-check", async ({ rule, anchor, forms }) => {
  const lines = (await read(rule)).split("\n");
  const at = lines.findIndex((line) => line.startsWith(anchor));
  for (const form of forms.filter((form) => form.startsWith("  call(async"))) {
    const built = program(rule.file, [...lines.slice(0, at), form, ...lines.slice(at)].join("\n"));
    const file = built.getSourceFile(root + rule.file)!;
    const errors = built.getSemanticDiagnostics(file).filter((diagnostic) => file.getLineAndCharacterOfPosition(diagnostic.start!).line === at)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    expect({ form, refused: errors.some((error) => error.includes("is not assignable to type 'never'")) }).toEqual({ form, refused: true });
  }
}, 60_000);

// Every `// host code: outside` marker is load-bearing: removing any one of them fails the guard at that line. Each one
// names an existing "outside" row of its README table, by the start of the row's first cell.
test.each(rules)("removing any outside marker in $file fails the guard", async (rule) => {
  const lines = (await read(rule)).split("\n");
  const marked = lines.flatMap((line, index) => line.includes("// host code: outside") ? [index] : []);
  expect(marked.length).toBeGreaterThan(0);
  const rows = (await Bun.file(root + rule.readme).text()).split("\n").flatMap((line) => {
    const cells = line.split("|").map((cell) => cell.trim());
    return line.startsWith("| ") && cells[2]?.startsWith("outside") ? [cells[1]!.replaceAll("`", "")] : [];
  });
  for (const index of marked) {
    const row = /\/\/ host code: outside; README row "([^"]+)"/.exec(lines[index]!)?.[1];
    expect({ line: index + 1, row, exists: !!row && rows.some((cell) => cell.startsWith(row)) }).toEqual({ line: index + 1, row, exists: true });
    const stripped = lines.with(index, lines[index]!.replace(/\s*\/\/ host code: outside.*$/, ""));
    expect({ line: index + 1, found: scan(stripped.join("\n"), rule).some((violation) => violation.startsWith(`${rule.file}:${index + 1}:`)) })
      .toEqual({ line: index + 1, found: true });
  }
}, 60_000);
