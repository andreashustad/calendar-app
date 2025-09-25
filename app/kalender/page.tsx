"use client";
import dynamic from "next/dynamic";

// Dynamisk import fordi komponenten bruker window/APIs
const CalendarOverlayApp = dynamic(() => import("../../components/CalendarOverlayApp"), { ssr: false });

export default function Page() {
  return (
    <main className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100 transition-colors">
      <CalendarOverlayApp />
    </main>
  );
}
