import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the SleizDev project root directory so Turbopack doesn't get
// confused by stray lockfiles in parent directories (e.g. a stray
// `package-lock.json` in `C:\Users\<user>\Downloads\`). Without this,
// Next.js 16 prints:
//   ⚠ Warning: Next.js inferred your workspace root, but it may not be correct.
//   We detected multiple lockfiles and selected the directory of ... as the root.
// Setting `turbopack.root` to this directory silences the warning AND ensures
// Turbopack's file watcher only watches the project tree (faster HMR).
const projectRoot =
  typeof __dirname !== "undefined"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Tell Turbopack exactly where the project root is, so it stops scanning
  // parent directories for lockfiles and silences the multiple-lockfiles
  // warning. This is the official fix per Next.js docs:
  // https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack#root-directory
  turbopack: {
    root: projectRoot,
  },
  allowedDevOrigins: [
    "*.space-z.ai",
    "*.chatglm.cn",
    "localhost",
    "127.0.0.1",
  ],
};

export default nextConfig;
