import path from "node:path";
import { cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const qmdExternalDependencies = [
  "@tobilu/qmd",
  "better-sqlite3",
  "sqlite-vec",
  "node-llama-cpp",
  /^@node-llama-cpp\/.*/,
];

export default defineConfig({
  main: {
    build: {
      outDir: "dist/main",
      rollupOptions: {
        input: {
          index: path.resolve(currentDirectory, "src/main/index.ts"),
          cli: path.resolve(currentDirectory, "../../packages/cli/src/index.ts"),
          "derived-index-worker": path.resolve(currentDirectory, "src/main/indexing/derived-index-worker.ts"),
        },
        external: qmdExternalDependencies,
        output: {
          entryFileNames: "[name].js",
        },
      },
    },
    plugins: [externalizeDepsPlugin({ exclude: ["@exograph/core"] }), {
      name: "publishing-resources",
      closeBundle: () => cp(path.join(currentDirectory, "resources/publishing"), path.join(currentDirectory, "dist/publishing"), { recursive: true }),
    }],
    resolve: {
      alias: {
        "@shared": path.resolve(currentDirectory, "src/shared"),
      },
    },
  },
  preload: {
    build: {
      outDir: "dist/preload",
      rollupOptions: {
        external: qmdExternalDependencies,
        output: {
          entryFileNames: "index.js",
          format: "cjs",
        },
      },
    },
    plugins: [externalizeDepsPlugin({ exclude: ["@exograph/core"] })],
    resolve: {
      alias: {
        "@shared": path.resolve(currentDirectory, "src/shared"),
      },
    },
  },
  renderer: {
    build: {
      outDir: "dist/renderer",
      rollupOptions: {
        input: {
          index: path.resolve(currentDirectory, "src/renderer/index.html"),
          browser: path.resolve(currentDirectory, "src/renderer/browser.html"),
          "gpu-probe": path.resolve(currentDirectory, "src/renderer/gpu-probe.html"),
        },
      },
    },
    plugins: [react()],
    resolve: {
      alias: {
        "@renderer": path.resolve(currentDirectory, "src/renderer/src"),
        "@shared": path.resolve(currentDirectory, "src/shared"),
      },
    },
  },
});
