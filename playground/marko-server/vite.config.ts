import marko from "@marko/vite";
import { defineConfig } from "vite";

export default defineConfig({
  appType: "custom",
  plugins: [marko()],
  server: {
    host: "127.0.0.1",
  },
});
