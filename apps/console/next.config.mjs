/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["pg", "luxon"],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
