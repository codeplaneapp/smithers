import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const ptyTarget = process.env.PTY_SERVER_URL || "http://127.0.0.1:7342";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5190,
    proxy: {
      "/terminal/ws": {
        target: ptyTarget,
        ws: true,
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4190,
  },
});
