// ---------- Explore: looks side by side ----------
// A board of columns, one per look (meta): each column is a stack of that look's typical photos,
// and the map beside the board shows each column's range in the column's color. Looks are learned
// by comparing them, not by reading a list: a blind test matched unseen photos to the right row of
// pictures 41/48 times against 28/48 by name, and the sort piles (a few looks side by side) were
// the part of the site that worked. The catalog this replaced (every meta as a card, grouped by
// family) went unused: hundreds of near-identical road photos sorted by names that do not carry
// the difference.
//
// What fills the board (a scope):
//   country - the looks of one country, largest share first   (#explore/<level>/c/<CC>)
//   here    - the looks around a spot you click on the board's map (World or Space)
//   near    - one look and its closest look-alikes               (#explore/<level>/<id>)
//   inside  - the finer looks a look splits into (one level down)
// From any column: Look-alikes (near), Inside (one level finer), Practice (a sort round).
// Hover a column to see only its range; hover a photo to pin where it was taken.
// The map is the site's live map moved under a cutout while Explore is open, as in Practice.
// Loaded after app.js; uses its helpers.
const explore = (() => {
  const X = { open: false, scope: null, page: 0, list: [], anchor: null, pending: null, suggestions: null };
  const PAGE = 6;
  const root = $("explore");
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const LEVEL_UP = { subregion: "region", scene: "subregion", micro: "scene" };
  const levelAbove = (level) => state.levels.includes(LEVEL_UP[level]) ? LEVEL_UP[level] : undefined;
  const LEVEL_DOWN = { region: "subregion", subregion: "scene", scene: "micro" };
  const levelBelow = (level) => state.levels.includes(LEVEL_DOWN[level]) ? LEVEL_DOWN[level] : undefined;
  const whereOf = (m, n = 2) => m.countries.filter(([, s]) => s >= 0.08).slice(0, n).map(([c]) => countryName(c)).join(", ")
    || countryName(m.countries[0][0]);

  // ----- the map under the cutout -----
  function placeMap() {
    if (!X.open) return;
    const r = $("xp-hole").getBoundingClientRect();
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
  new ResizeObserver(() => { if (X.open) placeMap(); }).observe($("xp-hole"));
  const pinLayer = L.layerGroup().addTo(map);
  const spotLayer = L.layerGroup().addTo(map);      // where you clicked, for a "here" board
  function pin(item, k) {
    pinLayer.clearLayers();
    if (!item) return;
    const at = isSpace() ? viewLatLng(item.lat, item.lng) : L.latLng(item.lat, wrapNear(item.lng, map.getCenter().lng));
    if (!at) return;
    pinLayer.addLayer(L.marker(at, { interactive: false, icon: L.divIcon({ className: "pr-pin latest", iconSize: null, html: `<i style="background:${PILE_COLORS[k]}"></i>` }) }));
  }
  function light(metas, hot = []) {
    state.selected = null; state.compare = null; state.preview = null; state.grayMap = false;
    state.piles = metas.length ? { ids: metas.map((m) => m.id), hot } : null;
    recolor();
    drawLabels();
  }
  function hover(k) {
    if (!state.piles) return;
    const hot = k < 0 ? [] : [k];
    if (String(state.piles.hot) === String(hot)) return;
    state.piles.hot = hot;
    recolor();
  }
  // Frame the shown looks: their dots' 3-97% extents, or, for a country, where their photos in
  // that country were taken.
  function frame(metas) {
    const layer = isSpace() ? points.space.xy : points.geo.xy;
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    const take = (x, y) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); };
    const ci = X.scope && X.scope.kind === "country" && !isSpace() && cc ? cc.index.get(X.scope.cc) : undefined;
    if (ci !== undefined) {
      // The country itself: the 1-99% extent of all its dots.
      const xs = [], ys = [];
      const geo = points.geo.xy;
      for (let i = 0; i < cc.arr.length; i += 7) if (cc.arr[i] === ci) { xs.push(geo[2 * i]); ys.push(geo[2 * i + 1]); }
      if (xs.length) {
        xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
        const q = (a, f) => a[Math.floor(f * (a.length - 1))];
        take(q(xs, 0.01), q(ys, 0.01)); take(q(xs, 0.99), q(ys, 0.99));
      }
    }
    if (x1 <= x0) {
      const q = (a, f) => a[Math.floor(f * (a.length - 1))];
      for (const m of metas) {
        const list = pointsOf(m.id);
        const step = Math.max(1, Math.floor(list.length / 3000));
        const xs = [], ys = [];
        for (let k = 0; k < list.length; k += step) { xs.push(layer[2 * list[k]]); ys.push(layer[2 * list[k] + 1]); }
        if (!xs.length) continue;
        xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
        take(q(xs, 0.03), q(ys, 0.03)); take(q(xs, 0.97), q(ys, 0.97));
      }
    }
    if (x1 <= x0) return;
    map.fitBounds([unitToLatLng(x0, y0), unitToLatLng(x1, y1)], { padding: [24, 24], maxZoom: isSpace() ? 9 : 7, animate: false });
  }

  // ----- countries: every dot's country (data/points/cc.u8, pipeline/countries.py) -----
  let cc = null;                   // { codes, arr, index: Map code -> k }
  const ccReady = Promise.all([getJSON("data/points/countries.json"), getBinary("data/points/cc.u8")])
    .then(([codes, buf]) => { cc = { codes, arr: new Uint8Array(buf), index: new Map(codes.map((c, k) => [c, k])) }; })
    .catch(() => {});
  // Looks per country at the current level: dots of each meta in each country.
  const perCountry = new Map();    // level -> Map(ci -> Map(metaId -> n))
  function countryCounts() {
    if (!cc) return null;
    if (!perCountry.has(state.level)) {
      const out = new Map();
      const ids = state.ids, arr = cc.arr;
      for (let i = 0; i < ids.length; i += 1) {
        if (!ids[i]) continue;
        let m = out.get(arr[i]);
        if (!m) out.set(arr[i], (m = new Map()));
        m.set(ids[i], (m.get(ids[i]) || 0) + 1);
      }
      perCountry.set(state.level, out);
    }
    return perCountry.get(state.level);
  }
  const MIN_IN = 20;               // a look counts for a country with at least this many dots there
  function countryTotals() {
    const counts = countryCounts();
    if (!counts) return [];
    const out = [];
    for (const [ci, m] of counts) {
      let n = 0, metas = 0;
      for (const v of m.values()) { n += v; if (v >= MIN_IN) metas += 1; }
      if (metas >= 2) out.push([cc.codes[ci], { n, metas }]);
    }
    return out.sort((a, b) => b[1].n - a[1].n);
  }
  // Photos of a look taken in one country, spread at least 25 km apart.
  async function inCountry(m, code, want) {
    if (!cc) return [];
    const ci = cc.index.get(code);
    const list = [...pointsOf(m.id)].filter((i) => cc.arr[i] === ci);
    const picked = [];
    for (let tries = 0; picked.length < want && tries < want * 10 && list.length; tries += 1) {
      const i = list[Math.floor(Math.random() * list.length)];
      const [lat, lng] = pointLatLng(i);
      if (picked.some((p) => haversineKm([p.lat, p.lng], [lat, lng]) < 25) && tries < want * 6) continue;
      if (picked.some((p) => p.i === i)) continue;
      picked.push({ i, lat, lng });
    }
    const rows = await Promise.all(picked.map((p) => panoAt(p.i)));
    return picked.map((p, k) => rows[k] && { pano: rows[k][0], heading: rows[k][1], lat: p.lat, lng: p.lng, code, meta: m }).filter(Boolean);
  }

  // ----- scopes -----
  async function resolve(scope) {
    if (scope.kind === "country") {
      await ccReady;
      const counts = countryCounts();
      const here = counts && cc.index.has(scope.cc) ? counts.get(cc.index.get(scope.cc)) : null;
      if (!here) return null;
      const rows = [];
      let total = 0;
      for (const [id, n] of here) total += n;
      for (const [id, n] of here) if (n >= MIN_IN && state.metas.has(id)) rows.push({ m: state.metas.get(id), n });
      rows.sort((a, b) => b.n - a.n);
      return { title: `The looks of ${countryName(scope.cc)}`, sub: `${rows.length} ${LEVEL_NAMES[state.level].toLowerCase()} looks, largest first`,
        items: rows.map(({ m, n }) => ({ m, note: `${Math.round((100 * n) / total)}% of ${countryName(scope.cc)}` })) };
    }
    if (scope.kind === "near") {
      const m = state.metas.get(scope.id);
      if (!m) return null;
      const leaving = Math.max(1e-6, 1 - m.containment);
      const items = [{ m, note: "this look" }];
      for (const [id, share] of m.closest) {
        const o = state.metas.get(id);
        if (o && items.length < 8) items.push({ m: o, note: `${Math.round((100 * share) / leaving)}% of its look-alike links` });
      }
      return { title: `${m.name} and its look-alikes`, sub: "Most confused first", items, anchor: m };
    }
    if (scope.kind === "inside") {
      const above = scope.parentLevel || levelAbove(state.level);
      const parent = above ? (await ensureLevel(above)).metas.get(scope.parent) : null;
      if (!parent) return null;
      const kids = [...state.metas.values()].filter((k) => k.links[above]?.[0]?.[0] === scope.parent).sort((a, b) => b.size - a.size);
      const total = kids.reduce((s, k) => s + k.size, 0) || 1;
      return { title: `Inside ${parent.name}`, sub: `The ${kids.length} ${LEVEL_NAMES[state.level].toLowerCase()} looks it splits into`,
        items: kids.map((k) => ({ m: k, note: `${Math.round((100 * k.size) / total)}% of it` })), parent, parentLevel: above };
    }
    if (scope.kind === "here") {
      const total = scope.counts.reduce((s, [, n]) => s + n, 0) || 1;
      const items = scope.counts.map(([id, n]) => ({ m: state.metas.get(id), note: `${Math.round((100 * n) / total)}% here` })).filter((x) => x.m);
      return { title: isSpace() ? "The looks in this part of Space" : "The looks around here", sub: "Click the map anywhere to look somewhere else", items };
    }
    return null;
  }
  async function show(scope, { push = true, keepPage = false } = {}) {
    X.scope = scope;
    if (!keepPage) X.page = 0;
    const r = await resolve(scope);
    if (!X.open || X.scope !== scope) return;
    if (!r || !r.items.length) { picker(); return; }
    X.list = r.items;
    X.anchor = r.anchor || null;
    $("xp-picker").hidden = true;
    $("xp-board").hidden = false;
    $("xp-title").textContent = r.title;
    $("xp-sub").textContent = r.sub;
    const up = $("xp-up");
    up.hidden = !r.parent;
    if (r.parent) {
      up.textContent = `↑ ${r.parent.name} and its look-alikes`;
      up.onclick = () => go({ kind: "near", id: r.parent.id }, r.parentLevel);
    }
    try { localStorage.setItem("meta-map-explore-scope", JSON.stringify({ kind: scope.kind, cc: scope.cc, id: scope.id, level: state.level })); } catch (_) { /* */ }
    const hash = scope.kind === "country" ? `#explore/${state.level}/c/${scope.cc}` : scope.kind === "near" ? `#explore/${state.level}/${scope.id}` : `#explore/${state.level}`;
    if (location.hash !== hash) history[push ? "pushState" : "replaceState"](null, "", hash);
    renderPage();
  }
  // Change level if needed, then show the scope (onLevel would otherwise remap it).
  async function go(scope, level = state.level) {
    if (level !== state.level) { X.pending = scope; await setLevel(level); return; }
    show(scope);
  }

  // ----- the board -----
  function renderPage() {
    X.hoverMeta = null;
    const items = X.list.slice(X.page * PAGE, X.page * PAGE + PAGE);
    const pages = Math.ceil(X.list.length / PAGE);
    $("xp-pager").hidden = pages < 2;
    $("xp-pages").textContent = `${X.page * PAGE + 1}-${Math.min(X.list.length, X.page * PAGE + PAGE)} of ${X.list.length}`;
    $("xp-prev").disabled = X.page === 0;
    $("xp-next").disabled = X.page >= pages - 1;
    const cols = $("xp-cols");
    cols.textContent = "";
    cols.style.setProperty("--cols", items.length);
    $("xp-board").scrollTop = 0;
    items.forEach(({ m, note }, k) => cols.append(column(m, note, k)));
    // Warm the next page's columns (typical photos, at the size shown), so → is instant.
    setTimeout(() => warm(X.list.slice((X.page + 1) * PAGE, (X.page + 2) * PAGE)
      .flatMap(({ m }) => exampleItems(m).slice(0, 6).map((item) => thumb(item.pano, item.heading, 480, 300)))), 600);
    light(items.map((x) => x.m));
    spotLayer.clearLayers();
    if (X.scope.kind === "here") {
      // Keep the view you clicked in; ring the spot.
      spotLayer.addLayer(L.circleMarker(X.scope.at, { radius: 22, color: "#ffffff", weight: 2, dashArray: "4 4", fill: false, interactive: false }));
    } else requestAnimationFrame(() => requestAnimationFrame(() => frame(items.map((x) => x.m))));
  }
  function column(m, note, k) {
    const col = el("section", "xp-col");
    col.style.setProperty("--pc", PILE_COLORS[k]);
    const head = el("div", "xp-head");
    const name = el("div", "xp-name");
    name.append(el("kbd", "", String(k + 1)), el("span", "", m.name));
    name.title = `${m.note || ""} (click for its full page)`;
    name.addEventListener("click", () => { const level = state.level; close(); metaPage.open(level, m.id); });
    head.append(name, el("div", "xp-note", m.note || ""), el("div", "xp-meta", `${note} · ${whereOf(m)}`));
    const acts = el("div", "xp-acts");
    const act = (label, tip, fn) => { const b = el("button", "", label); b.type = "button"; b.title = tip; b.addEventListener("click", fn); acts.append(b); };
    if (!(X.scope.kind === "near" && X.scope.id === m.id)) act("Look-alikes", "This look next to the ones it is most confused with", () => go({ kind: "near", id: m.id }));
    const finer = levelBelow(state.level);
    if (finer) act("Inside", `The ${LEVEL_NAMES[finer].toLowerCase()} looks it splits into`, () => go({ kind: "inside", parent: m.id, parentLevel: state.level }, finer));
    act("Practice", "A sort round: this look and its look-alikes", () => { close(); practice.open({ focus: m.id }); });
    head.append(acts);
    const photos = el("div", "xp-photos");
    // On a country's board: that country's typical photos, then more of its members taken there.
    const country = X.scope.kind === "country" ? X.scope.cc : null;
    let items = exampleItems(m);
    if (country) items = items.filter((x) => x.code === country);
    const add = (item) => {
      const n = items.indexOf(item);
      const ph = el("div", "xp-ph");
      ph.append(img([thumb(item.pano, item.heading, 480, 300)], { onMissing: () => ph.remove(),
        standIn: { lat: item.lat, lng: item.lng, heading: item.heading, w: 480, h: 300 } }));
      const home = X.scope.kind === "country" ? X.scope.cc : m.countries[0][0];
      if (item.code && item.code !== home) ph.append(el("span", "xp-cc", countryName(item.code)));
      ph.addEventListener("mouseenter", () => pin(item, k));
      ph.addEventListener("mouseleave", () => pin(null));
      ph.addEventListener("click", () => openViewer(items, items.indexOf(item)));
      photos.append(ph);
      return n;
    };
    items.forEach(add);
    if (country && items.length < 12) {
      const scope = X.scope;
      inCountry(m, country, 12 - items.length).then((more) => {
        if (X.scope !== scope) return;
        const seen = new Set(items.map((x) => x.pano));
        for (const x of more) if (!seen.has(x.pano)) { items.push(x); add(x); }
      });
    }
    col.append(head, photos);
    col.addEventListener("mouseenter", () => { hover(k); X.hoverMeta = m; });
    col.addEventListener("mouseleave", () => { hover(-1); if (X.hoverMeta === m) X.hoverMeta = null; });
    return col;
  }

  // ----- start: pick a country, or click the map -----
  async function picker() {
    X.scope = null; X.list = []; X.anchor = null;
    spotLayer.clearLayers();
    await ccReady;
    if (!X.open || X.scope) return;
    $("xp-board").hidden = true;
    $("xp-picker").hidden = false;
    $("xp-title").textContent = "Explore the looks";
    $("xp-sub").textContent = "Pick a country, search, or click the map anywhere";
    $("xp-up").hidden = true;
    $("xp-pager").hidden = true;
    light([]);
    const box = $("xp-countries");
    box.textContent = "";
    for (const [cc, t] of countryTotals().slice(0, 90)) {
      const b = el("button", "xp-country");
      b.type = "button";
      b.append(el("span", "", countryName(cc)), el("small", "", String(t.metas)));
      b.title = `${t.metas} ${LEVEL_NAMES[state.level].toLowerCase()} looks`;
      b.addEventListener("click", () => go({ kind: "country", cc }));
      box.append(b);
    }
    requestAnimationFrame(() => requestAnimationFrame(() => map.fitBounds([unitToLatLng(0.03, 0.14), unitToLatLng(0.97, 0.8)], { animate: false })));
    if (location.hash !== `#explore/${state.level}`) history.replaceState(null, "", `#explore/${state.level}`);
  }
  // Search: countries and looks by name; Enter takes the first.
  function suggest(q) {
    const box = $("xp-suggest");
    box.textContent = "";
    q = q.trim().toLowerCase();
    if (!q) { box.hidden = true; X.suggestions = null; return; }
    const out = [];
    for (const [cc, t] of countryTotals()) {
      if (countryName(cc).toLowerCase().includes(q) || cc.toLowerCase() === q) out.push({ label: countryName(cc), sub: `${t.metas} looks`, scope: { kind: "country", cc } });
    }
    for (const m of state.metas.values()) {
      if (out.length >= 14) break;
      if (m.name.toLowerCase().includes(q) || (q.length > 3 && (m.note || "").toLowerCase().includes(q))) {
        out.push({ label: m.name, sub: whereOf(m), scope: { kind: "near", id: m.id } });
      }
    }
    out.slice(0, 14).forEach((o, k) => {
      const b = el("button", k === 0 ? "on" : "");
      b.type = "button";
      b.append(el("span", "", o.label), el("small", "", o.sub));
      b.addEventListener("mousedown", (e) => { e.preventDefault(); pick(o.scope); });
      box.append(b);
    });
    box.hidden = !out.length;
    X.suggestions = out;
  }
  function pick(scope) {
    $("xp-q").value = "";
    $("xp-suggest").hidden = true;
    $("xp-q").blur();
    go(scope);
  }
  $("xp-q").addEventListener("input", () => suggest($("xp-q").value));
  $("xp-q").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && X.suggestions && X.suggestions[0]) { e.preventDefault(); pick(X.suggestions[0].scope); }
    if (e.key === "Escape") $("xp-suggest").hidden = true;
  });
  $("xp-q").addEventListener("blur", () => setTimeout(() => { $("xp-suggest").hidden = true; }, 100));

  // Clicking the board's map: the looks around that spot (World), or in that part of Space.
  map.on("click", (event) => {
    if (!X.open || morph.frame) return;
    const [x, y, world] = toWorld(event.containerPoint);
    const counts = new Map();
    for (const [j] of near(x, y, 40 / world)) { const id = state.ids[j]; if (id) counts.set(id, (counts.get(id) || 0) + 1); }
    const sorted = [...counts].sort((a, b) => b[1] - a[1]);
    const total = sorted.reduce((s, [, n]) => s + n, 0);
    const keep = sorted.filter(([, n]) => n >= Math.max(2, total * 0.03)).slice(0, 12);
    if (keep.length) show({ kind: "here", counts: keep, at: event.latlng });
  });

  // ----- open / close -----
  function enter() {
    if (X.open) return;
    if (train.on) stopTraining();
    practice.close();
    metaPage.close();
    if (!$("home").hidden) hideHome();
    if (!$("viewer").hidden) closeViewer();
    setTools(false);
    X.open = true;
    root.hidden = false;
    document.body.classList.add("exploring");
    root.style.setProperty("--xp-topbar", `${document.querySelector(".topbar").offsetWidth + 12}px`);
    syncNav();
    requestAnimationFrame(placeMap);
  }
  function lastScope() {
    try {
      const s = JSON.parse(localStorage.getItem("meta-map-explore-scope") || "null");
      if (s && s.level === state.level && (s.kind === "country" || (s.kind === "near" && state.metas.has(s.id)))) return { kind: s.kind, cc: s.cc, id: s.id };
    } catch (_) { /* */ }
    return null;
  }
  function open({ id = null, cc = null, search = false } = {}) {
    enter();
    if (id && state.metas.has(id)) show({ kind: "near", id }, { push: false });
    else if (cc) show({ kind: "country", cc }, { push: false });
    else if (X.scope) show(X.scope, { push: false, keepPage: true });
    else { const s = lastScope(); if (s) show(s, { push: false }); else picker(); }
    if (search) $("xp-q").focus();
  }
  function openMeta(level, id) { enter(); go({ kind: "near", id }, level); }
  // carry: going to Map from a look-alike board selects its look there.
  function close({ carry = false } = {}) {
    if (!X.open) return;
    const id = carry && X.anchor ? X.anchor.id : null;
    X.open = false;
    root.hidden = true;
    document.body.classList.remove("exploring");
    pinLayer.clearLayers();
    spotLayer.clearLayers();
    state.piles = null;
    releaseMap();
    recolor();
    drawLabels();
    syncNav();
    if (id && state.metas.has(id)) { state.mix = null; selectMeta(id, { fit: true }); }
    writeHash();
  }
  // Level changed (top bar, keys 1-5): keep the country; a look's board follows its best match.
  function onLevel(level) {
    if (!X.open) return;
    if (X.pending) { const s = X.pending; X.pending = null; show(s); return; }
    const s = X.scope;
    if (!s) { picker(); return; }
    if (s.kind === "country") { show(s, { push: false }); return; }
    const from = X.anchor || (X.list[0] && X.list[0].m);
    const best = from && from.links[level] ? from.links[level][0][0] : null;
    if (best && state.metas.has(best)) show({ kind: "near", id: best }, { push: false }); else picker();
  }
  function onView() { if (X.open && X.list.length) setTimeout(() => frame(X.list.slice(X.page * PAGE, X.page * PAGE + PAGE).map((x) => x.m)), MORPH_MS + 80); }
  function key(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    if (e.key === "Escape") { if (X.scope) picker(); else close(); return true; }
    if (e.key === "/") { e.preventDefault(); $("xp-q").focus(); return true; }
    if (e.key === "ArrowRight" && !$("xp-pager").hidden) { $("xp-next").click(); return true; }
    if (e.key === "ArrowLeft" && !$("xp-pager").hidden) { $("xp-prev").click(); return true; }
    if (e.key === "e") return true;
    if (e.key === "v" && X.hoverMeta) { const level = state.level, id = X.hoverMeta.id; close(); metaPage.open(level, id); return true; }   // full view of the column under the mouse
    return false;      // m / s, t, 1-5 and the rest go to the app
  }
  $("xp-prev").addEventListener("click", () => { if (X.page > 0) { X.page -= 1; renderPage(); } });
  $("xp-next").addEventListener("click", () => { if ((X.page + 1) * PAGE < X.list.length) { X.page += 1; renderPage(); } });
  $("xp-start").addEventListener("click", picker);
  addEventListener("popstate", () => {
    const parts = location.hash.slice(1).split("/");
    if (parts[0] !== "explore") { if (X.open) close(); return; }
    enter();
    if (parts[2] === "c" && parts[3]) show({ kind: "country", cc: parts[3] }, { push: false });
    else if (Number(parts[2]) && state.metas.has(Number(parts[2]))) show({ kind: "near", id: Number(parts[2]) }, { push: false });
    else picker();
  });
  return { open, close, openMeta, onLevel, onView, key, isOpen: () => X.open };
})();
