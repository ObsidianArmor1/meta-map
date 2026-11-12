"use strict";

// Meta Map: every pano is a dot coloured by its meta, and metas are coloured by look
// (pipeline/colors.py). Overlapping metas interleave instead of competing for a cell.

const PALETTE = [
  "#4ed8ff", "#58d774", "#f15757", "#e6df3e", "#d280ff", "#d79358",
  "#4c7eff", "#ffb938", "#2fd3b0", "#ff6fb5", "#a7d864", "#8e9bff",
];
const URBAN_COLORS = ["#f15757", "#d79358", "#e6df3e", "#a7d864", "#58d774", "#2fd3b0"];
const LEVEL_NAMES = { region: "Region", subregion: "Sub-region", scene: "Scene", micro: "Look" };   // "micro" keeps its old id so saved practice and labels carry over
// Two colour schemes. "distinct" (default): look colours nudged so metas that share ground on the
// map or in Space get clearly different colours (pipeline/distinct_colors.py). "look": the raw
// look-based colours. C flips between them; the choice is remembered.
const SCHEME_KEY = "meta-map-colors";
let colorScheme = (() => { try { return localStorage.getItem(SCHEME_KEY) || "distinct"; } catch (_) { return "distinct"; } })();
const colorOf = (m) => (colorScheme === "distinct" && m.distinctRgb) || m.rgb || PALETTE[m.color];
const rgbOf = (m) => {
  if (!m.rgbTriple) {
    const n = parseInt(colorOf(m).slice(1), 16);
    m.rgbTriple = [n >> 16, (n >> 8) & 255, n & 255];
  }
  return m.rgbTriple;
};
const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const countryName = (code) => {
  try { return regionNames.of(code) || code; } catch { return code; }
};

const state = {
  info: null,
  levels: [],
  level: null,
  metas: new Map(),
  ids: null,            // Uint16Array: meta id per point at the current level (0 = none)
  selected: null,
  preview: null,        // meta hovered in the list or the related cards
  filter: null,         // Set of meta ids matching the search
  mix: null,            // { tops: [[id, count]], total } around a clicked point
  compare: null,        // second meta in compare mode (the first is `selected`)
  sort: "size",
  query: "",
  viewerOpen: false,
  view: "map",          // "map" (geography) or "space" (embedding layout)
};
const $ = (id) => document.getElementById(id);

// ---------- thumbnails ----------
// Street View thumbnails: four equivalent host families, tried in order (see STREETVIEW_IMAGE_HOSTS.md
// in the Geoguessr root). streetviewpixels-pa.googleapis.com stopped accepting connections on
// 2026-11-09, so a host that fails is skipped for ten minutes and every attempt is capped at 4 s.
function thumbQuery(pano, heading, w, h, fov) {
  return `cb_client=maps_sv.tactile&w=${w}&h=${h}&pitch=0&panoid=${encodeURIComponent(pano)}&yaw=${heading}&thumbfov=${fov}`;
}
function thumb(pano, heading, w = 480, h = 320, fov = 100) {
  return `https://streetviewpixels-pa.clients6.google.com/v1/thumbnail?${thumbQuery(pano, heading, w, h, fov)}`;
}
const SV_DEAD_MS = 10 * 60 * 1000;
const svDead = new Map();
function svCandidates(url) {
  const query = url.slice(url.indexOf("?") + 1);
  const pano = new URLSearchParams(query).get("panoid") || "";
  let hash = 0;
  for (let k = 0; k < pano.length; k += 1) hash = (hash * 31 + pano.charCodeAt(k)) >>> 0;
  const n = hash % 4;
  const all = [
    `https://streetviewpixels-pa.clients6.google.com/v1/thumbnail?${query}`,
    `https://streetviewpixels-pa.googleapis.com/v1/thumbnail?${query}`,
    `https://geo${n}.ggpht.com/cbk?output=thumbnail&${query}`,
    `https://cbk${n}.google.com/cbk?output=thumbnail&${query}`,
  ];
  const alive = (u) => !((svDead.get(new URL(u).host) || 0) > Date.now());
  return [...all.filter(alive), ...all.filter((u) => !alive(u))];
}
async function svFetch(url) {
  let lastError;
  for (const candidate of svCandidates(url)) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 4000);
    try {
      const response = await fetch(candidate, { referrerPolicy: "no-referrer", signal: abort.signal });
      if (response.status >= 500 || response.status === 429) throw new Error(`HTTP ${response.status}`);
      return response.ok ? await response.blob() : null;
    } catch (error) {
      lastError = error;
      svDead.set(new URL(candidate).host, Date.now() + SV_DEAD_MS);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}
function streetView(pano, heading, lat = null, lng = null) {
  const params = new URLSearchParams({ api: "1", map_action: "pano", pano, heading: String(Math.round(heading || 0)) });
  if (Number.isFinite(lat) && Number.isFinite(lng)) params.set("viewpoint", `${lat},${lng}`);
  return `https://www.google.com/maps/@?${params}`;
}
// Street View answers a missing thumbnail with a tiny all-black JPEG (~400 bytes) and a 200,
// so thumbnails are fetched (the endpoint allows CORS) and blanks are treated as failures.
const thumbCache = new Map();
// Google's "no imagery" placeholder is a black JPEG whose size grows with the requested
// dimensions (410 B at 320x200, 5.8 KB at 1600x900: ~0.004 B/px); real images are >= 0.06 B/px.
function blankBytes(url) {
  const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
  const pixels = (Number(params.get("w")) || 320) * (Number(params.get("h")) || 200);
  return Math.max(1500, 0.012 * pixels);
}
// Any already-loaded image of a pano (hover card, list card): shown at once as a placeholder
// while a bigger size loads, so clicking something just seen never shows an empty frame.
// Keyed by pano and direction (to the nearest 15°): a placeholder facing another way would show
// the wrong view, e.g. the same forward photo in all four cells of the Shift enlargement.
const seenPano = new Map();
const panoOf = (url) => new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("panoid");
const viewKey = (url) => {
  const q = new URLSearchParams(url.slice(url.indexOf("?") + 1));
  const pano = q.get("panoid");
  return pano ? `${pano}@${Math.round((((Number(q.get("yaw")) || 0) % 360) + 360) % 360 / 15) % 24}` : null;
};
function fetchThumb(url) {
  if (!thumbCache.has(url)) {
    thumbCache.set(url, svFetch(url)
      .then((blob) => {
        if (!(blob && blob.size > blankBytes(url))) return null;
        const src = URL.createObjectURL(blob);
        const key = viewKey(url);
        if (key) seenPano.set(key, src);
        return src;
      })
      .catch(() => null));
  }
  return thumbCache.get(url);
}
// Warming: thumbnails the site knows it will show next (the next page of a board, the next round,
// the next photo in the viewer) are fetched ahead at the exact size they will be shown, so they
// appear instantly from thumbCache. A low-priority queue, a few at a time, newest requests first,
// so warming never competes much with the photos on screen.
const warmQueue = [];
let warming = 0;
const WARM_MAX = 3;
function warm(urls) {
  const fresh = urls.filter((u) => u && !thumbCache.has(u));
  if (!fresh.length) return;
  warmQueue.unshift(...fresh);
  if (warmQueue.length > 240) warmQueue.length = 240;
  pumpWarm();
}
function pumpWarm() {
  while (warming < WARM_MAX && warmQueue.length) {
    const u = warmQueue.shift();
    if (thumbCache.has(u)) continue;
    warming += 1;
    fetchThumb(u).finally(() => { warming -= 1; pumpWarm(); });
  }
}
const lazy = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    lazy.unobserve(entry.target);
    entry.target.loadThumb();
  }
}, { rootMargin: "400px" });
// ---------- withdrawn panos ----------
// About 1 in 40 corpus panos has since been withdrawn by Google (re-issued under a new ID or
// removed). For those, show the pano Google serves at the same spot now, always labelled with its
// capture date because it may be a different capture from the one the meta was learned from.
// Uses the Maps JS SingleImageSearch RPC (the legacy GeoPhotoService endpoint is turned down).
const currentPanoCache = new Map();
function findCurrentPano(lat, lng, radius = 50) {
  const key = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  if (!currentPanoCache.has(key)) {
    const body = JSON.stringify([["apiv3"], [[null, null, lat, lng], radius],
      [[null, null, null, null, null, null, null, null, null, null, [null, null]], null, null, null, null, null, null, null,
        [1], null, [[[2, true, 2]]]], [[2, 6]]]);
    currentPanoCache.set(key, fetch(
      "https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/SingleImageSearch",
      { method: "POST", headers: { "Content-Type": "application/json+protobuf" }, body, referrerPolicy: "no-referrer" },
    ).then((r) => (r.ok ? r.json() : null)).then((data) => {
      const message = data && data[1];
      const id = message && message[1] && message[1][1];
      if (typeof id !== "string" || message[1][0] !== 2) return null;
      const date = message[6] && message[6][7];
      return { pano: id, date: Array.isArray(date) && date.length >= 2 ? `${date[0]}-${String(date[1]).padStart(2, "0")}` : null };
    }).catch(() => null));
  }
  return currentPanoCache.get(key);
}
// The current pano's thumbnail at the same heading and size, or null.
async function currentThumb(lat, lng, heading, w, h) {
  const current = await findCurrentPano(lat, lng);
  if (!current) return null;
  const src = await fetchThumb(thumb(current.pano, heading, w, h));
  return src ? { ...current, src } : null;
}
function captureLabel(current) {
  return current.date ? `Current pano · ${current.date} capture` : "Current pano at this spot";
}
const WITHDRAWN_NOTE = "Google withdrew the original panorama. This is the panorama it shows at the same spot now, "
  + "which may be a different capture from the one this meta was learned from.";
function replacedBadge(current) {
  const badge = text(captureLabel(current), "replaced");
  badge.title = WITHDRAWN_NOTE;
  return badge;
}

// An <img> that loads the first non-blank of `urls`; if all are blank and `stand_in` is given
// ({ lat, lng, heading, w, h }), it shows the current pano at that spot and calls onReplaced.
function img(urls, { onMissing, standIn, onReplaced } = {}) {
  const el = document.createElement("img");
  el.alt = "";
  el.decoding = "async";
  const seen = urls.length && seenPano.get(viewKey(urls[0]));
  if (seen) el.src = seen;
  // Every pano image carries its pano and heading, so Shift + hover can enlarge it anywhere.
  if (urls.length) {
    const q = new URLSearchParams(urls[0].slice(urls[0].indexOf("?") + 1));
    if (q.get("panoid")) { el.dataset.pano = q.get("panoid"); el.dataset.heading = q.get("yaw") || "0"; }
    if (standIn) { el.dataset.lat = standIn.lat; el.dataset.lng = standIn.lng; }
  }
  el.loadThumb = async () => {
    for (const url of urls) {
      const src = await fetchThumb(url);
      if (src) { el.src = src; return; }
    }
    if (standIn) {
      const current = await currentThumb(standIn.lat, standIn.lng, standIn.heading, standIn.w, standIn.h);
      if (current) {
        el.src = current.src;
        if (onReplaced) onReplaced(el, current);
        return;
      }
    }
    if (onMissing) onMissing(el); else el.style.visibility = "hidden";
  };
  lazy.observe(el);
  return el;
}

// ---------- data ----------
async function getJSON(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
}
async function getBinary(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.arrayBuffer();
}
let inFlight = 0;
async function track(promise) {
  inFlight += 1;
  $("loading").hidden = false;
  try {
    return await promise;
  } finally {
    inFlight -= 1;
    if (!inFlight) $("loading").hidden = true;
  }
}

// Two layouts of the same dots: geography (Web Mercator) and embedding space (UMAP). `xy`/`grid`
// point at the one on screen; geographic lookups (border pairs, coordinates) always use `geo`.
const points = { count: 0, chunk: 4096, xy: null, grid: null, geo: { xy: null, grid: null }, space: { xy: null, grid: null } };
const isSpace = () => state.view === "space";
const panoChunks = new Map();
function panoAt(i) {
  const k = Math.floor(i / points.chunk);
  if (!panoChunks.has(k)) panoChunks.set(k, getJSON(`data/points/p/${k}.json`).catch(() => { panoChunks.delete(k); return null; }));
  return panoChunks.get(k).then((rows) => (rows ? rows[i - k * points.chunk] : null));
}

// Spatial hash over Mercator xy for hover and click lookups.
const GRID = 1024;
function buildGrid(layer = isSpace() ? points.space : points.geo) {
  const { xy } = layer;
  const { count } = points;
  const cellOf = new Uint32Array(count);
  const starts = new Uint32Array(GRID * GRID + 1);
  for (let i = 0; i < count; i += 1) {
    const gx = Math.min(GRID - 1, Math.max(0, Math.floor(xy[2 * i] * GRID)));
    const gy = Math.min(GRID - 1, Math.max(0, Math.floor(xy[2 * i + 1] * GRID)));
    const c = gy * GRID + gx;
    cellOf[i] = c;
    starts[c + 1] += 1;
  }
  for (let c = 0; c < GRID * GRID; c += 1) starts[c + 1] += starts[c];
  const fill = starts.slice(0, GRID * GRID);
  const items = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) items[fill[cellOf[i]]++] = i;
  layer.grid = { starts, items };
  if (layer.xy === points.xy) points.grid = layer.grid;
}
// Points within `radius` (world units) of (x, y). Geography wraps around the antimeridian; space does not.
function* near(x, y, radius, layer = null) {
  const { starts, items } = layer ? layer.grid : points.grid;
  const xy = layer ? layer.xy : points.xy;
  const wraps = xy === points.geo.xy;
  const r2 = radius * radius;
  const span = Math.ceil(radius * GRID);
  const cx = Math.floor(x * GRID), cy = Math.floor(y * GRID);
  for (let gy = Math.max(0, cy - span); gy <= Math.min(GRID - 1, cy + span); gy += 1) {
    for (let dx = -span; dx <= span; dx += 1) {
      if (!wraps && (cx + dx < 0 || cx + dx >= GRID)) continue;
      const gx = ((cx + dx) % GRID + GRID) % GRID;
      const wrap = cx + dx < 0 ? -1 : cx + dx >= GRID ? 1 : 0;
      const c = gy * GRID + gx;
      for (let k = starts[c]; k < starts[c + 1]; k += 1) {
        const i = items[k];
        const ddx = xy[2 * i] + wrap - x, ddy = xy[2 * i + 1] - y;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 <= r2) yield [i, d2];
      }
    }
  }
}

const levelStore = new Map();
function storeFor(level) {
  if (!levelStore.has(level)) levelStore.set(level, { metas: null, ids: null, pending: null });
  return levelStore.get(level);
}
function ensureLevel(level) {
  const store = storeFor(level);
  if (!store.pending) {
    store.pending = track(Promise.all([getJSON(`data/${level}/metas.json`), getBinary(`data/${level}/ids.u16`),
      getJSON(`data/${level}/labels.json`).catch(() => ({})), getJSON(`data/${level}/colors.json`).catch(() => ({}))]))
      .then(([metas, ids, labels, colors]) => {
        for (const m of metas) {
          if (colors[m.id]) m.distinctRgb = colors[m.id];
          const label = labels[m.id];
          m.place = metaName(m);
          if (label) Object.assign(m, { label: label.name, note: label.note, kind: label.kind, sure: label.sure });
          m.name = m.label || m.place;
          m.search = `${m.name} ${m.place} ${m.note || ""}`.toLowerCase();
        }
        store.metas = new Map(metas.map((m) => [m.id, m]));
        store.ids = new Uint16Array(ids);
        return store;
      }, (error) => { store.pending = null; throw error; });
  }
  return store.pending;
}

let levelToken = 0;
let wantedLevel = null;
function toggleColors() {
  colorScheme = colorScheme === "distinct" ? "look" : "distinct";
  syncSchemeToggle();
  try { localStorage.setItem(SCHEME_KEY, colorScheme); } catch (_) { /* no storage */ }
  for (const store of levelStore.values()) if (store.metas) for (const m of store.metas.values()) m.rgbTriple = null;
  recolor();
  renderList();
  if (state.selected && state.metas.get(state.selected)) showMeta(state.metas.get(state.selected));
  scheduleDraw();
}

function syncSchemeToggle() {
  const on = colorScheme === "distinct";
  $("scheme-toggle").setAttribute("aria-pressed", String(on));
  $("scheme-toggle").textContent = on ? "On" : "Off";
}
// The extras live in one Tools menu so the default screen stays calm.
function setTools(open) {
  $("tools-menu").hidden = !open;
  $("tools-toggle").setAttribute("aria-expanded", String(open));
}
$("tools-toggle").addEventListener("click", (event) => { event.stopPropagation(); setTools($("tools-menu").hidden); });
document.addEventListener("click", (event) => {
  if (!$("tools-menu").hidden && !event.target.closest("#tools-menu")) setTools(false);
});
$("scheme-toggle").addEventListener("click", toggleColors);
syncSchemeToggle();

// The top bar names three places, as the home screen does: Explore, Map, Practice. World and
// Space are two ways of looking at the map (a switch on the map itself), and the level is a
// setting (a menu), so the bar no longer mixes places, views and settings in one row.
function syncNav() {
  const at = explore.isOpen() ? "explore" : practice.isOpen() ? "practice" : "map";
  for (const b of $("view-control").children) b.setAttribute("aria-pressed", String(b.dataset.view === at));
  for (const b of $("space-switch").children) b.setAttribute("aria-pressed", String(b.dataset.view === state.view));
}
function setLevelMenu(open) {
  $("level-control").hidden = !open;
  $("level-button").setAttribute("aria-expanded", String(open));
}
$("level-button").addEventListener("click", (event) => { event.stopPropagation(); setLevelMenu($("level-control").hidden); });
document.addEventListener("click", (event) => { if (!$("level-control").hidden && !event.target.closest(".level-pick")) setLevelMenu(false); });

async function setLevel(level, { select = null } = {}) {
  const token = ++levelToken;
  wantedLevel = level;
  for (const button of $("level-control").children) {
    button.setAttribute("aria-pressed", String(button.dataset.level === level));
  }
  $("level-name").textContent = LEVEL_NAMES[level] || level;
  const store = await ensureLevel(level);
  if (token !== levelToken) return;
  state.level = level;
  state.metas = store.metas;
  state.ids = store.ids;
  state.compare = null;
  $("compare-view").hidden = true;
  state.mix = null;
  state.preview = null;
  state.selected = null;
  clearPin();
  closeViewer();
  hovered = -1;
  $("hover-card").hidden = true;
  if (split.on) clearLinks();
  renderList();
  warmCentres();
  if (train.on) { train.next = null; train.streak = 0; recolor(); nextQuestion(); }
  else if (select && store.metas.has(select)) selectMeta(select, { fit: false });
  else { showList(); recolor(); }
  writeHash();
  if (countryHi.list.length) setCountries(countryHi.list);   // labels follow the new level
  explore.onLevel(level);
  practice.onLevel(level);
  metaPage.onLevel(level);
}

function countryPart(m) {
  const [top, share] = m.countries[0];
  if (share >= 0.85) return countryName(top);
  const parts = [];
  let acc = 0;
  for (const [code, s] of m.countries) {
    if (parts.length && s < 0.04) break;
    parts.push(countryName(code));
    acc += s;
    if (acc >= 0.75 || parts.length === 3) break;
  }
  return parts.join(" / ");
}
// Width of a map label as drawn (.space-label: 0.72rem, weight 950, uppercase), cached per text.
const labelWidths = new Map();
let labelCtx = null;
function labelWidth(label) {
  let w = labelWidths.get(label);
  if (w === undefined) {
    if (!labelCtx) {
      labelCtx = document.createElement("canvas").getContext("2d");
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      labelCtx.font = `900 ${0.72 * rem}px ${getComputedStyle(document.body).fontFamily}`;
    }
    w = Math.ceil(labelCtx.measureText(label.toUpperCase()).width * 1.04);
    labelWidths.set(label, w);
  }
  return w;
}
function metaName(m) {
  const bits = [countryPart(m)];
  if (m.urbanTag) bits.push(m.urbanTag);
  if (m.where && m.countries[0][1] >= 0.85) bits.push(m.where);
  return bits.join(" · ");
}

// ---------- map ----------
const map = L.map("map", {
  center: [22, 5],
  zoom: 2,
  minZoom: 2,
  maxZoom: 12,
  worldCopyJump: true,
  zoomAnimation: false,
  zoomSnap: 0.5,
  zoomDelta: 0.5,
  wheelPxPerZoomLevel: 90,
  attributionControl: true,
  zoomControl: false,
});
L.control.zoom({ position: "bottomleft" }).addTo(map);
// World | Space: two ways of looking at the map, switched on the map itself (it travels with the
// map into the practice review).
const SpaceSwitch = L.Control.extend({
  options: { position: "topright" },
  onAdd() {
    const box = L.DomUtil.create("div", "segmented-control small space-switch");
    box.id = "space-switch";
    box.innerHTML = '<button type="button" data-view="map" aria-pressed="true" title="Each location where it is (M)">World</button>'
      + '<button type="button" data-view="space" aria-pressed="false" title="Each location next to the ones that look most like it (S)">Space</button>';
    L.DomEvent.disableClickPropagation(box);
    L.DomEvent.disableScrollPropagation(box);
    box.addEventListener("click", (event) => {
      const b = event.target.closest("button");
      if (b && practice.allowsSpace()) setView(b.dataset.view);
    });
    return box;
  },
});
new SpaceSwitch().addTo(map);
// Highlight countries: a box on the map (under World | Space), mainly for Space, where it shows
// which regions of look-space a country fills. Every dot's country is data/points/cc.u8
// (pipeline/countries.py), loaded the first time the box is used.
const countryHi = { cc: null, codes: null, counts: null, list: [], map: new Map(), loading: null };
function loadCountries() {
  if (!countryHi.loading) {
    countryHi.loading = Promise.all([getJSON("data/points/countries.json"), getBinary("data/points/cc.u8")]).then(([codes, buf]) => {
      countryHi.codes = codes;
      countryHi.cc = new Uint8Array(buf);
      const counts = new Uint32Array(codes.length);
      for (let i = 0; i < countryHi.cc.length; i += 1) counts[countryHi.cc[i]] += 1;
      countryHi.counts = counts;
    });
  }
  return countryHi.loading;
}
function setCountries(list) {
  countryHi.list = list.slice(0, 4);
  countryHi.map = new Map(countryHi.list.map((ci, k) => [ci, k]));
  const chips = $("cty-chips");
  chips.textContent = "";
  countryHi.list.forEach((ci, k) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "cty-chip";
    chip.title = "Remove";
    const dot = document.createElement("i");
    dot.style.background = countryHi.list.length > 1 ? PILE_COLORS[k] : "#ffffff";
    chip.append(dot, text(countryName(countryHi.codes[ci]), "name"), text(countryHi.counts[ci].toLocaleString(), "pct"), text("×", "x"));
    chip.addEventListener("click", () => setCountries(countryHi.list.filter((x) => x !== ci)));
    chips.append(chip);
  });
  chips.hidden = !countryHi.list.length;
  // Labels in Space: only the metas with at least a quarter of their dots in these countries.
  countryHi.labelIds = null;
  if (countryHi.list.length && state.ids) {
    const inside = new Map();
    for (let i = 0; i < state.ids.length; i += 1) if (countryHi.map.has(countryHi.cc[i]) && state.ids[i]) inside.set(state.ids[i], (inside.get(state.ids[i]) || 0) + 1);
    countryHi.labelIds = new Set([...inside].filter(([id, n]) => state.metas.has(id) && n >= 0.25 * state.metas.get(id).size).map(([id]) => id));
    countryHi.labelLevel = state.level;
  }
  recolor();
  drawLabels();
}
const CountryBox = L.Control.extend({
  options: { position: "topright" },
  onAdd() {
    const box = L.DomUtil.create("div", "cty-box");
    box.innerHTML = '<input id="cty-q" type="search" placeholder="Highlight countries" autocomplete="off" spellcheck="false" title="Light a country\'s locations (up to four, each in its own color)">'
      + '<div class="cty-sug" id="cty-sug" hidden></div><div class="cty-chips" id="cty-chips" hidden></div>';
    L.DomEvent.disableClickPropagation(box);
    L.DomEvent.disableScrollPropagation(box);
    return box;
  },
});
new CountryBox().addTo(map);
(() => {
  const q = $("cty-q"), sug = $("cty-sug");
  let first = null;
  const suggest = async () => {
    await loadCountries();
    const t = q.value.trim().toLowerCase();
    sug.textContent = "";
    first = null;
    if (!t) { sug.hidden = true; return; }
    const hits = countryHi.codes.map((c, ci) => [ci, countryName(c)])
      .filter(([ci, name]) => !countryHi.map.has(ci) && (name.toLowerCase().includes(t) || countryHi.codes[ci].toLowerCase() === t))
      .sort((a, b) => countryHi.counts[b[0]] - countryHi.counts[a[0]]).slice(0, 8);
    for (const [ci, name] of hits) {
      const b = document.createElement("button");
      b.type = "button";
      b.append(text(name, "name"), text(countryHi.counts[ci].toLocaleString(), "pct"));
      b.addEventListener("mousedown", (e) => { e.preventDefault(); pick(ci); });
      sug.append(b);
      if (first === null) first = ci;
    }
    sug.hidden = !hits.length;
  };
  const pick = (ci) => { q.value = ""; sug.hidden = true; setCountries([...countryHi.list, ci]); };
  q.addEventListener("focus", loadCountries);
  q.addEventListener("input", suggest);
  q.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && first !== null) { e.preventDefault(); pick(first); }
    if (e.key === "Escape") { if (!q.value && countryHi.list.length) setCountries([]); q.value = ""; sug.hidden = true; q.blur(); }   // Esc on an empty box clears
  });
  q.addEventListener("blur", () => setTimeout(() => { sug.hidden = true; }, 120));
})();
// Open on about one world's width: the map spans the window now that the list is in Explore.
map.setView([22, 5], Math.max(2, Math.floor(2 * Math.log2(map.getSize().x / 256)) / 2), { animate: false });
map.createPane("dots").style.zIndex = 350;
map.createPane("labels").style.zIndex = 450;
map.getPane("labels").style.pointerEvents = "none";
const esri = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/{layer}/MapServer/tile/{z}/{y}/{x}";
const attribution = "Esri, HERE, Garmin, &copy; OpenStreetMap contributors";
const baseTiles = L.tileLayer(esri, { layer: "World_Dark_Gray_Base", maxNativeZoom: 16, attribution }).addTo(map);
const labelTiles = L.tileLayer(esri, { layer: "World_Dark_Gray_Reference", maxNativeZoom: 16, pane: "labels", opacity: 0.85 }).addTo(map);
function wrapNear(lng, ref) { return lng + 360 * Math.round((ref - lng) / 360); }

// ---------- WebGL dots ----------
// One renderer per map (the main map, and the Space map in Split view). Each has its own canvas and
// WebGL2 context, since contexts cannot share buffers; both draw from the same colour array.
const DOT_VS = `#version 300 es
    precision highp float;
    in vec2 a_xy;               // map position (Web Mercator, unit square)
    in vec2 a_space;            // Space-view position (same unit square)
    in vec4 a_color;           // alpha 255 marks an emphasised dot
    uniform float u_t;          // 0 = map, 1 = Space; in between while morphing
    uniform float u_world;      // CSS px per world unit at this zoom
    uniform vec2 u_origin;      // world px at the canvas's top-left
    uniform vec2 u_view;        // canvas size in CSS px
    uniform float u_shift;      // world copy (-1, 0, 1)
    uniform float u_size;
    uniform float u_emph;
    uniform float u_dpr;
    uniform int u_pass;         // 0: everything, 1: emphasised only, 2: lens (drawn larger, in u_lens)
    uniform vec4 u_lens;        // lens color (rgb) and size factor (w): white x1.7 for the linked
                                // view's lens, red for Guess's look-alikes
    out vec4 v_color;
    void main() {
      bool emph = a_color.a > 0.995;
      if (u_pass == 1 && !emph) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
      vec2 pos = u_t <= 0.0 ? a_xy : (u_t >= 1.0 ? a_space : mix(a_xy, a_space, u_t));
      vec2 px = (pos + vec2(u_shift, 0.0)) * u_world - u_origin;
      gl_Position = vec4(px.x / u_view.x * 2.0 - 1.0, 1.0 - px.y / u_view.y * 2.0, 0.0, 1.0);
      // Lens dots stay at least 3.5 px so they read even in a zoomed-out inset.
      gl_PointSize = (u_pass == 2 ? max(u_size * u_lens.w, 3.5) : u_size * (emph ? u_emph : 1.0)) * u_dpr;
      v_color = u_pass == 2 ? vec4(u_lens.rgb, 1.0) : a_color;
    }`;
const DOT_FS = `#version 300 es
    precision mediump float;
    in vec4 v_color;
    uniform int u_accum;        // 1: accumulate colour * weight and weight (blend mode)
    out vec4 outColor;
    void main() {
      vec2 c = gl_PointCoord * 2.0 - 1.0;
      float r = dot(c, c);
      if (r > 1.0) discard;
      if (u_accum == 1) {
        float w = smoothstep(1.0, 0.7, r) * (v_color.a > 0.995 ? 1.0 : v_color.a / 0.784);
        outColor = vec4(pow(v_color.rgb, vec3(2.2)) * w, w);   // average in linear light
        return;
      }
      float a = v_color.a > 0.995 ? 1.0 : v_color.a;
      a *= smoothstep(1.0, 0.7, r);
      outColor = vec4(v_color.rgb * a, a);
    }`;
const BLEND_VS = `#version 300 es
    out vec2 v_uv;
    void main() {
      vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
      v_uv = p;
      gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
    }`;
const BLEND_FS = `#version 300 es
    precision highp float;
    uniform sampler2D u_acc;
    uniform float u_gain;
    uniform float u_sat;        // averaging washes colours out; push them back from grey
    in vec2 v_uv;
    out vec4 outColor;
    void main() {
      vec4 acc = texture(u_acc, v_uv);
      if (acc.a < 1e-4) discard;
      vec3 col = pow(acc.rgb / acc.a, vec3(1.0 / 2.2));
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = clamp(vec3(lum) + (col - vec3(lum)) * u_sat, 0.0, 1.0);
      float op = 1.0 - exp(-acc.a * u_gain);
      outColor = vec4(col * op, op);
    }`;
let dotColors = null;          // Uint8Array, RGBA per dot, written by recolor()
let dotOrder = null;           // random draw order, so no meta systematically paints over its neighbours
function drawOrder() {
  if (!dotOrder) {
    dotOrder = new Uint32Array(points.count);
    for (let i = 0; i < dotOrder.length; i += 1) dotOrder[i] = i;
    let seed = 20261109;
    for (let i = dotOrder.length - 1; i > 0; i -= 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const j = seed % (i + 1);
      const t = dotOrder[i]; dotOrder[i] = dotOrder[j]; dotOrder[j] = t;
    }
  }
  return dotOrder;
}
function compileOn(g, type, source) {
  const shader = g.createShader(type);
  g.shaderSource(shader, source);
  g.compileShader(shader);
  if (!g.getShaderParameter(shader, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(shader));
  return shader;
}
function linkOn(g, vs, fs) {
  const program = g.createProgram();
  g.attachShader(program, compileOn(g, g.VERTEX_SHADER, vs));
  g.attachShader(program, compileOn(g, g.FRAGMENT_SHADER, fs));
  g.linkProgram(program);
  if (!g.getProgramParameter(program, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(program));
  return program;
}
// a_xy: positions for t = 0; a_space: positions for t = 1 (the main map morphs between them; the
// Space map in Split view gets the Space layout as a_xy and stays at t = 0).
function createDots(mapObj, xy) {
  const cv = document.createElement("canvas");
  cv.className = "dot-canvas";
  mapObj.getPane("dots").appendChild(cv);
  const g = cv.getContext("webgl2", { antialias: false, premultipliedAlpha: true, alpha: true });
  const r = { map: mapObj, canvas: cv, gl: g };
  r.program = linkOn(g, DOT_VS, DOT_FS);
  r.u = Object.fromEntries(["u_world", "u_origin", "u_view", "u_shift", "u_size", "u_emph", "u_dpr", "u_pass", "u_accum", "u_t", "u_lens"]
    .map((name) => [name, g.getUniformLocation(r.program, name)]));
  r.vao = g.createVertexArray();
  g.bindVertexArray(r.vao);
  const attrib = (name, buffer, size, type, norm) => {
    const loc = g.getAttribLocation(r.program, name);
    g.bindBuffer(g.ARRAY_BUFFER, buffer);
    g.enableVertexAttribArray(loc);
    g.vertexAttribPointer(loc, size, type, norm, 0, 0);
  };
  r.xy = g.createBuffer();
  g.bindBuffer(g.ARRAY_BUFFER, r.xy);
  g.bufferData(g.ARRAY_BUFFER, xy, g.STATIC_DRAW);
  attrib("a_xy", r.xy, 2, g.FLOAT, false);
  r.space = g.createBuffer();                 // filled by setSpaceLayout(); until then a copy of xy
  g.bindBuffer(g.ARRAY_BUFFER, r.space);
  g.bufferData(g.ARRAY_BUFFER, points.space.xy || xy, g.STATIC_DRAW);
  attrib("a_space", r.space, 2, g.FLOAT, false);
  r.color = g.createBuffer();
  g.bindBuffer(g.ARRAY_BUFFER, r.color);
  g.bufferData(g.ARRAY_BUFFER, dotColors, g.DYNAMIC_DRAW);
  attrib("a_color", r.color, 4, g.UNSIGNED_BYTE, true);
  r.index = g.createBuffer();
  g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, r.index);
  g.bufferData(g.ELEMENT_ARRAY_BUFFER, drawOrder(), g.STATIC_DRAW);
  g.bindVertexArray(null);
  r.lens = g.createBuffer();                  // indices of dots under the other view's lens
  r.lensCount = 0;
  if (g.getExtension("EXT_color_buffer_float")) {
    const program = linkOn(g, BLEND_VS, BLEND_FS);
    r.blend = { program, tex: g.createTexture(), fbo: g.createFramebuffer(), w: 0, h: 0,
      u_acc: g.getUniformLocation(program, "u_acc"), u_gain: g.getUniformLocation(program, "u_gain"),
      u_sat: g.getUniformLocation(program, "u_sat"), vao: g.createVertexArray() };
  }
  return r;
}
function uploadColors(r) {
  r.gl.bindBuffer(r.gl.ARRAY_BUFFER, r.color);
  r.gl.bufferSubData(r.gl.ARRAY_BUFFER, 0, dotColors);
}
function setLens(r, indices) {
  const g = r.gl;
  g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, r.lens);
  g.bufferData(g.ELEMENT_ARRAY_BUFFER, indices, g.DYNAMIC_DRAW);
  r.lensCount = indices.length;
}
function blendTarget(r) {
  const g = r.gl, b = r.blend;
  if (b.w !== r.canvas.width || b.h !== r.canvas.height) {
    b.w = r.canvas.width; b.h = r.canvas.height;
    g.bindTexture(g.TEXTURE_2D, b.tex);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA16F, b.w, b.h, 0, g.RGBA, g.HALF_FLOAT, null);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
    g.bindFramebuffer(g.FRAMEBUFFER, b.fbo);
    g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, b.tex, 0);
  }
  return b;
}
let gpu = {};                  // the main map's renderer
const split = { on: false, map: null, dots: null };   // Split view: a second map for the Space layout
function initGL() {
  dotColors = new Uint8Array(points.count * 4);
  gpu = createDots(map, points.geo.xy);
  gpu.colors = dotColors;
}

function focusId() { return state.preview || state.selected; }
// Compare mode paints the two metas in fixed contrasting colours: close metas are, by design,
// close in look-colour, which would make them hard to tell apart on the map.
const COMPARE_COLORS = ["#4ed8ff", "#ffb938"];
// Practice piles 1-4, on the piles and on the map (distinct from each other and from the
// right/wrong feedback colors).
const PILE_COLORS = ["#5aa9ff", "#ffb347", "#e879f9", "#b5e853", "#4ee0d0", "#ff8a3d", "#a78bfa", "#ffe14d"];
function displayColor(m) {
  if (state.compare && m) {
    if (m.id === state.selected) return COMPARE_COLORS[0];
    if (m.id === state.compare) return COMPARE_COLORS[1];
  }
  return colorOf(m);
}

// Colour every point for the current level, focus and search.
// Unselected metas when something is selected, searched or compared: their own colour at 32%
// of the way from the background (solid, so dense areas stay dim). ?dim=0 gives the old grey.
let DIM = Number(new URLSearchParams(location.search).get("dim") ?? 0.32);
// Colour by: "meta" (each meta's colour), "place" (every dot by where it is on Earth) or "look"
// (every dot by where it sits in the Space layout). Place in the Space view shows which islands
// come from where; Look on the map shows which places share a look, both without hovering.
// Two-axis OKLab colour maps at constant lightness: one axis to a, the other to b.
let colorBy = "meta";
const byColors = { place: null, look: null };
function bivariate(xy, fx, fy) {
  const out = new Uint8Array(points.count * 3);
  const enc = (c) => Math.round(255 * Math.min(1, Math.max(0, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)));
  for (let i = 0; i < points.count; i += 1) {
    const A = 0.34 * (fx(xy[2 * i]) - 0.5), B = 0.34 * (fy(xy[2 * i + 1]) - 0.5), Lc = 0.74;
    const l = (Lc + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (Lc - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s2 = (Lc - 0.0894841775 * A - 1.291485548 * B) ** 3;
    out[3 * i] = enc(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s2);
    out[3 * i + 1] = enc(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s2);
    out[3 * i + 2] = enc(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s2);
  }
  return out;
}
function dotColorsBy(mode) {
  if (mode === "place" && !byColors.place) {
    // x: longitude across; y: latitude between 60 S and 72 N (Mercator y converted to latitude).
    byColors.place = bivariate(points.geo.xy, (x) => x, (y) => 1 - (Math.min(72, Math.max(-60, latOfY(y))) + 60) / 132);
  }
  if (mode === "look" && !byColors.look && points.space.xy) {
    byColors.look = bivariate(points.space.xy, (x) => (x - 0.1) / 0.8, (y) => (y - 0.05) / 0.9);
  }
  return byColors[mode];
}
async function setColorBy(mode) {
  if (mode === "look") await loadSpaceLayout();
  colorBy = mode;
  for (const b of $("color-mode").children) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
  recolor();
  drawLegend();
}
// Legend for Place / Look colouring: a miniature of the layout the colours come from (the world
// for Place, Space for Look), unless the linked inset already shows it.
function drawLegend() {
  const cv = $("legend");
  const sourceGeo = colorBy === "place";
  const shownInMain = colorBy === "place" ? !isSpace() : isSpace();
  const shownInInset = split.on && (colorBy === "place" ? insetIsGeo() : !insetIsGeo());
  cv.hidden = colorBy === "meta" || shownInMain || shownInInset;
  if (cv.hidden) return;
  const per = dotColorsBy(colorBy);
  const xy = sourceGeo ? points.geo.xy : points.space.xy;
  const W = 240, H = sourceGeo ? 130 : 200;
  const [x0, x1, y0, y1] = sourceGeo ? [0, 1, 0.2, 0.75] : [0.08, 0.92, 0.0, 1.0];
  const dpr = window.devicePixelRatio || 1;
  cv.width = W * dpr; cv.height = H * dpr;
  cv.style.width = `${W}px`; cv.style.height = `${H}px`;
  const ctx = cv.getContext("2d");
  const im = ctx.createImageData(cv.width, cv.height);
  for (let i = 0; i < points.count; i += 7) {
    const px = Math.floor((xy[2 * i] - x0) / (x1 - x0) * cv.width);
    const py = Math.floor((xy[2 * i + 1] - y0) / (y1 - y0) * cv.height);
    if (px < 0 || py < 0 || px >= cv.width || py >= cv.height) continue;
    const o = 4 * (py * cv.width + px);
    im.data[o] = per[3 * i]; im.data[o + 1] = per[3 * i + 1]; im.data[o + 2] = per[3 * i + 2]; im.data[o + 3] = 255;
  }
  ctx.putImageData(im, 0, 0);
  cv.title = sourceGeo ? "Colors = where each pano is on Earth" : "Colors = where each pano sits in Space";
}
function recolor() {
  if (!gpu.colors || !state.ids) return;
  const { ids, metas, filter } = state;
  const focus = focusId();
  const table = new Uint8Array((Math.max(...metas.keys()) + 1) * 4);
  for (const [id, m] of metas) {
    let [r, g, b] = rgbOf(m);
    let a = 200;
    if (state.piles) {
      // Practice: each pile's meta in its pile color (only the hovered pile, while one is).
      const k = state.piles.ids.indexOf(id);
      a = k >= 0 && (!state.piles.hot.length || state.piles.hot.includes(k)) ? 255 : 0;
      if (a) { const n = parseInt(PILE_COLORS[k].slice(1), 16); [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255]; }
    } else if (state.compare) {
      const k = id === state.selected ? 0 : id === state.compare ? 1 : -1;
      a = k >= 0 ? 255 : 0;
      if (k >= 0) { const n = parseInt(COMPARE_COLORS[k].slice(1), 16); [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255]; }
    } else if ((train.on && train.locating) || state.grayMap) a = 0;   // placing: coverage only
    else if (focus) a = id === focus ? 255 : 0;
    else if (filter) a = filter.has(id) ? 255 : 0;
    table.set([r, g, b, a], id * 4);
  }
  const out = gpu.colors;
  const per = colorBy === "meta" || state.grayMap ? null : dotColorsBy(colorBy);
  // Outside the focus, search or compare, other metas keep their own colour but dimmed, so the
  // map still reads as the map; unclustered panos are faint grey.
  const muted = focus || filter || state.compare || state.piles || state.grayMap || (train.on && train.locating);
  const backAlpha = state.grayMap ? 20 : muted ? 46 : 60;   // gray coverage (Guess) stays faint under the look-alikes
  // Highlighted countries (the map's country box): one country keeps its dots in their meta colors,
  // several get one color each; everything else dims. Not under Practice or a cutout map's own coloring.
  const hi = countryHi.list.length && countryHi.cc && !state.piles && !state.grayMap && !state.compare ? countryHi : null;
  const pile = hi ? hi.list.map((_, k) => { const n = parseInt(PILE_COLORS[k].slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }) : null;
  for (let i = 0; i < ids.length; i += 1) {
    const o = ids[i] * 4;
    if (hi) {
      const k = hi.map.get(hi.cc[i]);
      if (k !== undefined) {
        if (hi.list.length > 1) { const c = pile[k]; out[4 * i] = c[0]; out[4 * i + 1] = c[1]; out[4 * i + 2] = c[2]; }
        else if (ids[i]) { out[4 * i] = table[o]; out[4 * i + 1] = table[o + 1]; out[4 * i + 2] = table[o + 2]; }
        else { out[4 * i] = 200; out[4 * i + 1] = 204; out[4 * i + 2] = 210; }
        out[4 * i + 3] = 255;
      } else if (ids[i]) {
        out[4 * i] = 6 + (table[o] - 6) * DIM; out[4 * i + 1] = 7 + (table[o + 1] - 7) * DIM;
        out[4 * i + 2] = 10 + (table[o + 2] - 10) * DIM; out[4 * i + 3] = 199;
      } else { out[4 * i] = 150; out[4 * i + 1] = 154; out[4 * i + 2] = 162; out[4 * i + 3] = 30; }
      continue;
    }
    if (per && (!muted || (ids[i] && table[o + 3]))) {
      out[4 * i] = per[3 * i]; out[4 * i + 1] = per[3 * i + 1]; out[4 * i + 2] = per[3 * i + 2]; out[4 * i + 3] = muted ? 255 : 200;
    } else if (per && muted) {
      out[4 * i] = 6 + (per[3 * i] - 6) * DIM; out[4 * i + 1] = 7 + (per[3 * i + 1] - 7) * DIM;
      out[4 * i + 2] = 10 + (per[3 * i + 2] - 10) * DIM; out[4 * i + 3] = 199;
    } else if (ids[i] && table[o + 3]) {
      out[4 * i] = table[o]; out[4 * i + 1] = table[o + 1]; out[4 * i + 2] = table[o + 2]; out[4 * i + 3] = table[o + 3];
    } else if (ids[i] && muted && DIM && !train.locating && !state.grayMap && o + 3 < table.length) {
      // A darkened, solid version of the meta's own colour: dense areas cannot stack back up
      // to full brightness the way translucent dots would.
      out[4 * i] = 6 + (table[o] - 6) * DIM; out[4 * i + 1] = 7 + (table[o + 1] - 7) * DIM;
      out[4 * i + 2] = 10 + (table[o + 2] - 10) * DIM; out[4 * i + 3] = 199;
    } else {
      out[4 * i] = 150; out[4 * i + 1] = 154; out[4 * i + 2] = 162; out[4 * i + 3] = backAlpha;
    }
  }
  uploadColors(gpu);
  if (split.dots) uploadColors(split.dots);
  draw();
}

// Mix rendering: where dots overlap, each pixel shows their average colour (in linear light)
// instead of whichever dot was drawn last. Footprint is the dot's own. gain (dot weight ->
// opacity) and sat (saturation pushed back after averaging) were measured against plain dots on
// France at micro, zoom 6: plain 0.89 opacity / 0.70 lightness / 0.41 chroma, Mix 0.91 / 0.72 /
// 0.41. Wider averaging (1.7 and 3 dot sizes) was tried and lost: smoother regions, but blotchy
// and less detailed. The B key flips to plain dots for comparison (not remembered).
const MIX = { gain: 1.7, sat: 1.32 };
const BLEND_BELOW_ZOOM = 9;  // plain dots from here in
let plainDots = new URLSearchParams(location.search).get("paint") === "dots";
function dotSize(z) {
  // Small enough to show roads when zoomed in, big enough to read as regions zoomed out.
  return Math.min(6.5, 1.35 + 0.42 * Math.max(0, z - 2) + 0.05 * Math.max(0, z - 2) ** 2);
}

// Draw one renderer's dots for its map. t: morph position (main map only); wrap: repeat the
// world copies (map layout at t = 0 only); still: false mid-animation (plain dots, no Mix pass).
function drawDots(r, { t = 0, wrap = false, still = true } = {}) {
  const g = r.gl, m = r.map, cv = r.canvas;
  const size = m.getSize();
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(size.x * dpr) || cv.height !== Math.round(size.y * dpr)) {
    cv.width = Math.round(size.x * dpr);
    cv.height = Math.round(size.y * dpr);
    cv.style.width = `${size.x}px`;
    cv.style.height = `${size.y}px`;
  }
  const topLeft = m.containerPointToLayerPoint([0, 0]);
  L.DomUtil.setPosition(cv, topLeft);
  const zoom = m.getZoom();
  const world = 256 * 2 ** zoom;
  const origin = m.getPixelOrigin();
  g.viewport(0, 0, cv.width, cv.height);
  g.clearColor(0, 0, 0, 0);
  g.clear(g.COLOR_BUFFER_BIT);
  g.enable(g.BLEND);
  g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
  g.useProgram(r.program);
  g.bindVertexArray(r.vao);
  g.uniform1f(r.u.u_world, world);
  g.uniform2f(r.u.u_origin, origin.x + topLeft.x, origin.y + topLeft.y);
  g.uniform2f(r.u.u_view, size.x, size.y);
  g.uniform1f(r.u.u_size, dotSize(zoom));
  g.uniform1f(r.u.u_emph, zoom >= 7 ? 1.15 : 1.45);
  g.uniform1f(r.u.u_dpr, dpr);
  g.uniform1f(r.u.u_t, t);
  const passes = focusId() || state.filter || state.compare || (countryHi.list.length && !state.piles && !state.grayMap) ? [0, 1] : [0];
  const left = (origin.x + topLeft.x) / world;
  const right = left + size.x / world;
  const shifts = wrap ? Array.from({ length: Math.floor(right) - Math.floor(left) + 1 }, (_, k) => Math.floor(left) + k) : [0];
  const drawAll = (count = points.count) => {
    for (const shift of shifts) {
      g.uniform1f(r.u.u_shift, shift);
      g.drawElements(g.POINTS, count, g.UNSIGNED_INT, 0);
    }
  };
  // Only the overview blends: with a focus, search or compare, the grey background stays dots.
  // Mid-morph, plain dots: the Mix pass costs a second draw of all 2M dots plus a full-screen
  // pass per frame, which halved the frame rate in flight, and is invisible while dots move.
  // Gray coverage only (Practice's Guess): every dot is the same gray, so averaging colors does
  // nothing but costs a full-resolution float pass; the reveal zooms into dense coverage, where that
  // pass was heavy enough to stall the whole machine on a Retina display.
  const blend = r.blend && !plainDots && still && zoom < BLEND_BELOW_ZOOM && passes.length === 1 && !state.grayMap;
  for (const pass of passes) {
    g.uniform1i(r.u.u_pass, pass);
    if (pass === 0 && blend) {
      const b = blendTarget(r);
      g.bindFramebuffer(g.FRAMEBUFFER, b.fbo);
      g.clearColor(0, 0, 0, 0);
      g.clear(g.COLOR_BUFFER_BIT);
      g.blendFunc(g.ONE, g.ONE);
      g.uniform1i(r.u.u_accum, 1);
      drawAll();
      g.bindFramebuffer(g.FRAMEBUFFER, null);
      g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
      g.useProgram(b.program);
      g.bindVertexArray(b.vao);
      g.activeTexture(g.TEXTURE0);
      g.bindTexture(g.TEXTURE_2D, b.tex);
      g.uniform1i(b.u_acc, 0);
      g.uniform1f(b.u_gain, MIX.gain);
      g.uniform1f(b.u_sat, MIX.sat);
      g.drawArrays(g.TRIANGLES, 0, 3);
      g.useProgram(r.program);
      g.bindVertexArray(r.vao);
      g.uniform1i(r.u.u_accum, 0);
      continue;
    }
    g.uniform1i(r.u.u_accum, 0);
    drawAll();
  }
  // Lens: the dots under the cursor in the other view, white and slightly larger.
  if (r.lensCount) {
    g.uniform1i(r.u.u_pass, 2);
    g.uniform4fv(r.u.u_lens, r.lensColor || [1, 1, 1, 1.7]);
    g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, r.lens);
    drawAll(r.lensCount);
    g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, r.index);
  }
  g.bindVertexArray(null);
}
function draw() {
  if (!gpu.program || !state.ids) return;
  drawDots(gpu, { t: morph.t, wrap: morph.t <= 0, still: !morph.frame });
  if (split.on && split.dots) drawDots(split.dots, { t: insetIsGeo() ? 0 : 1, wrap: insetIsGeo(), still: !morph.frame });
  drawMarks();
}

let frame = 0;
function scheduleDraw() {
  if (frame) return;
  frame = requestAnimationFrame(() => { frame = 0; draw(); });
}
map.on("move zoom resize viewreset", scheduleDraw);
// The map's size can change without a window resize (the old side panel's room released at load,
// cutouts in Explore / Practice / a meta's page, the home screen): Leaflet only notices window
// resizes, and a stale size drew the dots for a narrower map, cut off at the right edge.
new ResizeObserver(() => {
  const el = map.getContainer();
  const size = map.getSize();
  if (Math.abs(el.clientWidth - size.x) > 1 || Math.abs(el.clientHeight - size.y) > 1) {
    map.invalidateSize({ pan: false, animate: false });
    scheduleDraw();
  }
}).observe(map.getContainer());

// ---------- hover / click ----------
const marks = document.createElement("div");
marks.className = "marks";
map.getContainer().appendChild(marks);
const hoverRing = document.createElement("div");
hoverRing.className = "ring";
hoverRing.hidden = true;
marks.appendChild(hoverRing);
let hovered = -1;
function pointPx(i) {
  const world = 256 * 2 ** map.getZoom();
  const origin = map.getPixelOrigin();
  const topLeft = map.containerPointToLayerPoint([0, 0]);
  let x = points.xy[2 * i] * world - origin.x - topLeft.x;
  const y = points.xy[2 * i + 1] * world - origin.y - topLeft.y;
  const size = map.getSize();
  if (!isSpace()) {
    while (x < 0) x += world;
    while (x > size.x && x - world >= 0) x -= world;
  }
  return [x, y];
}
function drawMarks() {
  drawLabels();
  drawSplitMarks();
  if (hovered < 0) { hoverRing.hidden = true; return; }
  const [x, y] = pointPx(hovered);
  hoverRing.style.transform = `translate(${x}px, ${y}px)`;
  hoverRing.hidden = false;
}
function eligible(i) {
  if (gpu.lensSet) return gpu.lensSet.has(i);        // Guess reveal: only the red look-alikes
  const id = state.ids[i];
  if (state.compare) return id === state.selected || id === state.compare;
  const focus = focusId();
  if (focus) return id === focus;
  if (state.filter) return state.filter.has(id);
  return true;
}
function toWorld(containerPoint) {
  const world = 256 * 2 ** map.getZoom();
  const p = map.containerPointToLayerPoint(containerPoint).add(map.getPixelOrigin());
  let x = p.x / world;
  if (!isSpace()) x -= Math.floor(x);
  return [x, p.y / world, world];
}
function nearestPoint(containerPoint, radiusPx) {
  if (!points.grid || !state.ids) return -1;
  const [x, y, world] = toWorld(containerPoint);
  let best = -1, bestD = Infinity;
  for (const [i, d2] of near(x, y, radiusPx / world)) {
    if (d2 < bestD && eligible(i)) { best = i; bestD = d2; }
  }
  return best;
}

let hoverToken = 0;
map.on("mousemove", (event) => {
  if (morph.frame) return;             // dots are in flight between layouts
  if (train.on && !train.answered) { $("hover-card").hidden = true; return; }   // no names before the answer
  if (practice.blindMap()) { $("hover-card").hidden = true; hideSheet(); hovered = -1; return; }   // Where: no peeking at dots
  if (event.originalEvent && event.originalEvent.altKey) { showSheet(map, mainLayer(), event.containerPoint); linkFromMain(event.containerPoint, -1); hidePeek(); return; }
  hideSheet();
  const card = $("hover-card");
  const i = state.viewerOpen ? -1 : pickHover(event.containerPoint);
  if (!state.viewerOpen) prefetchAround(event.containerPoint);
  if (i !== hovered) {
    hovered = i;
    drawMarks();
    if (i >= 0) showHover(i);
    clearTimeout(peekWarmTimer);
    if (i >= 0) peekWarmTimer = setTimeout(async () => { if (hovered !== i) return; const row = await panoAt(i); if (row && hovered === i) warmPeek(row[0], row[1]); }, 250);
  }
  linkFromMain(event.containerPoint, i);
  if (event.originalEvent) shiftHeld = event.originalEvent.shiftKey;   // the event knows; a missed keyup must not stick
  if (shiftHeld) { showPeek(i); card.hidden = true; return; }
  if (!$("peek").hidden) hidePeek();
  if (i < 0) { card.hidden = true; return; }
  const size = map.getSize();
  const [px, py] = pointPx(i);
  const cw = card.offsetWidth || 380, ch = card.offsetHeight || 280;
  // In page coordinates: the map may sit in a cutout (Explore, Practice, a meta's page) rather
  // than fill the window. A map too small to hold the card gets it beside the map, at the cursor's
  // height, so the card never covers the map you are hovering.
  const box = map.getContainer().getBoundingClientRect();
  let x, y;
  if (box.width < cw * 2.2 || box.height < ch * 1.6) {
    x = box.right + 12 + cw <= innerWidth - 8 ? box.right + 12 : box.left - 12 - cw;
    y = Math.max(box.top, box.top + py - ch / 2);         // not above the map, over the top bar
  } else {
    x = box.left + (px + 16 + cw > size.x ? px - 16 - cw : px + 16);
    y = box.top + Math.min(py + 14, size.y - ch - 8);
  }
  card.style.left = `${Math.max(8, Math.min(x, innerWidth - cw - 8))}px`;
  card.style.top = `${Math.max(8, Math.min(y, innerHeight - ch - 8))}px`;
  card.hidden = false;
});
map.on("mouseout", () => { hovered = -1; drawMarks(); $("hover-card").hidden = true; hideSheet(); if (split.on) clearLinks(); });

// Thumbnails take ~150-250 ms of Google-side latency whatever their size, but parallel requests
// are nearly free, so hover images are prefetched for the dots nearest the cursor while it moves
// slowly, and the hovered dot is usually already cached when the cursor lands on it.
const HOVER_W = 720, HOVER_H = 450;
const hoverUrl = (row) => thumb(row[0], row[1], HOVER_W, HOVER_H, 100);
const prefetched = new Set();   // dots whose hover image has been requested
const ready = new Set();        // dots whose hover image is decoded-ready in the cache
const blank = new Set();        // dots Street View has no thumbnail for
const motion = { x: 0, y: 0, t: 0, vx: 0, vy: 0, last: 0 };
let prefetchInFlight = 0;
function requestHover(i) {
  prefetched.add(i);
  return panoAt(i).then((row) => (row ? fetchThumb(hoverUrl(row)) : null)).then((src) => {
    if (src) ready.add(i); else blank.add(i);
    return src;
  });
}
function prefetchPoint(i) {
  if (prefetched.has(i) || prefetchInFlight >= 16) return;
  prefetchInFlight += 1;
  requestHover(i).finally(() => { prefetchInFlight -= 1; });
}
function nearestDots(point, radiusPx, count, skip) {
  const [x, y, world] = toWorld(point);
  const best = [];
  for (const [i, d2] of near(x, y, radiusPx / world)) {
    if (!eligible(i) || skip(i)) continue;
    if (best.length < count) best.push([d2, i]);
    else if (d2 < best[count - 1][0]) best[count - 1] = [d2, i];
    else continue;
    best.sort((a, b) => a[0] - b[0]);
  }
  return best.map(([, i]) => i);
}
function prefetchAround(point) {
  const now = performance.now();
  const dt = Math.max(1, now - motion.t);
  motion.vx = 0.6 * motion.vx + 0.4 * (point.x - motion.x) / dt;
  motion.vy = 0.6 * motion.vy + 0.4 * (point.y - motion.y) / dt;
  motion.x = point.x; motion.y = point.y; motion.t = now;
  const speed = Math.hypot(motion.vx, motion.vy) * 1000;
  // Fast sweeps are not aimed at anything; prefetch once the cursor slows down.
  if (speed > 900 || now - motion.last < 70 || !points.grid || !state.ids) return;
  motion.last = now;
  const skip = (i) => prefetched.has(i);
  // Around the cursor, then where it is heading in ~250 ms.
  for (const i of nearestDots(point, 9, 3, skip)) prefetchPoint(i);
  const ahead = L.point(point.x + motion.vx * 250, point.y + motion.vy * 250);
  for (const i of nearestDots(ahead, 9, 3, skip)) prefetchPoint(i);
}
// Which dot to show: keep the current one while it is under the cursor (no flicker), otherwise
// the nearest dot whose picture is already loaded, otherwise the nearest dot.
function pickHover(point) {
  if (!points.grid || !state.ids) return -1;
  const [x, y, world] = toWorld(point);
  let nearest = -1, nearestD = Infinity, readyBest = -1, readyD = Infinity, keep = false;
  for (const [i, d2] of near(x, y, 9 / world)) {
    if (!eligible(i)) continue;
    if (i === hovered) keep = true;
    if (d2 < nearestD) { nearest = i; nearestD = d2; }
    if (ready.has(i) && d2 < readyD) { readyBest = i; readyD = d2; }
  }
  if (keep && (ready.has(hovered) || readyBest < 0)) return hovered;
  return readyBest >= 0 ? readyBest : nearest;
}

const hoverStats = window.__hoverStats = [];
async function showHover(i) {
  const token = ++hoverToken;
  const started = performance.now();
  const id = state.ids[i];
  const m = state.metas.get(id);
  const line = $("hover-line");
  line.textContent = "";
  if (m) line.append(swatch(m), text(m.name, "name"), text(`#${m.id}`, "pct"));
  else line.append(text("Not in any meta", "name"));
  const slot = $("hover-slot");
  const picture = $("hover-img");
  const cached = ready.has(i);
  slot.classList.add("loading");
  slot.classList.remove("missing");
  const src = await requestHover(i);
  if (token !== hoverToken) return;
  slot.classList.remove("loading");
  let shownSrc = src;
  if (!src) {
    const [lat, lng] = pointLatLng(i);
    const row = await panoAt(i);
    const current = row ? await currentThumb(lat, lng, row[1], HOVER_W, HOVER_H) : null;
    if (token !== hoverToken) return;
    if (!current) { slot.classList.add("missing"); return; }
    shownSrc = current.src;
    line.append(replacedBadge(current));
  }
  if (picture.src !== shownSrc) {
    picture.src = shownSrc;
    try { await picture.decode(); } catch {}
  }
  if (token !== hoverToken) return;
  picture.classList.add("shown");
  hoverStats.push({ ms: Math.round(performance.now() - started), prefetched: cached });
  if (hoverStats.length > 500) hoverStats.shift();
}

map.on("click", (event) => {
  if (morph.frame || train.on || practice.isOpen() || explore.isOpen() || metaPage.isOpen()) return;
  const i = nearestPoint(event.containerPoint, 9);
  if (i < 0 || !state.ids[i]) {
    if (state.selected) deselect();
    return;
  }
  // The local mix: metas of all panos within 30 px of the click.
  const [x, y, world] = toWorld(event.containerPoint);
  const counts = new Map();
  let total = 0;
  for (const [j] of near(x, y, 30 / world)) {
    total += 1;
    const id = state.ids[j];
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  }
  const tops = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5);
  state.mix = { tops, total };
  selectMeta(state.ids[i], { fit: false });
});

// ---------- small DOM helpers ----------
function swatch(m) {
  const el = document.createElement("span");
  el.className = "swatch";
  el.style.background = displayColor(m);
  return el;
}
function text(value, className) {
  const el = document.createElement("span");
  if (className) el.className = className;
  el.textContent = value;
  return el;
}

// ---------- list ----------
function matches(m, query) {
  if (!query) return true;
  if (/^#\d+$/.test(query)) return m.id === Number(query.slice(1));
  return query.split(/\s+/).every((word) => m.search.includes(word)
    || m.countries.some(([code, s]) => s >= 0.05 && (code.toLowerCase() === word || countryName(code).toLowerCase().includes(word))));
}

// The list lives in Explore now; its search still filters the map (other metas dim, as with a
// selection), so this only keeps state.filter in step with state.query.
function renderList() {
  const query = (state.query || "").trim().toLowerCase();
  const hits = query ? [...state.metas.values()].filter((m) => matches(m, query)) : null;
  const filter = hits && hits.length < state.metas.size ? new Set(hits.map((m) => m.id)) : null;
  if (String(filter && [...filter]) !== String(state.filter && [...state.filter])) {
    state.filter = filter;
    recolor();
  }
}

// Preview a hovered meta on the map only when it is in view; otherwise hovering the list
// would blank the map to show something off-screen.
function inView(m) {
  const [s, w, n, e] = m.bounds;
  const view = map.getBounds();
  const west = wrapNear(w, view.getCenter().lng);
  return !(n < view.getSouth() || s > view.getNorth() || west > view.getEast() || west + (e - w) < view.getWest());
}
let previewTimer = 0;
function setPreview(id) {
  if (id && !inView(state.metas.get(id))) id = null;
  clearTimeout(previewTimer);
  // A short delay keeps the map still while the mouse travels across the list.
  previewTimer = setTimeout(() => {
    if (state.preview === id) return;
    state.preview = id;
    recolor();
  }, id ? 120 : 60);
}

// ---------- meta view ----------
function selectMeta(id, { fit }) {
  const m = state.metas.get(id);
  if (!m) return;
  clearTimeout(previewTimer);
  state.selected = id;
  state.preview = null;
  state.compare = null;
  $("compare-view").hidden = true;
  showMeta(m);
  if (fit) fitMeta(m);
  writeHash();
  recolor();
}
function fitMeta(m) {
  if (split.on && split.map) refreshInset({ refit: true });
  // Clear of the selection bar under the top bar when it is showing.
  const left = 40;
  const top = $("map-card").hidden ? 100 : $("map-card").offsetTop + $("map-card").offsetHeight + 24;
  if (isSpace()) {
    const [x0, y0, x1, y1] = spaceBounds(m.id);
    map.fitBounds([unitToLatLng(x0, y0), unitToLatLng(x1, y1)], { paddingTopLeft: [left + 20, top + 10], paddingBottomRight: [60, 60], maxZoom: 9 });
    return;
  }
  const [s, w, n, e] = m.bounds;
  map.fitBounds([[s, w], [n, e]], { paddingTopLeft: [left, top], paddingBottomRight: [40, 40], maxZoom: 8 });
}
function deselect() {
  state.selected = null;
  state.compare = null;
  $("compare-view").hidden = true;
  state.mix = null;
  clearPin();
  closeViewer();
  showList();
  writeHash();
  recolor();
}
function showList() { $("map-card").hidden = true; }

// A selected meta on the map gets a small card: name, what to look for, four photos and the
// metas around the click. Its full page is in Explore, one click away.
// A selected meta on the map gets a slim bar under the top bar: its name (click for the full
// page), where and how big, what to look for, Full page / Practice, and the other metas around the
// click. No photos: the hover card shows the dot under the cursor and the full page shows big ones;
// a corner card with four small photos repeated both and covered the map.
function showMeta(m) {
  $("map-card").hidden = false;
  const title = $("mc-title");
  title.textContent = "";
  title.append(swatch(m), text(m.name, "name"));
  const where = m.countries.filter(([, s]) => s >= 0.08).slice(0, 3).map(([c]) => countryName(c)).join(", ")
    || countryName(m.countries[0][0]);
  $("mc-where").textContent = `${LEVEL_NAMES[state.level]} #${m.id} · ${where} · ${m.size.toLocaleString()} panos`;
  $("mc-note").textContent = m.note || m.place;
  metaPage.warm(m);                       // Full page opens with its photos already here
  const mix = $("mc-mix");
  mix.textContent = "";
  const tops = state.mix ? state.mix.tops.filter(([id]) => state.metas.has(id)) : [];
  if (tops.length > 1) {
    mix.append(text(isSpace() ? "Look-alikes here" : "Also here", "mc-label"));
    for (const [mid, count] of tops) {
      if (mid === m.id) continue;
      const other = state.metas.get(mid);
      const chip = document.createElement("button");
      chip.type = "button";
      chip.title = other.note || other.name;
      chip.append(swatch(other), text(other.name, "name"), text(`${Math.round(100 * count / state.mix.total)}%`, "pct"));
      chip.addEventListener("click", () => selectMeta(mid, { fit: false }));
      mix.append(chip);
    }
  }
  mix.hidden = tops.length < 2;
}
$("mc-title").addEventListener("click", () => { if (state.selected) metaPage.open(state.level, state.selected); });
$("mc-close").addEventListener("click", () => deselect());
$("mc-open").addEventListener("click", () => { if (state.selected) metaPage.open(state.level, state.selected); });
$("mc-practice").addEventListener("click", () => { if (state.selected) practice.open({ focus: state.selected }); });

// ---------- space view ----------
// The same dots laid out by UMAP on the visual neighbour graph: look-alikes sit together.
// Unit-square coordinates are drawn exactly like Mercator ones, so pan/zoom/hover all carry over.
const unitToLatLng = (x, y) => map.unproject(L.point(x * 256, y * 256), 0);
const viewports = { map: null, space: null };
// The Space layout (16 MB) loads on first use, into every renderer's a_space buffer.
async function loadSpaceLayout() {
  if (points.space.xy) return;
  points.space.xy = new Float32Array(await track(getBinary("data/points/space.f32")));
  const g = gpu.gl;
  g.bindBuffer(g.ARRAY_BUFFER, gpu.space);
  g.bufferData(g.ARRAY_BUFFER, points.space.xy, g.STATIC_DRAW);
}

// Switching views morphs every dot from its place on the map to its place in the Space layout
// (or back): both layouts share the unit square, so the GPU just blends two positions per dot.
// The morph runs in a frame that shows the whole unit square, so the world map and the Space
// layout are both on screen.
const morph = { t: 0, from: 0, to: 0, start: 0, frame: 0 };
const MORPH_MS = 1700;
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
async function setView(view, { animate = true } = {}) {
  if (view === state.view) return;
  await loadSpaceLayout();
  if (split.on) clearLinks();
  // Label positions before the dots fly (a short pause on the key press, not a stall on landing).
  if (state.level && points.space.xy && !centreCache.has(state.level)) metaCentres();
  if (!morph.frame) viewports[state.view] = { center: map.getCenter(), zoom: map.getZoom() };
  state.view = view;
  document.body.classList.toggle("space", view === "space");
  syncNav();
  const layer = view === "space" ? points.space : points.geo;
  points.xy = layer.xy;
  points.grid = layer.grid;
  hovered = -1;
  $("hover-card").hidden = true;
  clearPin();
  const finish = () => {
    if (view === "map") { baseTiles.addTo(map); labelTiles.addTo(map); fadeTiles(0); }
    else { baseTiles.remove(); labelTiles.remove(); }
    // Leaflet attaches the world-wrap drag hooks when dragging is enabled, so re-enable it.
    map.options.worldCopyJump = view === "map";
    map.dragging.disable();
    map.dragging.enable();
    // After an animated switch, stay on the frame the morph ran in (the selected meta stays
    // highlighted there); zooming in on it would undo the overview the user was watching.
    const m = state.selected ? state.metas.get(state.selected) : null;
    if (!animate && m) fitMeta(m);
    else if (view === "map" && viewports.map && !animate) map.setView(viewports.map.center, viewports.map.zoom, { animate: false });
    if (!layer.grid) setTimeout(() => { buildGrid(layer); }, 0);
    refreshInset({ refit: true });
    draw();
  };
  if (state.selected && !state.compare && state.metas.has(state.selected)) showMeta(state.metas.get(state.selected));
  practice.onView();
  explore.onView();
  metaPage.onView();
  writeHash();
  const target = view === "space" ? 1 : 0;
  if (!animate) {
    morph.t = target;
    if (view === "space" && !state.selected) {
      if (viewports.space) map.setView(viewports.space.center, viewports.space.zoom, { animate: false });
      else fitSpace();
    }
    finish();
    return;
  }
  // Frame both layouts (unless a morph is already running and framed), then blend. The basemap
  // fades with the dots (gone in Space), instead of cutting at one end of the animation.
  if (!morph.frame) fitBoth();
  if (!map.hasLayer(baseTiles)) { fadeTiles(1); baseTiles.addTo(map); labelTiles.addTo(map); }
  cancelAnimationFrame(morph.frame);
  Object.assign(morph, { from: morph.t, to: target, start: performance.now() });
  const tick = (now) => {
    const k = Math.min(1, (now - morph.start) / (MORPH_MS * Math.abs(morph.to - morph.from || 1)));
    morph.t = morph.from + (morph.to - morph.from) * ease(k);
    fadeTiles(morph.t);
    draw();
    if (k < 1) { morph.frame = requestAnimationFrame(tick); return; }
    morph.frame = 0;
    morph.t = morph.to;
    finish();
  };
  morph.frame = requestAnimationFrame(tick);
}
function fadeTiles(t) {
  baseTiles.setOpacity(1 - t);
  labelTiles.setOpacity(0.85 * (1 - t));
}
// The whole unit square: the world map and the Space layout both fit.
function fitBoth() {
  map.fitBounds([unitToLatLng(0.02, 0.02), unitToLatLng(0.98, 0.98)],
    { paddingTopLeft: [30, 80], paddingBottomRight: [30, 20], animate: false });
}
$("view-control").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const go = button.dataset.view;
  if (go === "explore") explore.open();
  else if (go === "practice") practice.open();
  else { explore.close({ carry: true }); practice.close(); metaPage.close({ select: true }); if (train.on) stopTraining(); }
});

// Frame the whole layout: the dots' 0.5-99.5% extent, clear of the top bar.
function fitSpace() {
  const xy = points.space.xy;
  const xs = [], ys = [];
  for (let i = 0; i < points.count; i += 97) { xs.push(xy[2 * i]); ys.push(xy[2 * i + 1]); }
  xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
  const q = (a, f) => a[Math.floor(f * (a.length - 1))];
  map.fitBounds([unitToLatLng(q(xs, 0.005), q(ys, 0.005)), unitToLatLng(q(xs, 0.995), q(ys, 0.995))],
    { paddingTopLeft: [40, 96], paddingBottomRight: [40, 30], animate: false });
}

// Space bounds of a meta: 2nd-98th percentile of a sample of its dots.
function spaceBounds(id) {
  const list = pointsOf(id);
  const step = Math.max(1, Math.floor(list.length / 4000));
  const xs = [], ys = [];
  for (let k = 0; k < list.length; k += step) {
    xs.push(points.space.xy[2 * list[k]]);
    ys.push(points.space.xy[2 * list[k] + 1]);
  }
  xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
  const q = (a, f) => a[Math.min(a.length - 1, Math.floor(f * a.length))];
  return [q(xs, 0.02), q(ys, 0.02), q(xs, 0.98), q(ys, 0.98)];
}

// Where a geographic sample (lat/lng) sits in the current view.
function viewLatLng(lat, lng) {
  if (!isSpace()) return L.latLng(lat, wrapNear(lng, map.getCenter().lng));
  const geo = points.geo;
  if (!geo.grid) return null;
  const s = Math.sin(Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180);
  const x = (lng + 180) / 360, y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  let best = -1, bestD = Infinity;
  for (const [i, d2] of near(x, y, 2e-6, geo)) if (d2 < bestD) { best = i; bestD = d2; }
  return best < 0 ? null : unitToLatLng(points.space.xy[2 * best], points.space.xy[2 * best + 1]);
}

// Meta names at their centres in space, biggest first, skipping any that would overlap.
const labelPool = [];
const centreCache = new Map();
function metaCentres() {
  const key = state.level;
  if (!centreCache.has(key)) {
    const out = [];
    // Median of a ~300-dot sample per meta, in typed arrays (numeric sort): ~10x faster than
    // plain arrays, and precomputed in idle time after a level loads (see warmCentres).
    const xy = points.space.xy;
    const xs = new Float32Array(400), ys = new Float32Array(400);
    for (const m of state.metas.values()) {
      const list = pointsOf(m.id);
      const step = Math.max(1, Math.floor(list.length / 300));
      let n = 0;
      for (let k = 0; k < list.length && n < 400; k += step) {
        xs[n] = xy[2 * list[k]];
        ys[n] = xy[2 * list[k] + 1];
        n += 1;
      }
      const sx = xs.subarray(0, n).sort(), sy = ys.subarray(0, n).sort();
      out.push([m, sx[n >> 1], sy[n >> 1]]);
    }
    out.sort((a, b) => b[0].size - a[0].size);
    centreCache.set(key, out);
  }
  return centreCache.get(key);
}
// The side panel can be hidden (button on its edge, or P) to give the map the full window.
const PANEL_KEY = "meta-map-panel";
let panelOpen = (() => { try { return localStorage.getItem(PANEL_KEY) !== "hidden"; } catch (_) { return true; } })();
// The side panel only holds the trainer and compare now; it is gone the rest of the time.
// P (or the tab on its edge) still hides it while training; that choice is remembered.
const panelNeeded = () => train.on || !!state.compare;
function setPanel(open) {
  panelOpen = open;
  try { localStorage.setItem(PANEL_KEY, open ? "open" : "hidden"); } catch (_) { /* no storage */ }
  const shown = open && panelNeeded();
  $("panel-toggle").hidden = !panelNeeded();
  if (document.body.classList.contains("panel-hidden") === !shown) return;
  document.body.classList.toggle("panel-hidden", !shown);
  const b = $("panel-toggle");
  b.textContent = open ? "›" : "‹";
  b.title = open ? "Hide the panel (P)" : "Show the panel (P)";
  b.setAttribute("aria-expanded", String(open));
  const centre = map.getCenter();
  map.invalidateSize({ pan: false, animate: false });
  map.setView(centre, map.getZoom(), { animate: false });
  scheduleDraw();
}
$("panel-toggle").addEventListener("click", () => setPanel(!panelOpen));
document.body.classList.add("panel-hidden");
$("panel-toggle").hidden = true;
$("panel-toggle").textContent = panelOpen ? "›" : "‹";
$("panel-toggle").title = panelOpen ? "Hide the panel (P)" : "Show the panel (P)";

const LABELS_KEY = "meta-map-labels";
let showLabels = (() => { try { return localStorage.getItem(LABELS_KEY) !== "off"; } catch (_) { return true; } })();
function setLabels(on) {
  showLabels = on;
  try { localStorage.setItem(LABELS_KEY, on ? "on" : "off"); } catch (_) { /* no storage */ }
  $("labels-toggle").setAttribute("aria-pressed", String(on));
  $("labels-toggle").textContent = on ? "On" : "Off";
  drawMarks();
}
$("labels-toggle").setAttribute("aria-pressed", String(showLabels));
$("labels-toggle").textContent = showLabels ? "On" : "Off";
$("labels-toggle").addEventListener("click", () => setLabels(!showLabels));
// Compute label positions before they are needed (after a level loads, once the Space layout is
// there), so the first switch to Space never stalls when the dots land.
function warmCentres() {
  if (!points.space.xy || !state.level || centreCache.has(state.level)) return;
  const level = state.level;
  (window.requestIdleCallback || ((f) => setTimeout(f, 200)))(() => { if (state.level === level) metaCentres(); });
}
function drawLabels() {
  drawLabelsOn(map, marks, labelPool, showLabels && isSpace() && morph.t >= 1);
  if (split.map) drawLabelsOn(split.map, split.marks, split.labelPool, showLabels && split.on && !insetIsGeo(), 24);
}
function drawLabelsOn(m, container, pool, wanted, most = 70) {
  const show = wanted && points.space.xy && state.metas.size && !state.viewerOpen;
  let used = 0;
  if (show) {
    const world = 256 * 2 ** m.getZoom();
    const origin = m.getPixelOrigin();
    const topLeft = m.containerPointToLayerPoint([0, 0]);
    const size = m.getSize();
    const boxes = [];
    const limit = state.compare ? 0 : most;
    for (const [meta, x, y] of metaCentres()) {
      if (used >= limit) break;
      if (state.filter && !state.filter.has(meta.id)) continue;
      if (state.piles && !state.piles.ids.includes(meta.id)) continue;     // practice: only the piles
      if (!state.piles && countryHi.labelIds && countryHi.labelLevel === state.level && !countryHi.labelIds.has(meta.id)) continue;   // highlighted countries' own looks
      const px = x * world - origin.x - topLeft.x, py = y * world - origin.y - topLeft.y;
      if (px < 0 || py < 0 || px > size.x || py > size.y) continue;
      const label = meta.label || `${countryPart(meta)}${meta.urbanTag ? ` · ${meta.urbanTag}` : ""}`;
      const w = 16 + labelWidth(label), h = 20;
      const box = [px - w / 2, py - h / 2, px + w / 2, py + h / 2];
      if (boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
      boxes.push(box);
      let el = pool[used];
      if (!el) {
        el = document.createElement("div");
        el.className = "space-label";
        el.addEventListener("click", () => { state.mix = null; selectMeta(Number(el.dataset.id), { fit: true }); });
        container.appendChild(el);
        pool.push(el);
      }
      el.dataset.id = meta.id;
      el.textContent = label;
      el.style.color = displayColor(meta);
      el.style.opacity = state.selected && meta.id !== state.selected ? "0.35" : "1";
      el.style.transform = `translate(${px - w / 2}px, ${py - h / 2}px)`;
      el.style.maxWidth = `${w}px`;
      el.hidden = false;
      used += 1;
    }
  }
  for (let k = used; k < pool.length; k += 1) pool[k].hidden = true;
}

// ---------- compare ----------
// Two metas side by side: both on the map in contrasting colours, pairs of panos a few km apart
// across their border, and their typical images in two columns.
const EARTH_KM = 40075.017;
const latOfY = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;
function pointLatLng(i) { const xy = points.geo.xy; return [latOfY(xy[2 * i + 1]), xy[2 * i] * 360 - 180]; }
function haversineKm([a, b], [c, d]) {
  const r = Math.PI / 180;
  const h = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(Math.min(1, h)));
}
// Point indices of every meta at the current level (counting sort, cached per level).
function pointsOf(id) {
  const store = storeFor(state.level);
  if (!store.byMeta) {
    const ids = state.ids;
    const starts = new Uint32Array(Math.max(...state.metas.keys()) + 2);
    for (let i = 0; i < ids.length; i += 1) starts[ids[i] + 1] += 1;
    for (let k = 1; k < starts.length; k += 1) starts[k] += starts[k - 1];
    const fill = starts.slice();
    const items = new Uint32Array(ids.length);
    for (let i = 0; i < ids.length; i += 1) items[fill[ids[i]]++] = i;
    store.byMeta = { starts, items };
  }
  const { starts, items } = store.byMeta;
  return items.subarray(starts[id], starts[id + 1]);
}
// The closest cross-meta pairs within `maxKm`, spread at least `spreadKm` apart from each other.
function borderPairs(a, b, { maxKm = 20, spreadKm = 60, want = 10 } = {}) {
  const pa = pointsOf(a), pb = pointsOf(b);
  const flip = pa.length > pb.length;
  const [from, target] = flip ? [pb, a] : [pa, b];
  const stride = Math.max(1, Math.floor(from.length / 30000));
  const found = [];
  let sampled = 0;
  for (let k = 0; k < from.length; k += stride) {
    const i = from[k];
    sampled += 1;
    const x = points.geo.xy[2 * i], y = points.geo.xy[2 * i + 1];
    const kmPerUnit = EARTH_KM * Math.cos(latOfY(y) * Math.PI / 180);
    let best = -1, bestD = Infinity;
    for (const [j, d2] of near(x, y, maxKm / kmPerUnit, points.geo)) {
      if (state.ids[j] === target && d2 < bestD) { best = j; bestD = d2; }
    }
    if (best < 0) continue;
    const km = Math.sqrt(bestD) * kmPerUnit;
    if (km >= 0.3) found.push([km, flip ? best : i, flip ? i : best]);   // skip same-spot duplicates
  }
  found.sort((p, q) => p[0] - q[0]);
  const picked = [];
  for (const pair of found) {
    if (picked.length >= want) break;
    const here = pointLatLng(pair[1]);
    if (picked.every((other) => haversineKm(here, pointLatLng(other[1])) > spreadKm)) picked.push(pair);
  }
  return { pairs: picked, meetShare: sampled ? found.length / sampled : 0, fromIsA: !flip };
}

async function pointItem(i) {
  const row = await panoAt(i);
  if (!row) return null;
  const [lat, lng] = pointLatLng(i);
  return { pano: row[0], heading: row[1], lat, lng, meta: state.metas.get(state.ids[i]) };
}
function compareTile(item, index, items, k) {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "tile";
  tile.style.borderColor = COMPARE_COLORS[k];
  tile.append(img([thumb(item.pano, item.heading, 640, 400)], {
    onMissing: (el) => { el.style.visibility = "hidden"; },
    standIn: { lat: item.lat, lng: item.lng, heading: item.heading, w: 640, h: 400 },
    onReplaced: (_el, current) => tile.append(replacedBadge(current)),
  }));
  tile.addEventListener("mouseenter", () => showPin(item.lat, item.lng));
  tile.addEventListener("mouseleave", clearPin);
  tile.addEventListener("click", () => openViewer(items, index));
  return tile;
}

async function enterCompare(b) {
  const a = state.selected;
  const ma = state.metas.get(a), mb = state.metas.get(b);
  if (!ma || !mb || a === b) return;
  state.compare = b;
  state.preview = null;
  clearTimeout(previewTimer);
  $("map-card").hidden = true;
  $("compare-view").hidden = false;
  setPanel(true);
  const versus = $("versus");
  versus.textContent = "";
  [ma, mb].forEach((m, k) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.style.borderColor = COMPARE_COLORS[k];
    chip.title = `Open ${m.name}`;
    chip.append(swatch(m), text(m.name, "name"), text(`#${m.id}`, "pct"));
    chip.addEventListener("click", () => { exitCompare(); if (m.id !== state.selected) selectMeta(m.id, { fit: true }); });
    versus.append(chip);
  });
  recolor();
  writeHash();
  const [s1, w1, n1, e1] = ma.bounds, [s2, w2, n2, e2] = mb.bounds;
  if (isSpace()) {
    const [a0, a1, a2, a3] = spaceBounds(a), [b0, b1, b2, b3] = spaceBounds(b);
    map.fitBounds([unitToLatLng(Math.min(a0, b0), Math.min(a1, b1)), unitToLatLng(Math.max(a2, b2), Math.max(a3, b3))],
      { paddingTopLeft: [60, 110], paddingBottomRight: [60, 60], maxZoom: 9 });
  } else map.fitBounds([[Math.min(s1, s2), Math.min(w1, w2)], [Math.max(n1, n2), Math.max(e1, e2)]],
    { paddingTopLeft: [40, 100], paddingBottomRight: [40, 40], maxZoom: 8 });

  // Typical images: the two exemplar sets in two columns.
  const columns = $("columns");
  columns.textContent = "";
  const ea = exampleItems(ma), eb = exampleItems(mb);
  for (let r = 0; r < Math.min(8, Math.max(ea.length, eb.length)); r += 1) {
    for (const [list, k] of [[ea, 0], [eb, 1]]) {
      if (list[r]) columns.append(compareTile(list[r], r, list, k));
      else columns.append(document.createElement("span"));
    }
  }

  const pairsBox = $("pairs");
  pairsBox.textContent = "";
  pairsBox.append(text("Finding nearby pairs", "empty-note"));
  $("meet").textContent = "";
  await new Promise((r) => setTimeout(r, 0));
  if (!points.geo.grid) buildGrid(points.geo);
  if (state.compare !== b) return;
  const { pairs, meetShare, fromIsA } = borderPairs(a, b);
  const smaller = fromIsA ? ma : mb, other = fromIsA ? mb : ma;
  $("meet").innerHTML = "";
  $("meet").append(text(`${Math.round(meetShare * 100)}%`, ""), text(` of #${smaller.id}'s panos have a #${other.id} pano within 20 km`));
  $("meet").firstChild.style.fontWeight = "950";
  $("meet").firstChild.style.color = "var(--ink)";
  const items = (await Promise.all(pairs.flatMap(([, i, j]) => [pointItem(i), pointItem(j)])));
  if (state.compare !== b) return;
  pairsBox.textContent = "";
  if (!pairs.length) {
    pairsBox.append(text("These metas never come within 20 km of each other.", "empty-note"));
    return;
  }
  pairs.forEach(([km], p) => {
    const row = document.createElement("div");
    row.className = "pair";
    const two = document.createElement("div");
    two.className = "two";
    const ia = items[2 * p], ib = items[2 * p + 1];
    if (ia) two.append(compareTile(ia, 2 * p, items.filter(Boolean), 0));
    if (ib) two.append(compareTile(ib, 2 * p + 1, items.filter(Boolean), 1));
    row.append(two, text(`${km < 1 ? km.toFixed(1) : Math.round(km)} km apart`, "caption"));
    row.addEventListener("mouseenter", () => { if (ia && ib) showPins([ia, ib]); });
    row.addEventListener("mouseleave", clearPin);
    pairsBox.append(row);
  });
}

function exitCompare() {
  if (!state.compare) return;
  state.compare = null;
  $("compare-view").hidden = true;
  setPanel(panelOpen);
  clearPin();
  const m = state.metas.get(state.selected);
  if (m) showMeta(m); else showList();
  recolor();
  writeHash();
}
$("compare-back").addEventListener("click", exitCompare);

// ---------- viewer ----------
// Items: { pano, heading, lat, lng, code?, meta }. `turn` rotates the view in 90° steps, because
// the embedding saw all four directions and the clue may not be ahead.
const viewer = { items: [], index: 0, turn: 0 };
function exampleItems(m) {
  return m.examples.map(([pano, lat, lng, heading, code]) => ({ pano, lat, lng, heading, code, meta: m }));
}
function openViewer(items, index) {
  viewer.items = items;
  viewer.index = index;
  state.viewerOpen = true;
  $("viewer").hidden = false;
  $("hover-card").hidden = true;
  renderViewer();
}
function viewerUrl(item) {
  return thumb(item.pano, Math.round(item.heading + 90 * viewer.turn) % 360, 1600, 900, 100);
}
function renderViewer() {
  const item = viewer.items[viewer.index];
  const n = viewer.items.length;
  const picture = $("viewer-img");
  const shown = `${viewer.index}/${viewer.turn}`;
  picture.style.visibility = "hidden";
  $("viewer-count").textContent = `${viewer.index + 1} / ${n}`;
  $("viewer-note").hidden = true;
  warm([viewer.items[viewer.index + 1], viewer.items[viewer.index - 1]].filter(Boolean).map(viewerUrl));
  fetchThumb(viewerUrl(item)).then(async (src) => {
    if (`${viewer.index}/${viewer.turn}` !== shown) return;
    if (src) { picture.src = src; picture.style.visibility = ""; return; }
    const yaw = Math.round(item.heading + 90 * viewer.turn) % 360;
    const current = await currentThumb(item.lat, item.lng, yaw, 1600, 900);
    if (`${viewer.index}/${viewer.turn}` !== shown) return;
    if (!current) { $("viewer-count").textContent = `${viewer.index + 1} / ${n} · no image`; return; }
    picture.src = current.src;
    picture.style.visibility = "";
    $("viewer-note").textContent = captureLabel(current);
    $("viewer-note").title = WITHDRAWN_NOTE;
    $("viewer-note").hidden = false;
    $("viewer-link").href = streetView(current.pano, yaw);
  });
  for (const b of $("viewer-turn").children) b.setAttribute("aria-pressed", String(Number(b.dataset.turn) === viewer.turn));
  $("viewer-swatch").style.background = displayColor(item.meta);
  $("viewer-name").textContent = `${item.meta.name} #${item.meta.id}`;
  $("viewer-where").textContent = `${item.code ? `${countryName(item.code)} · ` : ""}${item.lat.toFixed(3)}, ${item.lng.toFixed(3)}`;
  $("viewer-link").href = streetView(item.pano, Math.round(item.heading + 90 * viewer.turn) % 360);
  showPin(item.lat, item.lng);
  locate(item.lat, item.lng);
  for (const step of [1, -1]) fetchThumb(viewerUrl(viewer.items[(viewer.index + step + n) % n]));
}
let locator = null;
let locatorPin = null;
function locate(lat, lng) {
  if (!locator) {
    locator = L.map("viewer-map", {
      zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false,
      doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false,
    });
    L.tileLayer(esri, { layer: "World_Dark_Gray_Base", maxNativeZoom: 16 }).addTo(locator);
    L.tileLayer(esri, { layer: "World_Dark_Gray_Reference", maxNativeZoom: 16, opacity: 0.8 }).addTo(locator);
    locatorPin = L.circleMarker([lat, lng], {
      radius: 7, color: "#ffffff", weight: 3, fillColor: "#06070a", fillOpacity: 1, interactive: false,
    }).addTo(locator);
  }
  locator.invalidateSize();
  locator.setView([lat, lng], 3, { animate: false });
  locatorPin.setLatLng([lat, lng]);
}
function stepViewer(step) {
  const n = viewer.items.length;
  viewer.index = (viewer.index + step + n) % n;
  renderViewer();
}
function turnViewer(turn) {
  viewer.turn = (turn + 4) % 4;
  renderViewer();
}
$("viewer-turn").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (button) turnViewer(Number(button.dataset.turn));
});
function closeViewer() {
  if ($("viewer").hidden) return;
  $("viewer").hidden = true;
  state.viewerOpen = false;
  clearPin();
}
$("viewer-prev").addEventListener("click", () => stepViewer(-1));
$("viewer-next").addEventListener("click", () => stepViewer(1));
$("viewer-close").addEventListener("click", closeViewer);
$("viewer").addEventListener("click", (event) => { if (event.target === $("viewer")) closeViewer(); });

document.addEventListener("keydown", (event) => {
  if (event.target.matches("input")) {
    if (event.key === "Escape") event.target.blur();
    return;
  }
  if (metaPage.isOpen() && $("viewer").hidden && metaPage.key(event)) return;
  if (practice.isOpen() && $("viewer").hidden && practice.key(event)) return;
  if (explore.isOpen() && $("viewer").hidden && explore.key(event)) return;
  if (!$("viewer").hidden) {
    if (event.key === "ArrowRight") stepViewer(1);
    else if (event.key === "ArrowLeft") stepViewer(-1);
    else if (event.key === "ArrowUp") { event.preventDefault(); turnViewer(viewer.turn + 1); }
    else if (event.key === "ArrowDown") { event.preventDefault(); turnViewer(viewer.turn - 1); }
    else if (event.key === "Escape") closeViewer();
    return;
  }
  if (event.key === "Escape" && !$("tools-menu").hidden) { setTools(false); return; }
  if (!$("home").hidden) { if (event.key === "Escape") hideHome(); return; }
  if (train.on) {
    if (/^[1-4]$/.test(event.key)) { const o = train.q && train.q.options[Number(event.key) - 1]; if (o) answer(o.id); return; }
    if ((event.key === " " || event.key === "Enter" || event.key === "n") && train.answered) { event.preventDefault(); nextQuestion(); return; }
    if (event.key === "Escape") { stopTraining(); return; }
    if (event.key === "t") { stopTraining(); return; }
    if (event.key === "g") { const order = ["pick", "place", "both"]; setMode(order[(order.indexOf(train.mode) + 1) % 3]); return; }
    if (event.key === "a") { setArea(!train.area); return; }
  } else if (event.key === "t") { practice.open(); return; }
  if (event.key === "Escape" && state.compare) exitCompare();
  else if (event.key === "Escape" && state.selected) deselect();
  else if (event.key === "v" && state.selected) metaPage.open(state.level, state.selected);   // V: full view, as in the userscript
  else if (event.key === "/") { event.preventDefault(); explore.open({ search: true }); }
  else if (event.key === "e") explore.open();
  else if (event.key === "m" || event.key === "s") setView(event.key === "m" ? "map" : "space");
  else if (event.key === "d") setSplit(!split.on);
  else if (event.key === "[" || event.key === "]") {
    LENS_PX = Math.max(12, Math.min(160, Math.round(LENS_PX * (event.key === "]" ? 1.3 : 1 / 1.3))));
    if (links.point) (links.from === "main" ? linkFromMain : insetHover)(links.point, links.i);
  }
  else if (event.key === "b") { plainDots = !plainDots; draw(); }
  else if (event.key === "l") setLabels(!showLabels);
  else if (event.key === "p") setPanel(!panelOpen);
  else if (event.key === "c") toggleColors();
  else if (event.key === "k") setColorBy({ meta: "place", place: "look", look: "meta" }[colorBy]);
  else if (/^[1-9]$/.test(event.key) && state.levels[Number(event.key) - 1]) {
    const level = state.levels[Number(event.key) - 1];
    const m = state.selected ? state.metas.get(state.selected) : null;
    const best = m && m.links[level] ? m.links[level][0] : null;
    setLevel(level, { select: best ? best[0] : null });
  }
});

let examplePins = [];
function showPins(list) {
  clearPin();
  examplePins = list.map(({ lat, lng }) => viewLatLng(lat, lng)).filter(Boolean).map((at) => L.marker(at, {
    icon: L.divIcon({ className: "example-pin", iconSize: null }),
    interactive: false,
  }).addTo(map));
}
function showPin(lat, lng) { showPins([{ lat, lng }]); }
function clearPin() {
  for (const pin of examplePins) pin.remove();
  examplePins = [];
}


// ---------- trainer ----------
// Recognise a meta among its closest look-alikes, from fresh member panos (random dots of the
// meta, not its gallery pictures). The options are rows of pictures, names hidden until you answer:
// a blind test matched unseen panos to the right row 41/48 times against 28/48 by name.
// Spaced repetition: a meta answered wrong comes back after a few questions; right answers push
// it further out. Progress is kept per level in this browser.
const TRAIN_KEY = "meta-map-train";
// Modes: "pick" (choose the right row of pictures), "place" (click where this look lives; scored
// on whether the click falls inside the meta's range) and "both" (pick, then place).
const train = { on: false, q: null, answered: false, locating: false, streak: 0, right: 0, total: 0, km: [], next: null,
  mode: (() => { try { const v = localStorage.getItem("meta-map-train-mode"); return ["pick", "place", "both"].includes(v) ? v : "pick"; } catch (_) { return "pick"; } })() };
const RANGE_KM = 30;      // a Place click within this of any member of the meta counts as in range
function trainStore() {
  try { return JSON.parse(localStorage.getItem(TRAIN_KEY) || "{}"); } catch (_) { return {}; }
}
function trainSave(data) { try { localStorage.setItem(TRAIN_KEY, JSON.stringify(data)); } catch (_) { /* no storage */ } }
function trainRecord(id, ok, chosen) {
  const data = trainStore();
  const lv = data[state.level] || (data[state.level] = { tick: 0, metas: {} });
  lv.tick += 1;
  const r = lv.metas[id] || (lv.metas[id] = { n: 0, ok: 0, box: 0, due: 0 });
  r.n += 1;
  if (ok) { r.ok += 1; r.box = Math.min(6, r.box + 1); } else { r.box = 0; r.miss = chosen; }
  r.due = lv.tick + (ok ? 3 * 2 ** r.box : 3);          // wrong: back within ~3 questions
  trainSave(data);
}
function trainCandidates() {
  if (train.focus && state.metas.has(train.focus)) {
    const m = state.metas.get(train.focus);
    return [m, ...m.closest.slice(0, 3).map(([id]) => state.metas.get(id))].filter((x) => x && x.closest.length >= 2);
  }
  const out = [];
  const area = train.area;
  for (const m of state.metas.values()) {
    const looks = m.closest.map(([id]) => id).filter((id) => state.metas.has(id));
    if (looks.length < 2 || m.size < 150) continue;
    if (area) {
      // In the chosen area: the meta's core (80% of its members) overlaps the area.
      const [s0, w0, n0, e0] = m.bounds;
      if (n0 < area.s || s0 > area.n || e0 < area.w || w0 > area.e) continue;
    }
    out.push(m);
  }
  if (area && out.length < 4) {                       // too small an area to quiz: drop the filter
    train.area = null;
    $("train-area").setAttribute("aria-pressed", "false");
    return trainCandidates();
  }
  return out;
}
// "This area": questions only about metas in the map view you started training from (once the
// trainer is up, the photos cover the map and later answers move it).
function setArea(on) {
  if (on && train.startBounds) {
    const b = train.startBounds;
    train.area = { s: b.getSouth(), n: b.getNorth(), w: Math.max(-180, b.getWest()), e: Math.min(180, b.getEast()) };
  } else train.area = null;
  $("train-area").setAttribute("aria-pressed", String(!!train.area));
  train.next = null;                                  // the prepared question may be out of area
  renderProgress();
}
$("train-area").addEventListener("click", () => setArea(!train.area));
function renderProgress() {
  const lv = trainStore()[state.level] || { metas: {} };
  const pool = trainCandidates();
  let seen = 0, solid = 0;
  for (const m of pool) {
    const r = lv.metas[m.id];
    if (!r) continue;
    seen += 1;
    if (r.box >= 3) solid += 1;
  }
  const focus = train.focus && state.metas.get(train.focus);
  $("train-progress").textContent = focus ? `Practicing ${focus.name} and its look-alikes · ${seen} of ${pool.length} practiced` : `${LEVEL_NAMES[state.level]}${train.area ? " · this area" : ""}: ` +
    `${seen.toLocaleString()} of ${pool.length.toLocaleString()} metas practiced · ${solid.toLocaleString()} solid (3+ right in a row)`;
}
function pickTarget(exclude) {
  const lv = trainStore()[state.level] || { tick: 0, metas: {} };
  const pool = trainCandidates().filter((m) => m.id !== exclude);
  const due = pool.filter((m) => lv.metas[m.id] && lv.metas[m.id].box === 0 && lv.metas[m.id].due <= lv.tick);
  if (due.length && Math.random() < 0.7) return due[Math.floor(Math.random() * due.length)];
  // Otherwise unseen or due metas, weighted toward common ones (square root of size).
  const fresh = pool.filter((m) => !lv.metas[m.id] || lv.metas[m.id].due <= lv.tick);
  const from = fresh.length ? fresh : pool;
  let total = 0;
  for (const m of from) total += Math.sqrt(m.size);
  let r = Math.random() * total;
  for (const m of from) { r -= Math.sqrt(m.size); if (r <= 0) return m; }
  return from[from.length - 1];
}
async function memberPanos(m, n) {
  const list = pointsOf(m.id);
  const gallery = new Set(m.examples.map(([p]) => p));
  const picked = [], tried = new Set();
  for (let guard = 0; picked.length < n && guard < n * 12 && tried.size < list.length; guard += 1) {
    const i = list[Math.floor(Math.random() * list.length)];
    if (tried.has(i)) continue;
    tried.add(i);
    const row = await panoAt(i);
    if (!row || gallery.has(row[0])) continue;
    const [lat, lng] = pointLatLng(i);
    // Spread the question across the meta: skip members within 50 km of one already picked.
    if (picked.some((p) => haversineKm([p.lat, p.lng], [lat, lng]) < 50) && guard < n * 8) continue;
    picked.push({ i, pano: row[0], heading: row[1], lat, lng, meta: m });
  }
  return picked;
}
// Question panos come from data/<level>/quiz.json (pipeline/quiz.py): members clearly closer to
// their own meta than to any of its look-alikes, so a question never hinges on a borderline pano.
const quizFiles = new Map();
function quizFor(level) {
  if (!quizFiles.has(level)) quizFiles.set(level, getJSON(`data/${level}/quiz.json`).catch(() => ({})));
  return quizFiles.get(level);
}
async function fairPanos(m, n) {
  const quiz = (await quizFor(state.level))[m.id] || [];
  if (quiz.length < n) return memberPanos(m, n);
  const pick = quiz.slice().sort(() => Math.random() - 0.5).slice(0, n);
  return Promise.all(pick.map(async (i) => {
    const row = await panoAt(i);
    const [lat, lng] = pointLatLng(i);
    return row && { i, pano: row[0], heading: row[1], lat, lng, meta: m };
  })).then((list) => list.filter(Boolean));
}
async function makeQuestion(exclude) {
  const target = pickTarget(exclude);
  const looks = target.closest.map(([id]) => state.metas.get(id)).filter(Boolean).slice(0, 3);
  const options = [target, ...looks].sort(() => Math.random() - 0.5);
  const panos = await fairPanos(target, 3);
  // Warm the images so the next question shows at once.
  for (const p of panos) fetchThumb(thumb(p.pano, Math.round(p.heading), 640, 400));
  for (const o of options) for (const [p, , , h] of o.examples.slice(0, 3)) fetchThumb(thumb(p, h, 480, 300));
  return { target, options, panos };
}
async function startTraining({ focus = null } = {}) {
  if (train.on) return;
  explore.close();
  train.on = true;
  // Practise one meta: questions only about it and its closest look-alikes.
  train.focus = focus;
  train.startBounds = isSpace() ? null : map.getBounds();
  setPanel(true);
  document.body.classList.add("training");
  syncNav();
  state.selected = null; state.compare = null; state.preview = null;
  $("map-card").hidden = true;
  $("compare-view").hidden = true;
  $("train-view").hidden = false;
  $("train-stage").hidden = false;
  train.streak = 0; train.right = 0; train.total = 0; train.km = []; train.area = null;
  $("train-area").setAttribute("aria-pressed", "false");
  setMode(train.mode);
  recolor();
  await nextQuestion();
}
function stopTraining() {
  if (!train.on) return;
  train.on = false;
  const back = train.focus;
  train.focus = null;
  train.q = null; train.next = null; train.locating = false;
  map.getContainer().classList.remove("locating");
  if (guessMarker) { guessMarker.remove(); guessMarker = null; }
  document.body.classList.remove("training");
  syncNav();
  $("train-view").hidden = true;
  $("train-stage").hidden = true;
  state.selected = null; state.compare = null;
  setPanel(panelOpen);
  clearPin();
  showList();
  recolor();
  writeHash();
  if (back && state.metas.has(back)) selectMeta(back, { fit: false });   // back to the meta you practised
}
async function nextQuestion() {
  const q = train.next ? await train.next : await makeQuestion();
  if (!train.on) return;
  train.q = q;
  train.answered = false;
  train.locating = false;
  map.getContainer().classList.remove("locating");
  if (guessMarker) { guessMarker.remove(); guessMarker = null; }
  train.next = makeQuestion(q.target.id);            // prepare the following one in the background
  state.selected = null; state.compare = null;
  clearPin();
  recolor();
  renderQuestion();
}
function renderQuestion() {
  const { q } = train;
  renderProgress();
  $("train-score").textContent = train.total
    ? `${train.right}/${train.total} · streak ${train.streak}` : `${LEVEL_NAMES[state.level]} level`;
  const place = train.mode === "place" && !isSpace();
  $("train-prompt").textContent = place
    ? "Click the map where this look lives (anywhere in its range)" : "Which row are the photos from? (1-4)";
  $("train-options").hidden = place;
  $("train-stage").hidden = place;
  $("train-q-panel").hidden = !place;
  train.locating = place;
  map.getContainer().classList.toggle("locating", place);
  recolor();
  if (place) map.setView([25, 10], 2, { animate: false });
  else setStage(true);
  const shots = place ? $("train-q-panel") : $("train-q");
  $("train-q").textContent = "";
  $("train-q-panel").textContent = "";
  q.panos.forEach((p, k) => {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = k === 0 ? "train-shot hero" : "train-shot";
    tile.append(img([thumb(p.pano, Math.round(p.heading), k === 0 ? 1280 : 640, k === 0 ? 800 : 400)], {
      standIn: { lat: p.lat, lng: p.lng, heading: p.heading, w: 640, h: 400 },
      onReplaced: (_el, current) => tile.append(replacedBadge(current)),
    }));
    tile.title = "Open large (the viewer can turn the view)";
    tile.addEventListener("click", () => openViewer(q.panos.map((x) => ({ ...x, meta: train.answered ? x.meta : { name: "?", id: "" } })), k));
    shots.append(tile);
  });
  const box = $("train-options");
  box.textContent = "";
  q.options.forEach((m, k) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "train-option";
    row.dataset.id = m.id;
    const head = document.createElement("div");
    head.className = "train-option-head";
    head.append(text(String(k + 1), "train-key"), text("", "name"));
    const strip = document.createElement("div");
    strip.className = "train-strip";
    const urls = m.examples.map(([p, , , h]) => thumb(p, h, 480, 300));
    for (let slot = 0; slot < 3; slot += 1) {
      strip.append(img(urls.filter((_, k) => k % 3 === slot), { onMissing: (el) => el.remove() }));
    }
    row.append(head, strip);
    row.addEventListener("click", () => answer(m.id));
    box.append(row);
  });
  $("train-after").hidden = true;
}
function answer(id) {
  const { q } = train;
  if (!q || train.answered || train.locating) return;
  q.chosen = id;
  // Locate step (optional, Map view only): click where the photos were taken before the reveal.
  if (train.mode === "both" && !isSpace()) {
    train.locating = true;
    for (const row of $("train-options").children) row.classList.toggle("picked", Number(row.dataset.id) === id);
    $("train-prompt").textContent = "Now click the map where you think the photos were taken";
    setStage(false);
    recolor();                           // coverage only: every dot grey, so colours give nothing away
    map.getContainer().classList.add("locating");
    return;
  }
  reveal();
}
function reveal(guess) {
  const { q } = train;
  const place = train.mode === "place";
  const id = place ? q.target.id : q.chosen;
  train.answered = true;
  train.locating = false;
  map.getContainer().classList.remove("locating");
  // Place mode: in range if any member of the meta is within RANGE_KM of the click.
  const rangeKm = guess ? nearestMemberKm(q.target.id, guess) : null;
  const ok = place ? rangeKm <= RANGE_KM : id === q.target.id;
  train.total += 1;
  if (ok) { train.right += 1; train.streak += 1; } else train.streak = 0;
  trainRecord(q.target.id, ok, id);
  for (const row of $("train-options").children) {
    const m = state.metas.get(Number(row.dataset.id));
    row.classList.remove("picked");
    row.classList.add("revealed");
    row.classList.toggle("correct", m.id === q.target.id);
    row.classList.toggle("wrong", m.id === id && !ok);
    row.querySelector(".name").textContent = m.name;
    row.title = m.note || "";
  }
  let km = null;
  if (guess) {
    km = Math.min(...q.panos.map((p) => haversineKm([guess.lat, guess.lng], [p.lat, p.lng])));
    train.km.push(km);
  }
  const avgKm = train.km.length ? Math.round(train.km.reduce((a, b) => a + b, 0) / train.km.length) : null;
  $("train-score").textContent = `${train.right}/${train.total} · streak ${train.streak}${avgKm !== null ? ` · avg ${avgKm.toLocaleString()} km` : ""}`;
  const after = $("train-after");
  after.textContent = "";
  const top = document.createElement("div");
  top.className = "train-after-top";
  top.append(text(place ? (ok ? "In range" : "Out of range") : (ok ? "Right" : "Not quite"), ok ? "train-verdict ok" : "train-verdict no"));
  if (place && rangeKm !== null && !ok) top.append(text(`${Math.round(rangeKm).toLocaleString()} km from its range`, "train-km"));
  if (km !== null) top.append(text(`${Math.round(km).toLocaleString()} km from the photos`, "train-km muted"));
  const next = document.createElement("button");
  next.type = "button";
  next.className = "train-next";
  next.textContent = "Next (Space)";
  next.addEventListener("click", nextQuestion);
  top.append(next);
  const what = document.createElement("p");
  what.className = "train-note";
  what.append(text(q.target.name, "train-name"), text(` · ${q.target.place}. `, "train-place"), text(q.target.note || ""));
  after.append(top, what);
  if (!ok && !place) {
    const chosen = state.metas.get(id);
    const vs = document.createElement("p");
    vs.className = "train-note muted";
    vs.textContent = `You picked ${chosen.name}: ${chosen.note || ""}`;
    after.append(vs);
  }
  after.hidden = false;
  $("train-prompt").textContent = "";
  const right = [...$("train-options").children].find((row) => Number(row.dataset.id) === q.target.id);
  if (right) right.scrollIntoView({ block: "nearest" });
  // On the map: the right meta lit (and the wrong pick in the second colour), the panos pinned.
  state.selected = q.target.id;
  state.compare = ok || place ? null : id;
  recolor();
  showPins(q.panos);
  if (guess) guessMarker = L.marker([guess.lat, guess.lng], { icon: L.divIcon({ className: "guess-pin", iconSize: null }), interactive: false }).addTo(map);
  fitAnswer(ok || place ? [q.target.id] : [q.target.id, id], guess ? [...q.panos, { ...guess, i: -1 }] : q.panos);
  setStage(false);       // the photos step aside so the map can show the answer
}
let guessMarker = null;
function nearestMemberKm(id, { lat, lng }) {
  const list = pointsOf(id);
  const step = Math.max(1, Math.floor(list.length / 20000));     // a 20k sample is plenty
  let best = Infinity;
  for (let k = 0; k < list.length; k += step) {
    const d = haversineKm([lat, lng], pointLatLng(list[k]));
    if (d < best) best = d;
  }
  return best;
}
map.on("click", (event) => {
  if (!train.on || !train.locating) return;
  reveal({ lat: event.latlng.lat, lng: ((event.latlng.lng + 540) % 360) - 180 });
});
function setMode(mode) {
  if (isSpace() && mode !== "pick") mode = "pick";         // placing needs the map
  const changed = mode !== train.mode;
  train.mode = mode;
  try { localStorage.setItem("meta-map-train-mode", mode); } catch (_) { /* no storage */ }
  for (const b of $("train-mode").children) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
  if (changed && train.on && train.q && !train.answered) renderQuestion();
}
$("train-mode").addEventListener("click", (event) => {
  const b = event.target.closest("button");
  if (b) setMode(b.dataset.mode);
});
// Frame the right meta (and a wrong pick) plus where the photos were taken.
function fitAnswer(ids, panos) {
  let s = 90, w = 180, n = -90, e = -180;
  if (isSpace()) {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const id of ids) {
      const [a, b, c, d] = spaceBounds(id);
      x0 = Math.min(x0, a); y0 = Math.min(y0, b); x1 = Math.max(x1, c); y1 = Math.max(y1, d);
    }
    for (const p of panos) {
      if (p.i < 0) continue;
      const sx = points.space.xy[2 * p.i], sy = points.space.xy[2 * p.i + 1];
      x0 = Math.min(x0, sx); y0 = Math.min(y0, sy); x1 = Math.max(x1, sx); y1 = Math.max(y1, sy);
    }
    map.fitBounds([unitToLatLng(x0, y0), unitToLatLng(x1, y1)], { paddingTopLeft: [60, 100], paddingBottomRight: [60, 190], maxZoom: 8 });
    return;
  }
  for (const id of ids) {
    const [a, b, c, d] = state.metas.get(id).bounds;
    s = Math.min(s, a); w = Math.min(w, b); n = Math.max(n, c); e = Math.max(e, d);
  }
  for (const p of panos) { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lng); e = Math.max(e, p.lng); }
  map.fitBounds([[s, w], [n, e]], { paddingTopLeft: [40, 100], paddingBottomRight: [40, 190], maxZoom: 7 });
}
// The question photos sit large over the map; after an answer they collapse to a strip so the
// map can show where the metas live; the button on the stage brings them back.
function setStage(open) {
  const stage = $("train-stage");
  stage.classList.toggle("collapsed", !open);
  $("train-stage-toggle").textContent = open ? (train.answered ? "Show the map" : "") : "Show the photos";
  $("train-stage-toggle").hidden = !train.answered;
}
$("train-stage-toggle").addEventListener("click", () => setStage($("train-stage").classList.contains("collapsed")));
$("train-exit").addEventListener("click", stopTraining);


// ---------- linked inset ----------
// One main view at full width, the other layout in a corner inset (picture in picture): the world
// map when the main view is Space, Space when it is the map. They are linked: hovering a dot in
// either rings the same pano in the other, and a lens around the cursor lights every pano under it,
// white, in the other, so sweeping an island in Space shows where it lives on Earth, and sweeping
// a country shows which islands it feeds. Swap flips which one is big. (A three-way split of map,
// Space and panel left every part too narrow to use.)
let LENS_PX = 36;
const insetIsGeo = () => isSpace();                       // the inset shows the other layout
const mainLayer = () => (isSpace() ? points.space : points.geo);
const insetLayer = () => (isSpace() ? points.geo : points.space);
function ensureInsetMap() {
  if (split.map) return;
  split.map = L.map("smap", {
    center: [20, 0], zoom: 1, minZoom: 0, maxZoom: 12, zoomAnimation: false, zoomSnap: 0.25, zoomDelta: 0.5,
    wheelPxPerZoomLevel: 90, attributionControl: false, zoomControl: false, worldCopyJump: false,
  });
  split.map.createPane("dots").style.zIndex = 350;
  split.tiles = L.tileLayer(esri, { layer: "World_Dark_Gray_Base", maxNativeZoom: 16 });
  split.dots = createDots(split.map, points.geo.xy);
  const g = split.dots.gl;
  g.bindBuffer(g.ARRAY_BUFFER, split.dots.space);
  g.bufferData(g.ARRAY_BUFFER, points.space.xy, g.STATIC_DRAW);
  uploadColors(split.dots);
  split.marks = document.createElement("div");
  split.marks.className = "marks";
  split.map.getContainer().appendChild(split.marks);
  split.ring = Object.assign(document.createElement("div"), { className: "ring", hidden: true });
  split.link = Object.assign(document.createElement("div"), { className: "ring linked", hidden: true });
  split.lensEl = Object.assign(document.createElement("div"), { className: "lens", hidden: true });
  split.marks.append(split.lensEl, split.link, split.ring);
  split.labelPool = [];
  split.map.on("move zoom resize viewreset", scheduleDraw);
  split.map.on("mousemove", (event) => {
    if (event.originalEvent && event.originalEvent.altKey) {
      showSheet(split.map, insetLayer(), event.containerPoint);
      links.from = "inset"; links.i = -1; links.point = event.containerPoint;
      setLens(gpu, lensIndices(split.map, insetLayer(), event.containerPoint));
      scheduleDraw();
      return;
    }
    hideSheet();
    insetHover(event.containerPoint);
  });
  split.map.on("mouseout", () => clearLinks());
  split.map.on("click", (event) => {
    const i = nearestOn(split.map, insetLayer(), event.containerPoint, 9);
    if (i >= 0 && state.ids[i]) { state.mix = null; selectMeta(state.ids[i], { fit: false }); }
  });
}
// Main-view links (rings and lens circle) live in the main map's marks layer.
const mainLink = Object.assign(document.createElement("div"), { className: "ring linked", hidden: true });
const mainLens = Object.assign(document.createElement("div"), { className: "lens", hidden: true });
marks.append(mainLens, mainLink);
const links = { from: null, i: -1, point: null };     // which view the cursor is in, its dot, its position
async function setSplit(on) {
  if (on === split.on) return;
  if (on) {
    if (train.on) stopTraining();
    await loadSpaceLayout();
    if (!points.space.grid) buildGrid(points.space);
    if (!points.geo.grid) buildGrid(points.geo);
  }
  split.on = on;
  document.body.classList.toggle("inset-on", on);
  $("inset").hidden = !on;
  $("split-toggle").setAttribute("aria-pressed", String(on));
  $("split-toggle").textContent = on ? "On" : "Off";
  if (on) {
    ensureInsetMap();
    uploadColors(split.dots);
    if (state.level && !centreCache.has(state.level)) metaCentres();
    refreshInset({ refit: true });
  }
  clearLinks();
  drawLegend();
  draw();
}
// After opening, swapping or selecting: the inset shows the other layout, framed on the selection.
function refreshInset({ refit = false } = {}) {
  drawLegend();
  if (!split.on || !split.map) return;
  $("inset-title").textContent = insetIsGeo() ? "World" : "Space";
  if (insetIsGeo()) split.tiles.addTo(split.map); else split.tiles.remove();
  split.map.invalidateSize({ animate: false });
  if (refit) {
    const m = state.selected ? state.metas.get(state.selected) : null;
    if (insetIsGeo()) {
      if (m) { const [s0, w0, n0, e0] = m.bounds; split.map.fitBounds([[s0, w0], [n0, e0]], { padding: [16, 16], maxZoom: 6, animate: false }); }
      else split.map.fitBounds([[-55, -170], [72, 180]], { animate: false });
    } else if (m) fitSpaceOn(split.map, m.id, 12);
    else fitSpaceOn(split.map, null, 12);
  }
  draw();
}
// Frame the whole Space layout, or one meta's part of it, on a given map.
function fitSpaceOn(m, id = null, pad = 70) {
  if (id) {
    const [x0, y0, x1, y1] = spaceBounds(id);
    m.fitBounds([unitToLatLng(x0, y0), unitToLatLng(x1, y1)], { padding: [pad, pad], maxZoom: 9, animate: false });
    return;
  }
  const xy = points.space.xy;
  const xs = [], ys = [];
  for (let i = 0; i < points.count; i += 97) { xs.push(xy[2 * i]); ys.push(xy[2 * i + 1]); }
  xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
  const q = (a, f) => a[Math.floor(f * (a.length - 1))];
  m.fitBounds([unitToLatLng(q(xs, 0.005), q(ys, 0.005)), unitToLatLng(q(xs, 0.995), q(ys, 0.995))],
    { padding: [pad, pad], animate: false });
}
// Pixel position of dot i in a map showing a given layout.
function layoutPx(m, xy, i, wrap) {
  const world = 256 * 2 ** m.getZoom();
  const origin = m.getPixelOrigin();
  const topLeft = m.containerPointToLayerPoint([0, 0]);
  let x = xy[2 * i] * world - origin.x - topLeft.x;
  const y = xy[2 * i + 1] * world - origin.y - topLeft.y;
  if (wrap) {
    const size = m.getSize();
    while (x < 0) x += world;
    while (x > size.x && x - world >= 0) x -= world;
  }
  return [x, y];
}
function worldAt(m, containerPoint, wrap) {
  const world = 256 * 2 ** m.getZoom();
  const p = m.containerPointToLayerPoint(containerPoint).add(m.getPixelOrigin());
  let x = p.x / world;
  if (wrap) x -= Math.floor(x);
  return [x, p.y / world, world];
}
function nearestOn(m, layer, containerPoint, radiusPx) {
  if (!layer.grid || !state.ids) return -1;
  const [x, y, world] = worldAt(m, containerPoint, layer === points.geo);
  let best = -1, bestD = Infinity;
  for (const [i, d2] of near(x, y, radiusPx / world, layer)) if (d2 < bestD && eligible(i)) { best = i; bestD = d2; }
  return best;
}
// Every eligible dot within the lens radius of the cursor, in one view's layout.
function lensIndices(m, layer, containerPoint) {
  if (!layer.grid || !state.ids) return new Uint32Array(0);
  const [x, y, world] = worldAt(m, containerPoint, layer === points.geo);
  const out = [];
  for (const [i] of near(x, y, LENS_PX / world, layer)) {
    if (eligible(i)) out.push(i);
    if (out.length >= 400000) break;
  }
  return Uint32Array.from(out);
}
// Cursor in the main view: called from its mousemove handler.
function linkFromMain(point, i) {
  if (!split.on || !split.dots || morph.frame) return;
  links.from = "main"; links.i = i; links.point = point;
  setLens(split.dots, lensIndices(map, mainLayer(), point));
  if (gpu.lensCount) setLens(gpu, new Uint32Array(0));
  scheduleDraw();
}
// Cursor in the inset.
function insetHover(point) {
  if (!split.on || morph.frame) return;
  const i = state.viewerOpen ? -1 : nearestOn(split.map, insetLayer(), point, 9);
  links.from = "inset"; links.i = i; links.point = point;
  setLens(gpu, lensIndices(split.map, insetLayer(), point));
  if (split.dots.lensCount) setLens(split.dots, new Uint32Array(0));
  const card = $("hover-card");
  if (i !== split.hovered) {
    split.hovered = i;
    if (i >= 0 && !shiftHeld) showHover(i);
  }
  if (shiftHeld) { showPeek(i); $("hover-card").hidden = true; scheduleDraw(); return; }
  if (i < 0) card.hidden = true;
  else {
    // The inset is small: the card goes beside it (left), or above it.
    const box = $("inset").getBoundingClientRect();
    const cw = card.offsetWidth || 380, ch = card.offsetHeight || 280;
    const left = box.left - cw - 12 >= 8 ? box.left - cw - 12 : Math.max(8, box.right - cw);
    const top = box.left - cw - 12 >= 8 ? Math.max(8, box.bottom - ch) : Math.max(8, box.top - ch - 12);
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
    card.hidden = false;
  }
  scheduleDraw();
}
function clearLinks() {
  links.from = null; links.i = -1; links.point = null;
  split.hovered = -1;
  if (gpu.lensCount) setLens(gpu, new Uint32Array(0));
  if (split.dots && split.dots.lensCount) setLens(split.dots, new Uint32Array(0));
  $("hover-card").hidden = true;
  scheduleDraw();
}
// Rings and lens circles, repositioned on every draw (both views pan and zoom independently).
function drawSplitMarks() {
  const place = (el, xy) => { el.style.transform = `translate(${xy[0]}px, ${xy[1]}px)`; el.hidden = false; };
  mainLink.hidden = mainLens.hidden = true;
  if (!split.on || !split.map) return;
  split.ring.hidden = split.link.hidden = split.lensEl.hidden = true;
  const { from, i, point } = links;
  if (from === "main") {
    if (i >= 0) place(split.link, layoutPx(split.map, insetLayer().xy, i, insetIsGeo()));
    if (point) { mainLens.style.width = mainLens.style.height = `${2 * LENS_PX}px`; place(mainLens, [point.x, point.y]); }
  } else if (from === "inset") {
    if (i >= 0) {
      place(split.ring, layoutPx(split.map, insetLayer().xy, i, insetIsGeo()));
      place(mainLink, layoutPx(map, mainLayer().xy, i, !isSpace()));
    }
    if (point) { split.lensEl.style.width = split.lensEl.style.height = `${2 * LENS_PX}px`; place(split.lensEl, [point.x, point.y]); }
  }
}
$("split-toggle").addEventListener("click", () => setSplit(!split.on));
$("color-mode").addEventListener("click", (event) => {
  const b = event.target.closest("button");
  if (b) setColorBy(b.dataset.mode);
});
$("inset-swap").addEventListener("click", () => setView(isSpace() ? "map" : "space"));
$("inset-size").addEventListener("click", () => {
  $("inset").classList.toggle("big");
  split.map.invalidateSize({ animate: false });
  draw();
});
// ---------- picture sheet ----------
// Hold Option (Alt) while hovering: a 3x3 sheet of panos from under the cursor instead of one photo. On
// the map they are nearby places; in Space they are look-alike neighbours, so a patch of either
// view can be read at a glance. The cursor radius is the lens radius ([ and ] resize it).
let sheetToken = 0;
let sheetKey = "";
function showSheet(m, layer, point) {
  const idx = lensIndices(m, layer, point);
  const card = $("sheet-card");
  if (!idx.length) { card.hidden = true; sheetKey = ""; return; }
  // Nine spread over the area: a fixed stride through the (spatially ordered) candidates.
  const pick = [];
  const step = idx.length / 9;
  for (let k = 0; k < 9 && k < idx.length; k += 1) pick.push(idx[Math.floor(k * step + step / 2)] ?? idx[k]);
  const key = pick.join(",");
  const box = m.getContainer().getBoundingClientRect();
  const cw = 3 * 196 + 2 * 6 + 16, ch = 3 * 122 + 2 * 6 + 40;
  const left = point.x + 20 + cw <= box.width ? point.x + 20 : point.x - 20 - cw;
  card.style.left = `${box.left + Math.max(4, left)}px`;
  card.style.top = `${Math.max(8, Math.min(point.y - ch / 2, box.height - ch - 8))}px`;
  card.hidden = false;
  $("hover-card").hidden = true;
  if (key === sheetKey) return;
  sheetKey = key;
  const token = ++sheetToken;
  const grid = $("sheet-grid");
  grid.textContent = "";
  const counts = new Map();
  for (const i of idx) counts.set(state.ids[i], (counts.get(state.ids[i]) || 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([id, n]) => { const mm = state.metas.get(id); return mm ? `${mm.name} ${Math.round(100 * n / idx.length)}%` : null; })
    .filter(Boolean);
  $("sheet-line").textContent = `${idx.length.toLocaleString()} panos under the cursor · ${top.join(" · ")}`;
  pick.forEach(async (i) => {
    const row = await panoAt(i);
    if (!row || token !== sheetToken) return;
    const cell = img([thumb(row[0], row[1], 392, 244)], { onMissing: (el) => { el.style.visibility = "hidden"; } });
    const meta = state.metas.get(state.ids[i]);
    if (meta) cell.style.borderBottom = `3px solid ${displayColor(meta)}`;
    grid.append(cell);
  });
}
function hideSheet() { $("sheet-card").hidden = true; sheetKey = ""; }
document.addEventListener("keyup", (event) => { if (event.key === "Alt") hideSheet(); });

// ---------- Shift enlargement ----------
// As in the trainer userscript: hold Shift while hovering a dot and its preview grows to nearly the
// whole window, the pano in all four directions (ahead, right, behind, left), because the clue is
// often not ahead. Shift is tracked from the keyboard, so pressing or releasing it updates the
// view at once even if the mouse does not move. Release Shift to close.
let shiftHeld = false;
let peekIndex = -1;
let peekToken = 0;
// What Shift would enlarge: the pano image under the cursor anywhere on the page, else the
// hovered dot on the map (or in the linked inset).
let overImage = null;
document.addEventListener("mouseover", (event) => {
  const el = event.target.closest && event.target.closest("img[data-pano]");
  overImage = el;
  if (shiftHeld && el) showPeekFor(imageItem(el));
  // Resting on a photo for a moment warms its four Shift views.
  clearTimeout(peekWarmTimer);
  if (el && !shiftHeld) peekWarmTimer = setTimeout(() => { if (overImage === el) warmPeek(el.dataset.pano, Number(el.dataset.heading) || 0); }, 250);
});
document.addEventListener("mouseout", (event) => {
  if (overImage && event.target === overImage) overImage = null;
});
function imageItem(el) {
  const info = exemplarInfo().get(el.dataset.pano);
  const lat = el.dataset.lat ? Number(el.dataset.lat) : info && info.lat;
  const lng = el.dataset.lng ? Number(el.dataset.lng) : info && info.lng;
  return { key: `pano:${el.dataset.pano}:${el.dataset.heading}`, pano: el.dataset.pano, heading: Number(el.dataset.heading) || 0,
    lat, lng, meta: info ? info.meta : null };
}
// pano id -> { meta, lat, lng } for every gallery exemplar at the current level, plus the
// trainer's question panos once answered, so the enlargement can name the meta.
let exemplarCache = { level: null, map: null };
function exemplarInfo() {
  if (exemplarCache.level !== state.level || !exemplarCache.map) {
    const out = new Map();
    for (const m of state.metas.values()) for (const [pano, lat, lng] of m.examples) out.set(pano, { meta: m, lat, lng });
    exemplarCache = { level: state.level, map: out };
  }
  if (train.on && train.answered && train.q) for (const p of train.q.panos) exemplarCache.map.set(p.pano, { meta: p.meta, lat: p.lat, lng: p.lng });
  return exemplarCache.map;
}
function peekTarget() {
  if (overImage && overImage.isConnected) return imageItem(overImage);
  const i = hovered >= 0 ? hovered : (split.on && split.hovered >= 0 ? split.hovered : -1);
  return i >= 0 ? { dot: i, key: `dot:${i}` } : null;
}
async function showPeek(i) { return showPeekFor(i >= 0 ? { dot: i, key: `dot:${i}` } : null); }
async function showPeekFor(item) {
  if (!item) { hidePeek(); return; }
  const el = $("peek");
  el.hidden = false;
  $("hover-card").hidden = true;
  if (item.key === peekIndex) return;
  peekIndex = item.key;
  const token = ++peekToken;
  const grid = $("peek-grid");
  grid.textContent = "";
  let { pano, heading, lat, lng, meta } = item;
  if (item.dot !== undefined) {
    const row = await panoAt(item.dot);
    if (!row || token !== peekToken) return;
    [pano, heading] = row;
    [lat, lng] = pointLatLng(item.dot);
    meta = state.metas.get(state.ids[item.dot]);
  }
  peekCurrent = { pano, heading, lat, lng };
  // No names while a trainer question is open: the enlargement must not give the answer away.
  const hideName = train.on && !train.answered;
  const head = $("peek-head");
  head.textContent = "";
  if (hideName) head.append(text("Four directions", "name"));
  else if (meta) head.append(swatch(meta), text(meta.name, "name"), text(` · ${meta.place}`, "pct"));
  else head.append(text("Four directions", "name"));
  ["Ahead", "Right", "Behind", "Left"].forEach((label, k) => {
    const h = Math.round(heading + 90 * k) % 360;
    const cell = document.createElement("div");
    cell.className = "peek-cell";
    const opts = Number.isFinite(lat) && Number.isFinite(lng)
      ? { standIn: { lat, lng, heading: h, w: 1024, h: 640 }, onReplaced: (_el, current) => cell.append(replacedBadge(current)) } : {};
    const picture = img([thumb(pano, h, 1024, 640, 100)], opts);
    delete picture.dataset.pano;              // the enlargement's own images are not targets
    cell.append(picture, text(label, "peek-dir"));
    grid.append(cell);
  });
}
// The Shift enlargement's four views of a pano (ahead, right, behind, left) at the size it shows them.
function peekUrls(pano, heading) {
  return [0, 1, 2, 3].map((k) => thumb(pano, Math.round(heading + 90 * k) % 360, 1024, 640, 100));
}
function warmPeek(pano, heading) { if (pano) warm(peekUrls(pano, heading)); }
let peekWarmTimer = 0;
function hidePeek() { $("peek").hidden = true; peekIndex = -1; peekToken += 1; peekCurrent = null; }   // also cancels a pending show
let peekCurrent = null;            // the pano the enlargement shows (for Shift + click)

// ---------- open in Google Street View ----------
// As in the userscript's board: any photo or map dot opens that exact pano in Google Maps Street
// View, in a new tab, facing the same way. Gestures, because a plain click already does something
// here (the viewer, selecting a meta): Cmd/Ctrl + click or middle-click on a photo or dot, or a click
// while Shift holds the four-direction view open. Not on a practice question before you answer.
function openStreetView({ pano, heading, lat, lng }) {
  if (pano) window.open(streetView(pano, heading, lat, lng), "_blank", "noopener,noreferrer");
}
// A dot's pano may still be loading: open the tab inside the click (so it is not blocked as a
// popup), then point it at the pano.
function openDotInStreetView(i) {
  const w = window.open("about:blank", "_blank");
  panoAt(i).then((row) => {
    if (!w) return;
    if (!row) { w.close(); return; }
    const [lat, lng] = pointLatLng(i);
    w.opener = null;
    w.location.href = streetView(row[0], row[1], lat, lng);
  });
}
function streetViewTarget(event, viaShift) {
  if (practice.questionOpen()) return false;
  if (viaShift && peekCurrent) { openStreetView(peekCurrent); return true; }
  const im = event.target.closest && event.target.closest("img[data-pano]");
  if (im) { openStreetView(imageItem(im)); return true; }
  for (const m of [map, split.map]) {
    if (!m || !m.getContainer().contains(event.target)) continue;
    const i = m === map ? nearestPoint(m.mouseEventToContainerPoint(event), 9) : nearestOn(m, insetLayer(), m.mouseEventToContainerPoint(event), 9);
    if (i >= 0) { openDotInStreetView(i); return true; }
  }
  return false;
}
document.addEventListener("click", (event) => {
  const viaShift = shiftHeld && !$("peek").hidden;
  if (!(event.metaKey || event.ctrlKey || viaShift)) return;
  if (streetViewTarget(event, viaShift)) { event.preventDefault(); event.stopPropagation(); }
}, true);
document.addEventListener("auxclick", (event) => {
  if (event.button !== 1) return;
  if (streetViewTarget(event, false)) { event.preventDefault(); event.stopPropagation(); }
}, true);
document.addEventListener("mousedown", (event) => {      // middle-click: no autoscroll over photos and maps
  if (event.button === 1 && event.target.closest && event.target.closest("img[data-pano], #map, #smap")) event.preventDefault();
}, true);
// Shift's state is read from every mouse move and key press, not only from its own keyup: a keyup
// the page never sees (a system shortcut, another app taking the keyboard, Shift released over
// browser chrome) left the enlargement open until Shift was pressed again.
document.addEventListener("mousemove", (event) => {
  if (shiftHeld && !event.shiftKey) { shiftHeld = false; hidePeek(); }
}, { passive: true, capture: true });
document.addEventListener("keydown", (event) => {
  if (event.key !== "Shift" && shiftHeld && !event.shiftKey) { shiftHeld = false; hidePeek(); }
}, true);
document.addEventListener("visibilitychange", () => { if (document.hidden) { shiftHeld = false; hidePeek(); } });
document.addEventListener("keydown", (event) => {
  if (event.key !== "Shift" || (event.target.matches && event.target.matches("input"))) return;
  shiftHeld = true;
  showPeekFor(peekTarget());
});
document.addEventListener("keyup", (event) => {
  if (event.key !== "Shift") return;
  shiftHeld = false;
  hidePeek();
});
window.addEventListener("blur", () => { shiftHeld = false; hidePeek(); });

// ---------- home screen ----------
// Where the site starts (unless a link points at a meta): what it is for, three ways in, and the
// level. Styled after the Blotto and Caption This home screens; the live map glows dimly behind.
const LEVEL_HINTS = {
  region: "{n} big areas of the world that look alike",
  subregion: "{n} smaller areas inside the regions",
  scene: "{n} scenes: the kinds of road in each area (town streets, highways, rural roads, unpaved roads)",
  micro: "{n} fine looks, the most detailed level",
};
// The hint with the level's real count from levels.json, so the numbers never go stale.
function levelHint(id) {
  const lv = state.info && state.info.levels.find((l) => l.id === id);
  return (LEVEL_HINTS[id] || "").replace("{n}", lv ? lv.metas.toLocaleString("en-US") : "");
}
function renderHomeLevels() {
  const box = $("home-levels");
  box.textContent = "";
  for (const level of state.levels) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = LEVEL_NAMES[level];
    b.setAttribute("aria-pressed", String(level === (wantedLevel || state.level)));
    b.addEventListener("click", async () => { await setLevel(level); renderHomeLevels(); });
    box.append(b);
  }
  $("home-level-hint").textContent = levelHint(wantedLevel || state.level);
}
function showHome() {
  if (train.on) stopTraining();
  $("home-about").hidden = true;
  $("home-main").hidden = false;
  renderHomeLevels();
  $("home").hidden = false;
  document.body.classList.add("at-home");
  resizeMap();
}
function hideHome() {
  $("home").hidden = true;
  document.body.classList.remove("at-home");
  resizeMap();
}
// The map spans the full window behind the home screen, then gives the panel its room back.
function resizeMap() {
  const centre = map.getCenter();
  map.invalidateSize({ pan: false, animate: false });
  map.setView(centre, map.getZoom(), { animate: false });
  scheduleDraw();
}
$("home").addEventListener("click", async (event) => {
  const tile = event.target.closest(".home-tile");
  if (!tile) return;
  const go = tile.dataset.go;
  hideHome();
  if (go === "explore") explore.open();
  else if (go === "practice") practice.open();
});
$("home-link").addEventListener("click", showHome);
$("home-about-open").addEventListener("click", () => { $("home-main").hidden = true; $("home-about").hidden = false; });
$("home-about-close").addEventListener("click", () => { $("home-about").hidden = true; $("home-main").hidden = false; });

// ---------- url state ----------
function writeHash() {
  if (explore.isOpen() || metaPage.isOpen()) return;   // Explore and the meta page keep their own hashes
  const prefix = state.view === "space" ? "space/" : "";
  const hash = state.selected
    ? `#${prefix}${state.level}/${state.selected}${state.compare ? `/${state.compare}` : ""}` : `#${prefix}${state.level}`;
  if (location.hash !== hash) history.replaceState(null, "", hash);
}
function readHash() {
  const parts = location.hash.slice(1).split("/");
  const ex = parts[0] === "explore";
  if (ex) parts.shift();
  const page = parts[0] === "meta";                     // #meta/<level>/<id>: a meta's full page
  if (page) parts.shift();
  const space = parts[0] === "space";
  if (space) parts.shift();
  const [level, id, versus] = parts;
  const cc = ex && id === "c" ? versus : null;          // #explore/<level>/c/<CC>: a country board
  return { explore: ex, page, space, level, cc, id: Number(id) || null, versus: Number(versus) || null };
}

// ---------- boot ----------
(async function boot() {
  if (!document.createElement("canvas").getContext("webgl2")) throw new Error("This page needs WebGL2");
  const [info, pointMeta, xy] = await track(Promise.all([
    getJSON("data/levels.json"), getJSON("data/points/meta.json"), getBinary("data/points/xy.f32"),
  ]));
  state.info = info;
  state.levels = info.levels.map((l) => l.id);
  points.count = pointMeta.count;
  points.chunk = pointMeta.chunk;
  points.geo.xy = new Float32Array(xy);
  points.xy = points.geo.xy;
  initGL();
  const control = $("level-control");
  info.levels.forEach((level, i) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.level = level.id;
    button.setAttribute("role", "menuitemradio");
    button.append(text(LEVEL_NAMES[level.id] || level.id, "lv-name"), text(levelHint(level.id), "lv-hint"), text(String(i + 1), "lv-key"));
    button.addEventListener("click", () => {
      setLevelMenu(false);
      if (wantedLevel === level.id) return;
      const m = state.selected ? state.metas.get(state.selected) : null;
      const best = m && m.links[level.id] ? m.links[level.id][0] : null;
      setLevel(level.id, { select: best ? best[0] : null });
    });
    control.append(button);
  });
  const wanted = readHash();
  const start = state.levels.includes(wanted.level) ? wanted.level : "subregion";
  await setLevel(start, { select: wanted.explore || wanted.page ? null : wanted.id });
  if (wanted.explore) explore.open({ id: wanted.id, cc: wanted.cc });
  if (wanted.page && wanted.id) metaPage.open(start, wanted.id);
  if (new URLSearchParams(location.search).has("bench")) { const b = document.createElement("script"); b.src = "bench.js?v=3"; document.body.append(b); }
  if (wanted.space) await setView("space", { animate: false });
  if (wanted.id && state.selected === wanted.id) fitMeta(state.metas.get(wanted.id));
  if (!location.hash || location.hash === `#${start}`) { if (!wanted.id && !wanted.space && !wanted.explore && !wanted.page) showHome(); }
  // A link with ?practice (e.g. ?practice#local/40) starts training on that meta and its look-alikes.
  if (new URLSearchParams(location.search).has("practice") && wanted.id && state.selected === wanted.id) {
    history.replaceState(null, "", location.pathname + location.hash);
    practice.open({ focus: wanted.id });
  }
  setTimeout(() => {          // hover index; the map is usable before it finishes
    buildGrid(points.geo);
    if (wanted.versus && state.selected === wanted.id && state.metas.has(wanted.versus)) enterCompare(wanted.versus);
  }, 0);
})().catch((error) => {
  $("loading").hidden = false;
  $("loading").textContent = error.message;
});
