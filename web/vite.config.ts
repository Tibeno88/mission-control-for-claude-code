import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const API = "http://127.0.0.1:4517";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: API,
        // Le serveur refuse les mutations dont l'Origin n'est pas celle de son Host
        // (garde anti-CSRF, tasks/api.ts). La forme courte "/api": url vaut
        // changeOrigin:true : Host devient :4517 alors que l'Origin du navigateur
        // reste :5173 => 403. On garde le Host du navigateur, la garde reste stricte.
        changeOrigin: false,
      },
      "/ws": { target: "ws://127.0.0.1:4517", ws: true },
    },
  },
});
