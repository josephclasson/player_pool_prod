/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async redirects() {
    return [
      { source: "/more", destination: "/", permanent: false },
      { source: "/scores", destination: "/", permanent: false },
      { source: "/my-team", destination: "/", permanent: false },
      { source: "/bracket", destination: "/", permanent: false },
      { source: "/rules", destination: "/", permanent: false },
      { source: "/exports", destination: "/", permanent: false },
      { source: "/test-mode", destination: "/", permanent: false }
    ];
  }
};

export default nextConfig;
