import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const fromDesktopRoot = (path: string) =>
  fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: fromDesktopRoot("./frontend"),
  base: "./",
  publicDir: false,
  build: {
    outDir: fromDesktopRoot("./frontend-dist"),
    emptyOutDir: true,
    target: "es2021",
  },
});
