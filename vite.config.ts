import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.VITE_API_URL;

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: apiTarget
      ? {
          "/api": {
            target: apiTarget,
            changeOrigin: true
          }
        }
      : undefined
  }
});
