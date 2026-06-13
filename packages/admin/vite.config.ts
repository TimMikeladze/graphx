import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
// The graphx Hono process the dev server proxies API calls to (override with VITE_API_TARGET).
const API_TARGET = process.env.VITE_API_TARGET ?? "http://localhost:8787"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    // Proxy both API realms to the Hono server so there is no CORS in dev (spec §3).
    proxy: {
      "/t": { target: API_TARGET, changeOrigin: true },
      "/admin": { target: API_TARGET, changeOrigin: true },
    },
  },
})
