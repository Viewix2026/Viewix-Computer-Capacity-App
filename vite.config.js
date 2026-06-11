import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'

// Build identifier for the stale-bundle detector (src/lib/
// useStaleBundleReload.js). Vercel exposes the deploy's commit as
// VERCEL_GIT_COMMIT_SHA; local builds fall back to git directly. The
// id is (a) baked into the bundle via `define` and (b) emitted as
// dist/version.json by the plugin below — the running app polls the
// JSON and reloads when the two stop matching. Only equality matters,
// so the local-vs-Vercel sha source never needs to agree across
// environments, just within one build.
function resolveBuildId() {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 12);
  try { return execSync('git rev-parse --short=12 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return 'dev'; }
}
const BUILD_ID = resolveBuildId();

// Chunk strategy:
//   - react vendor (split out so cache survives our app rebuilds)
//   - dnd-kit (only used inside Social Organic Select drag-and-drop)
//   - docx + file-saver (lazy-loaded by runsheetDocx.js — Vite will
//     emit them as their own dynamic chunk automatically because of
//     the await import() inside that file; we still want them grouped
//     into one chunk rather than two)
//   - everything else falls into the main app chunk
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'emit-version-json',
      apply: 'build',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ buildId: BUILD_ID }) });
      },
    },
  ],
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  // Honor the PORT env (preview/launch tooling assigns one). Falls
  // back to Vite's default 5173 for plain `npm run dev`. Only affects
  // the dev server — `vite build` (Vercel) ignores `server`.
  server: process.env.PORT ? { port: Number(process.env.PORT), strictPort: true } : undefined,
  build: {
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("react") || id.includes("scheduler")) return "react";
            if (id.includes("@dnd-kit")) return "dnd-kit";
            if (id.includes("docx") || id.includes("file-saver")) return "docx-export";
          }
        },
      },
    },
  },
})
