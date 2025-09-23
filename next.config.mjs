/** @type {import('next').NextConfig} */
const nextConfig = {
  // Viktig: ingen server-side proxies, kun statiske headers.
  async headers() {
    // Stramme sikkerhets-/privacy-headers for /kalender-ruten:
    const csp = [
      "default-src 'self'",
      // NB: Next.js injiserer noe inline-script. Start med 'unsafe-inline' for stabilitet,
      // fjern hvis du verifiserer at det fungerer uten i din versjon.
      "script-src 'self' https://accounts.google.com 'unsafe-inline'",
      "connect-src 'self' https://www.googleapis.com https://graph.microsoft.com https://login.microsoftonline.com https://accounts.google.com",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "frame-src https://accounts.google.com https://login.microsoftonline.com",
      "base-uri 'none'; form-action 'none'"
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
        // Gjelder kun kalender-ruten (isolert fra resten av siden)
        source: "/kalender",
        headers: [
          ...common,
          // HTML bør ikke caches
          { key: "Cache-Control", value: "no-store" },
          // HSTS bør helst settes på apex-domene i prod. Legges her for testdomene.
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }
        ]
      },
      {
        // Statiske assets under /kalender
        source: "/kalender/:path*",
        headers: common
      }
    ];
  }
};

export default nextConfig;
