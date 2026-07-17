# Kochbuch-Backend – Setup & Deployment

Kleiner Node.js/Express-Server, der TikTok-/Pinterest-/Instagram-Links per
oEmbed ausliest und den Text mit Claude zu einem strukturierten Rezept
(Titel, Zutaten, Zubereitung) verarbeitet.

## 1. Anthropic API-Key besorgen

1. Auf https://console.anthropic.com registrieren (separat vom claude.ai-Account).
2. Unter **API Keys** einen neuen Key erstellen.
3. Etwas Guthaben aufladen (ein paar Euro reichen für sehr viele Test-Importe,
   da hier bewusst das günstige Haiku-Modell verwendet wird).

**Achtung:** Das kostet echtes Geld pro Import (Cent-Bereich pro Anfrage),
ist aber getrennt von deinem claude.ai-Abo.

## 2. Deployment auf Render.com (kostenloser Tier)

1. Auf https://render.com mit GitHub-Account einloggen.
2. Diesen `kochbuch-backend`-Ordner in ein eigenes GitHub-Repo pushen
   (z. B. `kochbuch-backend`), **ohne** die `.env`-Datei (ist per
   `.gitignore` sowieso ausgeschlossen).
3. In Render: **New → Web Service** → das Repo auswählen.
4. Einstellungen:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Unter **Environment** die Variable setzen:
   - `ANTHROPIC_API_KEY` = dein Key aus Schritt 1
6. Deployen. Du bekommst eine URL wie `https://kochbuch-backend-xyz.onrender.com`.

**Hinweis Free-Tier:** Der kostenlose Render-Server "schläft" nach ca. 15 Minuten
Inaktivität ein. Der erste Import danach dauert ca. 30–60 Sekunden länger
(Cold Start), das ist normal.

## 3. Frontend verbinden

In `app.js` im Frontend die Zeile anpassen:

```js
const BACKEND_URL = "https://kochbuch-backend-xyz.onrender.com";
```

Danach die geänderte `app.js` erneut in dein GitHub-Pages-Repo hochladen
(Datei ersetzen, committen). Nach ein bis zwei Minuten ist die neue Version live.

## 4. Lokal testen (optional, vor dem Deployment)

```bash
cp .env.example .env
# .env öffnen und echten Key eintragen
npm install
npm start
```

Server läuft dann unter `http://localhost:3000`. Test:

```bash
curl -X POST http://localhost:3000/extract \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.tiktok.com/@BEISPIEL/video/123456"}'
```

## Bekannte Grenzen (Proof of Concept)

- Es wird **kein Video-Ton transkribiert** und **keine Bilderkennung** auf
  Videoframes durchgeführt – nur der öffentlich verfügbare Bildunterschrift-Text.
  Rezepte, die nur gesprochen oder als Text-Overlay im Video stehen, liefern
  leere Zutaten-/Schritte-Felder.
- **Instagram** liefert in der Praxis meist keine Daten, da Meta die offene
  oEmbed-API 2020 eingeschränkt hat (Zugriff erfordert eine genehmigte
  Facebook-Developer-App).
- Kein Rate-Limiting, keine Authentifizierung auf dem Endpunkt – für einen
  privaten Test okay, für einen öffentlichen Einsatz sollte das ergänzt werden.
