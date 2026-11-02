import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { zetaDiscoveryPlugin } from "./src/zeta-helper.ts";

const page = (file: string) => fileURLToPath(new URL(file, import.meta.url));

export default defineConfig({
  plugins: [zetaDiscoveryPlugin()],
  server: { cors: false },
  build: { rolldownOptions: { input: { main: page("index.html"), gallery: page("gallery.html"), virtual: page("virtual.html") } } },
});
