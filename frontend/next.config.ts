import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // SDK (../sdk) monorepo içinde yerel paket; Turbopack'in dışarıdaki dosyaları çözebilmesi için kök.
  transpilePackages: ["darkpool-sdk"],
  turbopack: { root: path.join(__dirname, "..") },
};

export default nextConfig;
