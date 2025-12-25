import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { motion, AnimatePresence, LayoutGroup } from "framer-motion";
import {
  Play,
  Pause,
  SkipForward,
  RotateCw,
  Download,
  Users,
  Clock,
  Target,
  Gauge,
  Plus,
  Minus,
  Timer,
  ChevronDown,
} from "lucide-react";

// ---------- Utilities ----------
const pad = (n) => String(n).padStart(2, "0");
const msToClock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${pad(mm)}:${pad(ss)}`;
};
const labelFor = (format, idx) =>
  format === "Quarters" ? `Q${idx + 1}` : `H${idx + 1}`;
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

// Storage keys
const STORAGE_KEY_STATE = "pt_state_v2"; // bump since schema changed
const STORAGE_KEY_ROSTERS = "pt_rosters_v1";

// Default roster names (11)
const DEFAULT_NAMES = [
  "Stella",
  "Lizzy",
  "Gisella",
  "Tory",
  "Esther",
  "Kaitlin",
  "Sadie",
  "Brigit",
  "Sofia",
  "Scarlett",
  "Empress",
];

// ---------- App ----------
export default function PlayingTimeApp() {
  // Config (mobile-first sensible defaults)
  const [numPlayers, setNumPlayers] = useState(DEFAULT_NAMES.length);
  const [onCourt, setOnCourt] = useState(5);
  const [format, setFormat] = useState("Quarters");
  const [periodMinutes, setPeriodMinutes] = useState(8);

  // Roster storage
  const [rosterName, setRosterName] = useState("My Roster");
  const [savedRosters, setSavedRosters] = useState(() => loadRosters());

  // Derived
  const numPeriods = format === "Quarters" ? 4 : 2;
  const periodLengthMs = periodMinutes * 60 * 1000;

  // Runtime state
  const [currentPeriod, setCurrentPeriod] = useState(0);
  const [periodElapsedMs, setPeriodElapsedMs] = useState(() =>
    Array(numPeriods).fill(0)
  );
  const [players, setPlayers] = useState(() =>
    Array.from({ length: DEFAULT_NAMES.length }, (_, i) => ({
      id: i + 1,
      name: DEFAULT_NAMES[i] ?? `Player ${i + 1}`,
      active: i < onCourt,
      totalMs: 0,
      periodMs: Array(numPeriods).fill(0),
    }))
  );
  const [running, setRunning] = useState(false);
  const lastTickRef = useRef(null);

  // Baseline toggle for progress bars
  const [baseline, setBaseline] = useState("goal"); // 'goal' (full game / players) or 'ideal' (so far)
  // View mode for period columns: show only current period or completed periods
  const [periodView, setPeriodView] = useState("current"); // 'current' | 'completed'
  // Expanded accordion cards
  const [expandedIds, setExpandedIds] = useState(new Set());
  // Error toast for too many players
  const [errorToast, setErrorToast] = useState(null);
  const errorTimeoutRef = useRef(null);
  // Toast notification for errors
  const [toast, setToast] = useState(null);
  const toastTimeoutRef = useRef(null);

  // -------- Timeouts & Overtime (single team; independent of player timer) --------
  const BASE_TIMEOUTS = 5; // full timeouts per game
  const OT_LENGTH_MS = 3 * 60 * 1000; // 3 minutes per overtime
  const [timeoutsUsed, setTimeoutsUsed] = useState(0);
  const [overtimes, setOvertimes] = useState(0);
  const timeoutsCap = BASE_TIMEOUTS + overtimes;
  const timeoutsRemaining = Math.max(0, timeoutsCap - timeoutsUsed);
  const useTimeout = () => setTimeoutsUsed((n) => Math.min(timeoutsCap, n + 1));
  const undoTimeout = () => setTimeoutsUsed((n) => Math.max(0, n - 1));
  const addOvertime = () => setOvertimes((x) => x + 1);

  // Optional standalone OT timer
  const [otElapsedMs, setOtElapsedMs] = useState(0);
  const [otRunning, setOtRunning] = useState(false);
  const otLastRef = useRef(null);
  useEffect(() => {
    if (!otRunning) return;
    otLastRef.current = performance.now();
    const iv = setInterval(() => {
      const now = performance.now();
      const last = otLastRef.current ?? now;
      const delta = now - last;
      otLastRef.current = now;
      setOtElapsedMs((prev) => Math.min(OT_LENGTH_MS, prev + delta));
    }, 200);
    return () => clearInterval(iv);
  }, [otRunning]);

  // -------- Persistence (names + config + timeouts) --------
  useEffect(() => {
    const saved = loadState();
    if (!saved) return;
    setNumPlayers(saved.numPlayers ?? DEFAULT_NAMES.length);
    setOnCourt(saved.onCourt ?? 5);
    setFormat(saved.format ?? "Quarters");
    setPeriodMinutes(saved.periodMinutes ?? 8);
    setRosterName(saved.rosterName ?? "My Roster");
    // players
    if (Array.isArray(saved.players) && saved.players.length) {
      const nP = (saved.format ?? "Quarters") === "Quarters" ? 4 : 2;
      setPlayers(
        Array.from({ length: saved.players.length }, (_, i) => ({
          id: i + 1,
          name:
            saved.players?.[i]?.name ?? DEFAULT_NAMES[i] ?? `Player ${i + 1}`,
          active: i < (saved.onCourt ?? 5),
          totalMs: 0,
          periodMs: Array(nP).fill(0),
        }))
      );
      setPeriodElapsedMs(Array(nP).fill(0));
      setCurrentPeriod(0);
    }
    // timeouts
    setTimeoutsUsed(saved.timeoutsUsed ?? 0);
    setOvertimes(saved.overtimes ?? 0);
    setOtElapsedMs(saved.otElapsedMs ?? 0);
  }, []);

  useEffect(() => {
    saveState({
      numPlayers,
      onCourt,
      format,
      periodMinutes,
      rosterName,
      players: players.map((p) => ({ name: p.name })),
      timeoutsUsed,
      overtimes,
      otElapsedMs,
    });
  }, [
    numPlayers,
    onCourt,
    format,
    periodMinutes,
    rosterName,
    players,
    timeoutsUsed,
    overtimes,
    otElapsedMs,
  ]);

  // -------- Reactive adjustments --------
  useEffect(() => {
    if (onCourt > numPlayers) setOnCourt(numPlayers);
  }, [numPlayers, onCourt]);

  useEffect(() => {
    setPeriodElapsedMs((prev) => {
      const next = Array(numPeriods).fill(0);
      for (let i = 0; i < Math.min(prev.length, numPeriods); i++)
        next[i] = prev[i];
      return next;
    });
    setPlayers((prev) =>
      prev.map((p) => {
        const arr = Array(numPeriods).fill(0);
        for (let i = 0; i < Math.min(p.periodMs.length, numPeriods); i++)
          arr[i] = p.periodMs[i];
        return { ...p, periodMs: arr };
      })
    );
    setCurrentPeriod((idx) => clamp(idx, 0, numPeriods - 1));
  }, [numPeriods]);

  useEffect(() => {
    setPlayers((prev) => {
      const next = [...prev];
      if (numPlayers > prev.length) {
        for (let i = prev.length; i < numPlayers; i++) {
          next.push({
            id: i + 1,
            name: DEFAULT_NAMES[i] ?? `Player ${i + 1}`,
            active: i < onCourt,
            totalMs: 0,
            periodMs: Array(numPeriods).fill(0),
          });
        }
      } else if (numPlayers < prev.length) {
        next.length = numPlayers;
      }
      return next;
    });
  }, [numPlayers, onCourt, numPeriods]);

  // -------- Timer loop --------
  useEffect(() => {
    if (!running) return;
    lastTickRef.current = performance.now();
    const iv = setInterval(() => {
      const now = performance.now();
      const last = lastTickRef.current ?? now;
      const delta = now - last;
      lastTickRef.current = now;
      setPeriodElapsedMs((prev) => {
        const next = [...prev];
        const remaining = periodLengthMs - prev[currentPeriod];
        const apply = Math.max(0, Math.min(delta, remaining));
        next[currentPeriod] += apply;
        if (apply > 0) {
          setPlayers((prevPlayers) =>
            prevPlayers.map((p) => {
              if (!p.active) return p;
              const pm = [...p.periodMs];
              pm[currentPeriod] += apply;
              return { ...p, totalMs: p.totalMs + apply, periodMs: pm };
            })
          );
        }
        if (next[currentPeriod] >= periodLengthMs) setRunning(false);
        return next;
      });
    }, 250);
    return () => clearInterval(iv);
  }, [running, currentPeriod, periodLengthMs]);

  // -------- Metrics --------
  const gameElapsedMs = useMemo(
    () => periodElapsedMs.reduce((a, b) => a + b, 0),
    [periodElapsedMs]
  );
  const idealMsSoFar = useMemo(
    () => (numPlayers ? gameElapsedMs * (onCourt / numPlayers) : 0),
    [gameElapsedMs, onCourt, numPlayers]
  );
  const fullGameMs = numPeriods * periodLengthMs;
  const goalPerPlayerFullGameMs = useMemo(
    () => (numPlayers ? (fullGameMs * onCourt) / numPlayers : 0),
    [fullGameMs, numPlayers, onCourt]
  );

  const periodLabels = useMemo(
    () => Array.from({ length: numPeriods }, (_, i) => labelFor(format, i)),
    [numPeriods, format]
  );

  const activeCount = players.filter((p) => p.active).length;
  const needSubs = activeCount !== onCourt;

  // -------- Actions --------
  const resetAll = () => {
    setRunning(false);
    setCurrentPeriod(0);
    setPeriodElapsedMs(Array(numPeriods).fill(0));
    setPlayers((prev) =>
      prev.map((p, i) => ({
        ...p,
        active: i < onCourt,
        totalMs: 0,
        periodMs: Array(numPeriods).fill(0),
      }))
    );
    // reset timeouts & OT
    setTimeoutsUsed(0);
    setOvertimes(0);
    setOtElapsedMs(0);
    setOtRunning(false);
  };
  const nextPeriod = () => {
    setRunning(false);
    setCurrentPeriod((i) => Math.min(i + 1, numPeriods - 1));
  };
  const showError = (message) => {
    if (errorTimeoutRef.current) clearTimeout(errorTimeoutRef.current);
    setErrorToast(message);
    errorTimeoutRef.current = setTimeout(() => setErrorToast(null), 3000);
  };

  const toggleActive = (idx) => {
    const player = players[idx];
    const currentActiveCount = players.filter((p) => p.active).length;
    
    // If trying to activate and already at max, show error
    if (!player.active && currentActiveCount >= onCourt) {
      showError(`Only ${onCourt} players can be on court. Remove someone first!`);
      return;
    }
    
    setPlayers((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], active: !next[idx].active };
      return next;
    });
  };
  const updateName = (idx, name) => {
    setPlayers((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], name };
      return next;
    });
  };
  const autoFill = () => {
    const byTime = players
      .map((p, i) => ({ i, totalMs: p.totalMs }))
      .sort((a, b) => a.totalMs - b.totalMs);
    const toActivate = new Set(byTime.slice(0, onCourt).map((x) => x.i));
    setPlayers((prev) =>
      prev.map((p, i) => ({ ...p, active: toActivate.has(i) }))
    );
  };
  const csvExport = () => {
    const headers = [
      "Player",
      "Total (mm:ss)",
      ...periodLabels.map((l) => `${l} (mm:ss)`),
    ];
    const rows = players.map((p) => [
      p.name,
      msToClock(p.totalMs),
      ...p.periodMs.map(msToClock),
    ]);
    const lines = [headers, ...rows]
      .map((r) =>
        r.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")
      )
      .join("\n");
    const blob = new Blob([lines], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "playing-time.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  // Save/Load rosters
  const saveCurrentRoster = () => {
    const name = (rosterName || "Roster").trim();
    const roster = {
      players: players.map((p) => ({ name: p.name })),
      numPlayers,
      onCourt,
    };
    const next = { ...savedRosters, [name]: roster };
    setSavedRosters(next);
    saveRosters(next);
  };
  const loadRosterByName = (name) => {
    const entry = savedRosters[name];
    if (!entry) return;
    setRosterName(name);
    setNumPlayers(entry.numPlayers ?? entry.players?.length ?? numPlayers);
    setOnCourt(entry.onCourt ?? onCourt);
    setPlayers(() => {
      const n = entry.players?.length ?? numPlayers;
      return Array.from({ length: n }, (_, i) => ({
        id: i + 1,
        name: entry.players?.[i]?.name ?? DEFAULT_NAMES[i] ?? `Player ${i + 1}`,
        active: i < (entry.onCourt ?? onCourt),
        totalMs: 0,
        periodMs: Array(numPeriods).fill(0),
      }));
    });
    setRunning(false);
    setCurrentPeriod(0);
    setPeriodElapsedMs(Array(numPeriods).fill(0));
  };
  const deleteRosterByName = (name) => {
    const next = { ...savedRosters };
    delete next[name];
    setSavedRosters(next);
    saveRosters(next);
  };

  const simpleRosterOptions = Object.keys(savedRosters).sort();

  // Progress baseline value
  const baselineMs =
    baseline === "goal" ? goalPerPlayerFullGameMs : idealMsSoFar;

  // Decide which period columns to display
  const completedPeriods = periodElapsedMs
    .map((ms, i) => (ms >= periodLengthMs ? i : null))
    .filter((i) => i !== null);
  const displayedPeriods =
    periodView === "current"
      ? [currentPeriod]
      : completedPeriods.length
      ? completedPeriods
      : [currentPeriod];

  // Sorted players: active first, then by totalMs descending
  const sortedPlayers = useMemo(() => {
    return [...players]
      .map((p, idx) => ({ ...p, originalIdx: idx }))
      .sort((a, b) => {
        // Active players first
        if (a.active !== b.active) return b.active - a.active;
        // Then by total time descending (most played at top)
        return b.totalMs - a.totalMs;
      });
  }, [players]);

  // Toggle accordion expansion
  const toggleExpanded = (id) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Chart data
  const chartData = players.map((p) => ({
    name: p.name,
    minutes: Math.round(p.totalMs / 600) / 10,
  }));

  return (
    <div className="min-h-screen bg-gradient-to-b from-sky-50 via-white to-violet-50 text-gray-900 pb-40">
      {/* Error Toast */}
      <AnimatePresence>
        {errorToast && (
          <motion.div
            initial={{ opacity: 0, y: -50, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.9 }}
            className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] px-4 py-3 rounded-2xl bg-rose-600 text-white shadow-lg flex items-center gap-3 max-w-[90vw]"
          >
            <div className="w-6 h-6 rounded-full bg-white/20 flex items-center justify-center shrink-0">
              <span className="text-sm font-bold">!</span>
            </div>
            <span className="text-sm font-medium">{errorToast}</span>
            <button
              onClick={() => setErrorToast(null)}
              className="ml-2 text-white/80 hover:text-white"
            >
              ✕
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <div className="sticky top-0 z-40 backdrop-blur supports-[backdrop-filter]:bg-white/70 bg-white/90 border-b">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-2xl bg-gradient-to-br from-sky-500 to-indigo-600 flex items-center justify-center shadow text-white">
              <Gauge size={18} />
            </div>
            <div>
              <div className="font-semibold leading-tight">
                Playing Time Tracker
              </div>
              <div className="text-xs text-gray-500">
                Keep it fair • Quarters or halves
              </div>
            </div>
          </div>
          <div className="hidden sm:flex items-center gap-2">
            <IconButton
              onClick={() => setRunning((r) => !r)}
              variant={running ? "amber" : "emerald"}
              icon={running ? Pause : Play}
              label={running ? "Pause" : "Start"}
            />
            <IconButton
              onClick={nextPeriod}
              disabled={currentPeriod >= numPeriods - 1}
              variant="indigo"
              icon={SkipForward}
              label={`Next ${labelFor(format, currentPeriod + 1)}`}
            />
            <IconButton
              onClick={resetAll}
              variant="slate"
              icon={RotateCw}
              label="Reset"
            />
            <IconButton
              onClick={csvExport}
              variant="blue"
              icon={Download}
              label="CSV"
            />
          </div>
        </div>
      </div>

      <main className="max-w-3xl mx-auto px-4 pt-4 space-y-4">
        {/* Stats strip */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <KpiCard icon={Clock} label="Game" value={msToClock(gameElapsedMs)} />
          <KpiCard
            icon={Target}
            label={labelFor(format, currentPeriod)}
            value={`${msToClock(
              periodElapsedMs[currentPeriod] || 0
            )} / ${msToClock(periodLengthMs)}`}
          />
          <KpiCard
            icon={Users}
            label="Ideal so far"
            value={msToClock(idealMsSoFar)}
            tooltip="Elapsed × (on-court / roster)"
          />
          <KpiCard
            icon={Gauge}
            label="Goal / player"
            value={msToClock(goalPerPlayerFullGameMs)}
            tooltip="Full game ÷ players"
          />
        </div>

        {/* Period tabs */}
        <section className="bg-white/90 rounded-2xl shadow-sm p-3">
          <div className="flex flex-wrap items-center gap-2 justify-between">
            <div className="flex flex-wrap items-center gap-2">
              {periodLabels.map((lbl, i) => (
                <button
                  key={lbl}
                  onClick={() => setCurrentPeriod(i)}
                  className={`px-3 py-2 rounded-full text-sm border ${
                    i === currentPeriod
                      ? "bg-indigo-600 text-white border-indigo-600"
                      : "bg-white hover:bg-gray-50"
                  }`}
                >
                  {lbl}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="text-gray-600">Show:</span>
              <Segmented
                value={periodView}
                onChange={setPeriodView}
                options={[
                  { value: "current", label: "Current only" },
                  { value: "completed", label: "Completed only" },
                ]}
              />
            </div>
          </div>
          <p className="text-xs text-gray-600 mt-2">
            Timer applies to the selected period. Toggle columns to show only
            the current period or completed periods.
          </p>
        </section>

        {/* Players list - Accordion cards */}
        <section className="space-y-1">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs text-gray-500">
              <span className="inline-flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-emerald-500" /> On court
              </span>
              <span className="mx-2">•</span>
              <span>Sorted by play time</span>
            </div>
            <button
              onClick={() => setExpandedIds(new Set())}
              className="text-xs text-indigo-600 hover:text-indigo-800"
            >
              Collapse all
            </button>
          </div>

          <LayoutGroup>
            <div className="flex flex-col gap-1">
              {sortedPlayers.map((p) => {
                const base = baselineMs || 1;
                const prog = Math.max(0, Math.min(1, p.totalMs / base));
                const delta =
                  p.totalMs -
                  (baseline === "goal"
                    ? goalPerPlayerFullGameMs
                    : idealMsSoFar);
                const isExpanded = expandedIds.has(p.id);

                return (
                  <motion.div
                    key={p.id}
                    layout
                    transition={{
                      layout: { type: "spring", stiffness: 500, damping: 35 },
                    }}
                    className={`rounded-2xl shadow-sm overflow-hidden ${
                      p.active
                        ? "bg-gradient-to-r from-emerald-50 to-white border-l-4 border-emerald-500"
                        : "bg-white"
                    }`}
                  >
                    {/* Collapsed header - always visible */}
                    <motion.div
                      layout="position"
                      className="flex items-center gap-3 p-3 cursor-pointer"
                      onClick={() => toggleExpanded(p.id)}
                    >
                      <input
                        type="checkbox"
                        checked={p.active}
                        onChange={(e) => {
                          e.stopPropagation();
                          toggleActive(p.originalIdx);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="h-6 w-6 shrink-0"
                      />
                      <div className="flex-1 min-w-0 flex items-center gap-3">
                        <span className="font-medium truncate">{p.name}</span>
                        <span className="text-xs tabular-nums text-gray-600">
                          {msToClock(p.totalMs)}
                        </span>
                        <span
                          className={`text-xs tabular-nums ${
                            delta < 0
                              ? "text-blue-600"
                              : delta > 0
                              ? "text-rose-600"
                              : "text-gray-500"
                          }`}
                        >
                          {delta === 0
                            ? "±0"
                            : `${delta > 0 ? "+" : ""}${Math.round(
                                delta / 1000
                              )}s`}
                        </span>
                      </div>
                      <div className="w-16 shrink-0">
                        <Progress value={prog * 100} />
                      </div>
                      <motion.div
                        animate={{ rotate: isExpanded ? 180 : 0 }}
                        transition={{ duration: 0.2 }}
                        className="shrink-0 text-gray-400"
                      >
                        <ChevronDown size={20} />
                      </motion.div>
                    </motion.div>

                    {/* Expanded content */}
                    <AnimatePresence initial={false}>
                      {isExpanded && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.2 }}
                          className="overflow-hidden"
                        >
                          <div className="px-3 pb-3 pt-0 space-y-3">
                            <input
                              className="w-full rounded-xl border px-3 py-2 font-medium"
                              value={p.name}
                              onChange={(e) =>
                                updateName(p.originalIdx, e.target.value)
                              }
                              onClick={(e) => e.stopPropagation()}
                            />
                            <div className="text-[11px] text-gray-600 flex flex-wrap gap-3">
                              <span>
                                Total:{" "}
                                <b className="tabular-nums">
                                  {msToClock(p.totalMs)}
                                </b>
                              </span>
                              <span>
                                Δ {baseline === "goal" ? "vs Goal" : "vs Ideal"}
                                :{" "}
                                <b
                                  className={`tabular-nums ${
                                    delta < 0
                                      ? "text-blue-700"
                                      : delta > 0
                                      ? "text-rose-700"
                                      : ""
                                  }`}
                                >
                                  {delta === 0
                                    ? "±00:00"
                                    : `${delta > 0 ? "+" : "-"}${msToClock(
                                        Math.abs(delta)
                                      )}`}
                                </b>
                              </span>
                            </div>
                            <div
                              className="grid gap-2 text-[11px]"
                              style={{
                                gridTemplateColumns: `repeat(${Math.max(
                                  1,
                                  displayedPeriods.length
                                )}, minmax(0,1fr))`,
                              }}
                            >
                              {displayedPeriods.map((i) => (
                                <div
                                  key={i}
                                  className="rounded-lg bg-gray-100 px-2 py-1 text-center tabular-nums"
                                >
                                  <div className="text-[10px] text-gray-500">
                                    {periodLabels[i]}
                                  </div>
                                  {msToClock(p.periodMs[i] || 0)}
                                </div>
                              ))}
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                );
              })}
            </div>
          </LayoutGroup>
        </section>

        {/* Chart */}
        <section className="bg-white/90 rounded-2xl shadow-sm p-3">
          <h3 className="font-semibold mb-2">Total Minutes by Player</h3>
          <div className="h-56 md:h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={chartData}
                margin={{ top: 10, right: 10, bottom: 10, left: 10 }}
              >
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 10 }}
                  interval={0}
                  angle={-25}
                  textAnchor="end"
                  height={50}
                />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip formatter={(v) => `${v} min`} />
                <Bar dataKey="minutes" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      </main>

      {/* Timeouts & OT (single team) */}
      <section className="bg-white/90 rounded-2xl shadow-sm p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold flex items-center gap-2">
            <Timer size={16} /> Timeouts & Overtime
          </h2>
          <div className="text-xs text-gray-600">
            Full timeouts: 5 • +1 each OT
          </div>
        </div>
        <div className="rounded-xl border p-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">Our Team</div>
            <div className="text-sm">
              Remaining: <b>{timeoutsRemaining}</b> / {timeoutsCap}
            </div>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <IconButton
              onClick={undoTimeout}
              variant="slate"
              icon={Minus}
              label="Undo"
            />
            <IconButton
              onClick={useTimeout}
              variant="indigo"
              icon={Plus}
              label="Use Timeout"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 pt-2 border-t">
          <div className="text-sm">
            Overtimes: <b>{overtimes}</b>
          </div>
          <IconButton
            onClick={addOvertime}
            variant="emerald"
            icon={Plus}
            label="Add Overtime (+1 TO)"
          />
          <div className="ml-auto text-sm text-gray-600">
            OT clock (3:00): <b>{msToClock(OT_LENGTH_MS - otElapsedMs)}</b>
          </div>
          <div className="flex items-center gap-2">
            <IconButton
              onClick={() => setOtRunning((r) => !r)}
              variant={otRunning ? "amber" : "emerald"}
              icon={otRunning ? Pause : Play}
              label={otRunning ? "Pause OT" : "Start OT"}
            />
            <IconButton
              onClick={() => {
                setOtRunning(false);
                setOtElapsedMs(0);
              }}
              variant="slate"
              icon={RotateCw}
              label="Reset OT"
            />
          </div>
        </div>
      </section>

      {/* Setup card */}
      <section className="bg-white/90 rounded-2xl shadow-sm p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold">Game Setup</h2>
          <div
            className={`text-xs ${
              activeCount !== onCourt ? "text-rose-600" : "text-emerald-700"
            }`}
          >
            On court: <b>{activeCount}</b> / {onCourt}{" "}
            {needSubs ? "• Balance needed" : ""}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Labeled label="# Players">
            <input
              type="number"
              min={1}
              className="mt-1 w-full rounded-xl border px-3 py-3 text-base"
              value={numPlayers}
              onChange={(e) =>
                setNumPlayers(clamp(parseInt(e.target.value || "0"), 1, 100))
              }
            />
          </Labeled>
          <Labeled label="On Court">
            <input
              type="number"
              min={1}
              max={numPlayers}
              className="mt-1 w-full rounded-xl border px-3 py-3 text-base"
              value={onCourt}
              onChange={(e) =>
                setOnCourt(
                  clamp(parseInt(e.target.value || "0"), 1, numPlayers)
                )
              }
            />
          </Labeled>
          <Labeled label="Format">
            <select
              className="mt-1 w-full rounded-xl border px-3 py-3 text-base"
              value={format}
              onChange={(e) => setFormat(e.target.value)}
            >
              <option>Quarters</option>
              <option>Halves</option>
            </select>
          </Labeled>
          <Labeled
            label={`Minutes per ${format === "Quarters" ? "Quarter" : "Half"}`}
          >
            <input
              type="number"
              min={1}
              className="mt-1 w-full rounded-xl border px-3 py-3 text-base"
              value={periodMinutes}
              onChange={(e) =>
                setPeriodMinutes(clamp(parseInt(e.target.value || "0"), 1, 90))
              }
            />
          </Labeled>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="w-full sm:w-auto px-4 py-3 rounded-xl bg-sky-600 text-white hover:bg-sky-700 active:scale-[.99]"
            onClick={autoFill}
          >
            Auto-Fill (lowest time)
          </button>
          <div className="ml-auto flex items-center gap-2 text-xs">
            <span className="text-gray-500">Progress baseline:</span>
            <Segmented
              value={baseline}
              onChange={setBaseline}
              options={[
                { value: "goal", label: "Goal" },
                { value: "ideal", label: "Ideal so far" },
              ]}
            />
          </div>
        </div>
      </section>

      {/* Roster manager */}
      <section className="bg-white/90 rounded-2xl shadow-sm p-4 space-y-3">
        <h2 className="font-semibold">Roster</h2>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="rounded-xl border px-3 py-3 w-56"
            value={rosterName}
            onChange={(e) => setRosterName(e.target.value)}
            placeholder="Roster name"
          />
          <button
            className="px-4 py-3 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 active:scale-[.99]"
            onClick={saveCurrentRoster}
          >
            Save
          </button>
          <select
            className="rounded-xl border px-3 py-3"
            onChange={(e) =>
              e.target.value && loadRosterByName(e.target.value)
            }
            defaultValue=""
          >
            <option value="" disabled>
              Load…
            </option>
            {simpleRosterOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <select
            className="rounded-xl border px-3 py-3"
            onChange={(e) => {
              const v = e.target.value;
              if (!v) return;
              deleteRosterByName(v);
              e.target.value = "";
            }}
            defaultValue=""
          >
            <option value="" disabled>
              Delete…
            </option>
            {simpleRosterOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </section>

      {/* Sticky mobile controls */}
      <div className="fixed bottom-0 left-0 right-0 border-t bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/70 z-50">
        <div className="max-w-3xl mx-auto p-3 flex items-center gap-2 justify-between">
          <div className="text-xs text-gray-600">
            Current {labelFor(format, currentPeriod)}:{" "}
            <b>{msToClock(periodElapsedMs[currentPeriod] || 0)}</b>
          </div>
          <div className="flex items-center gap-2">
            <IconButton
              onClick={() => setRunning((r) => !r)}
              variant={running ? "amber" : "emerald"}
              icon={running ? Pause : Play}
              label={running ? "Pause" : "Start"}
            />
            <IconButton
              onClick={nextPeriod}
              disabled={currentPeriod >= numPeriods - 1}
              variant="indigo"
              icon={SkipForward}
              label={`Next ${labelFor(format, currentPeriod + 1)}`}
            />
            <IconButton
              onClick={resetAll}
              variant="slate"
              icon={RotateCw}
              label="Reset"
              className="hidden sm:inline-flex"
            />
            <IconButton
              onClick={csvExport}
              variant="blue"
              icon={Download}
              label="CSV"
              className="hidden sm:inline-flex"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Small UI pieces ----------
function KpiCard({ icon: Icon, label, value, tooltip }) {
  return (
    <div className="rounded-2xl bg-white/90 shadow-sm p-3 flex items-center gap-3">
      <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white flex items-center justify-center">
        <Icon size={18} />
      </div>
      <div className="flex-1 min-w-0">
        <div
          className="text-[11px] uppercase tracking-wide text-gray-500"
          title={tooltip || ""}
        >
          {label}
        </div>
        <div className="text-base md:text-lg font-semibold tabular-nums truncate">
          {value}
        </div>
      </div>
    </div>
  );
}

function Labeled({ label, children }) {
  return (
    <label className="text-sm block">
      {label}
      {children}
    </label>
  );
}

function Segmented({ value, onChange, options = [] }) {
  return (
    <div className="inline-flex rounded-xl border overflow-hidden">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`px-3 py-1 text-xs ${
            value === opt.value
              ? "bg-indigo-600 text-white"
              : "bg-white hover:bg-gray-50"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function IconButton({
  onClick,
  icon: Icon,
  label,
  variant = "slate",
  disabled,
  className = "",
}) {
  const styles = {
    slate: "bg-gray-200 hover:bg-gray-300 text-gray-900",
    emerald: "bg-emerald-600 hover:bg-emerald-700 text-white",
    amber: "bg-amber-600 hover:bg-amber-700 text-white",
    indigo: "bg-indigo-600 hover:bg-indigo-700 text-white",
    blue: "bg-blue-600 hover:bg-blue-700 text-white",
  };
  return (
    <motion.button
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-2 rounded-xl text-sm inline-flex items-center gap-2 disabled:opacity-40 ${styles[variant]} ${className}`}
    >
      <Icon size={16} />
      <span className="hidden sm:inline">{label}</span>
    </motion.button>
  );
}

function Progress({ value }) {
  return (
    <div className="h-2 w-full rounded-full bg-gray-200 overflow-hidden">
      <div
        className="h-full bg-gradient-to-r from-sky-500 to-indigo-600"
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}

// ---------- Local storage helpers ----------
function loadRosters() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_ROSTERS);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
function saveRosters(obj) {
  try {
    localStorage.setItem(STORAGE_KEY_ROSTERS, JSON.stringify(obj));
  } catch {}
}
function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY_STATE, JSON.stringify(state));
  } catch {}
}
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_STATE);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}