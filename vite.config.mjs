import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./extensions/manifest.json" with { type: "json" };
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Manifest V3 blocks remotely hosted executable code. MediaPipe's JS/WASM
// loader is therefore copied into the extension package and loaded from
// chrome-extension://.../assets/mediapipe-wasm/ at runtime.
function bundleMediaPipeAssets() {
  return {
    name: "bundle-mediapipe-assets",
    closeBundle() {
      const wasmOutput = resolve("dist/assets/mediapipe-wasm");
      const modelOutput = resolve("dist/assets/models");
      mkdirSync(wasmOutput, { recursive: true });
      mkdirSync(modelOutput, { recursive: true });
      mkdirSync(resolve("dist/assets/tesseract"), { recursive: true });
      cpSync(resolve("node_modules/@mediapipe/tasks-vision/wasm"), wasmOutput, { recursive: true });
      // MediaPipe loads its WASM wrappers as classic scripts. Publish the
      // factory from those classic wrappers explicitly: using its ES-module
      // wrapper here would cause "import.meta outside a module".
      for (const filename of ["vision_wasm_internal.js", "vision_wasm_nosimd_internal.js"]) {
        const outputFile = resolve("dist/assets/mediapipe-wasm", filename);
        writeFileSync(
          outputFile,
          `${readFileSync(outputFile, "utf8")}\n;globalThis.ModuleFactory = ModuleFactory;\n`
        );
      }
      // MediaPipe 1.0.1's ES-module wrapper asks for a "_raw_" WASM name,
      // although the npm package ships it as "_module_". Point the bundled
      // wrapper at the actual local file so Chrome receives WASM, not a 404
      // HTML response that causes WebAssembly.instantiate() to fail.
      const moduleWrapper = resolve("dist/assets/mediapipe-wasm/vision_wasm_module_internal.js");
      writeFileSync(
        moduleWrapper,
        readFileSync(moduleWrapper, "utf8")
          .replaceAll(
            "vision_wasm_module_raw_internal.wasm",
            "vision_wasm_module_internal.wasm"
          )
          // These are expected TensorFlow Lite / XNNPACK diagnostics, such as
          // the delegate selected or unsupported optional feedback tensors.
          // Keep actual extension errors intact; only stop native log spam.
          .replace(
            "globalThis.custom_dbg = console.warn.bind(console);",
            "globalThis.custom_dbg = () => {};"
          )
      );
      cpSync(
        resolve("extensions/assets/face_landmarker.task"),
        resolve("dist/assets/models/face_landmarker.task")
      );
      cpSync(
        resolve("extensions/assets/blaze_face_short_range.tflite"),
        resolve("dist/assets/models/blaze_face_short_range.tflite")
      );
      cpSync(resolve("node_modules/tesseract.js/dist/worker.min.js"), resolve("dist/assets/tesseract/worker.min.js"));
      cpSync(resolve("node_modules/tesseract.js-core"), resolve("dist/assets/tesseract/core"), { recursive: true });
      cpSync(resolve("extensions/assets/tessdata-best"), resolve("dist/assets/tessdata-best"), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [
    crx({
      manifest,
      contentScripts: {
        standaloneFiles: [
          "extensions/src/content.js",
          "extensions/src/chatbot.js"
        ]
      }
    }),
    // Run after CRX writes the extension so it cannot overwrite the corrected
    // MediaPipe classic wrappers.
    bundleMediaPipeAssets(),
  ]
});
