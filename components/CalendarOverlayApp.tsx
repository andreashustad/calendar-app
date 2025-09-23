"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { PublicClientApplication, type AccountInfo } from "@azure/msal-browser";
import { backoff } from "../lib/backoff";
import { localTZ, isoDate, dayBoundsISO } from "../lib/dates";
import { Interval, invertBusyToFree, mergeIntervals } from "../lib/freebusy";

/**
 * ROBUST, CLIENT-ONLY KALENDEROVERLAY
 * - Default: Free/Busy (ingen titler)
 * - Opt-in: Detaljer (begrensede felt)
 * - Tokens: MSAL i sessionStorage, Google token kun i minne
 * - Panic: Revoke + clear + reload
 * - Auto-timeout: 45 min inaktivitet
 */

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID!;
const MSAL_CLIENT_ID = process.env.NEXT_PUBLIC_MSAL_CLIENT_ID!;
const MSAL_TENANT = process.env.NEXT_PUBLIC_MSAL_TENANT || "common";

const MSAL_SCOPES = ["Calendars.Read"]; // kun lesing
const GOOGLE_SCOPES = "https://www.googleapis.com/auth/calendar.readonly"; // kun lesing

type Source = "google" | "microsoft";
type BusyBlock = Interval & { source: Source };

// Minimal event-type når detaljer-modus er slått på
type EventItem = {
  source: Source;
  start: Date;
  end: Date;
  title?: string;
  location?: string;
  isPrivate?: boolean;
};

export default function CalendarOverlayApp() {
  // UI state
  const [date, setDate] = useState(isoDate(new Date()));
  const [workStart, setWorkStart] = useState(8);
  const [workEnd, setWorkEnd] = useState(17);
  const [minSlot, setMinSlot] = useState(30);
  const [detailsMode, setDetailsMode] = useState(false); // default free/busy

  // Auth state
  const tz = useMemo(localTZ, []);
  const [msalApp, setMsalApp] = useState<PublicClientApplication | null>(null);
  const [msAccount, setMsAccount] = useState<AccountInfo | null>(null);
  const googleTokenRef = useRef<string | null>(null);
  const [googleReady, setGoogleReady] = useState(false);

  // Data
  const [busy, setBusy] = useState<BusyBlock[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Inaktivitet -> auto-logout etter 45 min
  useEffect(() => {
    let timer: any;
    const reset = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => panic(), 45 * 60 * 1000);
    };
    ["mousemove", "keydown", "click", "visibilitychange"].forEach(ev => window.addEventListener(ev, reset));
    reset();
    return () => {
      ["mousemove", "keydown", "click", "visibilitychange"].forEach(ev => window.removeEventListener(ev, reset));
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Last MSAL fra pakke (self-host) og Google GSI (må fra accounts.google.com)
  useEffect(() => {
  // MSAL v3: you MUST call initialize() before any other MSAL API.
  const app = new PublicClientApplication({
    auth: {
      clientId: MSAL_CLIENT_ID,
      authority: `https://login.microsoftonline.com/${MSAL_TENANT}`
    },
    cache: { cacheLocation: "sessionStorage", storeAuthStateInCookie: false },
    system: { loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} } }
  });

  (async () => {
    await app.initialize();                 // ✅ required
    setMsalApp(app);

    // If a session already exists this tab, restore it
    const existing = app.getActiveAccount() || app.getAllAccounts()[0] || null;
    if (existing) {
      app.setActiveAccount(existing);
      setMsAccount(existing);
    }
  })();

  // Google GSI script (must load from accounts.google.com)
  const script = document.createElement("script");
  script.src = "https://accounts.google.com/gsi/client";
  script.async = true;
  script.onload = () => setGoogleReady(true);
  script.onerror = () => console.error("Failed to load Google GSI");
  document.head.appendChild(script);

  return () => {
    document.head.removeChild(script);
  };
}, []);


  // MS sign-in
  async function connectMicrosoft() {
  if (!msalApp) return;
  setErr(null);
  try {
    // Idempotent; safe to call even if already initialized
    await msalApp.initialize();

    const res = await msalApp.loginPopup({ scopes: MSAL_SCOPES });
    if (res.account) {
      msalApp.setActiveAccount(res.account);
      setMsAccount(res.account);
    }
  } catch (e: any) {
    setErr(`MSAL login failed: ${e?.errorMessage || e?.message || String(e)}`);
  }
}


  // Google sign-in (access token i minne)
  async function connectGoogle() {
    if (!googleReady) return;
    setErr(null);
    try {
      const tokenClient = (window as any).google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: GOOGLE_SCOPES,
        prompt: "consent",
        callback: (resp: any) => {
          if (resp?.access_token) googleTokenRef.current = resp.access_token;
        }
      });
      tokenClient.requestAccessToken();
    } catch (e: any) {
      setErr(`Google token feilet: ${e?.message ?? e}`);
    }
  }

  // Panic: revoke + clear + refresh
  async function panic() {
    try {
      // MSAL
      if (msalApp) {
        try { await msalApp.logoutPopup(); } catch {}
      }
      sessionStorage.clear();
      setMsAccount(null);
      // Google revoke
      if (googleTokenRef.current) {
        try {
          await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(googleTokenRef.current)}`, { method: "POST" });
        } catch {}
      }
      googleTokenRef.current = null;
    } finally {
      window.location.reload();
    }
  }

  // Token for Graph
async function getMsToken(): Promise<string | null> {
  if (!msalApp) return null;
  await msalApp.initialize(); // safe if already initialized

  // Use active account or restore first available
  let account = msalApp.getActiveAccount();
  if (!account) {
    const all = msalApp.getAllAccounts();
    if (all.length) {
      account = all[0];
      msalApp.setActiveAccount(account);
      setMsAccount(account);
    }
  }
  if (!account) return null;

  try {
    const res = await msalApp.acquireTokenSilent({ scopes: MSAL_SCOPES, account });
    return res.accessToken;
  } catch {
    const res = await msalApp.acquireTokenPopup({ scopes: MSAL_SCOPES });
    return res.accessToken;
  }
}


  // Free/Busy fetchers (default)
  async function fetchGraphFreeBusy(day: string): Promise<Interval[]> {
  const token = await getMsToken();
  if (!token) return [];
  const { startISO, endISO } = dayBoundsISO(day);

  let url = "https://graph.microsoft.com/v1.0/me/calendarView"
    + `?startDateTime=${encodeURIComponent(startISO)}`
    + `&endDateTime=${encodeURIComponent(endISO)}`
    + `&$select=start,end,showAs,sensitivity`
    + `&$orderby=start/dateTime`;

  const blocks: Interval[] = [];
  while (url) {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Prefer: `outlook.timezone="${tz}"` }
    });
    if (resp.status === 429 || resp.status === 503) { await backoff(resp); continue; }
    if (!resp.ok) throw new Error(`Graph calendarView: ${resp.status}`);
    const data = await resp.json();
    for (const e of (data.value || [])) {
      // Treat anything except explicit "free" as busy (busy | tentative | oof | workingElsewhere | unknown)
      const showAs = (e.showAs || "").toLowerCase();
      if (showAs !== "free") {
        const start = e.start?.dateTime ? new Date(e.start.dateTime) : new Date(e.start);
        const end   = e.end?.dateTime   ? new Date(e.end.dateTime)   : new Date(e.end);
        if (end > start) blocks.push({ start, end });
      }
    }
    url = data["@odata.nextLink"] || null;
  }
  return blocks;
}


  async function fetchGoogleFreeBusy(day: string): Promise<Interval[]> {
    if (!googleTokenRef.current) return [];
    const { startISO, endISO } = dayBoundsISO(day);
    const payload = {
      timeMin: startISO,
      timeMax: endISO,
      timeZone: tz,
      items: [{ id: "primary" }]
    };

    while (true) {
      const resp = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${googleTokenRef.current}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      if (resp.status === 429 || resp.status === 503) { await backoff(resp); continue; }
      if (!resp.ok) throw new Error(`Google freeBusy: ${resp.status}`);
      const data = await resp.json();
      const cal = data.calendars?.primary;
      const busy = (cal?.busy || []) as { start: string; end: string }[];
      return busy.map(b => ({ start: new Date(b.start), end: new Date(b.end) })).filter(i => i.end > i.start);
    }
  }

  // Detaljer (opt-in)
  async function fetchGraphDetails(day: string): Promise<EventItem[]> {
    const token = await getMsToken();
    if (!token) return [];
    const { startISO, endISO } = dayBoundsISO(day);
    let url = "https://graph.microsoft.com/v1.0/me/calendarView"
      + `?startDateTime=${encodeURIComponent(startISO)}`
      + `&endDateTime=${encodeURIComponent(endISO)}`
      + `&$select=start,end,sensitivity,showAs,location,subject`
      + `&$orderby=start/dateTime`;

    const items: EventItem[] = [];
    while (url) {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Prefer: `outlook.timezone="${tz}"` }
      });
      if (resp.status === 429 || resp.status === 503) { await backoff(resp); continue; }
      if (!resp.ok) throw new Error(`Graph details: ${resp.status}`);
      const data = await resp.json();
      for (const e of (data.value || [])) {
        const isPriv = e.sensitivity === "private";
        items.push({
          source: "microsoft",
          start: new Date(e.start?.dateTime || e.start),
          end: new Date(e.end?.dateTime || e.end),
          title: isPriv ? "(Privat)" : (e.subject || "(uten tittel)"),
          location: e.location?.displayName,
          isPrivate: isPriv
        });
      }
      url = data["@odata.nextLink"] || null;
    }
    return items.filter(x => x.end > x.start);
  }

  async function fetchGoogleDetails(day: string): Promise<EventItem[]> {
    if (!googleTokenRef.current) return [];
    const { startISO, endISO } = dayBoundsISO(day);
    let url = "https://www.googleapis.com/calendar/v3/calendars/primary/events"
      + `?singleEvents=true&orderBy=startTime`
      + `&timeMin=${encodeURIComponent(startISO)}`
      + `&timeMax=${encodeURIComponent(endISO)}`
      + `&timeZone=${encodeURIComponent(tz)}`
      + `&fields=items(start,end,visibility,transparency,location,summary),nextPageToken`;

    const items: EventItem[] = [];
    while (true) {
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${googleTokenRef.current}` } });
      if (resp.status === 429 || resp.status === 503) { await backoff(resp); continue; }
      if (!resp.ok) throw new Error(`Google details: ${resp.status}`);
      const data = await resp.json();
      for (const e of (data.items || [])) {
        const isPriv = e.visibility === "private";
        const start = e.start?.dateTime ? new Date(e.start.dateTime) : new Date(`${e.start?.date}T00:00:00`);
        const end = e.end?.dateTime ? new Date(e.end.dateTime) : new Date(`${e.end?.date}T23:59:59`);
        items.push({
          source: "google",
          start, end,
          title: isPriv ? "(Privat)" : (e.summary || "(uten tittel)"),
          location: e.location,
          isPrivate: isPriv
        });
      }
      if (!data.nextPageToken) break;
      url += `&pageToken=${data.nextPageToken}`;
    }
    return items.filter(x => x.end > x.start);
  }

  // Refresh data (free/busy + ev. detaljer)
  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      const tasks: Promise<any>[] = [];
      tasks.push(fetchGraphFreeBusy(date));
      tasks.push(fetchGoogleFreeBusy(date));
      const [msBusy, gBusy] = await Promise.all(tasks);
      const busyBlocks: BusyBlock[] = [
        ...msBusy.map((b: Interval): BusyBlock => ({ start: b.start, end: b.end, source: "microsoft" })),
        ...gBusy.map((b: Interval): BusyBlock => ({ start: b.start, end: b.end, source: "google" }))
      ];
      setBusy(busyBlocks);

      if (detailsMode) {
        const detTasks: Promise<any>[] = [];
        detTasks.push(fetchGraphDetails(date));
        detTasks.push(fetchGoogleDetails(date));
        const [msDet, gDet] = await Promise.all(detTasks);
        setEvents([...msDet, ...gDet].sort((a, b) => a.start.getTime() - b.start.getTime()));
      } else {
        setEvents([]);
      }
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Oppdater ved dato-/modusendring
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, detailsMode, msAccount, googleTokenRef.current]);

  // Avledet: free slots
  const freeSlots = useMemo(() => {
    const day = new Date(`${date}T00:00:00`);
    const merged = mergeIntervals(busy.map((b: BusyBlock) => ({ start: b.start, end: b.end })));
    return invertBusyToFree(merged, day, workStart, workEnd, minSlot);
  }, [busy, date, workStart, workEnd, minSlot]);

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Samlet kalender (lokal, free/busy som standard)</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={connectGoogle}
            className="px-3 py-2 rounded-lg border bg-white hover:bg-gray-50"
            title="Koble til Google (read-only)">
            {googleTokenRef.current ? "Google: tilkoblet" : "Koble til Google"}
          </button>
          <button
            onClick={connectMicrosoft}
            className="px-3 py-2 rounded-lg border bg-white hover:bg-gray-50"
            title="Koble til Microsoft (read-only)">
            {msAccount ? "Microsoft: tilkoblet" : "Koble til Microsoft"}
          </button>
          <button
            onClick={refresh}
            className="px-3 py-2 rounded-lg border bg-white hover:bg-gray-50">
            Oppdater
          </button>
          <button
            onClick={panic}
            className="px-3 py-2 rounded-lg border text-red-700 bg-red-50 hover:bg-red-100"
            title="Logg ut alle, opphev tokens og tøm alt">
            PANIC (tøm alt)
          </button>
        </div>
      </header>

      <section className="bg-white rounded-2xl shadow p-4 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm">Dato:
            <input type="date" value={date} onChange={e => setDate(e.target.value)} className="ml-2 border rounded px-2 py-1" />
          </label>
          <label className="text-sm">Arbeidstid:
            <input type="number" min={0} max={23} value={workStart} onChange={e => setWorkStart(parseInt(e.target.value || "8"))} className="ml-2 w-16 border rounded px-2 py-1" />
            <span className="mx-1">–</span>
            <input type="number" min={0} max={23} value={workEnd} onChange={e => setWorkEnd(parseInt(e.target.value || "17"))} className="w-16 border rounded px-2 py-1" />
          </label>
          <label className="text-sm">Min. hull (min):
            <input type="number" min={5} max={240} value={minSlot} onChange={e => setMinSlot(parseInt(e.target.value || "30"))} className="ml-2 w-20 border rounded px-2 py-1" />
          </label>
          <label className="text-sm inline-flex items-center gap-2">
            <input type="checkbox" checked={detailsMode} onChange={e => setDetailsMode(e.target.checked)} />
            Vis detaljer (opt‑in)
          </label>
        </div>

        {err && <p className="text-sm text-red-600">Feil: {err}</p>}
        {loading && <p className="text-sm text-gray-500">Laster …</p>}

        <div className="grid md:grid-cols-3 gap-4">
          <div className="md:col-span-2">
            <h2 className="font-medium mb-2">Ledige hull</h2>
            {freeSlots.length === 0 ? (
              <p className="text-sm text-gray-500">Ingen ledige hull innenfor arbeidstid.</p>
            ) : (
              <ul className="space-y-2">
                {freeSlots.map((s, i) => (
                  <li key={i} className="p-3 rounded-xl border bg-emerald-50">
                    <div className="text-sm">
                      {s.start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} – {s.end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </div>
                    <div className="text-xs text-gray-600">
                      {(s.end.getTime() - s.start.getTime()) / 60000} min
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <aside>
            <h2 className="font-medium mb-2">{detailsMode ? "Hendelser (begrensede felter)" : "Kilder"}</h2>
            {!detailsMode ? (
              <ul className="text-sm text-gray-700 space-y-1">
                <li>Google: free/busy</li>
                <li>Microsoft: getSchedule</li>
                <li>Tidssone: {tz}</li>
                <li>Ingen logger, ingen backend</li>
              </ul>
            ) : (
              <>
                {events.length === 0 ? (
                  <p className="text-sm text-gray-500">Ingen hendelser å vise, eller ikke tilkoblet.</p>
                ) : (
                  <ul className="space-y-2">
                    {events.map((e, i) => {
                      const range =
                        `${e.start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} – ${e.end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
                      return (
                        <li key={i} className="p-3 rounded-xl border bg-gray-50">
                          <div className="text-xs uppercase tracking-wide text-gray-500">
                            {e.source === "google" ? "Google" : "Microsoft"}
                          </div>
                          <div className="font-medium">{e.title ?? "(Privat)"}</div>
                          <div className="text-sm text-gray-600">
                            {range}{e.location ? ` · ${e.location}` : ""}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </aside>
        </div>

        <div className="text-xs text-gray-500 border-t pt-3">
          <p><strong>Personvern:</strong> Ingen hendelser sendes til andre enn Google/Microsoft. Ingen egen backend.</p>
          <p>Scopes: Google <code>calendar.readonly</code>, Microsoft <code>Calendars.Read</code>. Tokens i session/minne.</p>
        </div>
      </section>
    </div>
  );
}
