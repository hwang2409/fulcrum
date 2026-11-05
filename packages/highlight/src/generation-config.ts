import { bundledLanguagesInfo } from "shiki";

const publicNames: Record<string, string> = { docker: "dockerfile", shellscript: "shell", make: "makefile", proto: "protobuf" };
const excluded = new Set(["angular-expression", "angular-inline-style", "angular-inline-template", "angular-let-declaration", "angular-template-blocks", "vue-html"]);

export const generationEntries = () => bundledLanguagesInfo
  .filter((info) => !excluded.has(info.id))
  .map((info) => ({ actual: info.id, name: publicNames[info.id] ?? info.id, aliases: info.aliases ?? [] }));
