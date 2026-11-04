/** Static export in production; includes COOP/COEP headers for multi-threaded WebAssembly (SharedArrayBuffer). */
const isProdBuild = process.env.NODE_ENV === "production";

const nextConfig = {
  ...(isProdBuild ? { output: "export" } : {}),
  images: { unoptimized: true },
  reactStrictMode: true,
  devIndicators: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
        ],
      },
    ];
  },
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "onnxruntime-node$": false,
      "sharp$": false,
    };
    return config;
  },
};
export default nextConfig;
