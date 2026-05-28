const CACHE_TTL_MS = 60_000;
const cache = new Map();

const PORTS = {
  trelleborg: {
    sourceUrl:
      "https://r.jina.ai/http://www.myshiptracking.com/ports/port-of-trelleborg-in-se-sweden-id-427",
    arrivalsUrl:
      "https://r.jina.ai/http://www.myshiptracking.com/ports-arrivals-departures/?pid=427&type=1",
    estimateUrl: "https://r.jina.ai/http://www.myshiptracking.com/estimate?pid=427",
    ttlineRouteIds: [241, 243],
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
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    return { ok: res.ok, text };
  } catch {
    return { ok: false, text: "" };
  } finally {
    clearTimeout(timer);
  }
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

const toLocalLikeString = (d) => {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
};

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

const parsePortPage = (markdown, port, targetDate) => {
  const rows = markdown.split("\n");
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
      if (!t || !isSameDay(t, targetDate) || !v || !isPassenger(port, v)) continue;
      out.push({ vesselName: v, plannedTime: t, status: "arrived", source: "MyShipTracking vessels in port", feedKind: "in_port" });
      continue;
    }
    if (section === "activity") {
      if (cells.length < 3 || cells[0] === "Time" || cells[0] === "---") continue;
      if (!/\bARRIVAL\b/i.test(cells[1] || "")) continue;
      const t = parseDate(cells[0]);
      const v = vesselName(cells[2]);
      if (!t || !isSameDay(t, targetDate) || !v || !isPassenger(port, v)) continue;
      out.push({ vesselName: v, plannedTime: t, status: "arrived", source: "MyShipTracking activity feed", feedKind: "activity" });
      continue;
    }
    if (section === "expected") {
      if (cells.length < 3 || cells[0] === "MMSI" || cells[0] === "---") continue;
      const t = parseDate(cells[2]);
      const v = vesselName(cells[1]);
      if (!t || !isSameDay(t, targetDate) || !v || !isPassenger(port, v)) continue;
      out.push({ vesselName: v, plannedTime: t, status: statusFromEta(t), source: "MyShipTracking expected arrivals", feedKind: "expected" });
    }
  }
  return out;
};

const parsePortCalls = (markdown, port, targetDate) => {
  const rows = markdown.split("\n");
  const out = [];
  for (const row of rows) {
    if (!/\|\s*Arrival\s*\|/i.test(row)) continue;
    const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length < 4) continue;
    const t = parseDate(cells[1]);
    const v = vesselName(cells[3]);
    if (!t || !isSameDay(t, targetDate) || !v || !isPassenger(port, v)) continue;
    out.push({ vesselName: v, plannedTime: t, status: "arrived", source: "MyShipTracking port calls (arrivals)", feedKind: "port_calls" });
  }
  return out;
};

const parseEstimate = (markdown, port, targetDate) => {
  const rows = markdown.split("\n");
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
    if (!t || !isSameDay(t, targetDate) || !v || !isPassenger(port, v)) continue;
    out.push({ vesselName: v, plannedTime: t, status: statusFromEta(t), source: "MyShipTracking estimate (full ETA-lista)", feedKind: "expected" });
  }
  return out;
};

const parseTTLine = (markdown, targetDate, routeId) => {
  const out = [];
  const dayToken = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(targetDate);
  const dateToken = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, "0")}-${String(targetDate.getDate()).padStart(2, "0")}`;
  const rows = markdown.split("\n");
  let inDay = false;
  for (const row of rows) {
    if (row.includes(`${dayToken} (${dateToken})`)) {
      inDay = true;
      continue;
    }
    if (inDay && /^[A-Za-z]+ \(\d{4}-\d{2}-\d{2}\)/.test(row.trim())) break;
    if (!inDay || !row.includes("| DepartureArrival |")) continue;
    const times = Array.from(row.matchAll(/(\d{2}:\d{2})(\^?)/g)).map((m) => ({ time: m[1], next: m[2] === "^" }));
    for (let i = 0; i + 1 < times.length; i += 2) {
      if (times[i + 1].next) continue;
      const t = parseDate(`${dateToken} ${times[i + 1].time}`);
      if (!t || !isSameDay(t, targetDate)) continue;
      out.push({
        vesselName: "TT-Line (tidtabell)",
        plannedTime: t,
        status: statusFromEta(t),
        source: `TT-Line tidtabell (route ${routeId}, ej AIS-bekräftad)`,
        feedKind: "expected",
      });
    }
  }
  return out;
};

const reconcile = (rows) => {
  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.vesselName.toLowerCase().replace(/\s+/g, " ")}|${r.plannedTime.toISOString()}|${r.status}`;
    if (!byKey.has(key)) byKey.set(key, r);
  }
  return Array.from(byKey.values())
    .sort((a, b) => a.plannedTime.getTime() - b.plannedTime.getTime())
    .map((r) => ({ ...r, plannedTime: toLocalLikeString(r.plannedTime) }));
};

exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  const port = qs.port;
  const date = qs.date;
  if (!PORTS[port] || !date) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid port/date" }) };
  }
  const targetDate = parseDate(`${date} 12:00`);
  if (!targetDate) return { statusCode: 400, body: JSON.stringify({ error: "Bad date" }) };
  const key = `${port}:${date}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.ts < CACHE_TTL_MS) {
    return { statusCode: 200, body: JSON.stringify({ arrivals: cached.arrivals, cached: true }) };
  }

  const cfg = PORTS[port];
  const [sourcePack, callsPack, estimatePack] = await Promise.all([
    timeoutFetchText(cfg.sourceUrl),
    timeoutFetchText(cfg.arrivalsUrl),
    cfg.estimateUrl ? timeoutFetchText(cfg.estimateUrl) : Promise.resolve({ ok: true, text: "" }),
  ]);
  if (!sourcePack.ok || !callsPack.ok) {
    return { statusCode: 502, body: JSON.stringify({ error: "Upstream fetch failed" }) };
  }

  let rows = [
    ...parsePortCalls(callsPack.text, port, targetDate),
    ...parsePortPage(sourcePack.text, port, targetDate),
    ...(estimatePack.ok ? parseEstimate(estimatePack.text, port, targetDate) : []),
  ];

  if (port === "trelleborg") {
    const packs = await Promise.all(
      cfg.ttlineRouteIds.map((id) =>
        timeoutFetchText(`https://r.jina.ai/http://www.e-ferry.eu/pub/default.aspx?Date=${date}&ID=${id}&L=EN&Page=WeekDay`)
      )
    );
    for (let i = 0; i < packs.length; i++) {
      if (packs[i].ok) rows.push(...parseTTLine(packs[i].text, targetDate, cfg.ttlineRouteIds[i]));
    }
  }

  const arrivals = reconcile(rows);
  cache.set(key, { ts: now, arrivals });
  return { statusCode: 200, body: JSON.stringify({ arrivals, cached: false }) };
};

