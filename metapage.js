// ---------- Meta page ----------
// Everything about one meta, opened from the map card's "Full page" (or #meta/<level>/<id>).
// Photo-first, after the userscript's V board: a large grid of photos fills most of the window
// (2x2, 3x3 or 4x4, remembered; arrows page through more), with tabs above it:
//   Typical     this meta's typical photos (its center), then fresh members from across its range
//   Range       one photo per look sub-group, biggest first, with its share; hover lights its dots
//   Edges       members that look nearly like a look-alike, each beside that look-alike's closest photo
//   vs <name>   the grid split in half, this meta beside one of its closest look-alikes, same size
//   Inside      the finer metas it splits into, one big photo each
// A narrow column on the left holds a small live map (this meta lit in blue, a compared look-alike
// in amber, a hovered finer meta's dots in amber, a pin for the hovered photo), the lineage, what
// to look for, the numbers and the actions. Shift over any photo enlarges it in four directions.
// The thumbnails in a list-style page were too small to learn from.
// The map is the site's live map under a cutout; everything on it is drawn by its WebGL renderer
// plus a pin (Leaflet canvas/SVG overlays stalled Firefox). Loaded after app.js, explore.js and
// practice.js.
const metaPage = (() => {
  const S = { open: false, id: null, level: null, token: 0, pendingId: null, mode: "photos", page: 0, photos: null, vs: new Map(), kids: null, spread: null };
  let GRID = 3;
  try { const g = Number(localStorage.getItem("meta-map-page-grid")); if ([2, 3, 4].includes(g)) GRID = g; } catch (_) { /* */ }
  const root = $("meta-page");
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const LEVEL_DOWN = { region: "subregion", subregion: "scene", scene: "micro" };
  const levelBelow = (level) => state.levels.includes(LEVEL_DOWN[level]) ? LEVEL_DOWN[level] : undefined;
  const pct = (x) => `${Math.round(x * 100)}%`;
  const AMBER = [1, 0.7, 0.28, 2.0];

  // ----- the map under the cutout -----
  function placeMap() {
    if (!S.open) return;
    const r = $("mp-hole").getBoundingClientRect();
    if (r.width < 10) return;
    const m = $("map");
    m.style.inset = `${r.top}px ${innerWidth - r.right}px ${innerHeight - r.bottom}px ${r.left}px`;
    m.classList.add("pr-mapped");
    resizeMap();
  }
  function releaseMap() {
    const m = $("map");
    if (!m.classList.contains("pr-mapped")) return;
    m.style.inset = "";
    m.classList.remove("pr-mapped");
    resizeMap();
  }
  new ResizeObserver(() => { if (S.open) placeMap(); }).observe($("mp-hole"));
  const pinLayer = L.layerGroup().addTo(map);
  function pin(item, color) {
    pinLayer.clearLayers();
    if (!item) return;
    const at = isSpace() ? viewLatLng(item.lat, item.lng) : L.latLng(item.lat, wrapNear(item.lng, map.getCenter().lng));
    if (!at) return;
    pinLayer.addLayer(L.marker(at, { interactive: false, icon: L.divIcon({ className: "pr-pin latest", iconSize: null, html: `<i style="background:${color}"></i>` }) }));
  }
  function light(m, other = null) {
    state.selected = null; state.compare = null; state.preview = null; state.grayMap = false;
    state.piles = { ids: other ? [m.id, other.id] : [m.id], hot: [] };
    recolor();
    drawLabels();
  }
  function lens(indices) {
    if (indices && indices.length) { gpu.lensColor = AMBER; setLens(gpu, indices); }
    else if (gpu.lensCount) { setLens(gpu, new Uint32Array(0)); gpu.lensColor = null; }
    scheduleDraw();
  }
  function frame(metas) {
    const layer = isSpace() ? points.space.xy : points.geo.xy;
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    const q = (a, f) => a[Math.floor(f * (a.length - 1))];
    for (const m of metas) {
      const list = pointsOf(m.id);
      const step = Math.max(1, Math.floor(list.length / 4000));
      const xs = [], ys = [];
      for (let k = 0; k < list.length; k += step) { xs.push(layer[2 * list[k]]); ys.push(layer[2 * list[k] + 1]); }
      if (!xs.length) continue;
      xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
      x0 = Math.min(x0, q(xs, 0.02)); x1 = Math.max(x1, q(xs, 0.98)); y0 = Math.min(y0, q(ys, 0.02)); y1 = Math.max(y1, q(ys, 0.98));
    }
    if (x1 > x0) map.fitBounds([unitToLatLng(x0, y0), unitToLatLng(x1, y1)], { padding: [16, 16], maxZoom: isSpace() ? 9 : 7, animate: false });
  }
  const otherIdx = new Map();
  async function indicesOf(level, id) {
    if (level === state.level) return pointsOf(id);
    const key = `${level}/${id}`;
    if (!otherIdx.has(key)) {
      const ids = (await ensureLevel(level)).ids;
      const out = [];
      for (let i = 0; i < ids.length; i += 1) if (ids[i] === id) out.push(i);
      otherIdx.set(key, Uint32Array.from(out));
    }
    return otherIdx.get(key);
  }

  // ----- photo pools: the 16 typical photos, up to 48 more by the same rule (typical.json,
  // pipeline/typical.py: the meta's visual hubs, 40 km apart), then random members ("random") -----
  const typicalFiles = new Map();
  function typicalFor(level) {
    if (!typicalFiles.has(level)) typicalFiles.set(level, getJSON(`data/${level}/typical.json`).catch(() => ({})));
    return typicalFiles.get(level);
  }
  function pool(m) {
    return { m, level: S.level, items: exampleItems(m), seen: new Set(m.examples.map(([p]) => p)), done: false, typicalDone: false };
  }
  async function fill(p, n) {
    if (p.items.length < n && !p.typicalDone) {
      p.typicalDone = true;
      const extra = (await typicalFor(p.level))[p.m.id] || [];
      const rows = await Promise.all(extra.map(([i]) => panoAt(i)));
      extra.forEach(([i, code], k) => {
        const row = rows[k];
        if (!row || p.seen.has(row[0])) return;
        const [lat, lng] = pointLatLng(i);
        p.seen.add(row[0]);
        p.items.push({ pano: row[0], heading: row[1], lat, lng, code, meta: p.m });
      });
    }
    while (p.items.length < n && !p.done) {
      const fresh = (await memberPanos(p.m, Math.min(24, n - p.items.length + 8))).filter((x) => !p.seen.has(x.pano));
      if (!fresh.length) { p.done = true; break; }
      for (const x of fresh) { p.seen.add(x.pano); p.items.push({ ...x, random: true }); }
    }
    return p.items;
  }

  // ----- Range and Edges (pipeline/spread.py): data/<level>/spread.json and range.u8 -----
  const spreadFiles = new Map(), rangeFiles = new Map();
  function spreadFor(level) {
    if (!spreadFiles.has(level)) spreadFiles.set(level, getJSON(`data/${level}/spread.json`).catch(() => ({})));
    return spreadFiles.get(level);
  }
  function rangeFor(level) {
    if (!rangeFiles.has(level)) rangeFiles.set(level, getBinary(`data/${level}/range.u8`).then((b) => new Uint8Array(b)).catch(() => null));
    return rangeFiles.get(level);
  }
  async function dotItem(i, code, meta) {
    const row = await panoAt(i);
    if (!row) return null;
    const [lat, lng] = pointLatLng(i);
    return { pano: row[0], heading: row[1], lat, lng, code, meta };
  }
  function spreadOf() {
    if (!S.spread) {
      const level = S.level, m = state.metas.get(S.id);
      S.spread = (async () => {
        const d = (await spreadFor(level))[m.id] || { range: [], edges: [] };
        const range = (await Promise.all(d.range.map(async ([i, code, share], k) => {
          const it = await dotItem(i, code, m);
          if (it) Object.assign(it, { share, group: k });
          return it;
        }))).filter(Boolean);
        const edges = (await Promise.all(d.edges.map(async ([i, code, w, p, pc, margin]) => {
          const o = state.metas.get(w);
          if (!o) return null;
          const [a, b] = await Promise.all([dotItem(i, code, m), dotItem(p, pc, o)]);
          return a && b ? { a, b, o, margin } : null;
        }))).filter(Boolean);
        return { range, edges };
      })();
    }
    return S.spread;
  }
  async function groupDots(k) {
    const r = await rangeFor(S.level);
    if (!r || !S.open) return null;
    const out = [];
    for (const i of pointsOf(S.id)) if (r[i] === k) out.push(i);
    return Uint32Array.from(out);
  }
  const edgePer = () => (GRID === 2 ? 1 : 2) * GRID;

  // ----- the board -----
  const sizeFor = () => (GRID === 2 ? [960, 600] : GRID === 3 ? [720, 450] : [560, 350]);
  function tile(item, color, onClick, label) {
    const t = el("button", "mp-tile");
    t.type = "button";
    const [w, h] = sizeFor();
    t.append(img([thumb(item.pano, item.heading, w, h)], { onMissing: () => t.classList.add("missing"), standIn: { lat: item.lat, lng: item.lng, heading: item.heading, w, h } }));
    if (label) t.append(el("span", "mp-tile-label", label));
    t.addEventListener("mouseenter", () => pin(item, color));
    t.addEventListener("mouseleave", () => pin(null));
    t.addEventListener("click", onClick);
    return t;
  }
  async function renderBoard() {
    warmAhead();
    const token = S.token;
    const m = state.metas.get(S.id);
    if (!m) return;
    const board = $("mp-board");
    for (const b of $("mp-tabs").children) b.setAttribute("aria-pressed", String(b.dataset.mode === S.mode));
    for (const b of $("mp-grid").children) b.setAttribute("aria-pressed", String(Number(b.dataset.g) === GRID));
    const label = (item) => [item.code ? countryName(item.code) : "", item.random ? "random" : ""].filter(Boolean).join(" · ");
    if (S.mode === "photos") {
      const per = GRID * GRID;
      const items = await fill(S.photos, (S.page + 1) * per);
      if (token !== S.token || S.mode !== "photos") return;
      const page = items.slice(S.page * per, S.page * per + per);
      board.textContent = "";
      board.className = "mp-board";
      board.style.setProperty("--cols", GRID); board.style.setProperty("--rows", GRID);
      page.forEach((item) => board.append(tile(item, PILE_COLORS[0], () => openViewer(items, items.indexOf(item)), label(item))));
      $("mp-page").textContent = `${S.page * per + 1}-${S.page * per + page.length}${S.photos.done ? ` of ${items.length}` : ""}`;
      light(m);
      lens(null);
    } else if (S.mode.startsWith("vs:")) {
      const o = state.metas.get(Number(S.mode.slice(3)));
      if (!o) return;
      if (!S.vs.has(o.id)) S.vs.set(o.id, pool(o));
      const cols = Math.max(1, GRID - 1), per = cols * GRID;
      const [mine, theirs] = await Promise.all([fill(S.photos, (S.page + 1) * per), fill(S.vs.get(o.id), (S.page + 1) * per)]);
      if (token !== S.token || S.mode !== `vs:${o.id}`) return;
      board.textContent = "";
      board.className = "mp-board vs";
      const side = (meta, items, k) => {
        const panel = el("div", "mp-side-panel");
        panel.style.setProperty("--pc", PILE_COLORS[k]);
        const head = el("div", "mp-panel-head");
        head.append(el("kbd", "", k ? "B" : "A"), el("b", "", meta.name));
        if (k) {
          const open = el("button", "mp-link", "Open its page");
          open.type = "button";
          open.addEventListener("click", () => openPage(S.level, meta.id));
          head.append(open);
        }
        const grid = el("div", "mp-panel-grid");
        grid.style.setProperty("--cols", cols); grid.style.setProperty("--rows", GRID);
        items.slice(S.page * per, S.page * per + per).forEach((item) => grid.append(tile(item, PILE_COLORS[k], () => openViewer(items, items.indexOf(item)), label(item))));
        panel.append(head, grid);
        return panel;
      };
      board.append(side(m, mine, 0), side(o, theirs, 1));
      $("mp-page").textContent = `page ${S.page + 1}`;
      light(m, o);
      lens(null);
    } else if (S.mode === "range") {
      const { range } = await spreadOf();
      if (token !== S.token || S.mode !== "range") return;
      const per = GRID * GRID;
      board.textContent = "";
      board.className = "mp-board";
      board.style.setProperty("--cols", GRID); board.style.setProperty("--rows", GRID);
      range.slice(S.page * per, S.page * per + per).forEach((item) => {
        const t = tile(item, PILE_COLORS[0], () => openViewer(range, range.indexOf(item)), [`${Math.max(1, Math.round(item.share * 100))}% of it`, item.code ? countryName(item.code) : ""].filter(Boolean).join(" · "));
        t.title = "One sub-group of this meta's looks; hover to see where it is on the map";
        t.addEventListener("mouseenter", async () => { const idx = await groupDots(item.group); if (token === S.token && S.mode === "range") lens(idx); });
        t.addEventListener("mouseleave", () => lens(null));
        board.append(t);
      });
      $("mp-page").textContent = range.length ? `${S.page * per + 1}-${Math.min(range.length, S.page * per + per)} of ${range.length}` : "none";
      light(m);
      lens(null);
    } else if (S.mode === "edges") {
      const { edges } = await spreadOf();
      if (token !== S.token || S.mode !== "edges") return;
      const per = edgePer(), across = GRID === 2 ? 1 : 2;
      const flat = edges.flatMap((e) => [e.a, e.b]);
      board.textContent = "";
      board.className = "mp-board edges";
      board.style.setProperty("--cols", across); board.style.setProperty("--rows", GRID);
      edges.slice(S.page * per, S.page * per + per).forEach((e) => {
        const pair = el("div", "mp-pair");
        const a = tile(e.a, PILE_COLORS[0], () => openViewer(flat, flat.indexOf(e.a)), e.a.code ? countryName(e.a.code) : "this meta");
        const b = tile(e.b, PILE_COLORS[1], () => openViewer(flat, flat.indexOf(e.b)), [e.b.code ? countryName(e.b.code) : "", e.o.name].filter(Boolean).join(" · "));
        a.classList.add("mine"); b.classList.add("theirs");
        a.title = `This meta. ${e.margin < 0 ? `Looks a little more like ${e.o.name} than like its own meta` : `Looks almost as much like ${e.o.name}`}`;
        b.title = `${e.o.name}: its photo that looks most like the one on the left`;
        pair.append(a, b);
        pair.addEventListener("mouseenter", async () => { const idx = await indicesOf(S.level, e.o.id); if (token === S.token && S.mode === "edges") lens(idx); });
        pair.addEventListener("mouseleave", () => lens(null));
        board.append(pair);
      });
      $("mp-page").textContent = edges.length ? `pairs ${S.page * per + 1}-${Math.min(edges.length, S.page * per + per)} of ${edges.length}` : "none";
      light(m);
      lens(null);
    } else if (S.mode === "inside") {
      const fl = levelBelow(S.level);
      const kids = S.kids || [];
      const per = GRID * GRID;
      board.textContent = "";
      board.className = "mp-board";
      board.style.setProperty("--cols", GRID); board.style.setProperty("--rows", GRID);
      const total = kids.reduce((s, k) => s + k.size, 0) || 1;
      kids.slice(S.page * per, S.page * per + per).forEach((k) => {
        const ex = exampleItems(k)[0];
        if (!ex) return;
        const t = tile(ex, "#ffb347", () => openPage(fl, k.id), null);
        t.append(el("span", "mp-tile-name", `${k.name} · ${pct(k.size / total)}`));
        t.title = `${k.note || ""} (click for its page)`;
        t.addEventListener("mouseenter", async () => { const idx = await indicesOf(fl, k.id); if (token === S.token) lens(idx); });
        t.addEventListener("mouseleave", () => lens(null));
        board.append(t);
      });
      $("mp-page").textContent = `${Math.min(kids.length, S.page * per + 1)}-${Math.min(kids.length, S.page * per + per)} of ${kids.length}`;
      light(m);
    }
  }
  // Warm what comes next (see warm() in app.js): the next page of the current tab, and the first
  // page of every other tab, at the board's photo size. Shortly after the visible page starts
  // loading, so it goes first.
  const urlOf = (item) => { const [w, h] = sizeFor(); return thumb(item.pano, item.heading, w, h); };
  let warmTimer = 0;
  function warmAhead() {
    clearTimeout(warmTimer);
    const token = S.token;
    warmTimer = setTimeout(async () => {
      if (token !== S.token || !S.photos) return;
      const per = GRID * GRID, vsPer = Math.max(1, GRID - 1) * GRID;
      const urls = [];
      if (S.mode === "photos") {
        const items = await fill(S.photos, (S.page + 2) * per);
        if (token !== S.token) return;
        urls.push(...items.slice((S.page + 1) * per, (S.page + 2) * per).map(urlOf));
      } else if (S.mode.startsWith("vs:") && S.vs.has(Number(S.mode.slice(3)))) {
        const p = S.vs.get(Number(S.mode.slice(3)));
        const [mine, theirs] = await Promise.all([fill(S.photos, (S.page + 2) * vsPer), fill(p, (S.page + 2) * vsPer)]);
        if (token !== S.token) return;
        urls.push(...mine.slice((S.page + 1) * vsPer, (S.page + 2) * vsPer).map(urlOf), ...theirs.slice((S.page + 1) * vsPer, (S.page + 2) * vsPer).map(urlOf));
      }
      // The other tabs' first pages: each look-alike's typical photos, the finer metas' covers.
      urls.push(...S.photos.items.slice(0, per).map(urlOf));
      for (const b of $("mp-tabs").children) {
        if (!b.dataset.mode.startsWith("vs:")) continue;
        const o = state.metas.get(Number(b.dataset.mode.slice(3)));
        if (o) urls.push(...exampleItems(o).slice(0, vsPer).map(urlOf));
      }
      for (const k of (S.kids || []).slice(0, per)) { const ex = exampleItems(k)[0]; if (ex) urls.push(urlOf(ex)); }
      const sp = await spreadOf();
      if (token !== S.token) return;
      urls.push(...sp.range.slice(0, per).map(urlOf), ...sp.edges.slice(0, edgePer()).flatMap((e) => [urlOf(e.a), urlOf(e.b)]));
      if (S.mode === "range") urls.push(...sp.range.slice((S.page + 1) * per, (S.page + 2) * per).map(urlOf));
      if (S.mode === "edges") urls.push(...sp.edges.slice((S.page + 1) * edgePer(), (S.page + 2) * edgePer()).flatMap((e) => [urlOf(e.a), urlOf(e.b)]));
      warm(urls);
    }, 400);
  }
  // For the map card: the Photos tab's first page, so Full page opens with its photos ready.
  function warmMeta(m) { warm(exampleItems(m).slice(0, GRID * GRID).map(urlOf)); }
  function setMode(mode) {
    if (S.mode === mode) return;
    S.mode = mode; S.page = 0;
    renderBoard();
    const m = state.metas.get(S.id);
    const o = mode.startsWith("vs:") ? state.metas.get(Number(mode.slice(3))) : null;
    requestAnimationFrame(() => frame(o ? [m, o] : [m]));
  }
  function step(d) {
    const per = S.mode === "photos" || S.mode === "inside" || S.mode === "range" ? GRID * GRID : S.mode === "edges" ? edgePer() : Math.max(1, GRID - 1) * GRID;
    if (S.mode === "inside" && (S.page + d) * per >= (S.kids || []).length) return;
    if ((S.mode === "range" || S.mode === "edges") && d > 0) {
      const mode = S.mode, token = S.token;
      spreadOf().then((sp) => { if (token === S.token && S.mode === mode && (S.page + 1) * per < sp[mode].length) { S.page += 1; renderBoard(); } });
      return;
    }
    if (S.mode === "photos" && d > 0 && S.photos.done && (S.page + 1) * per >= S.photos.items.length) return;
    S.page = Math.max(0, S.page + d);
    renderBoard();
  }

  // ----- the side column and tabs -----
  async function render(m, level) {
    const token = ++S.token;
    S.mode = "photos"; S.page = 0; S.photos = pool(m); S.vs = new Map(); S.kids = null; S.spread = null;
    pinLayer.clearLayers();
    lens(null);
    if (location.hash !== `#meta/${level}/${m.id}`) history.replaceState(null, "", `#meta/${level}/${m.id}`);
    const title = $("mp-title");
    title.textContent = "";
    title.append(swatch(m), el("span", "", m.name), el("small", "", `${LEVEL_NAMES[level]} #${m.id}`));
    const info = $("mp-info");
    info.textContent = "";
    info.scrollTop = 0;

    const crumbs = el("div", "mp-crumbs");
    for (const pl of state.levels.slice(0, state.levels.indexOf(level))) {
      const best = m.links[pl] && m.links[pl][0];
      if (!best) continue;
      const p = (await ensureLevel(pl)).metas.get(best[0]);
      if (token !== S.token) return;
      if (!p) continue;
      const b = el("button", "", p.name);
      b.type = "button";
      b.title = `${LEVEL_NAMES[pl]} #${p.id} · ${pct(best[1])} of this meta's panos are in it`;
      b.addEventListener("click", () => openPage(pl, p.id));
      if (crumbs.childElementCount) crumbs.append(el("span", "mp-sep", "›"));
      crumbs.append(b);
    }
    if (crumbs.childElementCount) info.append(crumbs);
    const note = el("p", "mp-note", m.note || m.place);
    if (m.kind === "capture") note.prepend(el("span", "kind-badge", "Capture artifact"));
    else if (m.kind === "mixed") note.prepend(el("span", "kind-badge", "Partly a capture look"));
    info.append(note);
    const acts = el("div", "mp-acts");
    const act = (label, cls, tip, fn) => { const b = el("button", cls, label); b.type = "button"; b.title = tip; b.addEventListener("click", fn); acts.append(b); };
    act("Practice", "mp-primary", "A sort round: this meta and its closest look-alikes", () => { close(); practice.open({ focus: m.id }); });
    act("Show on map", "", "Back to the map with this meta selected (Esc)", () => close({ select: true }));
    info.append(acts);
    const r = trainStore()[level]?.metas?.[m.id];
    info.append(el("p", "mp-record", r && r.n ? `Practiced ${r.n} time${r.n > 1 ? "s" : ""}, ${r.ok} right${r.box >= 3 ? " · solid" : ""}` : "Not practiced yet"));
    const facts = el("div", "mp-facts");
    const fact = (label, value, tip) => { const f = el("div", "mp-fact"); f.title = tip; f.append(el("b", "", value), el("small", "", label)); facts.append(f); };
    fact("panos", m.size.toLocaleString(), "Panoramas in this meta (of 2 million)");
    fact("countries", String(m.countryCount), "Countries with at least one member");
    fact("hold", pct(m.containment), "Share of members' 20 nearest visual neighbors (beyond 3 km) that are in this meta too: how tightly the look holds together");
    fact("location bits", m.excessBits.toFixed(1), "How much knowing this meta narrows down where you are, beyond a random set of the same size");
    info.append(facts);
    const urb = el("div", "mp-urb");
    const track = el("div", "mp-urb-track");
    const keys = el("div", "mp-urb-keys");
    m.urbanity.forEach((share, i) => {
      const seg = el("i"); seg.style.width = `${share * 100}%`; seg.style.background = URBAN_COLORS[i];
      seg.title = `${state.info.urbanity[i]} ${pct(share)}`;
      track.append(seg);
      if (share >= 0.05) { const k = el("span"); const dot = el("i"); dot.style.background = URBAN_COLORS[i]; k.append(dot, el("span", "", `${state.info.urbanity[i]} ${pct(share)}`)); keys.append(k); }
    });
    urb.append(track, keys);
    info.append(urb);
    for (const [c, s] of m.countries.filter(([, s]) => s >= 0.02).slice(0, 6)) {
      const row = el("div", "mp-cbar");
      const t = el("span", "mp-track"); const fill2 = el("i"); fill2.style.width = `${s * 100}%`; t.append(fill2);
      row.append(el("span", "", countryName(c)), t, el("span", "mp-pct", pct(s)));
      info.append(row);
    }

    // Tabs: Photos, one per close look-alike, Inside.
    const tabs = $("mp-tabs");
    tabs.textContent = "";
    const tab = (mode, labelText, tip) => { const b = el("button", "", labelText); b.type = "button"; b.dataset.mode = mode; b.title = tip; b.addEventListener("click", () => setMode(mode)); tabs.append(b); return b; };
    tab("photos", "Typical", "Its most typical photos (the center of the look), then random ones (arrows page)");
    tab("range", "Range", "One photo per kind of look inside this meta, biggest first, with its share; hover one to see where it is");
    tab("edges", "Edges", "Its photos that look almost like a look-alike, each beside that look-alike's closest photo");
    const leaving = Math.max(1e-6, 1 - m.containment);
    for (const [id, share] of m.closest.slice(0, 4)) {
      const o = state.metas.get(id);
      if (!o) continue;
      const b = tab(`vs:${id}`, `vs ${o.name}`, `Side by side with a look-alike: ${Math.round((100 * share) / leaving)}% of its outside visual links go there`);
      b.classList.add("vs");
    }
    const fl = levelBelow(level);
    if (fl) {
      const finer = (await ensureLevel(fl)).metas;
      if (token !== S.token) return;
      S.kids = [...finer.values()].filter((k) => k.links[level]?.[0]?.[0] === m.id).sort((a, b) => b.size - a.size);
      if (S.kids.length > 1) tab("inside", `Inside (${S.kids.length})`, `The ${LEVEL_NAMES[fl].toLowerCase()} metas it splits into`);
    }
    renderBoard();
    requestAnimationFrame(() => requestAnimationFrame(() => frame([m])));
  }

  // ----- open / close -----
  async function openPage(level, id) {
    if (train.on) stopTraining();
    explore.close();
    practice.close();
    if (!$("home").hidden) hideHome();
    if (!$("viewer").hidden) closeViewer();
    setTools(false);
    $("map-card").hidden = true;
    if (!S.open) {
      S.open = true;
      root.hidden = false;
      document.body.classList.add("meta-paging");
      root.style.setProperty("--mp-topbar", `${document.querySelector(".topbar").offsetWidth + 12}px`);
      syncNav();
      requestAnimationFrame(placeMap);
    }
    if (level !== state.level) { S.pendingId = id; await setLevel(level); return; }   // onLevel renders it
    const m = state.metas.get(id);
    if (!m) { close(); return; }
    S.id = id; S.level = level;
    render(m, level);
  }
  function close({ select = false } = {}) {
    if (!S.open) return;
    S.open = false; S.token += 1;
    const id = S.id;
    root.hidden = true;
    document.body.classList.remove("meta-paging");
    pinLayer.clearLayers();
    lens(null);
    state.piles = null;
    releaseMap();
    recolor();
    drawLabels();
    syncNav();
    if (select && id && state.metas.has(id)) { state.mix = null; selectMeta(id, { fit: true }); }
    else writeHash();
  }
  function onLevel(level) {
    if (!S.open) return;
    const want = S.pendingId;
    S.pendingId = null;
    if (want != null && state.metas.has(want)) { S.id = want; S.level = level; render(state.metas.get(want), level); return; }
    const prev = S.id;
    ensureLevel(S.level).then((store) => {
      const m = store.metas.get(prev);
      const best = m && m.links[level] && m.links[level][0];
      if (best && state.metas.has(best[0])) { S.id = best[0]; S.level = level; render(state.metas.get(best[0]), level); }
      else close();
    });
  }
  function onView() {
    if (!S.open || !S.id) return;
    setTimeout(() => {
      const m = state.metas.get(S.id);
      const o = S.mode.startsWith("vs:") ? state.metas.get(Number(S.mode.slice(3))) : null;
      if (m) frame(o ? [m, o] : [m]);
    }, MORPH_MS + 80);
  }
  function key(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    if (e.key === "Escape" || e.key === "v") { close({ select: true }); return true; }   // V toggles the full view, as in the userscript
    if (e.key === "ArrowRight") { step(1); return true; }
    if (e.key === "ArrowLeft") { step(-1); return true; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      // Cycle the tabs.
      const modes = [...$("mp-tabs").children].map((b) => b.dataset.mode);
      const k = modes.indexOf(S.mode);
      setMode(modes[(k + (e.key === "ArrowDown" ? 1 : -1) + modes.length) % modes.length]);
      e.preventDefault();
      return true;
    }
    return false;                  // m / s, 1-5, t and e go to the app
  }
  map.on("click", (event) => {
    if (!S.open || morph.frame) return;
    const i = nearestPoint(event.containerPoint, 9);
    if (i >= 0 && state.ids[i] && state.ids[i] !== S.id) openPage(state.level, state.ids[i]);
  });
  $("mp-back").addEventListener("click", () => close({ select: true }));
  $("mp-prev").addEventListener("click", () => step(-1));
  $("mp-next").addEventListener("click", () => step(1));
  $("mp-grid").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    GRID = Number(b.dataset.g);
    try { localStorage.setItem("meta-map-page-grid", String(GRID)); } catch (_) { /* */ }
    S.page = 0;
    renderBoard();
  });
  return { open: openPage, close, onLevel, onView, key, warm: warmMeta, isOpen: () => S.open };
})();
