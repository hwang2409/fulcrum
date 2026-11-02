import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const page = (file: string) => fileURLToPath(new URL(file, import.meta.url));

export default defineConfig({
  build: { rolldownOptions: { input: { main: page("index.html"), gallery: page("gallery.html") } } },
});
