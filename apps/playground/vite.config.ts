import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { zetaDiscoveryPlugin } from "@fulcrum/zeta/discovery";

const page = (file: string) => fileURLToPath(new URL(file, import.meta.url));

const prependProfilingBuild = {
  name: "prepend-profiling-build",
  resolveId(source: string) {
    return source === "prepend-react-dom-client" ? "\0prepend-react-dom-client" : null;
  },
  load(id: string) {
    return id === "\0prepend-react-dom-client" ? 'export * from "react-dom/profiling";' : null;
  },
  transform(source: string, id: string) {
    if (id.endsWith("/src/prepend-main.tsx")) return { code: source.replace('"react-dom/client"', '"prepend-react-dom-client"'), map: null };
    return null;
  },
};

export default defineConfig({
  plugins: [zetaDiscoveryPlugin(), prependProfilingBuild],
  server: { cors: false },
  build: { manifest: true, rolldownOptions: { input: { main: page("index.html"), gallery: page("gallery.html"), virtual: page("virtual.html"), highlight: page("highlight.html"), fold: page("fold.html"), prepend: page("prepend.html") } } },
});
