const CACHE_TTL_MS = 60_000;
/** Hur länge en gammal cache får serveras som nödfallback när upstream/proxy felar. */
const STALE_CACHE_TTL_MS = 30 * 60_000;
/** Skydd mot pathologiskt stora svar från proxyn. */
const MAX_MARKDOWN_LINES = 6_000;
const MAX_RESULT_ROWS = 400;
const cache = new Map();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const jsonResponse = (statusCode, payload, extraHeaders = {}) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=30",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    ...extraHeaders,
  },
  body: JSON.stringify(payload),
});

const PORTS = {
  trelleborg: {
    sourceUrl:
      "https://r.jina.ai/http://www.myshiptracking.com/ports/port-of-trelleborg-in-se-sweden-id-427",
    arrivalsUrl:
      "https://r.jina.ai/http://www.myshiptracking.com/ports-arrivals-departures/?pid=427&type=1",
    estimateUrl: "https://r.jina.ai/http://www.myshiptracking.com/estimate?pid=427",
    // e-ferry route-ID för ankomster TILL Trelleborg: 241 TT-Line Rostock, 243 TT-Line Travemünde, 222 Stena Rostock.
    scheduleRouteIds: [241, 243, 222],
  },
  helsingborg: {
    sourceUrl:
      "https://r.jina.ai/http://www.myshiptracking.com/ports/port-of-helsingborg-in-se-sweden-id-209",
    arrivalsUrl:
      "https://r.jina.ai/http://www.myshiptracking.com/ports-arrivals-departures/?pid=209&type=1",
    estimateUrl: "https://r.jina.ai/http://www.myshiptracking.com/estimate?pid=209",
  },
  ystad: {
    sourceUrl:
      "https://r.jina.ai/http://www.myshiptracking.com/ports/port-of-ystad-in-se-sweden-id-2225",
    arrivalsUrl:
      "https://r.jina.ai/http://www.myshiptracking.com/ports-arrivals-departures/?pid=2225&type=1",
    estimateUrl: "https://r.jina.ai/http://www.myshiptracking.com/estimate?pid=2225",
  },
};

const KEYWORDS = {
  trelleborg: [
    "peter pan",
    "skane",
    "tinker bell",
    "tom sawyer",
    "mecklenburg",
    "nils holgersson",
    "nils dacke",
    "huckleberry finn",
    "robin hood",
    "akka",
    "epsilon",
    "marco polo",
    "jantar unity",
    "copernicus",
  ],
  helsingborg: [
    "tycho brahe",
    "aurora af helsingborg",
    "aurora af helsingbor",
    "hamlet",
    "mercuria",
    "uraniborg",
  ],
  ystad: ["polonia", "varsovia", "mazovia", "skania", "galileusz", "wolin", "cracovia"],
};

const timeoutFetchText = async (url, timeoutMs = 12000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "ferry-arrivals-sweden/1.0 (+netlify-function)" },
    });
    const text = await res.text();
    return { ok: res.ok, text };
  } catch {
    return { ok: false, text: "" };
  } finally {
    clearTimeout(timer);
  }
};

/** Proxyn (r.jina.ai) svarar ibland tomt/fel första gången — ett snabbt omförsök höjer träffsäkerheten. */
const fetchWithRetry = async (url, { timeoutMs = 12000, attempts = 2, minLength = 0 } = {}) => {
  let last = { ok: false, text: "" };
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      await new Promise((r) => setTimeout(r, 600));
    }
    last = await timeoutFetchText(url, timeoutMs);
    if (last.ok && last.text.length >= minLength) {
      return last;
    }
  }
  return last;
};

const parseDate = (text) => {
  const normalized = String(text).replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  const m = normalized.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isNaN(d.valueOf()) ? null : d;
};

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const isSameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const statusFromEta = (d) => (Date.now() - d.getTime() > 20 * 60 * 1000 ? "delayed" : "scheduled");

/**
 * parseDate bygger Date med lokala komponenter (samma väggklocka som källan visar), så
 * utläsningen måste också vara lokal — annars skiftas tiderna när servern inte kör i UTC.
 * Detta gör round-trippen källa → server → klient tidszons-oberoende.
 */
const toLocalLikeString = (d) => {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
};

const splitLines = (markdown) => String(markdown).split("\n").slice(0, MAX_MARKDOWN_LINES);

const vesselName = (text) =>
  String(text)
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\[[A-Z]{2}\]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const isPassenger = (port, name) => {
  const n = name.toLowerCase();
  return KEYWORDS[port].some((k) => n.includes(k));
};

const matchesFilter = (port, vessel, includeAll) => includeAll || isPassenger(port, vessel);

const parsePortPage = (markdown, port, targetDate, includeAll = false) => {
  const rows = splitLines(markdown);
  let section = "none";
  const out = [];
  for (const row of rows) {
    if (row.startsWith("### ")) {
      if (row.includes("Vessels In Port") || row.includes("Vessels currently in port")) section = "in_port";
      else if (row.includes("Expected Arrivals")) section = "expected";
      else if (row.includes("Activity")) section = "activity";
      else section = "none";
      continue;
    }
    if (!row.includes("|")) continue;
    const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
    if (section === "in_port") {
      if (cells.length < 2 || cells[0] === "Vessel" || cells[0] === "---") continue;
      const t = parseDate(cells[1]);
      const v = vesselName(cells[0]);
      if (!t || !isSameDay(t, targetDate) || !v || !matchesFilter(port, v, includeAll)) continue;
      out.push({ vesselName: v, plannedTime: t, status: "arrived", source: "MyShipTracking vessels in port", feedKind: "in_port" });
      continue;
    }
    if (section === "activity") {
      if (cells.length < 3 || cells[0] === "Time" || cells[0] === "---") continue;
      if (!/\bARRIVAL\b/i.test(cells[1] || "")) continue;
      const t = parseDate(cells[0]);
      const v = vesselName(cells[2]);
      if (!t || !isSameDay(t, targetDate) || !v || !matchesFilter(port, v, includeAll)) continue;
      out.push({ vesselName: v, plannedTime: t, status: "arrived", source: "MyShipTracking activity feed", feedKind: "activity" });
      continue;
    }
    if (section === "expected") {
      if (cells.length < 3 || cells[0] === "MMSI" || cells[0] === "---") continue;
      const t = parseDate(cells[2]);
      const v = vesselName(cells[1]);
      if (!t || !isSameDay(t, targetDate) || !v || !matchesFilter(port, v, includeAll)) continue;
      out.push({ vesselName: v, plannedTime: t, status: statusFromEta(t), source: "MyShipTracking expected arrivals", feedKind: "expected" });
    }
  }
  return out;
};

const parsePortCalls = (markdown, port, targetDate, includeAll = false) => {
  const rows = splitLines(markdown);
  const out = [];
  for (const row of rows) {
    if (!/\|\s*Arrival\s*\|/i.test(row)) continue;
    const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length < 4) continue;
    const t = parseDate(cells[1]);
    const v = vesselName(cells[3]);
    if (!t || !isSameDay(t, targetDate) || !v || !matchesFilter(port, v, includeAll)) continue;
    out.push({ vesselName: v, plannedTime: t, status: "arrived", source: "MyShipTracking port calls (arrivals)", feedKind: "port_calls" });
  }
  return out;
};

const parseEstimate = (markdown, port, targetDate, includeAll = false) => {
  const rows = splitLines(markdown);
  const out = [];
  let inTable = false;
  for (const row of rows) {
    if (row.includes("| MMSI |") && row.includes("Estimated Arrival")) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (/Showing\s+\d+\s*-\s*\d+\s+of\s+\d+\s+Results/i.test(row)) break;
    if (row.startsWith("#")) break;
    const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length < 3 || cells[0] === "MMSI" || !/^\d/.test(cells[0])) continue;
    const t = parseDate(cells[cells.length - 1]);
    const v = vesselName(cells[1]);
    if (!t || !isSameDay(t, targetDate) || !v || !matchesFilter(port, v, includeAll)) continue;
    out.push({ vesselName: v, plannedTime: t, status: statusFromEta(t), source: "MyShipTracking estimate (full ETA-lista)", feedKind: "expected" });
  }
  return out;
};

/**
 * e-ferry lägger hela tidtabellen på en rad och återanvänder tider i boknings-URL:er, så vi
 * arbetar på hela texten: ta utresetabellen (= ankomster TILL Trelleborg), klipp ut dygnsblocket,
 * strippa länkar (annars dubbelräknas tider) och para ihop avgång/ankomst. Andra tiden = ankomst.
 * Operatören (TT-Line/Stena) läses från sidan så samma parser fungerar för alla e-ferry-rutter.
 */
const operatorFromText = (text) => {
  if (/stena/i.test(text)) return "Stena Line";
  if (/tt-?line/i.test(text)) return "TT-Line";
  return "Färja";
};

const parseSchedule = (markdown, targetDate, routeId) => {
  const out = [];
  const dayToken = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(targetDate);
  const dateToken = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, "0")}-${String(targetDate.getDate()).padStart(2, "0")}`;
  const dayLabel = `${dayToken} (${dateToken})`;

  const text = String(markdown);
  const outbound = text.split(/RETURN TIMETABLE/i)[0];
  const start = outbound.indexOf(dayLabel);
  if (start === -1) return out;

  const after = outbound.slice(start + dayLabel.length);
  const nextDay = after.search(/[A-Za-z]+ \(\d{4}-\d{2}-\d{2}\)/);
  const rawBlock = nextDay === -1 ? after : after.slice(0, nextDay);
  const block = rawBlock.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

  const titleMatch = text.match(/([A-Za-zÀ-ÿ.\- ]+?),\s*Germany\s*-\s*Trelleborg/i);
  const origin = titleMatch ? titleMatch[1].trim() : `route ${routeId}`;
  const operator = operatorFromText(outbound);

  const times = Array.from(block.matchAll(/(\d{2}:\d{2})(\^?)/g)).map((m) => ({
    time: m[1],
    next: m[2] === "^",
  }));
  for (let i = 0; i + 1 < times.length; i += 2) {
    const arr = times[i + 1];
    if (arr.next) continue;
    const t = parseDate(`${dateToken} ${arr.time}`);
    if (!t || !isSameDay(t, targetDate)) continue;
    out.push({
      vesselName: `${operator} ${origin}–Trelleborg`,
      plannedTime: t,
      status: statusFromEta(t),
      source: `${operator} tidtabell (${origin}–Trelleborg, ej AIS-bekräftad)`,
      feedKind: "expected",
    });
  }
  return out;
};

const vKeyOf = (name) => name.toLowerCase().replace(/\s+/g, " ").trim();
const dayKeyOf = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

const reconcile = (rows) => {
  const byExactKey = new Map();
  for (const r of rows) {
    const key = `${vKeyOf(r.vesselName)}|${r.plannedTime.toISOString()}|${r.status}`;
    if (!byExactKey.has(key)) byExactKey.set(key, r);
  }
  const deduped = Array.from(byExactKey.values());

  const arrived = deduped.filter((r) => r.status === "arrived");

  const expectedWindowMs = 2 * 60 * 60 * 1000;
  const mergedExpected = [];
  for (const row of deduped) {
    if (row.status === "arrived") {
      mergedExpected.push(row);
      continue;
    }
    const vKey = vKeyOf(row.vesselName);
    const dup = mergedExpected.find(
      (m) =>
        m.status !== "arrived" &&
        vKeyOf(m.vesselName) === vKey &&
        Math.abs(m.plannedTime.getTime() - row.plannedTime.getTime()) <= expectedWindowMs
    );
    if (!dup) {
      mergedExpected.push(row);
      continue;
    }
    if (row.plannedTime.getTime() > dup.plannedTime.getTime()) {
      const idx = mergedExpected.indexOf(dup);
      mergedExpected[idx] = row;
    }
  }

  // Träffsäkerhet: en ETA/försenad-rad som redan har en bekräftad ankomst (samma fartyg, samma
  // dygn, ETA upp till 45 min efter → 10 h före ankomsten) ska inte ligga kvar som "kommande".
  const etaMatchBeforeMs = 45 * 60_000;
  const etaMatchAfterMs = 10 * 60 * 60_000;
  const staleEtaMs = 3 * 60 * 60_000;
  const now = Date.now();

  const cleaned = mergedExpected.filter((row) => {
    if (row.status === "arrived") {
      return true;
    }
    const vKey = vKeyOf(row.vesselName);
    const dayKey = dayKeyOf(row.plannedTime);
    const hasConfirmed = arrived.some((arr) => {
      if (vKeyOf(arr.vesselName) !== vKey || dayKeyOf(arr.plannedTime) !== dayKey) {
        return false;
      }
      const delta = arr.plannedTime.getTime() - row.plannedTime.getTime();
      return delta >= -etaMatchBeforeMs && delta <= etaMatchAfterMs;
    });
    if (hasConfirmed) {
      return false;
    }
    // Gamla "försenade" ETA utan bekräftelse (>3 h sedan) är brus → dölj.
    if (row.status === "delayed" && now - row.plannedTime.getTime() > staleEtaMs) {
      return false;
    }
    return true;
  });

  // TT-Line-tidtabellsrader är fallback: dölj dem när en riktig AIS-rad (ankommen/ETA) redan
  // täcker samma tidsfönster (±30 min), så samma tur inte visas dubbelt.
  const isTimetable = (r) => /tidtabell/i.test(r.source || "");
  const realRows = cleaned.filter((r) => !isTimetable(r));
  const filtered = cleaned.filter((row) => {
    if (!isTimetable(row)) {
      return true;
    }
    const covered = realRows.some(
      (r) =>
        dayKeyOf(r.plannedTime) === dayKeyOf(row.plannedTime) &&
        Math.abs(r.plannedTime.getTime() - row.plannedTime.getTime()) <= 30 * 60_000
    );
    return !covered;
  });

  return filtered
    .sort((a, b) => a.plannedTime.getTime() - b.plannedTime.getTime())
    .slice(0, MAX_RESULT_ROWS)
    .map((r) => ({ ...r, plannedTime: toLocalLikeString(r.plannedTime) }));
};

exports.handler = async (event) => {
  if (event.httpMethod && event.httpMethod === "OPTIONS") {
    return jsonResponse(204, {});
  }
  if (event.httpMethod && event.httpMethod !== "GET") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  const qs = event.queryStringParameters || {};
  const port = typeof qs.port === "string" ? qs.port : "";
  const date = typeof qs.date === "string" ? qs.date : "";
  const includeAll = qs.all === "1";

  // Strikt validering — port måste vara känd och date exakt YYYY-MM-DD.
  // Detta hindrar att godtyckliga värden injiceras i upstream-URL:er (t.ex. e-ferry-anropet).
  if (!Object.prototype.hasOwnProperty.call(PORTS, port)) {
    return jsonResponse(400, { error: "Invalid port" });
  }
  if (!DATE_RE.test(date)) {
    return jsonResponse(400, { error: "Invalid date (expected YYYY-MM-DD)" });
  }
  const targetDate = parseDate(`${date} 12:00`);
  if (!targetDate) {
    return jsonResponse(400, { error: "Invalid date" });
  }

  const key = `${port}:${date}:${includeAll ? "all" : "pax"}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.ts < CACHE_TTL_MS) {
    return jsonResponse(200, { arrivals: cached.arrivals, cached: true });
  }

  const cfg = PORTS[port];
  const [sourcePack, callsPack, estimatePack] = await Promise.all([
    fetchWithRetry(cfg.sourceUrl),
    fetchWithRetry(cfg.arrivalsUrl),
    cfg.estimateUrl ? fetchWithRetry(cfg.estimateUrl) : Promise.resolve({ ok: true, text: "" }),
  ]);

  // Om kärnkällorna felar: servera färsk-nog cache som nödfallback istället för tom vy/502.
  if (!sourcePack.ok || !callsPack.ok) {
    if (cached && now - cached.ts < STALE_CACHE_TTL_MS) {
      return jsonResponse(200, { arrivals: cached.arrivals, cached: true, stale: true });
    }
    return jsonResponse(502, { error: "Upstream fetch failed", arrivals: [] });
  }

  const rows = [
    ...parsePortCalls(callsPack.text, port, targetDate, includeAll),
    ...parsePortPage(sourcePack.text, port, targetDate, includeAll),
    ...(estimatePack.ok ? parseEstimate(estimatePack.text, port, targetDate, includeAll) : []),
  ];

  if (port === "trelleborg" && Array.isArray(cfg.scheduleRouteIds)) {
    const packs = await Promise.all(
      cfg.scheduleRouteIds.map((id) =>
        fetchWithRetry(
          `https://r.jina.ai/http://www.e-ferry.eu/pub/default.aspx?Date=${date}&ID=${id}&L=EN&Page=WeekDay`
        )
      )
    );
    for (let i = 0; i < packs.length; i++) {
      if (packs[i].ok) rows.push(...parseSchedule(packs[i].text, targetDate, cfg.scheduleRouteIds[i]));
    }
  }

  const arrivals = reconcile(rows);
  cache.set(key, { ts: now, arrivals });
  return jsonResponse(200, { arrivals, cached: false });
};

