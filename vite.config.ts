import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "/renderdoc-scene-fixer/",
  build: {
    target: "es2020",
  },
  plugins: [
    tailwindcss(),
  ],
});

