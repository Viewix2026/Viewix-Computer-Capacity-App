import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Chunk strategy:
//   - react vendor (split out so cache survives our app rebuilds)
//   - dnd-kit (only used inside Social Organic Select drag-and-drop)
//   - docx + file-saver (lazy-loaded by runsheetDocx.js — Vite will
//     emit them as their own dynamic chunk automatically because of
//     the await import() inside that file; we still want them grouped
//     into one chunk rather than two)
//   - everything else falls into the main app chunk
export default defineConfig({
  plugins: [react()],
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
