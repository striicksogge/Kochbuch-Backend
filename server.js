/* ===================================================================
   Kochbuch-Backend – server.js
   -------------------------------------------------------------------
   Nimmt einen TikTok-/Instagram-/Pinterest-Link entgegen, holt so viel
   Textinformation wie öffentlich verfügbar (über oEmbed) und lässt
   Claude daraus ein strukturiertes Rezept (Titel, Zutaten, Schritte)
   extrahieren.

   WICHTIGE EINSCHRÄNKUNG:
   Es wird kein Video-Ton transkribiert und keine Bilderkennung auf
   Frames durchgeführt. Basis ist ausschließlich der öffentlich
   verfügbare Text (Bildunterschrift/Beschreibung + Titel). Wenn ein
   Rezept nur gesprochen oder als Text-Overlay im Video vorkommt,
   bleiben die entsprechenden Felder leer – genau wie in der
   ursprünglichen Spezifikation vorgesehen.

   Instagram-Hinweis: Meta hat die offene oEmbed-API 2020 restriktiv
   gemacht. Ohne genehmigte Facebook-Developer-App liefert Instagram
   in der Praxis meist keine Daten. Der Code versucht es trotzdem und
   gibt bei Fehlschlag einfach leere Felder zurück.
   =================================================================== */

import express from "express";
import cors from "cors";

const app = express();
app.use(cors()); // Für den Proof of Concept offen; später ggf. auf deine GitHub-Pages-Domain einschränken
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"; // schnell & günstig, für Textextraktion ausreichend

if (!ANTHROPIC_API_KEY) {
  console.warn(
    "WARNUNG: ANTHROPIC_API_KEY ist nicht gesetzt. /extract wird ohne KI-Auswertung nur Rohdaten liefern."
  );
}

/* ---------------------------------------------------------------
   1) PLATTFORM-ERKENNUNG
   --------------------------------------------------------------- */

function detectPlatform(url) {
  const u = url.toLowerCase();
  if (u.includes("tiktok.com")) return "TikTok";
  if (u.includes("instagram.com")) return "Instagram";
  if (u.includes("pinterest.")) return "Pinterest";
  return "Unbekannt";
}

/* ---------------------------------------------------------------
   2) OEMBED-ABRUF PRO PLATTFORM
   -------------------------------------------------------------
   Liefert { title, description, thumbnailUrl } – so viel wie eben
   öffentlich verfügbar ist. Nicht gefundene Werte bleiben null.
   --------------------------------------------------------------- */

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTikTokOEmbed(url) {
  const endpoint = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
  const res = await fetchWithTimeout(endpoint);
  if (!res.ok) throw new Error(`TikTok oEmbed fehlgeschlagen (${res.status})`);
  const data = await res.json();
  return {
    title: data.title || null, // enthält bei TikTok meist die volle Caption
    description: null,
    thumbnailUrl: data.thumbnail_url || null,
  };
}

async function fetchPinterestOEmbed(url) {
  const endpoint = `https://www.pinterest.com/oembed.json?url=${encodeURIComponent(url)}`;
  const res = await fetchWithTimeout(endpoint);
  if (!res.ok) throw new Error(`Pinterest oEmbed fehlgeschlagen (${res.status})`);
  const data = await res.json();
  return {
    title: data.title || null,
    description: null,
    thumbnailUrl: data.thumbnail_url || null,
  };
}

async function fetchInstagramOEmbed(url) {
  // Ohne genehmigte Meta-Developer-App i. d. R. nicht erreichbar.
  // Versuch bleibt drin, damit es automatisch funktioniert, sobald du
  // eigene Zugangsdaten hinterlegst (siehe README).
  const endpoint = `https://api.instagram.com/oembed?url=${encodeURIComponent(url)}`;
  const res = await fetchWithTimeout(endpoint);
  if (!res.ok) throw new Error(`Instagram oEmbed fehlgeschlagen (${res.status})`);
  const data = await res.json();
  return {
    title: data.title || null,
    description: null,
    thumbnailUrl: data.thumbnail_url || null,
  };
}

async function fetchOEmbedData(url, platform) {
  try {
    if (platform === "TikTok") return await fetchTikTokOEmbed(url);
    if (platform === "Pinterest") return await fetchPinterestOEmbed(url);
    if (platform === "Instagram") return await fetchInstagramOEmbed(url);
  } catch (err) {
    console.warn(`oEmbed-Abruf für ${platform} fehlgeschlagen:`, err.message);
  }
  return { title: null, description: null, thumbnailUrl: null };
}

/* ---------------------------------------------------------------
   3) KI-EXTRAKTION MIT CLAUDE
   -------------------------------------------------------------
   Nimmt den rohen Caption-/Beschreibungstext und lässt Claude daraus
   ein sauberes JSON mit Titel, Zutaten und Zubereitungsschritten
   bauen. Wenn der Text nicht genug hergibt, liefert Claude leere
   Arrays statt zu halluzinieren (das wird im Prompt explizit verlangt).
   --------------------------------------------------------------- */

async function extractRecipeWithClaude(rawText, platform) {
  if (!ANTHROPIC_API_KEY || !rawText) {
    return { title: null, ingredients: [], steps: [], cookTime: null, caloriesPerServing: null };
  }

  const systemPrompt = `Du bekommst den rohen Bildunterschrift-/Beschreibungstext eines Rezept-Videos oder -Pins von ${platform}.
Extrahiere daraus, sofern vorhanden: einen kurzen Rezepttitel, eine strukturierte Zutatenliste, Zubereitungsschritte, die geschätzte Gesamt-Kochzeit und eine grobe Kalorienschätzung pro Portion.
WICHTIG - Sprache: Der Ausgangstext kann in jeder Sprache sein (z. B. Englisch). Erkenne die Sprache automatisch und gib Titel, Zutatennamen und Zubereitungsschritte IMMER auf Deutsch aus, unabhängig von der Ausgangssprache. Übersetze dabei sinngemäß mit korrekten deutschen Kochbegriffen (z. B. "fold in" -> "unterheben", nicht wörtlich "einfalten"), keine Wort-für-Wort-Übersetzung.
Antworte AUSSCHLIESSLICH mit einem JSON-Objekt in genau diesem Format, ohne Markdown-Codeblock, ohne zusätzlichen Text:
{"title": string oder null, "ingredients": [{"amount": string, "unit": string, "name": string}], "steps": string[], "cookTime": string oder null, "caloriesPerServing": number oder null}
Beispiel für eine Zutat: "250 g Spaghetti" -> {"amount": "250", "unit": "g", "name": "Spaghetti"}. Englisches Beispiel: "1 cup flour" -> {"amount": "1", "unit": "cup", "name": "Mehl"} (Name übersetzt, Menge/Einheit UNVERÄNDERT lassen - die Einheiten-Umrechnung passiert in einem separaten Schritt, nicht durch dich).
Bei Zutaten ohne erkennbare Menge/Einheit (z. B. "eine Prise Salz", "1 Ei"): amount/unit so gut wie möglich befüllen, sonst leerer String "" - name darf nicht leer sein.
cookTime: falls im Text explizit genannt (z. B. "in 20 Minuten fertig"), diese Angabe übernehmen (Format "X Min."). Falls nicht explizit genannt, aus der Anzahl/Komplexität der Zubereitungsschritte grob schätzen. Nur null, wenn wirklich keine sinnvolle Schätzung möglich ist (z. B. keine Zubereitungsschritte vorhanden).
caloriesPerServing: grobe Schätzung anhand der Zutatenliste, als reine Ganzzahl (z. B. 450). Das ist AUSDRÜCKLICH eine Schätzung, keine exakte Nährwertangabe - besser eine vorsichtige Schätzung liefern als null, außer die Zutatenliste ist leer oder zu unklar.
Erfinde bei Titel/Zutaten/Schritten NICHTS. Wenn Zutaten oder Schritte im Text nicht klar erkennbar sind, gib jeweils ein leeres Array zurück.
Wenn kein sinnvoller Titel erkennbar ist, gib null zurück.`;

  const response = await fetchWithTimeout(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: "user", content: rawText.slice(0, 4000) }],
      }),
    },
    15000
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API Fehler (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const textBlock = data.content.find((b) => b.type === "text");
  if (!textBlock) return { title: null, ingredients: [], steps: [], cookTime: null, caloriesPerServing: null };

  try {
    const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    const ingredients = Array.isArray(parsed.ingredients)
      ? parsed.ingredients
          .filter((ing) => ing && typeof ing.name === "string" && ing.name.trim())
          .map((ing) => ({
            amount: typeof ing.amount === "string" ? ing.amount : "",
            unit: typeof ing.unit === "string" ? ing.unit : "",
            name: ing.name.trim(),
          }))
      : [];
    const caloriesNum = Number(parsed.caloriesPerServing);
    return {
      title: parsed.title || null,
      ingredients,
      steps: Array.isArray(parsed.steps) ? parsed.steps : [],
      cookTime: typeof parsed.cookTime === "string" ? parsed.cookTime : null,
      caloriesPerServing: Number.isFinite(caloriesNum) ? Math.round(caloriesNum) : null,
    };
  } catch (err) {
    console.warn("Konnte Claude-Antwort nicht als JSON parsen:", err.message);
    return { title: null, ingredients: [], steps: [], cookTime: null, caloriesPerServing: null };
  }
}

/* ---------------------------------------------------------------
   4) HAUPT-ENDPUNKT
   --------------------------------------------------------------- */

/* ---------------------------------------------------------------
   4b) CUP-UMRECHNUNG (feste Tabelle, keine KI)
   -------------------------------------------------------------
   "Cup" ist ein Volumenmaß. Bei Flüssigkeiten ist die Umrechnung in ml
   immer gleich (1 Cup ≈ 240 ml), unabhängig von der Zutat. Bei festen/
   pulvrigen Zutaten hängt das Gewicht pro Cup von der Dichte der
   Zutat ab - dafür braucht es eine zutatenspezifische Tabelle.
   Zutaten, die nicht in der Tabelle stehen, bleiben bewusst
   unverändert (lieber "1 cup Kokosraspeln" stehen lassen als raten).
   --------------------------------------------------------------- */

const CUP_TO_ML = 240;

// Gramm pro US-Cup, für die gängigsten Back-/Kochzutaten
const DRY_CUP_TO_GRAMS = {
  "mehl": 120,
  "zucker": 200,
  "puderzucker": 120,
  "brauner zucker": 220,
  "butter": 227,
  "haferflocken": 90,
  "reis": 185,
  "kakaopulver": 85,
  "rosinen": 150,
  "paniermehl": 108,
  "kokosraspeln": 85,
  "schokoladenstückchen": 170,
  "parmesan": 100,
  "mandeln gemahlen": 95,
  "walnüsse gehackt": 120,
  "haselnüsse gehackt": 120,
};

const LIQUID_KEYWORDS = [
  "milch", "wasser", "öl", "sahne", "joghurt", "buttermilch",
  "brühe", "saft", "sirup", "kokosmilch", "bouillon",
];

function parseAmountSimple(text) {
  if (!text) return null;
  const t = String(text).trim().replace(",", ".");
  if (/^\d+\/\d+$/.test(t)) {
    const [n, d] = t.split("/").map(Number);
    return d !== 0 ? n / d : null;
  }
  const num = Number(t);
  return Number.isFinite(num) ? num : null;
}

function formatAmountSimple(num) {
  const rounded = Math.round(num * 10) / 10; // eine Nachkommastelle reicht bei umgerechneten Mengen
  return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(".", ",");
}

function convertCupsToMetric(ingredients) {
  return ingredients.map((ing) => {
    const isCup = /^cups?$/i.test((ing.unit || "").trim());
    if (!isCup) return ing;

    const amountNum = parseAmountSimple(ing.amount);
    if (amountNum === null) return ing; // keine sinnvolle Zahl, nicht anfassen

    const nameLower = ing.name.toLowerCase();

    const isLiquid = LIQUID_KEYWORDS.some((kw) => nameLower.includes(kw));
    if (isLiquid) {
      return { ...ing, amount: formatAmountSimple(amountNum * CUP_TO_ML), unit: "ml" };
    }

    const matchedKey = Object.keys(DRY_CUP_TO_GRAMS).find((key) => nameLower.includes(key));
    if (matchedKey) {
      return { ...ing, amount: formatAmountSimple(amountNum * DRY_CUP_TO_GRAMS[matchedKey]), unit: "g" };
    }

    return ing; // unbekannte Zutat: unverändert lassen
  });
}

app.post("/extract", async (req, res) => {
  const { url } = req.body || {};

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Feld 'url' fehlt oder ist ungültig." });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({ error: "Ungültiger Link." });
  }

  const platform = detectPlatform(url);

  // Schritt 1: oEmbed-Daten holen (Bild/Caption) – eigenständiger Fehlerfall
  const oembed = await fetchOEmbedData(url, platform); // wirft selbst nicht, siehe fetchOEmbedData
  const rawText = oembed.title || oembed.description || "";

  // Schritt 2: Claude-Extraktion – eigenständiger Fehlerfall, damit ein
  // Guthaben-/API-Fehler hier NICHT das bereits geladene Bild verwirft.
  let extracted = { title: null, ingredients: [], steps: [], cookTime: null, caloriesPerServing: null };
  let warning;
  try {
    extracted = await extractRecipeWithClaude(rawText, platform);
  } catch (err) {
    console.error("Claude-Extraktion fehlgeschlagen:", err.message);
    warning = "KI-Auswertung fehlgeschlagen (z. B. fehlendes Guthaben) – Titel/Zutaten/Zubereitung bleiben leer.";
  }

  res.json({
    platform,
    title: extracted.title,
    image: oembed.thumbnailUrl,
    ingredients: convertCupsToMetric(extracted.ingredients),
    steps: extracted.steps,
    cookTime: extracted.cookTime,
    caloriesPerServing: extracted.caloriesPerServing,
    ...(warning ? { warning } : {}),
  });
});

app.get("/", (req, res) => {
  res.send("Kochbuch-Backend läuft. POST an /extract mit { url } senden.");
});

/* ---------------------------------------------------------------
   5) INTELLIGENTE SUCHE
   -------------------------------------------------------------
   Bekommt die Sucheingabe in natürlicher Sprache plus eine
   kompakte Liste der vorhandenen Rezepte (nur die für die Suche
   relevanten Felder, keine Zubereitungsschritte) und lässt Claude
   die passenden IDs zurückgeben, nach Relevanz sortiert.

   Bewusste Einschränkung: läuft bei jeder Suche neu über alle
   Rezepte (kein Suchindex, keine Datenbank) – für eine private
   Sammlung im Bereich von einigen hundert Rezepten unproblematisch,
   bei sehr großen Sammlungen würde man das später cachen/indexieren.
   --------------------------------------------------------------- */

app.post("/search", async (req, res) => {
  const { query, recipes } = req.body || {};

  if (!query || typeof query !== "string") {
    return res.status(400).json({ error: "Feld 'query' fehlt oder ist ungültig." });
  }
  if (!Array.isArray(recipes) || recipes.length === 0) {
    return res.json({ matchingIds: [] });
  }
  if (!ANTHROPIC_API_KEY) {
    return res.status(400).json({
      error: "Kein ANTHROPIC_API_KEY gesetzt, intelligente Suche kann nicht laufen.",
    });
  }

  // Nur die für die Suche relevanten Felder mitschicken, spart Tokens.
  const compactRecipes = recipes.slice(0, 300).map((r) => ({
    id: r.id,
    title: r.title,
    ingredients: r.ingredients,
    categories: r.categories,
    cookTime: r.cookTime,
  }));

  const systemPrompt = `Du bekommst eine Sucheingabe in natürlicher Sprache und eine Liste von Rezepten (jeweils id, title, ingredients, categories, cookTime).
Jede Zutat in "ingredients" ist ein Objekt {amount, unit, name} - relevant für die Suche ist vor allem das "name"-Feld.
Finde die Rezepte, die zur Sucheingabe passen. Berücksichtige dabei auch sinngemäße/implizite Bedeutung, z. B.:
- "schnell für heute" -> kurze Kochzeit oder Kategorie "Schnell (<15 Min.)"
- "irgendwas mit Hähnchen" -> Zutaten oder Kategorien, die Hähnchen enthalten
- "vegetarisch" -> passende Kategorie, auch wenn nicht explizit im Titel
Antworte AUSSCHLIESSLICH mit einem JSON-Objekt in genau diesem Format, ohne Markdown-Codeblock, ohne zusätzlichen Text:
{"matchingIds": string[]}
Sortiere nach Relevanz (bester Treffer zuerst). Gib ein leeres Array zurück, wenn nichts wirklich passt. Erfinde keine IDs, die nicht in der Liste stehen.`;

  try {
    const response = await fetchWithTimeout(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 1000,
          system: systemPrompt,
          messages: [
            {
              role: "user",
              content: `Sucheingabe: "${query}"\n\nRezepte:\n${JSON.stringify(compactRecipes)}`,
            },
          ],
        }),
      },
      15000
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Claude API Fehler (${response.status}): ${errText}`);
    }

    const data = await response.json();
    const textBlock = data.content.find((b) => b.type === "text");
    const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    res.json({ matchingIds: Array.isArray(parsed.matchingIds) ? parsed.matchingIds : [] });
  } catch (err) {
    console.error("Fehler bei /search:", err.message);
    res.status(500).json({ error: "Suche fehlgeschlagen.", matchingIds: [] });
  }
});

app.listen(PORT, () => {
  console.log(`Kochbuch-Backend läuft auf Port ${PORT}`);
});
