import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Calendar Overlay",
  description: "Local free/busy - Google + Microsoft",
  manifest: "/manifest.webmanifest" // optional but recommended
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1
};

export default function RootLayout({ children }: { children: React.ReactNode }) { /* ... */ }
