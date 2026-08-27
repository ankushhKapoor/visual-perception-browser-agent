import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./extensions/manifest.json" with { type: "json" };

export default defineConfig({
  plugins: [
    crx({
      manifest,
      contentScripts: {
        standaloneFiles: ["extensions/src/content.js"]
      }
    })
  ]
});