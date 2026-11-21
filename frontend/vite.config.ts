import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The dev server forwards API, WebSocket and stand-in WhatsApp traffic to the backend,
// so the browser only ever talks to one origin.
const backend = process.env.BACKEND_URL ?? 'http://localhost:4000'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': backend,
      '/mock-whatsapp': backend,
      '/socket.io': { target: backend, ws: true },
    },
  },
})
