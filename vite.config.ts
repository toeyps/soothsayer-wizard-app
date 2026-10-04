import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  build: {
    rollupOptions: {
      output: {
        // Split the app's heaviest dependencies into their own vendor
        // chunks instead of one monolithic bundle.
        //
        // Function form (not the `{ chunk: [pkgs] }` object form), with React in its
        // own chunk: left to the default, Rollup put React (and the CJS interop helper)
        // INSIDE the echarts chunk because echarts-for-react imports it — so the main
        // window's entry statically imported, and index.html modulepreloaded, all 1.1 MB
        // of echarts even though echarts is only needed once a chart mounts.
        manualChunks(id: string) {
          if (id.includes("commonjsHelpers") || /node_modules[\/](react|react-dom|scheduler)[\/]/.test(id)) return "react";
          if (!id.includes("node_modules")) return undefined;
          if (/node_modules[\/](echarts|zrender|echarts-for-react)[\/]/.test(id)) return "echarts";
          if (/node_modules[\/]regl-scatterplot[\/]/.test(id)) return "regl-scatterplot";
          return undefined;
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching everything the app does not import.
      //    Vite full-reloads the page for a change to ANY watched file that is
      //    not in its module graph — verified 2026-10-04: even `touch CLAUDE.md`
      //    logs `page reload`, which throws away the Dashboard's React state and
      //    lands the user back on the Import page (there is no auto-resume). So
      //    editing docs, tests, scripts or the Rust/Python side while `tauri dev`
      //    has a workspace open must not touch the webview. (`src-tauri` is also
      //    watched by the Tauri CLI itself, which rebuilds/restarts on Rust edits.)
      ignored: [
        "**/src-tauri/**",
        "**/docs/**",
        "**/scripts/**",
        "**/.claude/**",
        "**/src/__tests__/**",
        "**/*.md",
        "**/*.py",
        "**/dist/**",
        "**/coverage/**",
      ],
    },
  },
}));
