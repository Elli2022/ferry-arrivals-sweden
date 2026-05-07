import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
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

const PORTS: Record<PortId, { name: string; sourceUrl: string }> = {
  ystad: {
    name: "Ystad",
    sourceUrl:
      "https://r.jina.ai/http://www.myshiptracking.com/ports/port-of-ystad-in-se-sweden-id-2225",
  },
  trelleborg: {
    name: "Trelleborg",
    sourceUrl:
      "https://r.jina.ai/http://myshiptracking.com/ports/port-of-trelleborg-in-se-sweden-id-427",
  },
  helsingborg: {
    name: "Helsingborg",
    sourceUrl:
      "https://r.jina.ai/http://www.myshiptracking.com/ports/port-of-helsingborg-in-se-sweden-id-209",
  },
};

const AUTO_REFRESH_MS = 60_000;

const parseDate = (text: string): Date | null => {
  const match = text.match(/(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/);
  if (!match) {
    return null;
  }

  const parsed = new Date(`${match[1]}T${match[2]}:00`);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
};

const isToday = (date: Date) => {
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
};

const getStatusFromEta = (plannedTime: Date): FerryStatus => {
  const delayThresholdMinutes = 20;
  const diff = Date.now() - plannedTime.getTime();
  if (diff > delayThresholdMinutes * 60_000) {
    return "delayed";
  }
  return "scheduled";
};

const parseArrivalsFromMarkdown = (markdown: string, portId: PortId): FerryArrival[] => {
  const rows = markdown.split("\n");
  const arrivals: FerryArrival[] = [];

  for (const row of rows) {
    if (!row.includes("|")) {
      continue;
    }

    if (row.includes("| ARRIVAL |")) {
      const cells = row.split("|").map((cell) => cell.trim()).filter(Boolean);
      if (cells.length < 3) {
        continue;
      }
      const plannedTime = parseDate(cells[0]);
      if (!plannedTime || !isToday(plannedTime)) {
        continue;
      }
      const vesselName = cells[2].replace(/\[|\]|\(.*?\)/g, "").trim();
      arrivals.push({
        id: `${portId}-arrived-${vesselName}-${plannedTime.toISOString()}`,
        vesselName,
        plannedTime,
        status: "arrived",
        source: "MyShipTracking activity feed",
      });
      continue;
    }

    const expectedPattern = /^\|\s*\d+\s*\|/;
    if (!expectedPattern.test(row)) {
      continue;
    }

    const cells = row.split("|").map((cell) => cell.trim()).filter(Boolean);
    if (cells.length < 3) {
      continue;
    }
    const plannedTime = parseDate(cells[2]);
    if (!plannedTime || !isToday(plannedTime)) {
      continue;
    }

    const vesselName = cells[1].replace(/\[|\]|\(.*?\)/g, "").trim();
    arrivals.push({
      id: `${portId}-expected-${vesselName}-${plannedTime.toISOString()}`,
      vesselName,
      plannedTime,
      status: getStatusFromEta(plannedTime),
      source: "MyShipTracking expected arrivals",
    });
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

const formatTime = (date: Date) =>
  new Intl.DateTimeFormat("sv-SE", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);

const statusLabel: Record<FerryStatus, string> = {
  arrived: "Ankommen",
  scheduled: "Planerad",
  delayed: "Försenad",
};

export default function App() {
  const [selectedPort, setSelectedPort] = useState<PortId>("ystad");
  const [arrivals, setArrivals] = useState<FerryArrival[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const selectedPortConfig = PORTS[selectedPort];

  const fetchArrivals = useCallback(
    async (refreshMode = false) => {
      if (refreshMode) {
        setIsRefreshing(true);
      } else {
        setIsLoading(true);
      }

      try {
        setError(null);
        const response = await fetch(selectedPortConfig.sourceUrl);
        if (!response.ok) {
          throw new Error("Kunde inte läsa data från källan");
        }
        const markdown = await response.text();
        const parsed = parseArrivalsFromMarkdown(markdown, selectedPort);
        setArrivals(parsed);
        setLastUpdated(new Date());
      } catch (_err) {
        setError("Kunde inte hämta live-data just nu. Försök igen.");
      } finally {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    },
    [selectedPort, selectedPortConfig.sourceUrl]
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

  const todayLabel = useMemo(
    () =>
      new Intl.DateTimeFormat("sv-SE", {
        weekday: "long",
        day: "numeric",
        month: "long",
      }).format(new Date()),
    []
  );

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Text style={styles.title}>Färjeankomster</Text>
        <Text style={styles.subtitle}>{todayLabel}</Text>
      </View>

      <View style={styles.tabRow}>
        {(Object.keys(PORTS) as PortId[]).map((portId) => {
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
        <Text style={styles.sectionTitle}>Ankomster idag - {selectedPortConfig.name}</Text>
        {lastUpdated ? (
          <Text style={styles.lastUpdated}>Senast uppdaterad {formatTime(lastUpdated)}</Text>
        ) : null}

        {isLoading ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color="#2563eb" />
            <Text style={styles.helperText}>Hämtar senaste data...</Text>
          </View>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {!isLoading && !error && arrivals.length === 0 ? (
          <Text style={styles.helperText}>Inga ankomster hittades för idag.</Text>
        ) : null}

        {!isLoading &&
          !error &&
          arrivals.map((arrival) => (
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

        <Text style={styles.note}>
          Status "Försenad" beräknas automatiskt när planerad tid har passerat mer än 20 min.
          Inställd-status kräver separat operatörsdata/API.
        </Text>
      </ScrollView>
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
  lastUpdated: {
    color: "#94a3b8",
    fontSize: 12,
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
    backgroundColor: "#111827",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#1f2937",
    padding: 14,
    gap: 8,
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
