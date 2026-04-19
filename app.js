// ===== Stop normalization =====
function normalizeStop(name) {
  if (!name) return "";
  let s = name.replace(/\xa0/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/\s+Bay\s+\w+$/i, "");
  return s.toLowerCase();
}

// ===== CSV parsing =====
function parseCsv(text) {
  // Strip BOM, split lines, handle quoted fields with commas.
  text = text.replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  if (!lines.length) return { headers: [], rows: [] };
  const split = (line) => {
    const out = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else {
        if (c === ",") { out.push(cur); cur = ""; }
        else if (c === '"') q = true;
        else cur += c;
      }
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const headers = split(lines[0]);
  const rows = lines.slice(1).map((l) => {
    const cols = split(l);
    const obj = {};
    headers.forEach((h, i) => (obj[h] = cols[i] ?? ""));
    return obj;
  });
  return { headers, rows };
}

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

// "Apr-19-2026 01:06 PM" -> Date
function parseTimestamp(dateStr, timeStr) {
  const m = /^(\w{3})-(\d{1,2})-(\d{4})$/.exec(dateStr.trim());
  const t = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(timeStr.trim());
  if (!m || !t) return null;
  const month = MONTHS[m[1]];
  if (month === undefined) return null;
  let hour = parseInt(t[1], 10) % 12;
  if (t[3].toUpperCase() === "PM") hour += 12;
  return new Date(parseInt(m[3], 10), month, parseInt(m[2], 10), hour, parseInt(t[2], 10));
}

function parseArcCsv(text) {
  const { rows } = parseCsv(text);
  const taps = [];
  for (const row of rows) {
    const desc = (row["Description"] || "").trim();
    let tapType;
    if (desc.toLowerCase().includes("missing")) tapType = "missing";
    else if (desc.includes("Entry")) tapType = "entry";
    else if (desc.includes("Exit")) tapType = "exit";
    else continue;

    const ts = parseTimestamp(row["Date"] || "", row["Time"] || "");
    if (!ts) continue;
    taps.push({ timestamp: ts, location: (row["Location"] || "").trim(), tap_type: tapType });
  }
  return taps;
}

// ===== Trip matching =====
function checkValidTrip(trip, entryStop, exitStop) {
  const ne = normalizeStop(entryStop);
  const nx = normalizeStop(exitStop);
  let idx = -1;
  for (let i = 0; i < trip.stops.length; i++) {
    if (normalizeStop(trip.stops[i]) === ne) { idx = i; break; }
  }
  if (idx === -1) return false;
  for (let i = idx; i < trip.stops.length; i++) {
    if (normalizeStop(trip.stops[i]) === nx) return true;
  }
  return false;
}

function matchTrips(taps, trips) {
  const travels = [];
  let pendingExit = null;

  const pushUnknown = (entryTap) => {
    travels.push({
      route_no: "Unknown Route",
      dir: "Unknown Dir",
      entry_stop: entryTap.location,
      exit_stop: "Unknown",
      start_time: entryTap.timestamp,
      end_time: null,
      duration_ms: null,
    });
  };

  for (const tap of taps) {
    const isExit = tap.tap_type === "exit" || tap.tap_type === "missing";
    if (isExit) {
      pendingExit = tap;
      continue;
    }
    if (tap.tap_type !== "entry") continue;

    if (pendingExit === null) { pushUnknown(tap); continue; }

    const entryTap = tap;
    const exitTap = pendingExit;
    pendingExit = null;

    if (exitTap.tap_type === "missing") { pushUnknown(entryTap); continue; }

    const entryStop = entryTap.location;
    const exitStop = exitTap.location || "Unknown";

    const matched = trips.filter((t) => checkValidTrip(t, entryStop, exitStop));
    let chosenIdx = -1;
    if (matched.length === 1) chosenIdx = 0;
    else if (matched.length > 1) {
      const cap = matched.findIndex((t) => t.route_no === "Capital Line");
      chosenIdx = cap >= 0 ? cap : 0;
    }

    if (chosenIdx >= 0) {
      const chosen = matched[chosenIdx];
      travels.push({
        route_no: chosen.route_no,
        dir: chosen.dir,
        entry_stop: entryStop,
        exit_stop: exitStop,
        start_time: entryTap.timestamp,
        end_time: exitTap.timestamp,
        duration_ms: exitTap.timestamp - entryTap.timestamp,
        alternatives: matched.length > 1 ? matched.map((t) => ({ route_no: t.route_no, dir: t.dir })) : null,
        alt_index: matched.length > 1 ? chosenIdx : null,
      });
    } else {
      travels.push({
        route_no: "Unknown Route",
        dir: "Unknown Dir",
        entry_stop: entryStop,
        exit_stop: exitStop,
        start_time: entryTap.timestamp,
        end_time: exitTap.timestamp,
        duration_ms: exitTap.timestamp - entryTap.timestamp,
      });
    }
  }
  // chronological (oldest first)
  travels.sort((a, b) => a.start_time - b.start_time);
  return travels;
}

// ===== Colors =====
const LRT_COLORS = {
  "Capital Line": "#003DA5",
  "Metro Line": "#C60C30",
  "Valley Line": "#007A33",
};

const DEFAULT_COLORS = [
  "#FFE119", "#F58231", "#911EB4", "#42D4F4", "#F032E6",
  "#BFEF45", "#FABED4", "#469990", "#DCBEFF", "#9A6324",
  "#FFFAC8", "#800000", "#AAFFC3", "#808000", "#FFD8B1",
  "#000075", "#A9A9A9", "#FFD700", "#8B4513", "#D2B48C",
];

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [0, 0, 0];
}
function rgbToHex(rgb) {
  return "#" + rgb.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, "0")).join("");
}
function adjustColor(hex, factor) {
  const rgb = hexToRgb(hex);
  let out;
  if (factor > 0) out = rgb.map((c) => c + (1 - c) * factor);
  else if (factor < 0) out = rgb.map((c) => c * (1 + factor));
  else out = rgb;
  return rgbToHex(out);
}

function buildColorMap(routePairs) {
  // routePairs: array of [route, direction]
  const baseColors = {};
  const uniqueRoutes = [...new Set(routePairs.map(([r]) => r))].sort();
  let nonLrtCount = 0;
  for (const route of uniqueRoutes) {
    if (LRT_COLORS[route]) { baseColors[route] = LRT_COLORS[route]; continue; }
    const idx = nonLrtCount % DEFAULT_COLORS.length;
    const wrap = Math.floor(nonLrtCount / DEFAULT_COLORS.length);
    let base = DEFAULT_COLORS[idx];
    if (wrap > 0) base = adjustColor(base, Math.max(-0.8, -0.2 * wrap));
    baseColors[route] = base;
    nonLrtCount++;
  }

  const colorMap = {};
  for (const [route, dir] of routePairs) {
    if (!colorMap[route]) colorMap[route] = {};
    if (colorMap[route][dir]) continue;
    const dirs = [...new Set(routePairs.filter(([r]) => r === route).map(([, d]) => d))].sort();
    const dirIdx = dirs.indexOf(dir);
    const factor = dirIdx === 0 ? 0 : 0.4;
    colorMap[route][dir] = adjustColor(baseColors[route], factor);
  }
  return colorMap;
}

// ===== Calendar rendering =====
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

function fmtTime(d) {
  if (!d) return "?";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function renderCalendar(travels, year, month, gridEl, legendEl, titleEl) {
  titleEl.textContent = `${MONTH_NAMES[month]} ${year}`;
  gridEl.innerHTML = "";
  legendEl.innerHTML = "";

  const inMonth = travels.filter((t) =>
    t.start_time.getFullYear() === year && t.start_time.getMonth() === month
  );
  const routePairs = inMonth
    .filter((t) => t.route_no !== "Unknown Route")
    .map((t) => [t.route_no, t.dir]);
  const colorMap = buildColorMap(routePairs);

  // Group by day
  const byDay = {};
  for (const t of inMonth) {
    const d = t.start_time.getDate();
    (byDay[d] ||= []).push(t);
  }
  for (const d in byDay) byDay[d].sort((a, b) => a.start_time - b.start_time);

  // Header row
  for (const dayName of DAY_NAMES) {
    const h = document.createElement("div");
    h.className = "dow";
    h.textContent = dayName;
    gridEl.appendChild(h);
  }

  // Compute weeks (Mon=0 ... Sun=6)
  const firstDay = new Date(year, month, 1);
  const offset = (firstDay.getDay() + 6) % 7; // Mon=0
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Leading blanks
  for (let i = 0; i < offset; i++) {
    const blank = document.createElement("div");
    blank.className = "cell blank";
    gridEl.appendChild(blank);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const cell = document.createElement("div");
    cell.className = "cell";

    const num = document.createElement("div");
    num.className = "daynum";
    num.textContent = String(day);
    cell.appendChild(num);

    const trips = byDay[day] || [];
    if (trips.length) {
      const stack = document.createElement("div");
      stack.className = "stripes";
      for (const t of trips) {
        const stripe = document.createElement("div");
        stripe.className = "stripe";
        const known = t.route_no !== "Unknown Route" && colorMap[t.route_no]?.[t.dir];
        stripe.style.background = known || "#d0d0d0";
        const dur = t.duration_ms != null ? `${Math.round(t.duration_ms / 60000)}m` : "?";
        let title = `${t.route_no} ${t.dir}\n${t.entry_stop} → ${t.exit_stop}\n${fmtTime(t.start_time)}–${fmtTime(t.end_time)} (${dur})`;
        if (t.alternatives) {
          stripe.classList.add("ambiguous");
          const altList = t.alternatives.map((a, i) => `${i === t.alt_index ? "● " : "○ "}${a.route_no} ${a.dir}`).join("\n");
          title += `\n\n[click to switch — ${t.alternatives.length} matches]\n${altList}`;
          stripe.addEventListener("click", (e) => {
            e.stopPropagation();
            t.alt_index = (t.alt_index + 1) % t.alternatives.length;
            const next = t.alternatives[t.alt_index];
            t.route_no = next.route_no;
            t.dir = next.dir;
            refresh();
          });
        }
        stripe.title = title;
        stack.appendChild(stripe);
      }
      cell.appendChild(stack);
    }

    gridEl.appendChild(cell);
  }

  // Trailing blanks to fill last row
  const totalCells = offset + daysInMonth;
  const trailing = (7 - (totalCells % 7)) % 7;
  for (let i = 0; i < trailing; i++) {
    const blank = document.createElement("div");
    blank.className = "cell blank";
    gridEl.appendChild(blank);
  }

  // Legend (sorted by route then dir)
  const legendItems = Object.entries(colorMap)
    .flatMap(([route, dirs]) => Object.entries(dirs).map(([dir, color]) => ({ route, dir, color })))
    .sort((a, b) => a.route.localeCompare(b.route) || a.dir.localeCompare(b.dir));
  for (const item of legendItems) {
    const wrap = document.createElement("div");
    wrap.className = "legend-item";
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = item.color;
    const lbl = document.createElement("span");
    lbl.textContent = `${item.route} (${item.dir})`;
    wrap.append(sw, lbl);
    legendEl.appendChild(wrap);
  }
}

// ===== App wiring =====
const state = {
  trips: [],
  travels: [],
  year: null,
  month: null,
};

function mostRecentMonth(travels) {
  if (!travels.length) {
    const n = new Date();
    return { year: n.getFullYear(), month: n.getMonth() };
  }
  const latest = travels.reduce((a, b) => (b.start_time > a.start_time ? b : a));
  return { year: latest.start_time.getFullYear(), month: latest.start_time.getMonth() };
}

function refresh() {
  const grid = document.getElementById("grid");
  const legend = document.getElementById("legend");
  const title = document.getElementById("title");
  renderCalendar(state.travels, state.year, state.month, grid, legend, title);
}

async function loadTrips() {
  const res = await fetch("trips.json");
  state.trips = await res.json();
}

function handleFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const taps = parseArcCsv(String(reader.result));
    state.travels = matchTrips(taps, state.trips);
    const { year, month } = mostRecentMonth(state.travels);
    state.year = year;
    state.month = month;
    document.getElementById("empty").hidden = true;
    document.getElementById("calendar").hidden = false;
    refresh();
  };
  reader.readAsText(file);
}

function init() {
  loadTrips().catch((e) => {
    document.getElementById("empty").textContent = "Failed to load trips.json — try serving the folder over HTTP (python -m http.server).";
    console.error(e);
  });

  const input = document.getElementById("file");
  input.addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (f) handleFile(f);
  });

  document.body.addEventListener("dragover", (e) => { e.preventDefault(); document.body.classList.add("drag"); });
  document.body.addEventListener("dragleave", () => document.body.classList.remove("drag"));
  document.body.addEventListener("drop", (e) => {
    e.preventDefault();
    document.body.classList.remove("drag");
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  });

  document.getElementById("prev").addEventListener("click", () => {
    let m = state.month - 1, y = state.year;
    if (m < 0) { m = 11; y--; }
    state.month = m; state.year = y;
    refresh();
  });
  document.getElementById("next").addEventListener("click", () => {
    let m = state.month + 1, y = state.year;
    if (m > 11) { m = 0; y++; }
    state.month = m; state.year = y;
    refresh();
  });
}

document.addEventListener("DOMContentLoaded", init);
