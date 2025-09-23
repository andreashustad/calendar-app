"use client";
import dynamic from "next/dynamic";

// Dynamisk import fordi komponenten bruker window/APIs
const CalendarOverlayApp = dynamic(() => import("../../components/CalendarOverlayApp"), { ssr: false });

export default function Page() {
  return (
    <main className="min-h-screen bg-gray-50">
      <CalendarOverlayApp />
    </main>
  );
}
