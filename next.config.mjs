/** @type {import('next').NextConfig} */
const isProd = process.env.NODE_ENV === "production";

const nextConfig = {
  // Add a simple redirect so hitting "/" works during dev/prod
  async redirects() {
    return [
      { source: "/", destination: "/kalender", permanent: false }
    ];
  },

  async headers() {
    // In development, DO NOT set CSP/strict headers.
    // Next's dev runtime and HMR often require eval/ws and will white-screen if blocked.
    if (!isProd) {
      return [];
    }

    // ---- Production-only security/privacy headers for /kalender ----
    // Keep this tight. We intentionally avoid 'unsafe-eval' in prod.
    const csp = [
      "default-src 'self'",
      // Keep 'unsafe-inline' only if your current Next build requires it.
      // Try removing it once everything is stable.
      "script-src 'self' https://accounts.google.com 'unsafe-inline'",
      "connect-src 'self' https://www.googleapis.com https://graph.microsoft.com https://login.microsoftonline.com https://accounts.google.com https://oauth2.googleapis.com",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "frame-src https://accounts.google.com https://login.microsoftonline.com",
      "base-uri 'none'",
      "form-action 'none'"
    ].join("; ");

    const common = [
      { key: "Content-Security-Policy", value: csp },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "Permissions-Policy", value: "geolocation=(), microphone=(), camera=(), clipboard-write=()" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      { key: "Cross-Origin-Resource-Policy", value: "same-site" }
    ];

    return [
      {
        // HTML entry for the /kalender route
        source: "/kalender",
        headers: [
          ...common,
          { key: "Cache-Control", value: "no-store" },
          // Prefer setting HSTS at apex in your real prod setup.
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }
        ]
      },
      {
        // Static assets under /kalender
        source: "/kalender/:path*",
        headers: common
      }
    ];
  }
};

export default nextConfig;
