import type {NextConfig} from 'next';

const nextConfig: NextConfig = {
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'placehold.co',
        port: '',
        pathname: '/**',
      },
    ],
  },
async rewrites() {
    return [
      {
        source: "/__/auth/:path*",
        destination: `https://astute-helper-451908-q3.firebaseapp.com/__/auth/:path*`, // Replace with your actual authDomain
      },
    ];
  },




};

export default nextConfig;
