import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// By default the frontend proxies /api to the local dev API (npm run dev:api).
// Set VITE_API_URL to point at a deployed stack instead:
//   $env:VITE_API_URL="https://YOUR_API_ID.execute-api.us-east-2.amazonaws.com"
const apiTarget = process.env.VITE_API_URL ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true
      }
    }
  }
});
