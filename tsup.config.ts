import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  splitting: false,
  sourcemap: false,
  clean: true,
  minify: true,
  dts: true, // Ensure TypeScript type definitions are generated
  outExtension({ format }) {
    return { js: format === "esm" ? ".mjs" : ".cjs" }; // Ensure correct file extensions
  },
});
