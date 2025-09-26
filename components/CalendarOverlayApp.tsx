"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PublicClientApplication, type AccountInfo } from "@azure/msal-browser";
import { backoff } from "../lib/backoff";
import { localTZ, isoDate, dayBoundsISO, weekBoundsISO, getISOWeek } from "../lib/dates";
import { Interval, invertBusyToFree, mergeIntervals } from "../lib/freebusy";
import { Sun, Moon } from "./Icons"; 

/**
 * ROBUST, CLIENT-ONLY CALENDAR OVERLAY
 * - Default: Free/Busy only (no titles)
 * - Opt-in: Limited details
 * - Tokens: MSAL in sessionStorage, Google token in memory only
 * - Panic: Revoke + clear + reload
 * - Auto-timeout: 45 min inactivity
 */

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID!;
const MSAL_CLIENT_ID = process.env.NEXT_PUBLIC_MSAL_CLIENT_ID!;
const MSAL_TENANT = process.env.NEXT_PUBLIC_MSAL_TENANT || "common";

const MSAL_SCOPES = ["Calendars.Read"]; // read-only
const GOOGLE_SCOPES = "https://www.googleapis.com/auth/calendar.readonly"; // read-only

type Source = "google" | "microsoft";
type BusyBlock = Interval & { source: Source };

// Minimal event type when details mode is ON
type EventItem = {
  source: Source;
  start: Date;
  end: Date;
  title?: string;
  location?: string;
  isPrivate?: boolean;
};

const DAY_INDICES = [0, 1, 2, 3, 4, 5, 6] as const;
type DayIndex = (typeof DAY_INDICES)[number];

type WorkHours = { start: number; end: number };
type WorkHoursMap = Record<DayIndex, WorkHours>;

const DEFAULT_WORK_HOURS_TEMPLATE: WorkHoursMap = {
  0: { start: 0, end: 0 },
  1: { start: 8, end: 17 },
  2: { start: 8, end: 17 },
  3: { start: 8, end: 17 },
  4: { start: 8, end: 17 },
  5: { start: 8, end: 17 },
  6: { start: 0, end: 0 },
};

const DAY_ORDER: DayIndex[] = [1, 2, 3, 4, 5, 6, 0];
const DAY_LABELS: Record<DayIndex, string> = {
  0: "Søndag",
  1: "Mandag",
  2: "Tirsdag",
  3: "Onsdag",
  4: "Torsdag",
  5: "Fredag",
  6: "Lørdag",
};

const SAVED_VIEWS_STORAGE_KEY = "calendar_saved_views";
const CUSTOM_HOURS_STORAGE_KEY = "calendar_custom_work_hours";
const CUSTOM_HOURS_MODE_STORAGE_KEY = "calendar_use_custom_work_hours";

type SavedView = {
  id: string;
  name: string;
  date: string;
  view: "day" | "week";
  detailsMode: boolean;
  minSlot: number;
  workStart: number;
  workEnd: number;
  useCustomWorkHours: boolean;
  customWorkHours: WorkHoursMap;
};

function clampHour(value: number): number {
  return Math.max(0, Math.min(23, Math.round(value)));
}

function createDefaultCustomWorkHours(): WorkHoursMap {
  const result = {} as WorkHoursMap;
  DAY_INDICES.forEach((day) => {
    const template = DEFAULT_WORK_HOURS_TEMPLATE[day];
    result[day] = { start: template.start, end: template.end };
  });
  return result;
}

function normalizeWorkHours(source?: any): WorkHoursMap {
  const normalized = createDefaultCustomWorkHours();
  if (!source) return normalized;
  DAY_INDICES.forEach((day) => {
    const candidate = source?.[day] ?? source?.[String(day)];
    if (!candidate) return;
    const startNumber = Number((candidate as any).start);
    const endNumber = Number((candidate as any).end);
    const start = Number.isFinite(startNumber) ? clampHour(startNumber) : normalized[day].start;
    const endRaw = Number.isFinite(endNumber) ? clampHour(endNumber) : normalized[day].end;
    normalized[day] = { start, end: endRaw < start ? start : endRaw };
  });
  return normalized;
}

function createUniformWorkHours(start: number, end: number): WorkHoursMap {
  const uniform = createDefaultCustomWorkHours();
  const s = clampHour(start);
  const eRaw = clampHour(end);
  const e = eRaw < s ? s : eRaw;
  DAY_INDICES.forEach((day) => {
    uniform[day] = { start: s, end: e };
  });
  return uniform;
}

function cloneWorkHours(hours: WorkHoursMap): WorkHoursMap {
  const clone = createDefaultCustomWorkHours();
  DAY_INDICES.forEach((day) => {
    const source = hours[day];
    clone[day] = { start: source.start, end: source.end };
  });
  return clone;
}


export default function CalendarOverlayApp() {
  // UI state
  const [date, setDate] = useState(isoDate(new Date()));
  const [workStart, setWorkStart] = useState(8);
  const [workEnd, setWorkEnd] = useState(17);
  const [minSlot, setMinSlot] = useState(30);
  const [detailsMode, setDetailsMode] = useState(false); // default: free/busy only
  const [view, setView] = useState<"day" | "week">("day");
  const [theme, setTheme] = useState("light");
  const [displayTimezone, setDisplayTimezone] = useState<string>("");
  const [timezones, setTimezones] = useState<string[]>([]);
  const [sourceColors, setSourceColors] = useState<Record<Source, string>>({
    google: "#0ea5e9",
    microsoft: "#6366f1",
  });
  const [showTimezoneHelper, setShowTimezoneHelper] = useState(false);
    const [useCustomWorkHours, setUseCustomWorkHours] = useState(false);
  const [customWorkHours, setCustomWorkHours] = useState<WorkHoursMap>(() =>
    createDefaultCustomWorkHours()
  );
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [selectedViewId, setSelectedViewId] = useState<string | null>(null);
  const [newViewName, setNewViewName] = useState("");

  const weekNumber = useMemo(() => getISOWeek(new Date(date)), [date]);

  // Auth state
  const tz = useMemo(localTZ, []);
  const [msalApp, setMsalApp] = useState<PublicClientApplication | null>(null);
  const [msAccount, setMsAccount] = useState<AccountInfo | null>(null);

  // Google token + client
  const googleTokenRef = useRef<string | null>(null);
  const googleTokenClientRef = useRef<any>(null);
  const [googleReady, setGoogleReady] = useState(false);
  const [googleConnected, setGoogleConnected] = useState(false);

  // Data
  const [busy, setBusy] = useState<BusyBlock[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

    useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const storedHours = localStorage.getItem(CUSTOM_HOURS_STORAGE_KEY);
      if (storedHours) {
        setCustomWorkHours(normalizeWorkHours(JSON.parse(storedHours)));
      }

      const storedMode = localStorage.getItem(CUSTOM_HOURS_MODE_STORAGE_KEY);
      if (storedMode) {
        setUseCustomWorkHours(storedMode === "true");
      }

      const storedViews = localStorage.getItem(SAVED_VIEWS_STORAGE_KEY);
      if (storedViews) {
        const parsed = JSON.parse(storedViews);
        if (Array.isArray(parsed)) {
          const hydrated: SavedView[] = parsed.map((item: any, idx: number) => {
            const id = typeof item?.id === "string" ? item.id : `view-${idx}-${Date.now()}`;
            const name = typeof item?.name === "string" ? item.name : "Uten navn";
            const storedDate = typeof item?.date === "string" ? item.date : isoDate(new Date());
            const storedView = item?.view === "week" ? "week" : "day";
            const storedDetails = Boolean(item?.detailsMode);
            const storedMinSlot = Number.isFinite(Number(item?.minSlot))
              ? Number(item.minSlot)
              : 30;
            const storedWorkStart = Number.isFinite(Number(item?.workStart))
              ? Number(item.workStart)
              : 8;
            const storedWorkEnd = Number.isFinite(Number(item?.workEnd))
              ? Number(item.workEnd)
              : 17;
            const storedCustomMode = Boolean(item?.useCustomWorkHours);
            return {
              id,
              name,
              date: storedDate,
              view: storedView,
              detailsMode: storedDetails,
              minSlot: storedMinSlot,
              workStart: storedWorkStart,
              workEnd: storedWorkEnd,
              useCustomWorkHours: storedCustomMode,
              customWorkHours: normalizeWorkHours(item?.customWorkHours),
            } satisfies SavedView;
          });
          setSavedViews(hydrated);
        }
      }
    } catch (storageError) {
      console.error("Kunne ikke laste lagrede innstillinger", storageError);
    }
  }, []);


  // Effect to handle theme changes and persistence
  useEffect(() => {
    // Check for saved theme in localStorage or user's OS preference
    const savedTheme = localStorage.getItem("theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const initialTheme = savedTheme || (prefersDark ? "dark" : "light");
    setTheme(initialTheme);
   setDisplayTimezone(localStorage.getItem("displayTimezone") || tz);
    try {
      const stored = localStorage.getItem("sourceColors");
      if (stored) {
        const parsed = JSON.parse(stored) as Partial<Record<Source, string>>;
        setSourceColors((prev) => ({ ...prev, ...parsed }));
      }
    } catch (error) {
      console.warn("Kunne ikke lese lagrede farger", error);
    }
  }, [tz]);


  useEffect(() => {
    if (theme === "dark") {
      document.documentElement.classList.add("dark");
      localStorage.setItem("theme", "dark");
    } else {
      document.documentElement.classList.remove("dark");
      localStorage.setItem("theme", "light");
    }
  }, [theme]);

    useEffect(() => {
    if (displayTimezone) {
      localStorage.setItem("displayTimezone", displayTimezone);
    }
  }, [displayTimezone]);

  useEffect(() => {
    localStorage.setItem("sourceColors", JSON.stringify(sourceColors));
  }, [sourceColors]);

  useEffect(() => {
    try {
      const supported =
        typeof Intl.supportedValuesOf === "function"
          ? (Intl.supportedValuesOf("timeZone") as string[])
          : [];
      if (supported.length) {
        setTimezones(supported);
      } else {
        setTimezones([
          "Europe/Oslo",
          "Europe/London",
          "UTC",
          "America/New_York",
          "America/Los_Angeles",
          "Asia/Singapore",
          "Asia/Tokyo",
          "Australia/Sydney",
        ]);
      }
    } catch (error) {
      console.warn("Kunne ikke hente tidssoneliste", error);
      setTimezones([tz, "UTC", "Europe/London", "America/New_York"]);
    }
  }, [tz]);

  // Inactivity -> auto-logout after 45 min
  useEffect(() => {
    let timer: number | undefined;
    const reset = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => panic(), 45 * 60 * 1000);
    };
    ["mousemove", "keydown", "click", "visibilitychange"].forEach((ev) =>
      window.addEventListener(ev, reset)
    );
    reset();
    return () => {
      ["mousemove", "keydown", "click", "visibilitychange"].forEach((ev) =>
        window.removeEventListener(ev, reset)
      );
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

    useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(CUSTOM_HOURS_STORAGE_KEY, JSON.stringify(customWorkHours));
    } catch (storageError) {
      console.error("Kunne ikke lagre arbeidstid per dag", storageError);
    }
  }, [customWorkHours]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(
        CUSTOM_HOURS_MODE_STORAGE_KEY,
        useCustomWorkHours ? "true" : "false"
      );
    } catch (storageError) {
      console.error("Kunne ikke lagre modus for arbeidstid", storageError);
    }
  }, [useCustomWorkHours]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(SAVED_VIEWS_STORAGE_KEY, JSON.stringify(savedViews));
    } catch (storageError) {
      console.error("Kunne ikke lagre lagrede visninger", storageError);
    }
  }, [savedViews]);

  // Initialize MSAL v3 and load Google GSI
  useEffect(() => {
    // --- MSAL (must call initialize() before use) ---
    const app = new PublicClientApplication({
      auth: {
        clientId: MSAL_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${MSAL_TENANT}`,
      },
      cache: { cacheLocation: "sessionStorage", storeAuthStateInCookie: false },
      system: { loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} } },
    });

    (async () => {
      await app.initialize(); // required in v3
      setMsalApp(app);
      // restore session in this tab if present
      const existing = app.getActiveAccount() || app.getAllAccounts()[0] || null;
      if (existing) {
        app.setActiveAccount(existing);
        setMsAccount(existing);
      }
    })();

    // --- Google GSI ---
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => {
      try {
        const oauth2 = (window as any).google?.accounts?.oauth2;
        if (!oauth2) {
          console.error("Google GSI loaded but oauth2 is undefined");
          return;
        }
        googleTokenClientRef.current = oauth2.initTokenClient({
          client_id: GOOGLE_CLIENT_ID,
          scope: GOOGLE_SCOPES,
          prompt: "", // don't force the consent dialog each time
          callback: async (resp: any) => {
            if (resp?.access_token) {
              googleTokenRef.current = resp.access_token;
              setGoogleConnected(true);
              setErr(null);
              await refresh(); // auto-refresh data after getting a token
            } else {
              setErr("Google returned no access_token.");
            }
          },
        });
        setGoogleReady(true);
      } catch (e) {
        console.error("Failed to initialize Google token client", e);
        setGoogleReady(false);
      }
    };
    script.onerror = () => {
      console.error("Failed to load Google GSI");
      setGoogleReady(false);
    };
    document.head.appendChild(script);

    return () => {
      document.head.removeChild(script);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Microsoft sign-in
  async function connectMicrosoft() {
    if (!msalApp) return;
    setErr(null);
    try {
      await msalApp.initialize(); // idempotent
      const res = await msalApp.loginPopup({ scopes: MSAL_SCOPES });
      if (res.account) {
        msalApp.setActiveAccount(res.account);
        setMsAccount(res.account);
      }
    } catch (e: any) {
      setErr(`MSAL login failed: ${e?.errorMessage || e?.message || String(e)}`);
    }
  }

  // Google sign-in (access token stays in memory)
  async function connectGoogle() {
    setErr(null);
    if (!googleReady || !googleTokenClientRef.current) {
      setErr("Google Sign-In is not ready yet. Wait a moment and try again.");
      return;
    }
    try {
      // For testing, you can use { prompt: "consent" } to force re-consent each click.
      googleTokenClientRef.current.requestAccessToken({});
    } catch (e: any) {
      setErr(`Google token failed: ${e?.message ?? String(e)}`);
    }
  }

  // Panic: revoke + clear + reload
  async function panic() {
    try {
      if (msalApp) {
        try {
          await msalApp.logoutPopup();
        } catch {}
      }
      sessionStorage.clear();
      setMsAccount(null);
      if (googleTokenRef.current) {
        try {
          await fetch(
            `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(
              googleTokenRef.current
            )}`,
            { method: "POST" }
          );
        } catch {}
      }
      googleTokenRef.current = null;
      setGoogleConnected(false);
    } finally {
      window.location.reload();
    }
  }

  // Acquire Graph token
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

  // ---- Free/Busy fetchers (default) ----

  // Microsoft: derive busy from calendarView (robust across tenants)
  async function fetchGraphFreeBusy(startISO: string, endISO: string): Promise<Interval[]> {
    const token = await getMsToken();
    if (!token) return [];

    let url =
      "https://graph.microsoft.com/v1.0/me/calendarView" +
      `?startDateTime=${encodeURIComponent(startISO)}` +
      `&endDateTime=${encodeURIComponent(endISO)}` +
      `&$select=start,end,showAs,sensitivity` +
      `&$orderby=start/dateTime`;

    const blocks: Interval[] = [];
    while (url) {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Prefer: `outlook.timezone="${tz}"` },
      });
      if (resp.status === 429 || resp.status === 503) {
        await backoff(resp);
        continue;
      }
      if (!resp.ok) throw new Error(`Graph calendarView: ${resp.status}`);
      const data = await resp.json();
      for (const e of data.value || []) {
        // Anything except explicit "free" counts as busy (busy | tentative | oof | workingElsewhere | unknown)
        const showAs = (e.showAs || "").toLowerCase();
        if (showAs !== "free") {
          const start = e.start?.dateTime ? new Date(e.start.dateTime) : new Date(e.start);
          const end = e.end?.dateTime ? new Date(e.end.dateTime) : new Date(e.end);
          if (end > start) blocks.push({ start, end });
        }
      }
      url = data["@odata.nextLink"] || null;
    }
    return blocks;
  }

  // Google: freeBusy endpoint
  async function fetchGoogleFreeBusy(startISO: string, endISO: string): Promise<Interval[]> {
    if (!googleTokenRef.current) return [];
    const payload = {
      timeMin: startISO,
      timeMax: endISO,
      timeZone: tz,
      items: [{ id: "primary" }],
    };

    while (true) {
      const resp = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${googleTokenRef.current}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (resp.status === 429 || resp.status === 503) {
        await backoff(resp);
        continue;
      }
      if (!resp.ok) {
        let msg = `Google freeBusy: ${resp.status}`;
        try {
          const err = await resp.json();
          if (err?.error?.message) msg += ` – ${err.error.message}`;
        } catch {}
        throw new Error(msg);
      }
      const data = await resp.json();
      const busy = ((data.calendars?.primary?.busy as { start: string; end: string }[]) || []).map(
        (b) => ({ start: new Date(b.start), end: new Date(b.end) })
      );
      return busy.filter((i) => i.end > i.start);
    }
  }

  // ---- Details (opt-in) ----

  async function fetchGraphDetails(day: string): Promise<EventItem[]> {
    const token = await getMsToken();
    if (!token) return [];
    const { startISO, endISO } = dayBoundsISO(day);
    let url =
      "https://graph.microsoft.com/v1.0/me/calendarView" +
      `?startDateTime=${encodeURIComponent(startISO)}` +
      `&endDateTime=${encodeURIComponent(endISO)}` +
      `&$select=start,end,sensitivity,showAs,location,subject` +
      `&$orderby=start/dateTime`;

    const items: EventItem[] = [];
    while (url) {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Prefer: `outlook.timezone="${tz}"` },
      });
      if (resp.status === 429 || resp.status === 503) {
        await backoff(resp);
        continue;
      }
      if (!resp.ok) throw new Error(`Graph details: ${resp.status}`);
      const data = await resp.json();
      for (const e of data.value || []) {
        const isPriv = e.sensitivity === "private";
        items.push({
          source: "microsoft",
          start: new Date(e.start?.dateTime || e.start),
          end: new Date(e.end?.dateTime || e.end),
          title: isPriv ? "(Privat)" : e.subject || "(uten tittel)",
          location: e.location?.displayName,
          isPrivate: isPriv,
        });
      }
      url = data["@odata.nextLink"] || null;
    }
    return items.filter((x) => x.end > x.start);
  }

  async function fetchGoogleDetails(day: string): Promise<EventItem[]> {
    if (!googleTokenRef.current) return [];
    const { startISO, endISO } = dayBoundsISO(day);
    let url =
      "https://www.googleapis.com/calendar/v3/calendars/primary/events" +
      `?singleEvents=true&orderBy=startTime` +
      `&timeMin=${encodeURIComponent(startISO)}` +
      `&timeMax=${encodeURIComponent(endISO)}` +
      `&timeZone=${encodeURIComponent(tz)}` +
      `&fields=items(start,end,visibility,transparency,location,summary),nextPageToken`;

    const items: EventItem[] = [];
    while (true) {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${googleTokenRef.current}` },
      });
      if (resp.status === 429 || resp.status === 503) {
        await backoff(resp);
        continue;
      }
      if (!resp.ok) throw new Error(`Google details: ${resp.status}`);
      const data = await resp.json();
      for (const e of data.items || []) {
        const isPriv = e.visibility === "private";
        const start = e.start?.dateTime
          ? new Date(e.start.dateTime)
          : new Date(`${e.start?.date}T00:00:00`);
        const end = e.end?.dateTime
          ? new Date(e.end.dateTime)
          : new Date(`${e.end?.date}T23:59:59`);
        items.push({
          source: "google",
          start,
          end,
          title: isPriv ? "(Privat)" : e.summary || "(uten tittel)",
          location: e.location,
          isPrivate: isPriv,
        });
      }
      if (!data.nextPageToken) break;
      url += `&pageToken=${data.nextPageToken}`;
    }
    return items.filter((x) => x.end > x.start);
  }

  // ---- Refresh data (free/busy + optionally details) ----
  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      const { startISO, endISO } = view === 'day' ? dayBoundsISO(date) : weekBoundsISO(date);

      const tasks: Promise<any>[] = [fetchGraphFreeBusy(startISO, endISO), fetchGoogleFreeBusy(startISO, endISO)];
      const [msBusy, gBusy] = await Promise.all(tasks);

      const busyBlocks: BusyBlock[] = [
        ...msBusy.map((b: Interval): BusyBlock => ({
          start: b.start,
          end: b.end,
          source: "microsoft",
        })),
        ...gBusy.map((b: Interval): BusyBlock => ({
          start: b.start,
          end: b.end,
          source: "google",
        })),
      ];
      setBusy(busyBlocks);

      if (detailsMode) {
        const detTasks: Promise<any>[] = [fetchGraphDetails(date), fetchGoogleDetails(date)];
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

  // Re-run when inputs or connection state changes
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, detailsMode, msAccount, googleConnected, view]);

  // Derived: free slots (returns Interval[] for day view, Map<string, Interval[]> for week view)
  const freeSlots = useMemo(() => {
    const merged = mergeIntervals(
      busy.map((b: BusyBlock) => ({ start: b.start, end: b.end }))
    );

    if (view === 'day') {
      const day = new Date(`${date}T00:00:00`);
      const dayIndex = day.getDay() as DayIndex;
      const hours = useCustomWorkHours
        ? customWorkHours[dayIndex] ?? { start: workStart, end: workEnd }
        : { start: workStart, end: workEnd };
      return invertBusyToFree(merged, day, hours.start, hours.end, minSlot);
    }
    
    // For week view
    const weeklySlots = new Map<string, Interval[]>();
    const startOfWeek = new Date(date);
    const dayOfWeek = startOfWeek.getDay();
    const diff = startOfWeek.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
    startOfWeek.setDate(diff);

    for (let i = 0; i < 7; i++) {
      const currentDay = new Date(startOfWeek);
      currentDay.setDate(startOfWeek.getDate() + i);
      const currentIndex = currentDay.getDay() as DayIndex;
      const hours = useCustomWorkHours
        ? customWorkHours[currentIndex] ?? { start: workStart, end: workEnd }
        : { start: workStart, end: workEnd };
      const dailyBusy = merged.filter(
        (b) =>
          b.start.getDate() === currentDay.getDate() &&
          b.start.getMonth() === currentDay.getMonth()
      );
    const dailyFree = invertBusyToFree(dailyBusy, currentDay, hours.start, hours.end, minSlot);      weeklySlots.set(isoDate(currentDay), dailyFree);
    }
    return weeklySlots;

  }, [
    busy,
    customWorkHours,
    date,
    minSlot,
    useCustomWorkHours,
    view,
    workEnd,
    workStart,
  ]);

    const formatTime = useCallback(
    (value: Date) =>
      value.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: displayTimezone || tz,
      }),
    [displayTimezone, tz]
  );

  const isConnected = googleConnected || !!msAccount;

  const handleToday = useCallback(() => {
    const today = new Date();
    setDate(isoDate(today));
  }, []);


  function handlePrev() {
    const currentDate = new Date(date);
    const increment = view === 'week' ? 7 : 1;
    currentDate.setDate(currentDate.getDate() - increment);
    setDate(isoDate(currentDate));
  }

  function handleNext() {
    const currentDate = new Date(date);
    const increment = view === 'week' ? 7 : 1;
    currentDate.setDate(currentDate.getDate() + increment);
    setDate(isoDate(currentDate));
  }

  function handleCustomWorkHourChange(day: DayIndex, field: "start" | "end", value: string) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    const clamped = clampHour(parsed);
    setCustomWorkHours((prev) => {
      const next: WorkHoursMap = { ...prev };
      next[day] = { ...prev[day], [field]: clamped } as WorkHours;
      if (next[day].end < next[day].start) {
        if (field === "start") {
          next[day].end = clamped;
        } else {
          next[day].start = clamped;
        }
      }
      return next;
    });
  }

  function copyStandardHoursToCustom() {
    setCustomWorkHours(createUniformWorkHours(workStart, workEnd));
  }

  function applySavedView(id: string) {
    const viewToApply = savedViews.find((v) => v.id === id);
    if (!viewToApply) return;
    setSelectedViewId(id);
    setDate(viewToApply.date);
    setView(viewToApply.view);
    setDetailsMode(viewToApply.detailsMode);
    setMinSlot(viewToApply.minSlot);
    setWorkStart(viewToApply.workStart);
    setWorkEnd(viewToApply.workEnd);
    setUseCustomWorkHours(viewToApply.useCustomWorkHours);
    setCustomWorkHours(normalizeWorkHours(viewToApply.customWorkHours));
  }

  function handleDeleteSavedView() {
    if (!selectedViewId) return;
    setSavedViews((prev) => prev.filter((view) => view.id !== selectedViewId));
    setSelectedViewId(null);
  }

  function handleSaveView() {
    const trimmed = newViewName.trim();
    if (!trimmed) return;
    const snapshot: SavedView = {
      id: `view-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: trimmed,
      date,
      view,
      detailsMode,
      minSlot,
      workStart,
      workEnd,
      useCustomWorkHours,
      customWorkHours: useCustomWorkHours
        ? cloneWorkHours(customWorkHours)
        : createUniformWorkHours(workStart, workEnd),
    };
    setSavedViews((prev) => [...prev, snapshot]);
    setSelectedViewId(snapshot.id);
    setNewViewName("");
  }

return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        {/* FIX: Added dark mode text color to the title */}
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          Samlet kalender (lokal, free/busy som standard)
        </h1>
        <div className="flex items-center gap-2">
          {/* Theme Toggle Button */}
          <button
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            className="px-3 py-2 rounded-lg border bg-white dark:bg-gray-700 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors flex items-center gap-2"
            title="Toggle Dark Mode"
            aria-label={theme === "light" ? "Aktiver mørk modus" : "Aktiver lys modus"}
          >
            {theme === "light" ? <Moon /> : <Sun />}
            <span className="text-sm font-medium">
              {theme === "light" ? "Dark mode" : "Light mode"}
            </span>
          </button>
          
          <button
            onClick={connectGoogle}
            disabled={!googleReady}
            className="px-3 py-2 rounded-lg border bg-white dark:bg-gray-700 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-600 disabled:opacity-60 transition-colors"
            title="Koble til Google (read-only)"
          >
            {googleConnected ? "Google: tilkoblet" : googleReady ? "Koble til Google" : "Laster Google…"}
          </button>

          <button
            onClick={connectMicrosoft}
            className="px-3 py-2 rounded-lg border bg-white dark:bg-gray-700 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors"
            title="Koble til Microsoft (read-only)"
          >
            {msAccount ? "Microsoft: tilkoblet" : "Koble til Microsoft"}
          </button>

          <button onClick={refresh} className="px-3 py-2 rounded-lg border bg-white dark:bg-gray-700 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors">
            Oppdater
          </button>

          <button
            onClick={panic}
            className="px-3 py-2 rounded-lg border text-red-700 bg-red-50 hover:bg-red-100 dark:bg-red-900/40 dark:hover:bg-red-900/60 dark:text-red-300 dark:border-red-700/50 transition-colors"
            title="Logg ut alle, opphev tokens og tøm alt"
          >
            PANIC (tøm alt)
          </button>
        </div>
      </header>

      {/* FIX: Replaced semi-transparent background with a solid one */}
      <section className="bg-white dark:bg-gray-800 rounded-2xl shadow p-4 space-y-4 border dark:border-gray-700 transition-colors">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1">
            <button
              onClick={handlePrev}
              className="px-2 py-1 rounded-lg border bg-white dark:bg-gray-700 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors"
              title={view === 'day' ? 'Forrige dag' : 'Forrige uke'}
            >
              &lt;
            </button>
            <label className="text-sm">
              Dato:
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="ml-2 border rounded px-2 py-1 bg-white dark:bg-gray-700 dark:border-gray-600"
              />
            </label>
            <button
              onClick={handleNext}
              className="px-2 py-1 rounded-lg border bg-white dark:bg-gray-700 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors"
              title={view === 'day' ? 'Neste dag' : 'Neste uke'}
            >
              &gt;
            </button>
            <button
              onClick={handleToday}
              className="px-3 py-1 rounded-lg border bg-sky-50 text-sky-800 hover:bg-sky-100 dark:bg-sky-900/40 dark:hover:bg-sky-900/60 dark:text-sky-200 dark:border-sky-800 transition-colors text-sm"
            >
              I dag
            </button>
          </div>

          <div className="flex items-center gap-2 ml-4">
            <button
              onClick={() => setView("day")}
              className={`px-3 py-1 rounded-lg border text-sm transition-colors ${
                view === "day" ? "bg-gray-200 dark:bg-gray-600 font-semibold" : "bg-white dark:bg-gray-700 dark:border-gray-600"
              }`}
            >
              Dag
            </button>
            <button
              onClick={() => setView("week")}
              className={`px-3 py-1 rounded-lg border text-sm transition-colors ${
                view === "week" ? "bg-gray-200 dark:bg-gray-600 font-semibold" : "bg-white dark:bg-gray-700 dark:border-gray-600"
              }`}
            >
              Uke {view === 'week' && <span className="font-bold ml-1">{weekNumber}</span>}
            </button>
          </div>

         <div className="flex flex-wrap items-center gap-2 text-sm">
            <label className="flex items-center">
              Arbeidstid:
              <input
                type="number"
                min={0}
                max={23}
                value={workStart}
                onChange={(e) =>
                  setWorkStart(parseInt(e.target.value || "8", 10))
                }
                className="ml-2 w-16 border rounded px-2 py-1 bg-white dark:bg-gray-700 dark:border-gray-600"
              />
              <span className="mx-1">–</span>
              <input
                type="number"
                min={0}
                max={23}
                value={workEnd}
                onChange={(e) => setWorkEnd(parseInt(e.target.value || "17", 10))}
                className="w-16 border rounded px-2 py-1 bg-white dark:bg-gray-700 dark:border-gray-600"
              />
            </label>
            <button
              onClick={() => setUseCustomWorkHours((prev) => !prev)}
              className="px-3 py-1 rounded-lg border bg-white dark:bg-gray-700 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors"
            >
              {useCustomWorkHours ? "Samme tid alle dager" : "Tilpass per dag"}
            </button>
            {useCustomWorkHours && (
              <button
                onClick={copyStandardHoursToCustom}
                className="px-3 py-1 rounded-lg border bg-white dark:bg-gray-700 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors"
              >
                Kopier standard til alle
              </button>
            )}
          </div>

          <label className="text-sm">
            Min. hull (min):
            <input
              type="number"
              min={5}
              max={240}
              value={minSlot}
              onChange={(e) => setMinSlot(parseInt(e.target.value || "30", 10))}
              className="ml-2 w-20 border rounded px-2 py-1 bg-white dark:bg-gray-700 dark:border-gray-600"
            />
          </label>

          <label className="text-sm inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={detailsMode}
              onChange={(e) => setDetailsMode(e.target.checked)}
              className="dark:accent-sky-400"
            />
            Vis detaljer (opt‑in)
          </label>
          
          <button
            onClick={() => setShowTimezoneHelper((prev) => !prev)}
            className="text-sm px-3 py-1 rounded-lg border bg-white dark:bg-gray-700 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors"
            aria-expanded={showTimezoneHelper}
          >
            {showTimezoneHelper ? "Skjul tidssonehjelper" : "Tidssonehjelper"}
          </button>
        </div>

               {useCustomWorkHours && (
          <div className="grid w-full gap-3 border-t pt-3 border-gray-200 dark:border-gray-700 sm:grid-cols-2 lg:grid-cols-3">
            {DAY_ORDER.map((day) => (
              <div
                key={day}
                className="rounded-xl border bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-700/40"
              >
                <div className="text-sm font-medium text-gray-700 dark:text-gray-200">
                  {DAY_LABELS[day]}
                </div>
                <div className="mt-2 flex items-center gap-2 text-sm">
                  <label className="flex items-center gap-1">
                    <span className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Start
                    </span>
                    <input
                      type="number"
                      min={0}
                      max={23}
                      value={customWorkHours[day].start}
                      onChange={(e) =>
                        handleCustomWorkHourChange(day, "start", e.target.value)
                      }
                      className="w-16 border rounded px-2 py-1 bg-white dark:bg-gray-800 dark:border-gray-600"
                    />
                  </label>
                  <label className="flex items-center gap-1">
                    <span className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Slutt
                    </span>
                    <input
                      type="number"
                      min={0}
                      max={23}
                      value={customWorkHours[day].end}
                      onChange={(e) =>
                        handleCustomWorkHourChange(day, "end", e.target.value)
                      }
                      className="w-16 border rounded px-2 py-1 bg-white dark:bg-gray-800 dark:border-gray-600"
                    />
                  </label>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex w-full flex-wrap items-center gap-2 border-t pt-3 border-gray-200 dark:border-gray-700">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Lagrede visninger
          </span>
          <select
            value={selectedViewId ?? ""}
            onChange={(e) => {
              const id = e.target.value;
              if (!id) {
                setSelectedViewId(null);
                return;
              }
              applySavedView(id);
            }}
            className="border rounded px-2 py-1 bg-white dark:bg-gray-700 dark:border-gray-600 text-sm"
          >
            <option value="">Velg …</option>
            {savedViews.map((saved) => (
              <option key={saved.id} value={saved.id}>
                {saved.name}
              </option>
            ))}
          </select>
          <button
            onClick={handleDeleteSavedView}
            disabled={!selectedViewId}
            className="px-3 py-1 rounded-lg border bg-white dark:bg-gray-700 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors disabled:opacity-50"
          >
            Slett valgt
          </button>
          <div className="flex flex-1 flex-wrap items-center gap-2 min-w-[220px]">
            <input
              type="text"
              value={newViewName}
              onChange={(e) => setNewViewName(e.target.value)}
              placeholder="Navn på visning"
              className="flex-1 min-w-[160px] border rounded px-2 py-1 bg-white dark:bg-gray-700 dark:border-gray-600 text-sm"
            />
            <button
              onClick={handleSaveView}
              disabled={!newViewName.trim()}
              className="px-3 py-1 rounded-lg border bg-white dark:bg-gray-700 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors disabled:opacity-50"
            >
              Lagre nåværende
            </button>
          </div>
        </div>

        {err && <p className="text-sm text-red-500 dark:text-red-400">Feil: {err}</p>}
        {loading && <p className="text-sm text-gray-500 dark:text-gray-400">Laster …</p>}

      {showTimezoneHelper && (
          <div className="rounded-xl border bg-sky-50 dark:bg-sky-900/30 dark:border-sky-800/40 p-4 space-y-3 text-sm text-sky-900 dark:text-sky-100">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2">
                <span className="font-medium">Vis tider som:</span>
                <select
                  className="border rounded px-2 py-1 bg-white dark:bg-gray-700 dark:border-gray-600"
                  value={displayTimezone || tz}
                  onChange={(e) => setDisplayTimezone(e.target.value)}
                >
                  {[displayTimezone || tz, tz]
                    .concat(timezones)
                    .filter((zone, idx, arr) => zone && arr.indexOf(zone) === idx)
                    .map((zone) => (
                      <option key={zone} value={zone}>
                        {zone}
                      </option>
                    ))}
                </select>
              </label>
              <button
                onClick={() => setDisplayTimezone(tz)}
                className="px-3 py-1 rounded-lg border bg-white dark:bg-gray-700 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors"
              >
                Bruk lokal tid ({tz})
              </button>
            </div>
            <p>
              Endre tidssonen midlertidig for å se hvordan møtene treffer kolleger i andre regioner. API-kallene bruker fortsatt din lokale tidssone.
            </p>
          </div>
        )}

        {!isConnected && (
          <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900/40 p-6 text-sm space-y-3 text-gray-700 dark:text-gray-300">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Kom i gang</h2>
            <ol className="list-decimal list-inside space-y-1">
              <li>Koble til Google-kalenderen din for å hente opptatt/ledig-områder.</li>
              <li>Koble til Microsoft 365 om du også bruker Outlook.</li>
              <li>Velg arbeidstid og ønsket minstelengde – appen foreslår ledige hull automatisk.</li>
            </ol>
            <p>
              Du kan når som helst aktivere detaljer for å se møtetittel og sted. All behandling skjer lokalt i nettleseren.
            </p>
          </div>
        )}

        <div className="grid md:grid-cols-3 gap-4">
          <div className="md:col-span-2">
            <h2 className="font-medium mb-2">Ledige hull</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
              Viser tider i {displayTimezone || tz}
              {displayTimezone && displayTimezone !== tz ? ` (lokal tid: ${tz})` : ""}.
            </p>
            {view === 'day' && (
              (freeSlots as Interval[]).length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">Ingen ledige hull innenfor arbeidstid.</p>
              ) : (
                <ul className="space-y-2">
                  {(freeSlots as Interval[]).map((s, i) => (
                    <li key={i} className="p-3 rounded-xl border bg-emerald-50 dark:bg-emerald-900/50 dark:border-emerald-800/50">
                      <div className="text-sm">
                        {formatTime(s.start)} – {formatTime(s.end)}
                      </div>
                      <div className="text-xs text-gray-600 dark:text-gray-400">
                        {(s.end.getTime() - s.start.getTime()) / 60000} min
                      </div>
                    </li>
                  ))}
                </ul>
              )
            )}

            {view === 'week' && (
              <div className="space-y-4">
                {Array.from((freeSlots as Map<string, Interval[]>).entries()).map(([dayStr, slots]) => (
                  <div key={dayStr}>
                    <h3 className="font-medium text-sm text-gray-800 dark:text-gray-300 mb-1 border-b pb-1 dark:border-gray-700">
                      {new Date(dayStr).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
                    </h3>
                    {slots.length === 0 ? (
                      <p className="text-sm text-gray-500 dark:text-gray-400 px-3 py-2">Ingen ledige hull.</p>
                    ) : (
                      <ul className="space-y-2">
                        {slots.map((s, i) => (
                           <li key={i} className="p-3 rounded-xl border bg-emerald-50 dark:bg-emerald-900/50 dark:border-emerald-800/50">
                            <div className="text-sm">
                              {formatTime(s.start)} – {formatTime(s.end)}
                            </div>
                            <div className="text-xs text-gray-600 dark:text-gray-400">
                              {(s.end.getTime() - s.start.getTime()) / 60000} min
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <aside>
            <h2 className="font-medium mb-2">
              {detailsMode ? "Hendelser (begrensede felter)" : "Kilder"}
            </h2>

            {!detailsMode ? (
              <div className="space-y-4 text-sm text-gray-700 dark:text-gray-400">
                <ul className="space-y-2">
                  {([
                    { key: "google" as Source, label: "Google" },
                    { key: "microsoft" as Source, label: "Microsoft" },
                  ] as const).map(({ key, label }) => (
                    <li key={key} className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span
                          className="inline-flex h-3 w-3 rounded-full"
                          style={{ backgroundColor: sourceColors[key] }}
                          aria-hidden
                        />
                        <span>
                          {label}: free/busy
                        </span>
                      </div>
                      <label className="inline-flex items-center gap-2">
                        <span className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Farge</span>
                        <input
                          type="color"
                          value={sourceColors[key]}
                          onChange={(e) =>
                            setSourceColors((prev) => ({
                              ...prev,
                              [key]: e.target.value,
                            }))
                          }
                          className="h-8 w-8 border rounded cursor-pointer"
                          aria-label={`${label}-farge`}
                        />
                      </label>
                    </li>
                  ))}
                </ul>
                <ul className="space-y-1">
                  <li>API-kilder: Google freeBusy & Microsoft calendarView</li>
                  <li>Standard tidssone: {tz}</li>
                  <li>Ingen logger, ingen backend</li>
                </ul>
              </div>              
            ) : events.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Ingen hendelser å vise, eller ikke tilkoblet.
              </p>
            ) : (
              <ul className="space-y-2">
                {events.map((e, i) => {
                  const range = `${formatTime(e.start)} – ${formatTime(e.end)}`;
                  return (
                    <li
                      key={i}
                      className="p-3 rounded-xl border bg-white dark:bg-gray-700 dark:border-gray-600"
                      style={{
                        borderLeft: `4px solid ${sourceColors[e.source]}`,
                        boxShadow: `inset 4px 0 0 ${sourceColors[e.source]}20`,
                      }}
                    >
                      <div className="flex items-center justify-between text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                        <span>{e.source === "google" ? "Google" : "Microsoft"}</span>
                        <span style={{ color: sourceColors[e.source] }}>{displayTimezone || tz}</span>
                      </div>
                      <div className="font-medium">{e.title ?? "(Privat)"}</div>
                      <div className="text-sm text-gray-600 dark:text-gray-300">
                        {range}
                        {e.location ? ` · ${e.location}` : ""}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </aside>
        </div>

        <div className="text-xs text-gray-500 dark:text-gray-400 border-t pt-3 dark:border-gray-700">
          <p>
            <strong>Personvern:</strong> Ingen hendelser sendes til andre enn Google/Microsoft.
            Ingen egen backend.
          </p>
          <p>
            Scopes: Google <code>calendar.readonly</code>, Microsoft <code>Calendars.Read</code>.
            Tokens i session/minne.
          </p>
        </div>
      </section>
    </div>
  );
}
