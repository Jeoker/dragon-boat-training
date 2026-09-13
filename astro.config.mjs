import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: "https://jeoker.github.io",
  base: "/dragon-boat-training",
  output: "static",
  vite: {
    plugins: [tailwindcss()],
  },
});
