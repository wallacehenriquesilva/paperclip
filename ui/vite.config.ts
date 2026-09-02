import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { compression } from "vite-plugin-compression2";
import { createUiDevWatchOptions } from "./src/lib/vite-watch";

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
    // Emit .gz/.br siblings for every asset so the server can serve
    // pre-compressed bytes (express-static-gzip) with zero runtime CPU.
    // The main bundle is ~4.3MB raw — ~1MB gzip / ~800KB brotli.
    compression({ algorithms: ["gzip", "brotliCompress"], threshold: 1024 }),
  ],
  build: {
    minify: "esbuild",
  },
  esbuild:
    mode === "production"
      ? {
          drop: ["console", "debugger"],
          legalComments: "none",
        }
      : undefined,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/Lexical.mjs"),
    },
  },
  server: {
    port: 5173,
    watch: createUiDevWatchOptions(process.cwd()),
    proxy: {
      "/api": {
        target: "http://localhost:3100",
        ws: true,
      },
    },
  },
}));
