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
        // React gets its own chunk: by default Rollup put it inside the echarts chunk, so the main entry preloaded all of echarts.
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

  // Tauri dev: don't clear the screen, so Rust errors stay visible.
  clearScreen: false,
  // Tauri expects a fixed port; fail if it is not available.
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
      // Ignore files the app doesn't import: Vite full-reloads on any watched file outside its module graph, losing Dashboard state.
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
