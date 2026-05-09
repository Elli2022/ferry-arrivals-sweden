import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
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

type FerryArrival = {
  id: string;
  vesselName: string;
  plannedTime: Date;
  status: FerryStatus;
  source: string;
};

type PortConfig = {
  name: string;
  sourceUrl: string;
  arrivalsUrl: string;
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
      "https://r.jina.ai/http://myshiptracking.com/ports-arrivals-departures/?pid=2225&type=1",
  },
  trelleborg: {
    name: "Trelleborg",
    sourceUrl:
      "https://r.jina.ai/http://myshiptracking.com/ports/port-of-trelleborg-in-se-sweden-id-427",
    arrivalsUrl:
      "https://r.jina.ai/http://myshiptracking.com/ports-arrivals-departures/?pid=427&type=1",
  },
  helsingborg: {
    name: "Helsingborg",
    sourceUrl:
      "https://r.jina.ai/http://www.myshiptracking.com/ports/port-of-helsingborg-in-se-sweden-id-209",
    arrivalsUrl:
      "https://r.jina.ai/http://myshiptracking.com/ports-arrivals-departures/?pid=209&type=1",
    trafficUrl: "https://r.jina.ai/http://www.oresundslinjen.se/trafikinformation",
  },
};

const AUTO_REFRESH_MS = 30_000;
const PORT_ORDER: PortId[] = ["trelleborg", "helsingborg", "ystad"];

const WEEKDAY_LABELS_SV = ["mån", "tis", "ons", "tors", "fre", "lör", "sön"] as const;

const PASSENGER_FERRY_KEYWORDS: Record<PortId, string[]> = {
  trelleborg: [
    "peter pan",
    "skane",
    "tinker bell",
    "tom sawyer",
    "mecklenburg",
    "nils holgersson",
    "huckleberry finn",
    "robin hood",
    "akca",
    "akka",
    "epsilon",
    "marco polo",
    "jantar unity",
    "copernicus",
  ],
  helsingborg: [
    "tycho brahe",
    "aurora",
    "hamlet",
    "mercuria",
    "uraniborg",
  ],
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

const parseDate = (text: string): Date | null => {
  const normalized = text.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  const match = normalized.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
  if (!match) {
    return null;
  }

  const parsed = new Date(`${match[1]}T${match[2]}:00`);
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
  const normalized = vesselName.toLowerCase();
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

const arrivalsTitleForDate = (selectedDate: Date, portName: string) => {
  const today = new Date();
  const diff = calendarDayDiff(selectedDate, today);
  if (diff === 0) {
    return `Ankomster idag – ${portName}`;
  }
  if (diff === 1) {
    return `Ankomster imorgon – ${portName}`;
  }
  if (diff === -1) {
    return `Ankomster i går – ${portName}`;
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
  const diff = Date.now() - plannedTime.getTime();
  if (diff > delayThresholdMinutes * 60_000) {
    return "delayed";
  }
  return "scheduled";
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
    });
  }

  return arrivals;
};

const generateHelsingborgUpcoming = (targetDate: Date): FerryArrival[] => {
  const now = new Date();
  const selectedDayStart = startOfDay(targetDate);
  const todayStart = startOfDay(now);

  if (selectedDayStart < todayStart) {
    return [];
  }

  const first = isSameCalendarDay(targetDate, now) ? new Date(now) : new Date(targetDate);
  first.setSeconds(0, 0);
  const minuteRemainder = first.getMinutes() % 20;
  if (minuteRemainder !== 0) {
    first.setMinutes(first.getMinutes() + (20 - minuteRemainder));
  }
  if (isSameCalendarDay(targetDate, now) && minuteRemainder === 0) {
    first.setMinutes(first.getMinutes() + 20);
  }

  const endOfDay = new Date(targetDate);
  endOfDay.setHours(23, 59, 59, 999);

  const generated: FerryArrival[] = [];
  let cursor = first;
  while (cursor <= endOfDay) {
    if (isSameCalendarDay(cursor, targetDate)) {
      generated.push({
        id: `helsingborg-oresund-est-${cursor.toISOString()}`,
        vesselName: "Öresundslinjen",
        plannedTime: new Date(cursor),
        status: "scheduled",
        source: "Öresundslinjen tidtabell (standardtrafik var 20:e min)",
      });
    }
    cursor = new Date(cursor.getTime() + 20 * 60 * 1000);
  }
  return generated;
};

const formatTime = (date: Date) =>
  new Intl.DateTimeFormat("sv-SE", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);

const statusLabel: Record<FerryStatus, string> = {
  arrived: "Ankommen",
  scheduled: "Estimerad",
  delayed: "Försenad (est.)",
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

  const selectedPortConfig = PORTS[selectedPort];

  useEffect(() => {
    setSelectedDate((d) => clampToSelectableDay(d));
  }, []);

  const fetchArrivals = useCallback(
    async (refreshMode = false) => {
      if (refreshMode) {
        setIsRefreshing(true);
      } else {
        setIsLoading(true);
      }

      try {
        setError(null);
        const arrivalsPromise = fetch(selectedPortConfig.sourceUrl);
        const portCallsPromise = fetch(selectedPortConfig.arrivalsUrl);
        const trafficPromise =
          selectedPort === "helsingborg" && selectedPortConfig.trafficUrl
            ? fetch(selectedPortConfig.trafficUrl)
            : Promise.resolve(null);

        const [arrivalsResponse, portCallsResponse, trafficResponse] = await Promise.all([
          arrivalsPromise,
          portCallsPromise,
          trafficPromise,
        ]);

        if (!arrivalsResponse.ok || !portCallsResponse.ok) {
          throw new Error("Kunde inte läsa data från källan");
        }
        const markdown = await arrivalsResponse.text();
        const portCallsMarkdown = await portCallsResponse.text();
        const targetDate = selectedDate;
        const parsedFromPortCalls = parsePortCallsArrivals(
          portCallsMarkdown,
          selectedPort,
          targetDate
        );
        const parsedFromMainPage = parseArrivalsFromMarkdown(markdown, selectedPort, targetDate);

        const combined = [...parsedFromPortCalls, ...parsedFromMainPage];
        if (selectedPort === "helsingborg") {
          combined.push(...generateHelsingborgUpcoming(targetDate));
        }
        const unique = new Map<string, FerryArrival>();
        for (const arrival of combined) {
          const key = `${arrival.vesselName}-${arrival.plannedTime.toISOString()}-${arrival.status}`;
          if (!unique.has(key)) {
            unique.set(key, arrival);
          }
        }
        setArrivals(
          Array.from(unique.values()).sort(
            (a, b) => a.plannedTime.getTime() - b.plannedTime.getTime()
          )
        );

        if (trafficResponse?.ok) {
          const trafficText = await trafficResponse.text();
          setTrafficInfo(extractOresundTrafficInfo(trafficText));
        } else {
          setTrafficInfo(null);
        }

        setLastUpdated(new Date());
      } catch (_err) {
        setError("Kunde inte hämta live-data just nu. Försök igen.");
      } finally {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    },
    [selectedDate, selectedPort, selectedPortConfig.arrivalsUrl, selectedPortConfig.sourceUrl]
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

  const arrivedArrivals = arrivals.filter((arrival) => arrival.status === "arrived");
  const upcomingArrivals = arrivals.filter((arrival) => arrival.status !== "arrived");

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
        <View style={styles.freeRealtimeBanner}>
          <Text style={styles.freeRealtimeText}>
            Gratis live-läge från MyShipTracking (rullande lista). Datumväljaren matchar feeden:
            igår, idag eller imorgon — passagerarfärjor enligt nyckelord.
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

        {isLoading ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color="#2563eb" />
            <Text style={styles.helperText}>Hämtar senaste data...</Text>
          </View>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {!isLoading && !error && arrivals.length === 0 ? (
          <Text style={styles.helperText}>
            Inga passagerarfärjeankomster i feeden för {dateLabel}. (Källan har ingen full tidtabell;
            byt hamn eller prova igår/imorgon.)
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
              <Text style={styles.source}>{arrival.source}</Text>
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
              <Text style={styles.source}>{arrival.source}</Text>
            </View>
          ))}

        <Text style={styles.note}>
          Data slås ihop från hamnsidan: fartyg i hamn, förväntade ankomster och aktivitetsflödet
          (endast ARRIVAL), plus anropslistan. Ankommen = registrerad ankomst; estimerad/försenad =
          ETA. Endast valt kalenderdygn och passagerarfärjor enligt nyckelord.
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
});
