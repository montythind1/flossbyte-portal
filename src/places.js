// Google Places address lookup, proxied through the Worker so the API
// key never reaches the browser. Active only when the GOOGLE_PLACES_API_KEY
// secret is set; until then these endpoints report { enabled: false } and
// the address fields keep using the free OpenStreetMap lookup instead.
//
// Billing note: the client sends one session token per address field and
// reuses it for the Place Details call when a suggestion is picked, which
// is how Google groups a typing session into a single billable event.
const AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete";
const DETAILS_URL = "https://places.googleapis.com/v1/places/";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function placesAutocomplete(env, request) {
  const key = env.GOOGLE_PLACES_API_KEY;
  if (!key) return json({ enabled: false, items: [] });
  const q = String(new URL(request.url).searchParams.get("q") || "").trim().slice(0, 120);
  const session = String(new URL(request.url).searchParams.get("session") || "");
  if (q.length < 3) return json({ enabled: true, items: [] });
  try {
    const res = await fetch(AUTOCOMPLETE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key },
      body: JSON.stringify({
        input: q,
        languageCode: "en",
        includedRegionCodes: ["us"],
        ...(session ? { sessionToken: session } : {}),
      }),
    });
    if (!res.ok) return json({ enabled: true, items: [], error: "google" });
    const data = await res.json();
    const items = (data.suggestions || []).map((s) => {
      const p = s.placePrediction || {};
      const fmt = p.structuredFormat || {};
      return {
        placeId: p.placeId || "",
        main: (fmt.mainText && fmt.mainText.text) || (p.text && p.text.text) || "",
        secondary: (fmt.secondaryText && fmt.secondaryText.text) || "",
      };
    }).filter((i) => i.placeId && i.main);
    return json({ enabled: true, items });
  } catch {
    return json({ enabled: true, items: [], error: "network" });
  }
}

export async function placesDetails(env, request) {
  const key = env.GOOGLE_PLACES_API_KEY;
  if (!key) return json({ enabled: false });
  const url = new URL(request.url);
  const id = String(url.searchParams.get("id") || "");
  const session = String(url.searchParams.get("session") || "");
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return json({ enabled: true, error: "bad id" }, 400);
  try {
    const res = await fetch(DETAILS_URL + encodeURIComponent(id) + (session ? `?sessionToken=${encodeURIComponent(session)}` : ""), {
      headers: {
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "addressComponents",
      },
    });
    if (!res.ok) return json({ enabled: true, error: "google" });
    const data = await res.json();
    const byType = {};
    for (const c of data.addressComponents || []) {
      for (const t of c.types || []) if (!byType[t]) byType[t] = c;
    }
    const long = (t) => (byType[t] ? byType[t].longText || "" : "");
    const short = (t) => (byType[t] ? byType[t].shortText || "" : "");
    const zipBase = long("postal_code");
    const zipSuffix = long("postal_code_suffix");
    return json({
      enabled: true,
      street: [long("street_number"), long("route")].filter(Boolean).join(" "),
      subpremise: long("subpremise"),
      city: long("locality") || long("postal_town") || long("sublocality_level_1") || long("administrative_area_level_2"),
      state: short("administrative_area_level_1"),
      zip: zipBase ? (zipSuffix ? `${zipBase}-${zipSuffix}` : zipBase) : "",
    });
  } catch {
    return json({ enabled: true, error: "network" });
  }
}
