import devServer from "@hono/vite-dev-server"
import path from "path"
import fs from "fs"
const __dirname = import.meta.dirname
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Local HTTPS cert (mkcert, gitignored under .certs/) - browser APIs like
// navigator.geolocation require a secure context, which plain http:// over
// the LAN doesn't qualify as. Falls back to http if the cert isn't there
// (e.g. a fresh checkout that hasn't run the mkcert setup yet).
const certDir = path.resolve(__dirname, ".certs")
const certFile = path.join(certDir, "cert.pem")
const keyFile = path.join(certDir, "key.pem")
const https = fs.existsSync(certFile) && fs.existsSync(keyFile)
  ? { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }
  : undefined

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    devServer({ entry: "api/boot.ts", exclude: [/^\/(?!api\/|uploads\/).*$/] }),
    react(),
  ],
  server: {
    port: 3000,
    host: true, // listen on 0.0.0.0 — reachable from LAN (phone on same wifi)
    https,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@contracts": path.resolve(__dirname, "./contracts"),
      "@db": path.resolve(__dirname, "./db"),
      "db": path.resolve(__dirname, "./db"),
    },
  },
  envDir: path.resolve(__dirname),
  build: {
    outDir: path.resolve(__dirname, "dist/public"),
    emptyOutDir: true,
    // two front ends on one API: the Workbench (/) and the phone-first Flow (/flow/)
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        flow: path.resolve(__dirname, "flow/index.html"),
      },
    },
  },
});
