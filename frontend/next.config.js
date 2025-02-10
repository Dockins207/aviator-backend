/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_BACKEND_URL: 'http://192.168.0.12:8000',
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://192.168.0.12:8000/api/:path*'
      }
    ];
  },
  // Optional: CORS configuration if needed
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          { key: 'Access-Control-Allow-Credentials', value: 'true' },
          { key: 'Access-Control-Allow-Origin', value: 'http://192.168.0.10:3000' },
          { key: 'Access-Control-Allow-Methods', value: 'GET,OPTIONS,PATCH,DELETE,POST,PUT' },
          { key: 'Access-Control-Allow-Headers', value: 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version' },
        ]
      }
    ];
  }
};

module.exports = nextConfig;
