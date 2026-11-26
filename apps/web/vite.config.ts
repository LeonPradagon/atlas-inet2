import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  return {
    plugins: [react()],
    optimizeDeps: {
      exclude: ["@paddleocr/paddleocr-js"],
      // PaddleOCR must retain its worker URL; its CommonJS dependencies need interop.
      include: ["clipper-lib", "@techstark/opencv-js", "js-yaml"],
    },
    server: {
      host: "0.0.0.0",
      port: 5176,
      proxy: {
        "/api": {
          target: env.API_PROXY_TARGET || "http://127.0.0.1:3000",
          changeOrigin: true,
        },
      },
    },
  };
});
