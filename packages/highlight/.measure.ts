import { readFileSync } from "node:fs";
import * as R from "./dist/runtime.js"; const TokenizerRuntime = (R as any).TokenizerRuntime;
const warmed = new Set<string>();
const rt = new TokenizerRuntime((u) => warmed.add(u.id), () => {});
const samples: Record<string, [string, string]> = {
  cpp: ["cpp", "A<B<C,D>,E<F>>::g(h++,--i,j+=k,l?m:n); // x\n"],
  tsx: ["tsx", readFileSync("../react/src/parts.tsx", "utf8")],
  py: ["python", readFileSync(process.env.HOME + "/me/fun/zeta/src/zeta/server/control.py", "utf8")],
  json: ["json", readFileSync("../../bun.lock", "utf8")],
};
let v = 0;
for (const [name, [lang, src]] of Object.entries(samples)) {
  const ctx = { id: `w-${name}`, version: 1, state: "done" as const };
  await rt.tokenize("x", lang, ctx);
  while (!warmed.has(ctx.id)) await new Promise((r) => setTimeout(r, 20));
  for (const chars of [10_000, 25_000, 50_000, 100_000]) {
    let code = ""; while (code.length < chars) code += src; code = code.slice(0, chars);
    const times: number[] = [];
    for (let i = 0; i < 3; i++) { const t = performance.now(); await rt.tokenize(code, lang, { id: `m-${name}-${chars}-${i}`, version: ++v, state: "done" }); times.push(performance.now() - t); }
    times.sort((a, b) => a - b);
    console.log(name, chars, "median", times[1]!.toFixed(1), "ms");
  }
}
rt.dispose();
