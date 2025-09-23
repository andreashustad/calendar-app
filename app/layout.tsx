import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Calendar Overlay",
  description: "Lokal free/busy - Google + Microsoft",
  viewport: "width=device-width, initial-scale=1"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="no">
      <body>{children}</body>
    </html>
  );
}
