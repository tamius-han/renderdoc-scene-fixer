import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "./",
  build: {
    target: "es2020",
  },
  plugins: [
    tailwindcss(),
  ],
});

