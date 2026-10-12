import type { NextConfig } from 'next';
import { securityHeaders } from './src/server/security-headers';

const isDev = process.env.NODE_ENV !== 'production';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders(isDev) }];
  },
};

export default nextConfig;
