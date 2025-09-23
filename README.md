# Kalender-overlay (client-only, robust privacy)

## Hva
- Kombinerer **Google** og **Microsoft 365** kalender **free/busy** lokalt i nettleseren.
- **Default:** Kun opptatt/ledig. **Opt-in:** Begrensede detaljer (uten å eksponere privat innhold).
- **Ingen backend**, ingen tredjeparts-logging. Tokens i **sessionStorage** (MSAL) og **minne** (Google).

## Kom i gang (lokalt)
1. `npm i`
2. Kopier `.env.example` til `.env.local` og fyll:
   - `NEXT_PUBLIC_GOOGLE_CLIENT_ID`
   - `NEXT_PUBLIC_MSAL_CLIENT_ID`
   - `NEXT_PUBLIC_MSAL_TENANT` (f.eks. `common` eller din tenant)
3. Start: `npm run dev` (http://localhost:5173)

## OAuth-oppsett
### Google
- Opprett OAuth Client (Web) i Google Cloud Console.
- Authorized JavaScript origins:
  - `http://localhost:5173`
  - `https://kalender.andreashustad.com` (prod)
  - (ev. `https://*.vercel.app` for previews)
- Scope: `https://www.googleapis.com/auth/calendar.readonly` (read-only).

### Microsoft (Entra ID)
- App registrations → Registrér SPA (Public client).
- Redirect URIs:
  - `http://localhost:5173/kalender`
  - `https://kalender.andreashustad.com/kalender`
- API permissions: Microsoft Graph → **Delegated** → `Calendars.Read`.
- Admin consent kan kreves i noen tenanter.

## Deploy (Vercel)
- Legg `NEXT_PUBLIC_*` env-vars i Vercel (Production + Preview).
- Sett DNS for subdomene (CNAME til Vercel).
- Deploy og besøk `/kalender`.
- **Headers/CSP** er satt i `next.config.mjs` kun for `/kalender`.

## Personvern/sikkerhet
- Ingen server, ingen logging. Tokens lagres ikke i LocalStorage.
- `Content-Security-Policy` begrenser skript og nettverkskall til Google/Microsoft.
- HTML for `/kalender` har `Cache-Control: no-store`.
- “Panic”-knapp opphever tokens og tømmer session.

## Verifisering (for revisjon)
- DevTools → Network: Bare `accounts.google.com`, `www.googleapis.com`, `login.microsoftonline.com`, `graph.microsoft.com`.
- Ingen requests til ditt domene etter initial sideinnlasting.
- Test i inkognito/ren profil (extensions av).
