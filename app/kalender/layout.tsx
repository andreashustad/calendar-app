import type { Metadata } from "next";

// Ingen indeksering/analytics på verktøyruten
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  title: "Kalender (lokal free/busy)",
  description: "Client-only kombinert free/busy fra Google og Microsoft"
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
