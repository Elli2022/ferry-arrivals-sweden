import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

type PortId = "ystad" | "trelleborg" | "helsingborg";
type FerryStatus = "arrived" | "scheduled" | "delayed";
/** Vilken MyShipTracking-del raden kommer ifrån (underflikar per hamn). */
type ArrivalFeedKind = "activity" | "port_calls" | "in_port" | "expected";

type ListFeedTabId = "alla" | "ankomna" | "i_hamn" | "forvantade";

const LIST_FEED_TABS: { id: ListFeedTabId; label: string }[] = [
  { id: "alla", label: "Allt" },
  { id: "ankomna", label: "Ankomna" },
  { id: "i_hamn", label: "I hamn" },
  { id: "forvantade", label: "Förväntade ankomster" },
];

type FerryArrival = {
  id: string;
  vesselName: string;
  plannedTime: Date;
  status: FerryStatus;
  source: string;
  feedKind: ArrivalFeedKind;
};

const arrivalMatchesFeedTab = (a: FerryArrival, tab: ListFeedTabId): boolean => {
  if (tab === "alla") {
    return true;
  }
  if (tab === "ankomna") {
    return a.feedKind === "activity" || a.feedKind === "port_calls";
  }
  if (tab === "i_hamn") {
    return a.feedKind === "in_port";
  }
  return a.feedKind === "expected";
};

type PortConfig = {
  name: string;
  sourceUrl: string;
  arrivalsUrl: string;
  /** Full ETA-tabell (saknas ofta i hamnsidans utdrag). */
  estimateUrl?: string;
  trafficUrl?: string;
};

type TrafficInfo = {
  message: string;
  source: string;
  severity: "normal" | "warning";
};

const PORTS: Record<PortId, PortConfig> = {
  ystad: {
    name: "Ystad",
    sourceUrl:
      "https://r.jina.ai/http://www.myshiptracking.com/ports/port-of-ystad-in-se-sweden-id-2225",
    arrivalsUrl:
      "https://r.jina.ai/http://www.myshiptracking.com/ports-arrivals-departures/?pid=2225&type=1",
    estimateUrl: "https://r.jina.ai/http://www.myshiptracking.com/estimate?pid=2225",
  },
  trelleborg: {
    name: "Trelleborg",
    sourceUrl:
      "https://r.jina.ai/http://www.myshiptracking.com/ports/port-of-trelleborg-in-se-sweden-id-427",
    arrivalsUrl:
      "https://r.jina.ai/http://www.myshiptracking.com/ports-arrivals-departures/?pid=427&type=1",
    estimateUrl: "https://r.jina.ai/http://www.myshiptracking.com/estimate?pid=427",
  },
  helsingborg: {
    name: "Helsingborg",
    sourceUrl:
      "https://r.jina.ai/http://www.myshiptracking.com/ports/port-of-helsingborg-in-se-sweden-id-209",
    arrivalsUrl:
      "https://r.jina.ai/http://www.myshiptracking.com/ports-arrivals-departures/?pid=209&type=1",
    estimateUrl: "https://r.jina.ai/http://www.myshiptracking.com/estimate?pid=209",
    trafficUrl: "https://r.jina.ai/http://www.oresundslinjen.se/trafikinformation",
  },
};

const AUTO_REFRESH_MS = 30_000;
/** jina/MyShipTracking kan första gången svara med tomt eller ofullständigt utdrag — omförsök innan tom vy. */
const ARRIVAL_FETCH_EMPTY_RETRY_PAUSE_MS = 2_500;
const ARRIVAL_FETCH_MAX_ATTEMPTS_INITIAL = 3;
const ARRIVAL_FETCH_MAX_ATTEMPTS_REFRESH = 2;
const TRELLEBORG_TTLINE_TIMETABLE_ID_INBOUND = [241, 243] as const;
const CORE_FETCH_TIMEOUT_MS = 12_000;

const fetchTextSafe = async (url: string): Promise<{ ok: boolean; text: string }> => {
  try {
    const response = await fetch(url);
    const text = await response.text();
    return { ok: response.ok, text };
  } catch {
    return { ok: false, text: "" };
  }
};
const fetchTextSafeWithTimeout = async (
  url: string,
  timeoutMs = CORE_FETCH_TIMEOUT_MS
): Promise<{ ok: boolean; text: string }> => {
  return Promise.race([
    fetchTextSafe(url),
    new Promise<{ ok: boolean; text: string }>((resolve) =>
      setTimeout(() => resolve({ ok: false, text: "" }), timeoutMs)
    ),
  ]);
};

const withMirrorVariants = (url: string): string[] => {
  const variants = [url];
  if (url.includes("://www.")) {
    variants.push(url.replace("://www.", "://"));
  } else {
    variants.push(url.replace("://", "://www."));
  }
  return Array.from(new Set(variants));
};

const fetchTextFromAnyMirror = async (url: string): Promise<{ ok: boolean; text: string }> => {
  for (const variant of withMirrorVariants(url)) {
    const res = await fetchTextSafeWithTimeout(variant);
    if (res.ok) {
      return res;
    }
  }
  return { ok: false, text: "" };
};

const keepLikelyUpcomingExpected = (rows: FerryArrival[]) =>
  rows.filter(
    (r) =>
      r.feedKind === "expected" &&
      r.status === "scheduled" &&
      r.plannedTime.getTime() >= Date.now() - 30 * 60 * 1000
  );
const PORT_ORDER: PortId[] = ["trelleborg", "helsingborg", "ystad"];

/** Direkta sidor på MyShipTracking (appen hämtar markdown via r.jina.ai/http://… som mellanled). */
const PUBLIC_MST_PAGES: Record<PortId, { hamn: string; estimate: string; anrop: string }> = {
  trelleborg: {
    hamn: "https://www.myshiptracking.com/ports/port-of-trelleborg-in-se-sweden-id-427",
    estimate: "https://www.myshiptracking.com/estimate?pid=427",
    anrop: "https://www.myshiptracking.com/ports-arrivals-departures/?pid=427&type=1",
  },
  helsingborg: {
    hamn: "https://www.myshiptracking.com/ports/port-of-helsingborg-in-se-sweden-id-209",
    estimate: "https://www.myshiptracking.com/estimate?pid=209",
    anrop: "https://www.myshiptracking.com/ports-arrivals-departures/?pid=209&type=1",
  },
  ystad: {
    hamn: "https://www.myshiptracking.com/ports/port-of-ystad-in-se-sweden-id-2225",
    estimate: "https://www.myshiptracking.com/estimate?pid=2225",
    anrop: "https://www.myshiptracking.com/ports-arrivals-departures/?pid=2225&type=1",
  },
};

const WEEKDAY_LABELS_SV = ["mån", "tis", "ons", "tors", "fre", "lör", "sön"] as const;

/** Endast ForSea/Öresundslinjens färjor i Helsingborg — inga andra fartyg i hamnen. */
const ORESUND_FERRY_NAME_FRAGMENTS = [
  "tycho brahe",
  "aurora af helsingborg",
  "aurora af helsingbor",
  "hamlet",
  "mercuria",
  "uraniborg",
] as const;

const PASSENGER_FERRY_KEYWORDS: Record<PortId, string[]> = {
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
    "akca",
    "akka",
    "epsilon",
    "marco polo",
    "jantar unity",
    "copernicus",
  ],
  helsingborg: [...ORESUND_FERRY_NAME_FRAGMENTS],
  ystad: [
    "polonia",
    "varsovia",
    "mazovia",
    "skania",
    "galileusz",
    "wolin",
    "cracovia",
  ],
};

/** Alltid lokal kalendertid (Europe/Stockholm på enheten) — undviker ISO-/UTC-fällor i RN/Web. */
const parseDate = (text: string): Date | null => {
  const normalized = text.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  const match = normalized.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (!match) {
    return null;
  }
  const y = Number(match[1]);
  const mo = Number(match[2]);
  const d = Number(match[3]);
  const hh = Number(match[4]);
  const mm = Number(match[5]);
  const parsed = new Date(y, mo - 1, d, hh, mm, 0, 0);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
};

const extractVesselName = (text: string): string => {
  // Remove image markdown and links while keeping readable vessel labels.
  return text
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\[[A-Z]{2}\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
};

const isPassengerFerry = (portId: PortId, vesselName: string): boolean => {
  const normalized = vesselName.toLowerCase().replace(/\s+/g, " ");
  return PASSENGER_FERRY_KEYWORDS[portId].some((keyword) => normalized.includes(keyword));
};

const extractOresundTrafficInfo = (text: string): TrafficInfo | null => {
  const cleaned = text.replace(/\r/g, "");
  const trafficHeadingIndex = cleaned.indexOf("Trafikinformation");
  if (trafficHeadingIndex === -1) {
    return null;
  }

  const trafficChunk = cleaned.slice(trafficHeadingIndex, trafficHeadingIndex + 2500);
  const paragraphMatches = Array.from(trafficChunk.matchAll(/<p>(.*?)<\/p>/g))
    .map((match) => match[1].replace(/&nbsp;/g, " ").replace(/<[^>]+>/g, "").trim())
    .filter(Boolean);

  const message = paragraphMatches.slice(0, 2).join(" ");
  if (!message) {
    return null;
  }

  const lower = message.toLowerCase();
  const severity = /(inställd|försenad|stopp|avvik)/.test(lower) ? "warning" : "normal";
  return {
    message,
    source: "Öresundslinjen trafikinformation",
    severity,
  };
};

const isSameCalendarDay = (date: Date, targetDate: Date) => {
  return (
    date.getFullYear() === targetDate.getFullYear() &&
    date.getMonth() === targetDate.getMonth() &&
    date.getDate() === targetDate.getDate()
  );
};

const startOfDay = (date: Date) => {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value;
};

/** MyShipTracking-feeden täcker i praktiken igår–imorgon; längre datumval är meningslöst. */
const SELECTABLE_DAY_OFFSET = 1;

const addCalendarDays = (date: Date, days: number) => {
  const d = startOfDay(date);
  d.setDate(d.getDate() + days);
  return d;
};

const selectableDayBounds = () => {
  const today = startOfDay(new Date());
  return {
    min: addCalendarDays(today, -SELECTABLE_DAY_OFFSET),
    max: addCalendarDays(today, SELECTABLE_DAY_OFFSET),
    today,
  };
};

const clampToSelectableDay = (date: Date) => {
  const { min, max } = selectableDayBounds();
  const t = startOfDay(date).getTime();
  if (t < min.getTime()) {
    return min;
  }
  if (t > max.getTime()) {
    return max;
  }
  return startOfDay(date);
};

const isSelectableCalendarDay = (date: Date) => {
  const { min, max } = selectableDayBounds();
  const t = startOfDay(date).getTime();
  return t >= min.getTime() && t <= max.getTime();
};

const monthIndex = (d: Date) => d.getFullYear() * 12 + d.getMonth();

const buildMonthGridCells = (viewMonthStart: Date) => {
  const year = viewMonthStart.getFullYear();
  const month = viewMonthStart.getMonth();
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  const cells: { date: Date; inCurrentMonth: boolean }[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(year, month, 1 - offset + i);
    cells.push({
      date: startOfDay(d),
      inCurrentMonth: d.getMonth() === month,
    });
  }
  return cells;
};

const calendarDayDiff = (a: Date, b: Date) => {
  const startA = startOfDay(a).getTime();
  const startB = startOfDay(b).getTime();
  return Math.round((startA - startB) / 86_400_000);
};

const weekdayDayMonthSv = (d: Date) =>
  new Intl.DateTimeFormat("sv-SE", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(d);

const arrivalsTitleForDate = (selectedDate: Date, portName: string) => {
  const today = new Date();
  const diff = calendarDayDiff(selectedDate, today);
  const dayLabel = weekdayDayMonthSv(selectedDate);
  if (diff === 0) {
    return `Ankomster idag (${dayLabel}) – ${portName}`;
  }
  if (diff === 1) {
    return `Ankomster imorgon (${dayLabel}) – ${portName}`;
  }
  if (diff === -1) {
    return `Ankomster i går (${dayLabel}) – ${portName}`;
  }
  const formatted = new Intl.DateTimeFormat("sv-SE", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(selectedDate);
  return `Ankomster ${formatted} – ${portName}`;
};

const getStatusFromEta = (plannedTime: Date): FerryStatus => {
  const delayThresholdMinutes = 20;
  if (plannedTime.getTime() > Date.now() + delayThresholdMinutes * 60_000) {
    return "scheduled";
  }
  if (Date.now() - plannedTime.getTime() > delayThresholdMinutes * 60_000) {
    return "delayed";
  }
  return "scheduled";
};

const normalizeVesselKey = (name: string) => name.toLowerCase().replace(/\s+/g, " ").trim();

const feedKindRank: Record<ArrivalFeedKind, number> = {
  port_calls: 4,
  activity: 3,
  in_port: 2,
  expected: 1,
};

/** Samma ankomst från flera tabeller → en rad; ETA som redan skett ersätts av bekräftad ankomst. */
const reconcileArrivalList = (rows: FerryArrival[]): FerryArrival[] => {
  const arrived = rows.filter((r) => r.status === "arrived");
  const etaLike = rows.filter((r) => r.status !== "arrived");

  const dedupedArrived: FerryArrival[] = [];
  for (const row of arrived.sort((a, b) => a.plannedTime.getTime() - b.plannedTime.getTime())) {
    const key = normalizeVesselKey(row.vesselName);
    const dup = dedupedArrived.find(
      (m) =>
        normalizeVesselKey(m.vesselName) === key &&
        Math.abs(m.plannedTime.getTime() - row.plannedTime.getTime()) < 6 * 60_000
    );
    if (!dup) {
      dedupedArrived.push(row);
      continue;
    }
    if (feedKindRank[row.feedKind] > feedKindRank[dup.feedKind]) {
      const idx = dedupedArrived.indexOf(dup);
      dedupedArrived[idx] = row;
    }
  }

  const etaMatchBeforeMs = 45 * 60_000;
  const etaMatchAfterMs = 10 * 60 * 60_000;
  const staleEtaMs = 3 * 60 * 60_000;

  const dedupedEta: FerryArrival[] = [];
  for (const eta of etaLike.sort((a, b) => a.plannedTime.getTime() - b.plannedTime.getTime())) {
    const dup = dedupedEta.find(
      (m) =>
        normalizeVesselKey(m.vesselName) === normalizeVesselKey(eta.vesselName) &&
        Math.abs(m.plannedTime.getTime() - eta.plannedTime.getTime()) <= 2 * 60_000
    );
    if (!dup) {
      dedupedEta.push(eta);
      continue;
    }
    if (feedKindRank[eta.feedKind] > feedKindRank[dup.feedKind]) {
      const idx = dedupedEta.indexOf(dup);
      dedupedEta[idx] = eta;
    }
  }

  const keptEta: FerryArrival[] = [];
  for (const eta of dedupedEta) {
    const vKey = normalizeVesselKey(eta.vesselName);
    const etaDay = startOfDay(eta.plannedTime).getTime();
    const hasConfirmed = dedupedArrived.some((arr) => {
      if (normalizeVesselKey(arr.vesselName) !== vKey) {
        return false;
      }
      if (startOfDay(arr.plannedTime).getTime() !== etaDay) {
        return false;
      }
      const delta = arr.plannedTime.getTime() - eta.plannedTime.getTime();
      return delta >= -etaMatchBeforeMs && delta <= etaMatchAfterMs;
    });
    if (hasConfirmed) {
      continue;
    }
    if (eta.status === "delayed" && Date.now() - eta.plannedTime.getTime() > staleEtaMs) {
      continue;
    }
    keptEta.push(eta);
  }

  return [...dedupedArrived, ...keptEta].sort(
    (a, b) => a.plannedTime.getTime() - b.plannedTime.getTime()
  );
};

const parseArrivalsFromMarkdown = (
  markdown: string,
  portId: PortId,
  targetDate: Date
): FerryArrival[] => {
  const rows = markdown.split("\n");
  const arrivals: FerryArrival[] = [];
  let section: "none" | "in_port" | "expected" | "activity" = "none";

  for (const row of rows) {
    if (row.startsWith("### ")) {
      if (row.includes("Vessels In Port") || row.includes("Vessels currently in port")) {
        section = "in_port";
      } else if (row.includes("Expected Arrivals")) {
        section = "expected";
      } else if (row.includes("Activity")) {
        section = "activity";
      } else {
        section = "none";
      }
      continue;
    }

    if (!row.includes("|")) {
      continue;
    }

    const cells = row.split("|").map((cell) => cell.trim()).filter(Boolean);

    if (section === "in_port") {
      if (cells.length < 2 || cells[0] === "Vessel" || cells[0] === "---") {
        continue;
      }
      const plannedTime = parseDate(cells[1]);
      if (!plannedTime || !isSameCalendarDay(plannedTime, targetDate)) {
        continue;
      }
      const vesselName = extractVesselName(cells[0]);
      if (!vesselName || !isPassengerFerry(portId, vesselName)) {
        continue;
      }
      arrivals.push({
        id: `${portId}-inport-${vesselName}-${plannedTime.toISOString()}`,
        vesselName,
        plannedTime,
        status: "arrived",
        source: "MyShipTracking vessels in port",
        feedKind: "in_port",
      });
      continue;
    }

    if (section === "activity") {
      if (cells.length < 3 || cells[0] === "Time" || cells[0] === "---") {
        continue;
      }
      if (!/\bARRIVAL\b/i.test(cells[1] ?? "")) {
        continue;
      }
      const plannedTime = parseDate(cells[0]);
      if (!plannedTime || !isSameCalendarDay(plannedTime, targetDate)) {
        continue;
      }
      const vesselName = extractVesselName(cells[2]);
      if (!vesselName || !isPassengerFerry(portId, vesselName)) {
        continue;
      }
      arrivals.push({
        id: `${portId}-arrived-${vesselName}-${plannedTime.toISOString()}`,
        vesselName,
        plannedTime,
        status: "arrived",
        source: "MyShipTracking activity feed",
        feedKind: "activity",
      });
      continue;
    }

    if (section === "expected") {
      if (cells.length < 3 || cells[0] === "MMSI" || cells[0] === "---") {
        continue;
      }
      const plannedTime = parseDate(cells[2]);
      if (!plannedTime || !isSameCalendarDay(plannedTime, targetDate)) {
        continue;
      }
      const vesselName = extractVesselName(cells[1]);
      if (!vesselName || !isPassengerFerry(portId, vesselName)) {
        continue;
      }
      arrivals.push({
        id: `${portId}-expected-${vesselName}-${plannedTime.toISOString()}`,
        vesselName,
        plannedTime,
        status: getStatusFromEta(plannedTime),
        source: "MyShipTracking expected arrivals",
        feedKind: "expected",
      });
    }
  }

  const unique = new Map<string, FerryArrival>();
  for (const arrival of arrivals) {
    const key = `${arrival.vesselName}-${arrival.plannedTime.toISOString()}`;
    if (!unique.has(key)) {
      unique.set(key, arrival);
    }
  }

  return Array.from(unique.values()).sort(
    (a, b) => a.plannedTime.getTime() - b.plannedTime.getTime()
  );
};

const parsePortCallsArrivals = (
  markdown: string,
  portId: PortId,
  targetDate: Date
): FerryArrival[] => {
  const rows = markdown.split("\n");
  const arrivals: FerryArrival[] = [];

  for (const row of rows) {
    if (!/\|\s*Arrival\s*\|/i.test(row)) {
      continue;
    }
    const cells = row.split("|").map((cell) => cell.trim()).filter(Boolean);
    if (cells.length < 4) {
      continue;
    }
    const plannedTime = parseDate(cells[1]);
    if (!plannedTime || !isSameCalendarDay(plannedTime, targetDate)) {
      continue;
    }
    const vesselName = extractVesselName(cells[3]);
    if (!vesselName || !isPassengerFerry(portId, vesselName)) {
      continue;
    }
    arrivals.push({
      id: `${portId}-portcalls-${vesselName}-${plannedTime.toISOString()}`,
      vesselName,
      plannedTime,
      status: "arrived",
      source: "MyShipTracking port calls (arrivals)",
      feedKind: "port_calls",
    });
  }

  return arrivals;
};

/** ETA-sidan `estimate?pid=` har ofta fler rader än hamnsidans korta Expected-tabell (viktigt för Öresund). */
const parseEstimatePageMarkdown = (
  markdown: string,
  portId: PortId,
  targetDate: Date
): FerryArrival[] => {
  const rows = markdown.split("\n");
  const arrivals: FerryArrival[] = [];
  let inTable = false;

  for (const row of rows) {
    if (row.includes("| MMSI |") && row.includes("Estimated Arrival")) {
      inTable = true;
      continue;
    }
    if (inTable && /^\|\s*-/.test(row)) {
      continue;
    }
    if (inTable && /Showing\s+\d+\s*-\s*\d+\s+of\s+\d+\s+Results/i.test(row)) {
      break;
    }
    if (inTable && row.startsWith("#")) {
      break;
    }
    if (!inTable || !row.includes("|")) {
      continue;
    }

    const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length < 3) {
      continue;
    }
    if (cells[0] === "MMSI" || !/^\d/.test(cells[0])) {
      continue;
    }

    const timeCell = cells[cells.length - 1];
    const plannedTime = parseDate(timeCell);
    if (!plannedTime || !isSameCalendarDay(plannedTime, targetDate)) {
      continue;
    }
    const vesselName = extractVesselName(cells[1]);
    if (!vesselName || !isPassengerFerry(portId, vesselName)) {
      continue;
    }

    arrivals.push({
      id: `${portId}-estimate-${vesselName}-${plannedTime.toISOString()}`,
      vesselName,
      plannedTime,
      status: getStatusFromEta(plannedTime),
      source: "MyShipTracking estimate (full ETA-lista)",
      feedKind: "expected",
    });
  }

  return arrivals;
};

const dateIsoLocal = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const weekdayEnForDate = (d: Date) =>
  new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(d);

const parseTTLineScheduleForDate = (
  markdown: string,
  targetDate: Date,
  routeId: number
): FerryArrival[] => {
  const dayToken = `${weekdayEnForDate(targetDate)} (${dateIsoLocal(targetDate)})`;
  const rows = markdown.split("\n");
  const results: FerryArrival[] = [];
  let inDayBlock = false;

  for (const row of rows) {
    if (row.includes(dayToken)) {
      inDayBlock = true;
      continue;
    }
    if (inDayBlock && /^[A-Za-z]+ \(\d{4}-\d{2}-\d{2}\)/.test(row.trim())) {
      break;
    }
    if (!inDayBlock || !row.includes("| DepartureArrival |")) {
      continue;
    }

    const matches = Array.from(row.matchAll(/(\d{2}:\d{2})(\^?)/g)).map((m) => ({
      time: m[1],
      nextDay: m[2] === "^",
    }));
    for (let i = 0; i + 1 < matches.length; i += 2) {
      const arrival = matches[i + 1];
      if (arrival.nextDay) {
        continue;
      }
      const plannedTime = parseDate(`${dateIsoLocal(targetDate)} ${arrival.time}`);
      if (!plannedTime || !isSameCalendarDay(plannedTime, targetDate)) {
        continue;
      }
      results.push({
        id: `trelleborg-ttline-${routeId}-${plannedTime.toISOString()}`,
        vesselName: "TT-Line (tidtabell)",
        plannedTime,
        status: getStatusFromEta(plannedTime),
        source: `TT-Line tidtabell (route ${routeId}, ej AIS-bekräftad)`,
        feedKind: "expected",
      });
    }
  }

  return results;
};

const ORESUND_SHUTTLE_NAMES = ["Tycho Brahe", "Aurora af Helsingborg"] as const;

/**
 * Om varken hamnsida eller estimate ger framtida Öresund-ETA (pendeln syns sällan i trunkerade tabeller),
 * fyll på med ~20-minutersankomster till Helsingborg tills dygnsslut — tydligt märkta som ungefärliga.
 */
const supplementHelsingborgOresundIfNoUpcoming = (
  arrivals: FerryArrival[],
  targetDate: Date
): FerryArrival[] => {
  const now = new Date();
  const dayStart = startOfDay(targetDate);
  if (dayStart.getTime() < startOfDay(now).getTime()) {
    return [];
  }

  const hasScheduledPassenger = arrivals.some(
    (a) =>
      a.status === "scheduled" &&
      isPassengerFerry("helsingborg", a.vesselName)
  );
  if (hasScheduledPassenger) {
    return [];
  }

  const endOfDay = new Date(targetDate);
  endOfDay.setHours(23, 59, 59, 999);

  const oresundSameDay = arrivals
    .filter(
      (a) =>
        isPassengerFerry("helsingborg", a.vesselName) &&
        isSameCalendarDay(a.plannedTime, targetDate)
    )
    .sort((a, b) => b.plannedTime.getTime() - a.plannedTime.getTime());

  let cursor: Date;
  if (isSameCalendarDay(targetDate, now)) {
    cursor = new Date(now);
    cursor.setSeconds(0, 0);
    const rem = cursor.getMinutes() % 20;
    cursor.setMinutes(rem === 0 ? cursor.getMinutes() + 20 : cursor.getMinutes() + (20 - rem));
    if (oresundSameDay.length > 0) {
      const afterLast = new Date(oresundSameDay[0].plannedTime.getTime() + 20 * 60 * 1000);
      if (afterLast > cursor) {
        cursor = afterLast;
      }
    }
  } else {
    cursor = startOfDay(targetDate);
    const rem = cursor.getMinutes() % 20;
    if (rem !== 0) {
      cursor.setMinutes(cursor.getMinutes() + (20 - rem));
    }
  }

  let nameFlip = 0;
  if (oresundSameDay.length > 0) {
    const last = oresundSameDay[0].vesselName.toLowerCase();
    nameFlip = last.includes("aurora") ? 0 : 1;
  }

  const extra: FerryArrival[] = [];
  while (cursor <= endOfDay && extra.length < 100) {
    if (!isSameCalendarDay(cursor, targetDate)) {
      break;
    }
    const vesselName = ORESUND_SHUTTLE_NAMES[(nameFlip + extra.length) % 2];
    extra.push({
      id: `helsingborg-supplement-${cursor.toISOString()}-${vesselName}`,
      vesselName,
      plannedTime: new Date(cursor),
      status: "scheduled",
      source:
        "Ungefärlig pendelfärjeankomst (~20 min). Visas bara när ingen framtida ETA finns i MyShipTrackings listor.",
      feedKind: "expected",
    });
    cursor = new Date(cursor.getTime() + 20 * 60 * 1000);
  }

  return extra;
};

const formatTime = (date: Date) =>
  new Intl.DateTimeFormat("sv-SE", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);

const statusLabel: Record<FerryStatus, string> = {
  arrived: "Ankommen",
  scheduled: "Kommande (ETA)",
  delayed: "Försenad (ej bekräftad)",
};

const fetchServerAggregated = async (
  portId: PortId,
  date: Date
): Promise<{ ok: boolean; arrivals: FerryArrival[] }> => {
  const dateParam = dateIsoLocal(date);
  try {
    const res = await fetch(`/.netlify/functions/ferries?port=${portId}&date=${dateParam}`);
    if (!res.ok) {
      return { ok: false, arrivals: [] };
    }
    const json = (await res.json()) as {
      arrivals?: Array<
        Omit<FerryArrival, "plannedTime"> & {
          plannedTime: string;
        }
      >;
    };
    const parsed =
      json.arrivals?.map((r) => ({
        ...r,
        plannedTime: parseDate(r.plannedTime) ?? new Date(r.plannedTime),
      })) ?? [];
    return { ok: true, arrivals: parsed };
  } catch {
    return { ok: false, arrivals: [] };
  }
};

export default function App() {
  const [selectedPort, setSelectedPort] = useState<PortId>("trelleborg");
  const [selectedDate, setSelectedDate] = useState<Date>(() => clampToSelectableDay(new Date()));
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [pendingDate, setPendingDate] = useState<Date>(() => clampToSelectableDay(new Date()));
  const [calendarViewMonth, setCalendarViewMonth] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  );
  const [arrivals, setArrivals] = useState<FerryArrival[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [trafficInfo, setTrafficInfo] = useState<TrafficInfo | null>(null);
  const [listFeedTab, setListFeedTab] = useState<ListFeedTabId>("alla");
  const [emptyResultCount, setEmptyResultCount] = useState(0);
  const [errorStreak, setErrorStreak] = useState(0);
  const fetchGenerationRef = useRef(0);
  const arrivalsCacheRef = useRef<Record<string, FerryArrival[]>>({});

  const selectedPortConfig = PORTS[selectedPort];

  useEffect(() => {
    setSelectedDate((d) => clampToSelectableDay(d));
  }, []);

  useEffect(() => {
    setListFeedTab("alla");
  }, [selectedPort]);

  const cacheKey = useMemo(
    () => `${selectedPort}-${dateIsoLocal(selectedDate)}`,
    [selectedPort, selectedDate]
  );

  useEffect(() => {
    setEmptyResultCount(0);
  }, [selectedPort, selectedDate]);

  const fetchArrivals = useCallback(
    async (refreshMode = false) => {
      if (refreshMode) {
        setIsRefreshing(true);
      } else {
        setIsLoading(true);
        const cached = arrivalsCacheRef.current[cacheKey];
        // Visa direkt senaste lyckade svar för hamn+datum om vi har cache.
        if (cached) {
          setArrivals(cached);
        } else {
          setArrivals([]);
        }
      }

      const generation = ++fetchGenerationRef.current;

      try {
        setError(null);
        const maxAttempts = refreshMode
          ? ARRIVAL_FETCH_MAX_ATTEMPTS_REFRESH
          : ARRIVAL_FETCH_MAX_ATTEMPTS_INITIAL;

        let finalList: FerryArrival[] = [];
        let hadCoreSuccess = false;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          if (attempt > 0) {
            await new Promise((resolve) => setTimeout(resolve, ARRIVAL_FETCH_EMPTY_RETRY_PAUSE_MS));
            if (fetchGenerationRef.current !== generation) {
              return;
            }
          }

          const serverAggregated = await fetchServerAggregated(selectedPort, selectedDate);
          if (fetchGenerationRef.current !== generation) {
            return;
          }
          if (serverAggregated.ok && serverAggregated.arrivals.length > 0) {
            finalList = reconcileArrivalList(serverAggregated.arrivals);
            hadCoreSuccess = true;
            const stableImmediate = reconcileArrivalList([
              ...finalList,
              ...keepLikelyUpcomingExpected(arrivalsCacheRef.current[cacheKey] ?? []),
            ]);
            setArrivals(stableImmediate);
            arrivalsCacheRef.current[cacheKey] = stableImmediate;
            setEmptyResultCount((prev) => (stableImmediate.length > 0 ? 0 : prev + 1));
            setErrorStreak(0);
            setLastUpdated(new Date());
            break;
          }

          const [srcPack, callsPack] = await Promise.all([
            fetchTextFromAnyMirror(selectedPortConfig.sourceUrl),
            fetchTextFromAnyMirror(selectedPortConfig.arrivalsUrl),
          ]);

          if (!srcPack.ok || !callsPack.ok) {
            // Tillfälligt källa/proxy-fel: försök igen innan vi visar rött felläge.
            continue;
          }
          hadCoreSuccess = true;
          const markdown = srcPack.text;
          const portCallsMarkdown = callsPack.text;
          if (fetchGenerationRef.current !== generation) {
            return;
          }

          const targetDate = selectedDate;
          const parsedFromPortCalls = parsePortCallsArrivals(
            portCallsMarkdown,
            selectedPort,
            targetDate
          );
          const parsedFromMainPage = parseArrivalsFromMarkdown(markdown, selectedPort, targetDate);

          const combined = [
            ...parsedFromPortCalls,
            ...parsedFromMainPage,
          ];
          let merged = reconcileArrivalList(combined);

          if (selectedPort === "helsingborg") {
            merged = reconcileArrivalList([
              ...merged,
              ...supplementHelsingborgOresundIfNoUpcoming(merged, targetDate),
            ]);
          }

          finalList = merged;
          const cachedForKey = arrivalsCacheRef.current[cacheKey] ?? [];
          const stableImmediate = reconcileArrivalList([
            ...finalList,
            ...keepLikelyUpcomingExpected(cachedForKey),
          ]);
          setArrivals(stableImmediate);
          arrivalsCacheRef.current[cacheKey] = stableImmediate;
          setEmptyResultCount((prev) => (stableImmediate.length > 0 ? 0 : prev + 1));
          setErrorStreak(0);
          setLastUpdated(new Date());

          const estUrl = selectedPortConfig.estimateUrl;
          if (estUrl) {
            void (async () => {
              const estPack = await fetchTextFromAnyMirror(estUrl);
              if (!estPack.ok || fetchGenerationRef.current !== generation) {
                return;
              }
              const estimateRows = parseEstimatePageMarkdown(estPack.text, selectedPort, targetDate);
              let ttRows: FerryArrival[] = [];
              if (selectedPort === "trelleborg") {
                const schedulePacks = await Promise.all(
                  TRELLEBORG_TTLINE_TIMETABLE_ID_INBOUND.map((routeId) =>
                    fetchTextSafe(
                      `https://r.jina.ai/http://www.e-ferry.eu/pub/default.aspx?Date=${dateIsoLocal(targetDate)}&ID=${routeId}&L=EN&Page=WeekDay`
                    )
                  )
                );
                if (fetchGenerationRef.current !== generation) {
                  return;
                }
                ttRows = schedulePacks
                  .map((pack, idx) =>
                    pack.ok
                      ? parseTTLineScheduleForDate(
                          pack.text,
                          targetDate,
                          TRELLEBORG_TTLINE_TIMETABLE_ID_INBOUND[idx]
                        )
                      : []
                  )
                  .flat();
              }
              const enriched = reconcileArrivalList([...stableImmediate, ...estimateRows, ...ttRows]);
              if (fetchGenerationRef.current !== generation) {
                return;
              }
              setArrivals(enriched);
              arrivalsCacheRef.current[cacheKey] = enriched;
              setEmptyResultCount((prev) => (enriched.length > 0 ? 0 : prev + 1));
              setLastUpdated(new Date());
            })();
          }

          if (finalList.length > 0) {
            break;
          }
        }

        if (!hadCoreSuccess) {
          const cached = arrivalsCacheRef.current[cacheKey];
          if (cached) {
            setArrivals(cached);
            setError(null);
            setIsLoading(false);
            setIsRefreshing(false);
            return;
          }
          throw new Error("Kunde inte läsa data från källan");
        }
        if (selectedPort === "helsingborg" && selectedPortConfig.trafficUrl) {
          const trafficUrl = selectedPortConfig.trafficUrl;
          void (async () => {
            try {
              const trafficResponse = await fetch(trafficUrl);
              if (fetchGenerationRef.current !== generation) {
                return;
              }
              if (trafficResponse.ok) {
                const trafficText = await trafficResponse.text();
                if (fetchGenerationRef.current !== generation) {
                  return;
                }
                setTrafficInfo(extractOresundTrafficInfo(trafficText));
              } else {
                setTrafficInfo(null);
              }
            } catch {
              if (fetchGenerationRef.current === generation) {
                setTrafficInfo(null);
              }
            }
          })();
        } else {
          setTrafficInfo(null);
        }
      } catch (_err) {
        const nextStreak = errorStreak + 1;
        setErrorStreak(nextStreak);
        if (nextStreak >= 2) {
          setError("Kunde inte hämta live-data just nu. Försök igen.");
        } else {
          setError(null);
          setTimeout(() => {
            if (fetchGenerationRef.current === generation) {
              void fetchArrivals(true);
            }
          }, 1800);
        }
      } finally {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    },
    [
      selectedDate,
      selectedPort,
      cacheKey,
      errorStreak,
      selectedPortConfig.arrivalsUrl,
      selectedPortConfig.sourceUrl,
      selectedPortConfig.estimateUrl,
      selectedPortConfig.trafficUrl,
    ]
  );

  useEffect(() => {
    fetchArrivals();
  }, [fetchArrivals]);

  useEffect(() => {
    const interval = setInterval(() => {
      fetchArrivals(true);
    }, AUTO_REFRESH_MS);
    return () => clearInterval(interval);
  }, [fetchArrivals]);

  const dateLabel = useMemo(
    () =>
      new Intl.DateTimeFormat("sv-SE", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }).format(selectedDate),
    [selectedDate]
  );

  const arrivalsSectionTitle = useMemo(
    () => arrivalsTitleForDate(selectedDate, selectedPortConfig.name),
    [selectedDate, selectedPortConfig.name]
  );

  const openDatePicker = () => {
    const clamped = clampToSelectableDay(selectedDate);
    setPendingDate(clamped);
    setCalendarViewMonth(new Date(clamped.getFullYear(), clamped.getMonth(), 1));
    setDatePickerOpen(true);
  };

  const { min: selectableMin, max: selectableMax } = selectableDayBounds();
  const selectableMinMonth = new Date(selectableMin.getFullYear(), selectableMin.getMonth(), 1);
  const selectableMaxMonth = new Date(selectableMax.getFullYear(), selectableMax.getMonth(), 1);
  const calendarAtMinMonth = monthIndex(calendarViewMonth) <= monthIndex(selectableMinMonth);
  const calendarAtMaxMonth = monthIndex(calendarViewMonth) >= monthIndex(selectableMaxMonth);

  const calendarCells = useMemo(
    () => buildMonthGridCells(calendarViewMonth),
    [calendarViewMonth]
  );

  const calendarMonthTitle = useMemo(() => {
    const raw = new Intl.DateTimeFormat("sv-SE", {
      month: "long",
      year: "numeric",
    }).format(calendarViewMonth);
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }, [calendarViewMonth]);

  const shiftCalendarMonth = (delta: number) => {
    setCalendarViewMonth((prev) => {
      const { min, max } = selectableDayBounds();
      const minMonth = new Date(min.getFullYear(), min.getMonth(), 1);
      const maxMonth = new Date(max.getFullYear(), max.getMonth(), 1);
      const next = new Date(prev.getFullYear(), prev.getMonth() + delta, 1);
      if (monthIndex(next) < monthIndex(minMonth)) {
        return minMonth;
      }
      if (monthIndex(next) > monthIndex(maxMonth)) {
        return maxMonth;
      }
      return next;
    });
  };

  const jumpPendingToToday = () => {
    const t = clampToSelectableDay(new Date());
    setPendingDate(t);
    setCalendarViewMonth(new Date(t.getFullYear(), t.getMonth(), 1));
  };

  const arrivalsForTab = useMemo(
    () => arrivals.filter((row) => arrivalMatchesFeedTab(row, listFeedTab)),
    [arrivals, listFeedTab]
  );

  /** Past ETA från "Expected arrivals" blir status delayed → under Ankomna-gruppen, inte Kommande. */
  const upcomingArrivals = arrivalsForTab.filter((arrival) => arrival.status === "scheduled");
  const arrivedArrivals = arrivalsForTab.filter((arrival) => arrival.status !== "scheduled");

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Text style={styles.title}>Färjeankomster</Text>
        <Text style={styles.subtitle}>{dateLabel}</Text>
      </View>

      <View style={styles.dateRow}>
        <Pressable style={styles.datePickerMain} onPress={openDatePicker}>
          <Text style={styles.datePickerHint}>Kalender</Text>
          <Text style={styles.datePickerValue}>{dateLabel}</Text>
        </Pressable>
        <Pressable
          style={styles.dateTodayButton}
          onPress={() => setSelectedDate(clampToSelectableDay(new Date()))}
        >
          <Text style={styles.dateTodayText}>Idag</Text>
        </Pressable>
      </View>

      <View style={styles.tabRow}>
        {PORT_ORDER.map((portId) => {
          const active = portId === selectedPort;
          return (
            <Pressable
              key={portId}
              style={[styles.tab, active && styles.tabActive]}
              onPress={() => setSelectedPort(portId)}
            >
              <Text style={[styles.tabText, active && styles.tabTextActive]}>
                {PORTS[portId].name}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.feedTabBar}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.feedTabBarInner}
        >
          {LIST_FEED_TABS.map(({ id, label }) => {
            const active = listFeedTab === id;
            return (
              <Pressable
                key={id}
                style={[styles.feedTab, active && styles.feedTabActive]}
                onPress={() => setListFeedTab(id)}
              >
                <Text style={[styles.feedTabText, active && styles.feedTabTextActive]}>{label}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={() => fetchArrivals(true)}
            tintColor="#2563eb"
          />
        }
      >
        <Text style={styles.sectionTitle}>{arrivalsSectionTitle}</Text>
        {lastUpdated ? (
          <Text style={styles.lastUpdated}>Senast uppdaterad {formatTime(lastUpdated)}</Text>
        ) : null}
        {(isLoading || isRefreshing) ? (
          <View style={styles.loadingBanner}>
            <ActivityIndicator size="small" color="#93c5fd" />
            <Text style={styles.loadingBannerText}>Uppdaterar färjedata...</Text>
          </View>
        ) : null}
        <View style={styles.freeRealtimeBanner}>
          <Text style={styles.freeRealtimeText}>
            {selectedPort === "helsingborg"
              ? "Helsingborg: hämtar även den separata ETA-sidan (estimate?pid=) — hamnsidans tabell saknar ofta pendelbåtarna. Saknas alla framtida ETA visas ~20-minutersankomster (ungefärligt). Övrigt som förut."
              : "Vi hämtar hamnsida + anropslista + ETA-sidan estimate?pid= (ofta fler rader än i hamnutdraget). Datumväljaren: igår, idag eller imorgon — passagerarfärjor."}
          </Text>
        </View>
        {selectedPort === "helsingborg" && trafficInfo ? (
          <View
            style={[
              styles.trafficCard,
              trafficInfo.severity === "warning" ? styles.trafficWarning : styles.trafficNormal,
            ]}
          >
            <Text style={styles.trafficTitle}>Helsingborg: Trafikläge från Öresundslinjen</Text>
            <Text style={styles.trafficMessage}>{trafficInfo.message}</Text>
            <Text style={styles.source}>{trafficInfo.source}</Text>
          </View>
        ) : null}

        {isLoading && arrivals.length === 0 ? (
          <View style={styles.skeletonWrap}>
            <View style={styles.skeletonCard}>
              <View style={styles.skeletonRow}>
                <View style={[styles.skeletonLine, styles.skeletonTime]} />
                <View style={[styles.skeletonLine, styles.skeletonBadge]} />
              </View>
              <View style={[styles.skeletonLine, styles.skeletonVessel]} />
              <View style={[styles.skeletonLine, styles.skeletonSource]} />
            </View>
            <View style={styles.skeletonCard}>
              <View style={styles.skeletonRow}>
                <View style={[styles.skeletonLine, styles.skeletonTime]} />
                <View style={[styles.skeletonLine, styles.skeletonBadge]} />
              </View>
              <View style={[styles.skeletonLine, styles.skeletonVessel]} />
              <View style={[styles.skeletonLine, styles.skeletonSource]} />
            </View>
            <View style={styles.skeletonCard}>
              <View style={styles.skeletonRow}>
                <View style={[styles.skeletonLine, styles.skeletonTime]} />
                <View style={[styles.skeletonLine, styles.skeletonBadge]} />
              </View>
              <View style={[styles.skeletonLine, styles.skeletonVessel]} />
              <View style={[styles.skeletonLine, styles.skeletonSource]} />
            </View>
            <View style={styles.centered}>
              <ActivityIndicator size="small" color="#2563eb" />
              <Text style={styles.helperText}>Hämtar senaste data...</Text>
              <Text style={styles.loadingSubhint}>
                Proxyn/hamnsidan kan svara segt — vi visar laddningskort tills första svar kommer.
              </Text>
            </View>
          </View>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {!isLoading && !error && arrivals.length === 0 && emptyResultCount >= 2 ? (
          <Text style={styles.helperText}>
            {selectedPort === "helsingborg"
              ? `Inga Öresundsfärjor i utdraget för ${dateLabel}. Sajten skickar bara de senaste raderna — på kvällen kan morgondagens turer saknas tills de läggs in i feeden. Prova uppdatera senare eller se Öresundslinjens tidtabell.`
              : `Inga passagerarfärjeankomster i feeden för ${dateLabel}. (Källan har ingen full tidtabell; byt hamn eller prova igår/imorgon.)`}
          </Text>
        ) : null}

        {!isLoading && !error && arrivals.length > 0 && arrivalsForTab.length === 0 ? (
          <Text style={styles.helperText}>
            Inga rader i fliken &quot;
            {LIST_FEED_TABS.find((t) => t.id === listFeedTab)?.label ?? ""}&quot; för valt datum —
            prova &quot;Allt&quot; eller en annan källa.
          </Text>
        ) : null}

        {!isLoading && !error && arrivedArrivals.length > 0 ? (
          <Text style={styles.groupTitle}>Ankomna ({arrivedArrivals.length})</Text>
        ) : null}

        {!isLoading &&
          !error &&
          arrivedArrivals.map((arrival) => (
            <View key={arrival.id} style={styles.card}>
              <View style={styles.cardTop}>
                <Text style={styles.time}>{formatTime(arrival.plannedTime)}</Text>
                <View
                  style={[
                    styles.badge,
                    arrival.status === "arrived"
                      ? styles.badge_arrived
                      : arrival.status === "delayed"
                        ? styles.badge_delayed
                        : styles.badge_scheduled,
                  ]}
                >
                  <Text style={styles.badgeText}>{statusLabel[arrival.status]}</Text>
                </View>
              </View>
              <Text style={styles.vessel}>{arrival.vesselName}</Text>
              {selectedPort !== "helsingborg" ? (
                <Text style={styles.source}>{arrival.source}</Text>
              ) : null}
            </View>
          ))}

        {!isLoading && !error && upcomingArrivals.length > 0 ? (
          <Text style={styles.groupTitle}>Kommande ({upcomingArrivals.length})</Text>
        ) : null}

        {!isLoading &&
          !error &&
          upcomingArrivals.map((arrival) => (
            <View key={arrival.id} style={[styles.card, styles.cardUpcoming]}>
              <View style={styles.cardTop}>
                <Text style={styles.time}>{formatTime(arrival.plannedTime)}</Text>
                <View
                  style={[
                    styles.badge,
                    arrival.status === "arrived"
                      ? styles.badge_arrived
                      : arrival.status === "delayed"
                        ? styles.badge_delayed
                        : styles.badge_scheduled,
                  ]}
                >
                  <Text style={styles.badgeText}>{statusLabel[arrival.status]}</Text>
                </View>
              </View>
              <Text style={styles.vessel}>{arrival.vesselName}</Text>
              {selectedPort !== "helsingborg" ? (
                <Text style={styles.source}>{arrival.source}</Text>
              ) : null}
            </View>
          ))}

        <View style={styles.sourcesCard}>
          <Text style={styles.sourcesTitle}>Var hämtas datan?</Text>
          <Text style={styles.sourcesP}>
            Appen använder ingen betald sjöfarts-API eller AIS-nyckel. Vi läser samma publika webbsidor som vem som helst kan öppna i en webbläsare; inför appen anropas de som ren text via proxyn{" "}
            <Text style={styles.sourceMono}>https://r.jina.ai/</Text> så att webben slipper CORS-block mot MyShipTracking.
          </Text>
          <Text style={styles.sourcesP}>
            Vill du dubbelkolla eller se om fler turer finns än i utdraget, öppna originalen för{" "}
            {selectedPortConfig.name}:
          </Text>
          <Pressable onPress={() => Linking.openURL(PUBLIC_MST_PAGES[selectedPort].hamn)}>
            <Text style={styles.sourceLink}>• Hamnsida — aktivitet, fartyg i hamn, kort ETA-ruta</Text>
          </Pressable>
          <Pressable onPress={() => Linking.openURL(PUBLIC_MST_PAGES[selectedPort].estimate)}>
            <Text style={styles.sourceLink}>• ETA-lista — estimate?pid= (hel tabell om MST fyllt i den)</Text>
          </Pressable>
          <Pressable onPress={() => Linking.openURL(PUBLIC_MST_PAGES[selectedPort].anrop)}>
            <Text style={styles.sourceLink}>• Anropslista — ankomster i rullande lista</Text>
          </Pressable>
          {selectedPort === "helsingborg" ? (
            <Pressable
              onPress={() => Linking.openURL("https://www.oresundslinjen.se/trafikinformation")}
            >
              <Text style={styles.sourceLink}>• Öresundslinjen — trafikinformation (text i appen)</Text>
            </Pressable>
          ) : null}
          <Text style={styles.sourcesPMuted}>
            Gratis ”API”:er för fartyg finns ofta med registrering eller strikta gränser (AISHub m.fl.). Den här appen väljer medvetet bara fria webbutdrag så du slipper nycklar — då följer begränsningarna i MST:s korta listor.
          </Text>
          {selectedPort === "trelleborg" ? (
            <Text style={styles.sourcesPMuted}>
              För Trelleborg 10 maj i MST:s utdrag (vid senaste kontroll): estimate-tabellen kunde vara tom samtidigt som anropslistan visade passagerarfärjeankomster tidigt på dygnet — senare turer kan saknas tills de dyker i feeden eller finns bara hos rederiet (TT-Line).
            </Text>
          ) : null}
        </View>

        <Text style={styles.note}>
          {selectedPort === "helsingborg"
            ? "ETA-listan estimate-sidan ger oftast korrekta nästa Tycho/Aurora-tider; saknas de visas pendlings-placeholder (~20 min) under Förväntade. Underflikar som övriga hamnar."
            : "Underflikarna filtrerar per källa. Om samma fartyg har både ETA och bekräftad ankomst (anropslista/aktivitet) visas bara ankomsten — gamla ETA-rader tas bort så de inte står kvar som försenade i timmar. Kommande = framtida ETA utan bekräftad ankomst."}
        </Text>
      </ScrollView>

      <Modal
        visible={datePickerOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setDatePickerOpen(false)}
      >
        <View style={styles.dateModalRoot}>
          <Pressable style={styles.dateModalBackdrop} onPress={() => setDatePickerOpen(false)} />
          <View style={styles.dateModalCard}>
            <View style={styles.dateModalHeaderRow}>
              <Text style={styles.dateModalTitle}>Välj datum</Text>
              <Pressable style={styles.dateModalTodayChip} onPress={jumpPendingToToday}>
                <Text style={styles.dateModalTodayChipText}>Idag</Text>
              </Pressable>
            </View>
            <Text style={styles.dateModalHint}>
              Live-feeden täcker igår–idag–imorgon; andra datum döljs.
            </Text>

            <View style={styles.calMonthNav}>
              <Pressable
                style={[styles.calNavHit, calendarAtMinMonth && styles.calNavHitDisabled]}
                onPress={() => shiftCalendarMonth(-1)}
                disabled={calendarAtMinMonth}
                accessibilityLabel="Föregående månad"
              >
                <Text style={[styles.calNavArrow, calendarAtMinMonth && styles.calNavArrowDisabled]}>
                  ‹
                </Text>
              </Pressable>
              <Text style={styles.calMonthTitle}>{calendarMonthTitle}</Text>
              <Pressable
                style={[styles.calNavHit, calendarAtMaxMonth && styles.calNavHitDisabled]}
                onPress={() => shiftCalendarMonth(1)}
                disabled={calendarAtMaxMonth}
                accessibilityLabel="Nästa månad"
              >
                <Text style={[styles.calNavArrow, calendarAtMaxMonth && styles.calNavArrowDisabled]}>
                  ›
                </Text>
              </Pressable>
            </View>

            <View style={styles.calWeekHeader}>
              {WEEKDAY_LABELS_SV.map((label) => (
                <Text key={label} style={styles.calWeekday}>
                  {label}
                </Text>
              ))}
            </View>

            <View style={styles.calGrid}>
              {calendarCells.map((cell, index) => {
                const pendingTs = pendingDate.getTime();
                const cellTs = cell.date.getTime();
                const todayTs = startOfDay(new Date()).getTime();
                const isSelected = cellTs === pendingTs;
                const isToday = cellTs === todayTs;
                const canPick = isSelectableCalendarDay(cell.date);
                return (
                  <Pressable
                    key={`${cellTs}-${index}`}
                    style={[
                      styles.calCell,
                      !cell.inCurrentMonth && styles.calCellOutside,
                      !canPick && styles.calCellDisabled,
                      isSelected && styles.calCellSelected,
                      isToday && !isSelected && canPick && styles.calCellToday,
                    ]}
                    disabled={!canPick}
                    onPress={() => {
                      if (canPick) {
                        setPendingDate(cell.date);
                      }
                    }}
                  >
                    <Text
                      style={[
                        styles.calCellText,
                        !cell.inCurrentMonth && styles.calCellTextOutside,
                        !canPick && styles.calCellTextDisabled,
                        isSelected && styles.calCellTextSelected,
                      ]}
                    >
                      {cell.date.getDate()}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.dateModalActions}>
              <Pressable style={styles.dateModalButtonGhost} onPress={() => setDatePickerOpen(false)}>
                <Text style={styles.dateModalButtonGhostText}>Avbryt</Text>
              </Pressable>
              <Pressable
                style={styles.dateModalButtonPrimary}
                onPress={() => {
                  setSelectedDate(clampToSelectableDay(pendingDate));
                  setDatePickerOpen(false);
                }}
              >
                <Text style={styles.dateModalButtonPrimaryText}>Klart</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#0b1220",
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
  },
  title: {
    color: "#f8fafc",
    fontSize: 28,
    fontWeight: "700",
  },
  subtitle: {
    marginTop: 2,
    color: "#cbd5e1",
    fontSize: 14,
    textTransform: "capitalize",
  },
  tabRow: {
    flexDirection: "row",
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  feedTabBar: {
    borderBottomWidth: 1,
    borderBottomColor: "#1e293b",
    paddingBottom: 6,
  },
  feedTabBarInner: {
    paddingHorizontal: 10,
    gap: 8,
    alignItems: "center",
    flexDirection: "row",
  },
  feedTab: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "#1e293b",
    borderWidth: 1,
    borderColor: "#334155",
  },
  feedTabActive: {
    backgroundColor: "#334155",
    borderColor: "#64748b",
  },
  feedTabText: {
    color: "#94a3b8",
    fontWeight: "700",
    fontSize: 13,
  },
  feedTabTextActive: {
    color: "#f8fafc",
  },
  dateRow: {
    flexDirection: "row",
    paddingHorizontal: 12,
    gap: 8,
    paddingBottom: 6,
    alignItems: "stretch",
  },
  datePickerMain: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#334155",
    backgroundColor: "#0f172a",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  datePickerHint: {
    color: "#94a3b8",
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  datePickerValue: {
    color: "#f8fafc",
    fontSize: 15,
    fontWeight: "700",
    marginTop: 4,
    textTransform: "capitalize",
  },
  dateTodayButton: {
    justifyContent: "center",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#334155",
    backgroundColor: "#1e293b",
    paddingHorizontal: 14,
  },
  dateTodayText: {
    color: "#bfdbfe",
    fontWeight: "700",
    fontSize: 14,
  },
  dateModalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(2, 6, 23, 0.65)",
  },
  dateModalRoot: {
    flex: 1,
    justifyContent: "flex-end",
    alignItems: "center",
  },
  dateModalCard: {
    backgroundColor: "#0f172a",
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 16,
    borderTopWidth: 1,
    borderColor: "#1e293b",
    width: "92%",
    maxWidth: 300,
    alignSelf: "center",
    marginBottom: 8,
  },
  dateModalHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  dateModalTitle: {
    color: "#f8fafc",
    fontSize: 14,
    fontWeight: "700",
  },
  dateModalTodayChip: {
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#334155",
    backgroundColor: "#1e293b",
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  dateModalTodayChipText: {
    color: "#bfdbfe",
    fontWeight: "700",
    fontSize: 12,
  },
  dateModalHint: {
    color: "#94a3b8",
    fontSize: 11,
    lineHeight: 15,
    marginBottom: 8,
  },
  calMonthNav: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  calNavHit: {
    minWidth: 36,
    minHeight: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  calNavHitDisabled: {
    opacity: 0.35,
  },
  calNavArrow: {
    color: "#e2e8f0",
    fontSize: 22,
    fontWeight: "300",
    lineHeight: 26,
  },
  calNavArrowDisabled: {
    color: "#64748b",
  },
  calMonthTitle: {
    color: "#f8fafc",
    fontSize: 15,
    fontWeight: "700",
    textTransform: "capitalize",
  },
  calWeekHeader: {
    flexDirection: "row",
    marginBottom: 4,
  },
  calWeekday: {
    flex: 1,
    textAlign: "center",
    color: "#94a3b8",
    fontSize: 10,
    fontWeight: "700",
    textTransform: "lowercase",
  },
  calGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginBottom: 2,
  },
  calCell: {
    width: "14.28%",
    height: 32,
    maxWidth: "14.28%",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
  },
  calCellOutside: {
    opacity: 0.35,
  },
  calCellDisabled: {
    opacity: 0.22,
  },
  calCellSelected: {
    backgroundColor: "#2563eb",
  },
  calCellToday: {
    borderWidth: 1,
    borderColor: "#f87171",
  },
  calCellText: {
    color: "#f8fafc",
    fontSize: 13,
    fontWeight: "600",
  },
  calCellTextOutside: {
    color: "#cbd5e1",
  },
  calCellTextDisabled: {
    color: "#475569",
  },
  calCellTextSelected: {
    color: "#ffffff",
  },
  dateModalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 8,
  },
  dateModalButtonGhost: {
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  dateModalButtonGhostText: {
    color: "#94a3b8",
    fontWeight: "700",
    fontSize: 15,
  },
  dateModalButtonPrimary: {
    backgroundColor: "#2563eb",
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 18,
  },
  dateModalButtonPrimaryText: {
    color: "#ffffff",
    fontWeight: "700",
    fontSize: 15,
  },
  tab: {
    flex: 1,
    backgroundColor: "#1e293b",
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: "center",
  },
  tabActive: {
    backgroundColor: "#2563eb",
  },
  tabText: {
    color: "#cbd5e1",
    fontWeight: "600",
  },
  tabTextActive: {
    color: "#ffffff",
  },
  content: {
    padding: 16,
    paddingBottom: 36,
    gap: 10,
  },
  sectionTitle: {
    color: "#f8fafc",
    fontSize: 18,
    fontWeight: "600",
  },
  groupTitle: {
    marginTop: 8,
    color: "#bfdbfe",
    fontSize: 14,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.7,
  },
  trafficCard: {
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    gap: 6,
  },
  trafficNormal: {
    backgroundColor: "#0f172a",
    borderColor: "#1d4ed8",
  },
  trafficWarning: {
    backgroundColor: "#3f1d0f",
    borderColor: "#fb923c",
  },
  trafficTitle: {
    color: "#e0e7ff",
    fontWeight: "700",
    fontSize: 13,
  },
  trafficMessage: {
    color: "#f8fafc",
    fontSize: 14,
    lineHeight: 20,
  },
  lastUpdated: {
    color: "#94a3b8",
    fontSize: 12,
  },
  loadingBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#1e40af",
    backgroundColor: "#0b2545",
  },
  loadingBannerText: {
    color: "#dbeafe",
    fontSize: 12,
    fontWeight: "700",
  },
  freeRealtimeBanner: {
    backgroundColor: "#0b2545",
    borderColor: "#1d4ed8",
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  freeRealtimeText: {
    color: "#dbeafe",
    fontSize: 12,
    fontWeight: "600",
  },
  centered: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 30,
    gap: 8,
  },
  helperText: {
    color: "#cbd5e1",
    fontSize: 14,
  },
  loadingSubhint: {
    marginTop: 8,
    color: "#94a3b8",
    fontSize: 12,
    lineHeight: 17,
    textAlign: "center",
    paddingHorizontal: 12,
    maxWidth: 340,
  },
  skeletonWrap: {
    gap: 10,
  },
  skeletonCard: {
    backgroundColor: "#0f172a",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#1f2937",
    padding: 14,
    gap: 10,
  },
  skeletonRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  skeletonLine: {
    borderRadius: 999,
    backgroundColor: "#1e293b",
  },
  skeletonTime: {
    width: 78,
    height: 22,
  },
  skeletonBadge: {
    width: 118,
    height: 18,
  },
  skeletonVessel: {
    width: "64%",
    height: 18,
  },
  skeletonSource: {
    width: "42%",
    height: 14,
  },
  error: {
    color: "#fecaca",
    backgroundColor: "#7f1d1d",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  card: {
    backgroundColor: "#052e16",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#14532d",
    padding: 14,
    gap: 8,
  },
  cardUpcoming: {
    backgroundColor: "#111827",
    borderColor: "#1f2937",
  },
  cardTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  time: {
    color: "#e2e8f0",
    fontSize: 20,
    fontWeight: "700",
  },
  vessel: {
    color: "#f8fafc",
    fontSize: 16,
    fontWeight: "600",
  },
  source: {
    color: "#94a3b8",
    fontSize: 12,
  },
  badge: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  badge_arrived: {
    backgroundColor: "#14532d",
  },
  badge_scheduled: {
    backgroundColor: "#1e3a8a",
  },
  badge_delayed: {
    backgroundColor: "#7c2d12",
  },
  badgeText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "700",
  },
  note: {
    marginTop: 6,
    color: "#94a3b8",
    fontSize: 12,
    lineHeight: 18,
  },
  sourcesCard: {
    marginTop: 14,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#334155",
    backgroundColor: "#0f172a",
    gap: 8,
  },
  sourcesTitle: {
    color: "#e2e8f0",
    fontSize: 15,
    fontWeight: "700",
  },
  sourcesP: {
    color: "#cbd5e1",
    fontSize: 13,
    lineHeight: 19,
  },
  sourcesPMuted: {
    color: "#94a3b8",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 4,
  },
  sourceMono: {
    fontFamily: "monospace",
    color: "#93c5fd",
    fontSize: 12,
  },
  sourceLink: {
    color: "#93c5fd",
    fontSize: 13,
    fontWeight: "600",
    textDecorationLine: "underline",
    paddingVertical: 4,
  },
});
