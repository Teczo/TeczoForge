import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  // Read frontend/.env. The default matches .env.example.
  const env = loadEnv(mode, ".", "");
  const backendUrl = env.BACKEND_URL || "http://127.0.0.1:4000";

  return {
    plugins: [react()],
    server: {
      // Open on this PC only, until ticket FRG-15.
      host: "127.0.0.1",
      port: 5173,
      // Send every /api request to the backend.
      proxy: {
        "/api": backendUrl,
      },
    },
  };
});
