import { defineConfig } from "vite";
import { zetaDiscoveryPlugin } from "./src/zeta-helper.ts";

export default defineConfig({ plugins: [zetaDiscoveryPlugin()] });
