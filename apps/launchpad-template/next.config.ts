import type { NextConfig } from 'next';
import { securityHeaders } from './src/forge/security-headers';

const isDev = process.env.NODE_ENV !== 'production';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: {
    // Linting runs through `pnpm lint` (root flat config), not through `next build`.
    ignoreDuringBuilds: true,
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders(isDev) }];
  },
};

export default nextConfig;
