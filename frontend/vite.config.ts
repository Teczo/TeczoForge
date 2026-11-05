import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  // Read frontend/.env. The default matches .env.example.
  const env = loadEnv(mode, ".", "");
  const backendUrl = env.BACKEND_URL || "http://127.0.0.1:4000";

  return {
    plugins: [react(), tailwindcss()],
    server: {
      // Open on this PC only, until ticket FRG-15.
      host: "127.0.0.1",
      // 5180, not 5173: AquaTwin uses 5173 on this PC.
      port: 5180,
      // Stop with an error if 5180 is busy. Do not move to another port.
      strictPort: true,
      // Send every /api request to the backend.
      proxy: {
        "/api": backendUrl,
      },
    },
  };
});
