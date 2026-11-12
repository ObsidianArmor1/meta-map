// ---------- Practice ----------
// Two kinds of round, both over the whole window (Train / T):
//
// Sort: one photo at a time, sorted into piles that stay on screen for the whole round: a meta and
// its closest look-alikes (3-4 piles, about 16 photos). Fixed piles let a picture of each look
// build up over the round; the earlier trainer showed four fresh rows of pictures per question,
// so nothing carried from one question to the next. While sorting there is no map (the user
// preferred it that way). The map comes around the round instead:
//   after  - every round ends on the review next to the map: each pile's range in its color and a
//            pin where each photo was taken, so the looks you just learned get their places.
//   before - only for a set you have never practiced: one screen with the piles' ranges, so you
//            know what you are about to learn. Not every round: look-alike piles mostly cover
//            the same ground, so a map before each round would cost a screen and tell little.
//
// Guess: one location at a time, click where you think it is, and the reveal shows where its
// closest look-alikes are (not a meta's range: the photo's own neighbors in embedding space).
// Five per round, scored like GeoGuessr. See "guess rounds" below.
//
// Photos are "fair" members (pipeline/quiz.py). Answers feed the per-meta Leitner record that
// Explore shows. The map is the site's live map, moved under a cutout (.pr-hole) while a screen
// needs it and given back afterwards. Loaded after app.js and explore.js.
const practice = (() => {
  const P = { open: false, mode: "sort", round: null, q: 0, answered: false, focus: null, next: null, turn: 0, last: null,
    timer: 0, pins: [], pinFocus: null, viewTimer: 0 };
  try { const m = localStorage.getItem("meta-map-practice-mode"); if (m === "where") P.mode = m; } catch (_) { /* */ }
  const root = $("practice");
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const PHOTO = [1600, 900];
  const photoUrl = (p, turn = 0) => thumb(p.pano, Math.round(p.heading + turn) % 360, PHOTO[0], PHOTO[1], 100);
  const record = (id) => (trainStore()[state.level] || { metas: {} }).metas[id];
  const chip = (k) => { const c = el("span", "pr-chip", String(k + 1)); c.style.background = PILE_COLORS[k]; return c; };

  // ----- screens -----
  // sort-intro, sort-play, sort-summary, where-play, where-summary. CSS lays each out; the map is
  // shown wherever the screen has the cutout (everywhere but sort-play).
  function screen(name) {
    root.dataset.view = name;
    const withMap = name !== "sort-play";
    root.classList.toggle("opaque", !withMap);
    if (withMap) requestAnimationFrame(placeMap); else releaseMap();
  }
  function placeMap() {
    if (!P.open || root.classList.contains("opaque")) return;
    const r = $("pr-hole").getBoundingClientRect();
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
  new ResizeObserver(() => { if (P.open) placeMap(); }).observe($("pr-hole"));

  // ----- map layers: pins, guesses, framing -----
  const pinLayer = L.layerGroup().addTo(map);
  function pinAt(p) {
    if (isSpace()) return p.i >= 0 ? unitToLatLng(points.space.xy[2 * p.i], points.space.xy[2 * p.i + 1]) : null;
    return L.latLng(p.lat, wrapNear(p.lng, map.getCenter().lng));
  }
  function drawPins() {
    pinLayer.clearLayers();
    const hot = state.piles ? state.piles.hot : [];
    P.pins.forEach((pin, n) => {
      const at = pinAt(pin.p);
      if (!at) return;
      const dim = P.pinFocus ? !P.pinFocus.has(pin) : hot.length && !hot.includes(pin.k);
      const lit = P.pinFocus && P.pinFocus.has(pin);
      const cls = ["pr-pin", pin.ok ? "" : "miss", lit ? "latest" : "", dim ? "dim" : ""].join(" ");
      const marker = L.marker(at, { keyboard: false,
        icon: L.divIcon({ className: cls, iconSize: null, html: `<i style="background:${PILE_COLORS[pin.k]}"></i>` }) });
      marker.on("click", () => openViewer(P.pins.map((x) => x.p), n));
      const said = pin.said && pin.said !== pin.p.meta ? ` · you said ${pin.said.name}` : "";
      marker.bindTooltip(`<img src="${thumb(pin.p.pano, Math.round(pin.p.heading), 320, 200)}" referrerpolicy="no-referrer" alt=""><span>${pin.p.meta.name}${said}</span>`,
        { direction: "top", offset: [0, -10], className: "pr-tip" });
      pinLayer.addLayer(marker);
      // Where rounds: your guess, joined to the photo.
      if (pin.guess && !isSpace()) {
        const g = L.latLng(pin.guess.lat, wrapNear(pin.guess.lng, at.lng));
        pinLayer.addLayer(L.polyline([g, at], { color: "#ffffff", weight: 1.5, opacity: dim ? 0.15 : 0.7, dashArray: "4 5", interactive: false }));
        pinLayer.addLayer(L.marker(g, { interactive: false, icon: L.divIcon({ className: `pr-guess${dim ? " dim" : ""}`, iconSize: null }) }));
      }
    });
  }
  // Light only some piles (and optionally only some pins); [] lights them all.
  function hoverPiles(ks, pins = null) {
    if (!state.piles) return;
    if (String(state.piles.hot) === String(ks) && P.pinFocus === pins) return;
    state.piles.hot = ks;
    P.pinFocus = pins;
    recolor();
    drawPins();
  }
  function lightPiles(metas) {
    state.selected = null; state.compare = null; state.preview = null; state.grayMap = false;
    state.piles = metas ? { ids: metas.map((m) => m.id), hot: [] } : null;
    P.pinFocus = null;
    recolor();
    drawLabels();
  }
  // Frame metas (2-98% of a sample of their dots) plus any extra points, in Map or Space.
  function frame(metas, extra = []) {
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
      x0 = Math.min(x0, q(xs, 0.02)); x1 = Math.max(x1, q(xs, 0.98));
      y0 = Math.min(y0, q(ys, 0.02)); y1 = Math.max(y1, q(ys, 0.98));
    }
    if (!isSpace()) for (const { lat, lng } of extra) {
      const s = Math.sin(Math.max(-85, Math.min(85, lat)) * Math.PI / 180);
      const x = (lng + 180) / 360, y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    if (x1 <= x0) return;
    map.fitBounds([unitToLatLng(x0, y0), unitToLatLng(x1, y1)], { padding: [30, 30], maxZoom: isSpace() ? 9 : 7, animate: false });
  }
  function worldView() { map.fitBounds([unitToLatLng(0.03, 0.14), unitToLatLng(0.97, 0.8)], { animate: false }); }

  // ----- sort rounds -----
  // Three piles while the target is new or shaky, four once you have it two rounds running
  // (Leitner box 2+): the fourth look-alike is the hardest to tell apart.
  function setFor(target) {
    const r = record(target.id);
    const size = r && r.box >= 2 ? 4 : 3;
    const set = [target];
    for (const [id] of target.closest) {
      const o = state.metas.get(id);
      if (o && !set.includes(o)) set.push(o);
      if (set.length === size) break;
    }
    return set;
  }
  async function makeSort(focus) {
    const level = state.level;
    const target = (focus && state.metas.get(focus)) || pickTarget(P.last);
    const set = setFor(target);
    const per = { 2: 7, 3: 5, 4: 4 }[set.length] || 4;
    const lists = await Promise.all(set.map((m) => fairPanos(m, per)));
    const photos = shuffle(lists.flat().filter(Boolean));
    // No meta three times running: it would let the order, not the photo, answer.
    for (let k = 2; k < photos.length; k += 1) {
      if (photos[k].meta === photos[k - 1].meta && photos[k].meta === photos[k - 2].meta) {
        const j = photos.findIndex((p, i) => i > k && p.meta !== photos[k].meta);
        if (j > 0) [photos[k], photos[j]] = [photos[j], photos[k]];
      }
    }
    return { kind: "sort", level, target, set, photos, answers: [], fresh: !set.some((m) => record(m.id)) };
  }
  // Warm a prepared round (see warm() in app.js): its first photos and its piles' pictures, at the
  // sizes they are shown, so the next round appears at once.
  function warmRound(r) {
    if (!r) return;
    warm([...r.photos.slice(0, 3).map((p) => photoUrl(p)),
      ...r.set.flatMap((m) => exampleItems(m).slice(0, 3).map((item) => thumb(item.pano, item.heading, 400, 250)))]);
  }
  async function startSort(round) {
    clearTimeout(P.timer);
    const r = await round;
    if (!P.open || r.level !== state.level || P.mode !== "sort") return;
    P.round = r;
    P.last = r.target.id;
    P.q = 0; P.answered = false; P.turn = 0; P.pins = [];
    P.next = null;
    pinLayer.clearLayers();
    renderPiles();
    $("pr-title").textContent = P.focus ? `${r.target.name} and its look-alikes` : `${LEVEL_NAMES[state.level]} · ${r.target.name} and its look-alikes`;
    if (r.fresh) intro(); else play();
  }
  // Before: only for a set you have never practiced.
  function intro() {
    screen("sort-intro");
    lightPiles(P.round.set);
    const hint = $("pr-hint");
    hint.textContent = "";
    const start = el("button", "pr-primary", "Start sorting (Space)");
    start.type = "button";
    start.addEventListener("click", play);
    hint.append(el("b", "", "New piles. "), el("span", "", "Here is where each one lives; hover a pile to see just its range. "), start);
    $("pr-map-note").textContent = "Where each pile lives";
    renderDots();
    requestAnimationFrame(() => requestAnimationFrame(() => frame(P.round.set)));
  }
  function play() {
    if (!P.round) return;
    screen("sort-play");
    $("pr-hint").textContent = "Which pile? Press 1-4 or click a pile. Arrows turn the view; hold Shift for all four directions.";
    renderQuestion();
  }
  function renderPiles() {
    const box = $("pr-piles");
    box.textContent = "";
    box.style.setProperty("--piles", P.round.set.length);
    P.round.set.forEach((m, k) => {
      const pile = el("button", "pr-pile");
      pile.type = "button";
      pile.style.setProperty("--pc", PILE_COLORS[k]);
      const head = el("div", "pr-pile-head");
      head.append(el("kbd", "", String(k + 1)), el("span", "pr-pile-name", m.name));
      head.title = `${m.name}: ${m.note || ""}`;
      const refs = el("div", "pr-refs");
      for (const item of exampleItems(m).slice(0, 3)) {
        refs.append(img([thumb(item.pano, item.heading, 400, 250)], { standIn: { lat: item.lat, lng: item.lng, heading: item.heading, w: 400, h: 250 } }));
      }
      pile.append(head, refs, el("div", "pr-sorted"));
      pile.addEventListener("click", () => answer(k));
      pile.addEventListener("mouseenter", () => hoverPiles([k]));
      pile.addEventListener("mouseleave", () => hoverPiles([]));
      box.append(pile);
    });
  }
  function renderDots() {
    const box = $("pr-dots");
    box.textContent = "";
    const list = P.round ? P.round.photos : [];
    list.forEach((_, k) => {
      const a = P.round.answers[k];
      box.append(el("i", a ? (a.ok ? "ok" : "miss") : k === P.q && root.dataset.view !== "sort-intro" ? "now" : ""));
    });
    const right = P.round ? P.round.answers.filter((a) => a && a.ok).length : 0;
    $("pr-count").textContent = list.length ? `${Math.min(P.q + 1, list.length)} of ${list.length} · ${right} ${P.mode === "where" ? "2,500+ points" : "right"}` : "";
  }
  function showPhoto() {
    const p = P.round.photos[P.q];
    const frameEl = $("pr-photo");
    frameEl.querySelectorAll("img").forEach((x) => x.remove());
    frameEl.prepend(img([photoUrl(p, P.turn)], { standIn: { lat: p.lat, lng: p.lng, heading: p.heading + P.turn, w: PHOTO[0], h: PHOTO[1] } }));
    for (const b of $("pr-turn").children) b.setAttribute("aria-pressed", String(Number(b.dataset.t) === P.turn));
  }
  function renderQuestion() {
    P.answered = false; P.turn = 0;
    showPhoto();
    $("pr-photo").className = "pr-photo";
    $("pr-feedback").textContent = "";
    $("pr-feedback").className = "pr-feedback";
    for (const pile of $("pr-piles").children) pile.classList.remove("right", "wrong");
    renderDots();
    for (const n of P.round.photos.slice(P.q + 1, P.q + 3)) fetchThumb(photoUrl(n));   // never wait on the network
    { const p = P.round.photos[P.q]; warmPeek(p.pano, p.heading); }                 // its Shift views
  }
  function turnTo(t) {
    if (!P.round || !P.round.photos[P.q]) return;
    P.turn = ((t % 360) + 360) % 360;
    showPhoto();
  }
  function feedback(ok, main, rest, wait) {
    const fb = $("pr-feedback");
    fb.textContent = "";
    fb.className = `pr-feedback ${ok ? "ok" : "miss"}`;
    fb.append(el("b", "", main), el("span", "", rest));
    if (wait) fb.append(el("em", "", "Space to continue"));
    $("pr-photo").classList.add(ok ? "ok" : "miss");
  }
  function answer(k) {
    if (!P.round || P.round.kind !== "sort" || P.answered || root.dataset.view !== "sort-play") return;
    const p = P.round.photos[P.q];
    const chosen = P.round.set[k];
    if (!p || !chosen) return;
    const ok = chosen === p.meta;
    P.answered = true; P.answeredAt = performance.now();
    P.round.answers[P.q] = { p, chosen, ok };
    trainRecord(p.meta.id, ok, chosen.id);
    const piles = $("pr-piles").children;
    const rightK = P.round.set.indexOf(p.meta);
    piles[rightK].classList.add("right");
    if (!ok) piles[k].classList.add("wrong");
    // The photo joins its true pile, so each pile fills with what that look really is; its pin
    // waits for the map after the round.
    const thumbEl = img([thumb(p.pano, p.heading, 240, 150)], { standIn: { lat: p.lat, lng: p.lng, heading: p.heading, w: 240, h: 150 } });
    if (!ok) thumbEl.classList.add("miss");
    const sorted = piles[rightK].querySelector(".pr-sorted");
    sorted.prepend(thumbEl);
    while (sorted.children.length > 6) sorted.lastChild.remove();
    P.pins.push({ p, k: rightK, ok, said: chosen });
    if (ok) {
      feedback(true, "Right", ` · ${p.meta.name}`, false);
      const q = P.q;
      P.timer = setTimeout(() => { if (P.q === q && P.answered) next(); }, 700);
    } else feedback(false, `It's ${p.meta.name}`, ` · you said ${chosen.name}`, true);
    renderDots();
  }
  function next() {
    clearTimeout(P.timer);
    if (!P.round || !P.answered) return;
    P.q += 1;
    if (P.q >= P.round.photos.length) (P.round.kind === "sort" ? sortSummary : whereSummary)();
    else if (P.round.kind === "sort") renderQuestion();
    else whereQuestion();
  }

  // After: the review next to the map with every photo pinned.
  function sortSummary() {
    const r = P.round;
    screen("sort-summary");
    for (const pile of $("pr-piles").children) pile.classList.remove("right", "wrong");
    lightPiles(r.set);
    $("pr-map-note").textContent = "Where each pile lives · pins: this round's photos (red ring: missed)";
    requestAnimationFrame(() => requestAnimationFrame(() => { frame(r.set); drawPins(); }));
    const kOf = (m) => r.set.indexOf(m);
    const box = $("pr-summary");
    box.textContent = "";
    box.scrollTop = 0;
    const right = r.answers.filter((a) => a && a.ok).length;
    const head = el("div", "pr-sum-head");
    head.append(el("div", "pr-score", `${right} / ${r.photos.length}`),
      el("div", "pr-sum-line", right === r.photos.length ? "Every photo in the right pile." : "Here is what went into the wrong pile."));
    const actions = el("div", "pr-sum-actions");
    const tally = el("div", "pr-tally");
    box.append(head, actions, tally);
    const act = (label, cls, tip, fn) => { const b = el("button", cls, label); b.type = "button"; b.title = tip; b.addEventListener("click", fn); actions.append(b); };
    act(P.focus ? "Another round (Space)" : "Next round (Space)", "pr-primary", P.focus ? "Same piles, new photos" : "A new set, chosen by what is due", () => nextRound());
    if (!P.focus) act("Same piles again (R)", "", "These metas again, new photos", () => sameAgain());
    for (const m of r.set) {
      const mine = r.answers.filter((a) => a && a.p.meta === m);
      const ok = mine.filter((a) => a.ok).length;
      const cell = el("button", "pr-tally-cell");
      cell.type = "button";
      cell.title = "Open its page";
      cell.append(chip(kOf(m)), el("span", "", m.name), el("b", "", `${ok}/${mine.length}`));
      cell.addEventListener("click", () => openPage(m.id));
      cell.addEventListener("mouseenter", () => hoverPiles([kOf(m)]));
      cell.addEventListener("mouseleave", () => hoverPiles([]));
      tally.append(cell);
    }
    // Confusions, worst first: your misses next to typical photos of the pile they went to.
    const pairs = new Map();
    for (const a of r.answers) if (a && !a.ok) {
      const key = `${a.p.meta.id}>${a.chosen.id}`;
      if (!pairs.has(key)) pairs.set(key, { truth: a.p.meta, said: a.chosen, list: [] });
      pairs.get(key).list.push(a.p);
    }
    for (const c of [...pairs.values()].sort((a, b) => b.list.length - a.list.length)) {
      const row = el("div", "pr-conf");
      const lab = el("div", "pr-conf-lab");
      const link = (m) => { const b = el("button", "pr-link"); b.type = "button"; b.append(chip(kOf(m)), el("span", "", m.name)); b.addEventListener("click", () => openPage(m.id)); return b; };
      lab.append(el("small", "", `${c.list.length} photo${c.list.length > 1 ? "s" : ""} of`), link(c.truth), el("small", "", "went to"), link(c.said));
      const photos = el("div", "pr-conf-photos");
      const group = (label, cls, items, onClick) => {
        const g = el("div", `pr-conf-group ${cls}`);
        g.append(el("div", "pr-conf-cap", label));
        const strip = el("div", "pr-conf-strip");
        items.forEach((p, k) => {
          const ph = el("div", "pr-conf-ph");
          ph.append(img([thumb(p.pano, p.heading, 400, 250)], { standIn: { lat: p.lat, lng: p.lng, heading: p.heading, w: 400, h: 250 } }));
          ph.addEventListener("click", () => onClick(k));
          strip.append(ph);
        });
        g.append(strip);
        return g;
      };
      photos.append(group(`Yours: ${c.truth.name}`, "mine", c.list.slice(0, 3), (k) => openViewer(c.list, k)),
        group(`Typical ${c.said.name}`, "theirs", exampleItems(c.said).slice(3, 5), (k) => openViewer(exampleItems(c.said), 3 + k)));
      row.append(lab, photos);
      // Hover a confusion: just those two piles on the map, and the pins of these misses.
      const missPins = new Set(P.pins.filter((pin) => !pin.ok && pin.p.meta === c.truth && pin.said === c.said));
      row.addEventListener("mouseenter", () => hoverPiles([kOf(c.truth), kOf(c.said)], missPins));
      row.addEventListener("mouseleave", () => hoverPiles([]));
      box.append(row);
    }
    P.next = makeSort(P.focus);              // prepare the next round while you read
    P.next.then((n) => warmRound(n));
  }

  // ----- guess rounds -----
  // The learning loop of the in-game trainer: one location, you guess where it is, then the reveal
  // shows where the photos that look most like it are. Not metas: a photo's own closest look-alikes
  // (exact C-RADIOv4-H top-500, keeping the first 100 that are 3 km+ away, so they are similar
  // places, not the same road; pipeline/guess_pool.py) are sharper than any meta's range.
  // The reveal: the true spot, your guess, the look-alikes as red dots (closest brightest; hover for
  // the photo), the 8 closest under the photo, and where the look points: the densest cluster of
  // look-alikes (similarity-weighted, softmax T 0.02, 300 km kernel), with what that click alone
  // would have scored. Scores use the GeoGuessr world curve, 5000 * exp(-km / 1492.7).
  // Internally the mode is still called "where" (views where-play / where-summary).
  const GUESS_ROUND = 5;
  const REVEAL_GRACE_MS = 900;     // Space/Enter this soon after answering does not skip the reveal
  const score = (km) => Math.round(5000 * Math.exp(-km / 1492.7));
  const half = (h) => { const e = (h >> 10) & 31, f = h & 1023; const v = e ? 2 ** (e - 15) * (1 + f / 1024) : 2 ** -14 * (f / 1024); return h & 0x8000 ? -v : v; };
  let G = null, gReady = null;
  function loadGuess() {
    if (!gReady) gReady = Promise.all([getJSON("data/guess/meta.json"), getBinary("data/guess/q.u32"), getBinary("data/guess/nb.u32"), getBinary("data/guess/sim.f16")])
      .then(([meta, q, nb, sim]) => { G = { ...meta, q: new Uint32Array(q), nb: new Uint32Array(nb), sim: new Uint16Array(sim) }; return G; });
    return gReady;
  }
  const seenQ = new Set();
  async function makeWhere() {
    const level = state.level;
    const g = await loadGuess();
    const picks = [];
    for (let tries = 0; picks.length < GUESS_ROUND && tries < 400; tries += 1) {
      const k = Math.floor(Math.random() * g.count);
      if (seenQ.has(k) || picks.some((p) => p.k === k)) continue;
      const i = g.q[k];
      const [lat, lng] = pointLatLng(i);
      if (tries < 300 && picks.some((p) => haversineKm([p.lat, p.lng], [lat, lng]) < 1500)) continue;   // spread a round out
      picks.push({ k, i, lat, lng });
    }
    const rows = await Promise.all(picks.map((p) => panoAt(p.i)));
    const photos = picks.map((p, n) => rows[n] && { ...p, pano: rows[n][0], heading: rows[n][1],
      meta: state.metas.get(state.ids[p.i]) || { name: "", id: "", countries: [["", 1]] } }).filter(Boolean);
    photos.forEach((p) => seenQ.add(p.k));
    return { kind: "where", level, set: [], photos, answers: [] };
  }
  function neighborsOf(p) {
    const out = [];
    const base = p.k * G.k;
    for (let r = 0; r < G.k; r += 1) {
      const i = G.nb[base + r];
      const [lat, lng] = pointLatLng(i);
      out.push({ i, lat, lng, sim: half(G.sim[base + r]), rank: r });
    }
    return out;
  }
  // Where the look points: the look-alike with the most similarity-weighted company within ~300 km,
  // then the weighted mean of that cluster.
  function lookPoint(nbs) {
    const top = nbs[0].sim;
    const w = nbs.map((n) => Math.exp((n.sim - top) / 0.02));
    const R = 300;
    const near2 = (a, b) => Math.exp(-((haversineKm([a.lat, a.lng], [b.lat, b.lng]) / R) ** 2));
    let best = 0, bestS = -1;
    nbs.forEach((a, j) => { let sc = 0; nbs.forEach((b, k) => { sc += w[k] * near2(a, b); }); if (sc > bestS) { bestS = sc; best = j; } });
    const c = nbs[best];
    let sw = 0, sl = 0, sg = 0;
    nbs.forEach((b, k) => { const ww = w[k] * near2(c, b); sw += ww; sl += ww * b.lat; sg += ww * wrapNear(b.lng, c.lng); });
    return { lat: sl / sw, lng: ((sg / sw + 540) % 360) - 180 };
  }
  // Pins (the photo, your guess, the look point) are a few Leaflet markers; the look-alikes are
  // drawn by the map's own WebGL dot renderer (its highlight pass, in red), and hovering one shows
  // its photo through the map's normal hover card. Drawing them as 100 Leaflet canvas circles plus
  // a dashed SVG line made Firefox take seconds per frame while panning after the reveal.
  const nbLayer = L.layerGroup().addTo(map);
  const NB_LENS = [1, 0.31, 0.43, 2.4];
  function showNeighbors(nbs) {
    if (nbs && nbs.length) {
      gpu.lensColor = NB_LENS;
      gpu.lensSet = new Set(nbs.map((n) => n.i));
      setLens(gpu, Uint32Array.from(nbs.map((n) => n.i)));
    } else {
      if (gpu.lensCount) setLens(gpu, new Uint32Array(0));
      gpu.lensColor = null; gpu.lensSet = null;
    }
    scheduleDraw();
  }
  function tipHtml(pano, heading, line) {
    return `<img src="${thumb(pano, Math.round(heading), 320, 200)}" referrerpolicy="no-referrer" alt=""><span>${line}</span>`;
  }
  // Draw answers: the true spot, your guess and where the look pointed; for one answer, its
  // look-alikes too.
  function drawGuesses(list, withNeighbors) {
    nbLayer.clearLayers();
    showNeighbors(withNeighbors && list.length === 1 ? list[0].nbs : null);
    for (const a of list) {
      const ref = a.p.lng;
      const at = L.latLng(a.p.lat, a.p.lng);
      const g = L.latLng(a.guess.lat, wrapNear(a.guess.lng, ref));
      const lk = L.latLng(a.look.lat, wrapNear(a.look.lng, ref));
      nbLayer.addLayer(L.marker(lk, { interactive: false, icon: L.divIcon({ className: "gs-look", iconSize: null }) }));
      nbLayer.addLayer(L.marker(g, { interactive: false, icon: L.divIcon({ className: "pr-guess", iconSize: null }) }));
      const truth = L.marker(at, { keyboard: false, icon: L.divIcon({ className: "gs-true", iconSize: null }) });
      truth.bindTooltip(tipHtml(a.p.pano, a.p.heading, `The photo · you were ${Math.round(a.km).toLocaleString()} km off`), { direction: "top", offset: [0, -10], className: "pr-tip" });
      truth.on("click", () => openViewer([a.p], 0));
      nbLayer.addLayer(truth);
    }
  }
  function fitGuesses(list, withNeighbors) {
    const pts = [];
    for (const a of list) {
      const ref = a.p.lng;
      pts.push([a.p.lat, a.p.lng], [a.guess.lat, wrapNear(a.guess.lng, ref)], [a.look.lat, wrapNear(a.look.lng, ref)]);
      if (withNeighbors) for (const n of a.nbs.slice(0, 30)) pts.push([n.lat, wrapNear(n.lng, ref)]);
    }
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 8, animate: false });
  }
  async function startWhere(round) {
    clearTimeout(P.timer);
    const r = await round;
    if (!P.open || r.level !== state.level || P.mode !== "where") return;
    if (isSpace()) await setView("map", { animate: false });       // guessing needs the world map
    P.round = r;
    P.q = 0; P.pins = [];
    P.next = null;
    pinLayer.clearLayers();
    $("pr-title").textContent = "Where is this?";
    screen("where-play");
    whereQuestion();
  }
  function whereQuestion() {
    P.answered = false; P.turn = 0;
    // Coverage only (colors would hint at the answer): one repaint, and none if already gray.
    const was = state.grayMap && !state.piles;
    state.selected = null; state.compare = null; state.preview = null; state.piles = null; state.grayMap = true;
    if (!was) { recolor(); drawLabels(); }
    pinLayer.clearLayers();
    nbLayer.clearLayers();
    showNeighbors(null);
    showPhoto();
    $("pr-strip").hidden = true;
    $("pr-photo").className = "pr-photo";
    $("pr-feedback").textContent = "";
    $("pr-feedback").className = "pr-feedback";
    $("pr-hint").textContent = "Click the map where you think this is. Arrows turn the view; hold Shift for all four directions.";
    $("pr-map-note").textContent = "Gray: all coverage";
    map.getContainer().classList.add("locating");
    requestAnimationFrame(() => requestAnimationFrame(worldView));
    renderDots();
    for (const n of P.round.photos.slice(P.q + 1, P.q + 3)) fetchThumb(photoUrl(n));
    { const p = P.round.photos[P.q]; warmPeek(p.pano, p.heading); }                 // its Shift views
  }
  function guess(latlng) {
    if (!P.round || P.round.kind !== "where" || P.answered || root.dataset.view !== "where-play" || !G) return;
    const p = P.round.photos[P.q];
    const g = { lat: latlng.lat, lng: ((latlng.lng + 540) % 360) - 180 };
    const km = haversineKm([g.lat, g.lng], [p.lat, p.lng]);
    const nbs = neighborsOf(p);
    const look = lookPoint(nbs);
    const lookKm = haversineKm([look.lat, look.lng], [p.lat, p.lng]);
    const a = { p, guess: g, km, points: score(km), nbs, look, lookKm, lookPoints: score(lookKm) };
    a.ok = a.points >= 2500;
    P.answered = true; P.answeredAt = performance.now();
    map.getContainer().classList.remove("locating");
    P.round.answers[P.q] = a;
    drawGuesses([a], true);
    fitGuesses([a], true);
    feedback(a.ok, `${a.points.toLocaleString()} points`, ` · ${Math.round(km).toLocaleString()} km off · the look pointed ${Math.round(lookKm).toLocaleString()} km off (${a.lookPoints.toLocaleString()})`, true);
    $("pr-hint").textContent = "Red: the 100 photos that look most like it (hover a dot for its photo). Diamond: where the look points. Space for the next one.";
    $("pr-map-note").textContent = "Red: its closest look-alikes · white ring: the photo · white dot: your guess";
    // The closest look-alikes, under the photo.
    const strip = $("pr-strip");
    strip.textContent = "";
    const items = [];
    nbs.slice(0, 8).forEach((n, r) => {
      const cell = el("div", "pr-strip-cell");
      strip.append(cell);
      panoAt(n.i).then((row) => {
        if (!row) return;
        const item = { pano: row[0], heading: row[1], lat: n.lat, lng: n.lng, meta: state.metas.get(state.ids[n.i]) || p.meta };
        items[r] = item;
        cell.append(img([thumb(row[0], row[1], 320, 200)], { standIn: { lat: n.lat, lng: n.lng, heading: row[1], w: 320, h: 200 } }),
          el("span", "", `${Math.round(haversineKm([n.lat, n.lng], [p.lat, p.lng])).toLocaleString()} km`));
        cell.addEventListener("click", () => openViewer(items.filter(Boolean), items.filter(Boolean).indexOf(item)));
      });
    });
    strip.prepend(el("div", "pr-strip-cap", "Looks most like it"));
    strip.hidden = false;
    renderDots();
  }
  function whereSummary() {
    const r = P.round;
    screen("where-summary");
    map.getContainer().classList.remove("locating");
    state.grayMap = true;
    recolor();
    const done = r.answers.filter(Boolean);
    drawGuesses(done, false);
    $("pr-map-note").textContent = "White ring: the photos · white dot: your guesses · diamond: where each look pointed";
    requestAnimationFrame(() => requestAnimationFrame(() => fitGuesses(done, false)));
    const box = $("pr-summary");
    box.textContent = "";
    box.scrollTop = 0;
    const total = done.reduce((s, a) => s + a.points, 0);
    const lookTotal = done.reduce((s, a) => s + a.lookPoints, 0);
    const head = el("div", "pr-sum-head");
    head.append(el("div", "pr-score", total.toLocaleString()),
      el("div", "pr-sum-line", `of ${(5000 * done.length).toLocaleString()} · following the look alone: ${lookTotal.toLocaleString()}`));
    const actions = el("div", "pr-sum-actions");
    box.append(head, actions);
    const act = (label, cls, tip, fn) => { const b = el("button", cls, label); b.type = "button"; b.title = tip; b.addEventListener("click", fn); actions.append(b); };
    act("Next round (Space)", "pr-primary", "Five new locations", () => nextRound());
    act("Sort rounds", "", "Back to sorting photos into piles", () => setMode("sort"));
    // One row per photo, in play order; hover one to see its look-alikes again.
    for (const a of done) {
      const row = el("div", "pr-where-row");
      const ph = el("div", "pr-conf-ph");
      ph.append(img([thumb(a.p.pano, a.p.heading, 400, 250)], { standIn: { lat: a.p.lat, lng: a.p.lng, heading: a.p.heading, w: 400, h: 250 } }));
      ph.addEventListener("click", () => openViewer(done.map((x) => x.p), done.indexOf(a)));
      const lab = el("div", "pr-where-lab");
      lab.append(el("b", a.ok ? "ok" : "miss", `${a.points.toLocaleString()} points · ${Math.round(a.km).toLocaleString()} km off`),
        el("small", "", `The look pointed ${Math.round(a.lookKm).toLocaleString()} km off (${a.lookPoints.toLocaleString()})`));
      if (a.p.meta && a.p.meta.id) {
        const name = el("button", "pr-link");
        name.type = "button";
        name.append(el("span", "", a.p.meta.name));
        name.title = "Its meta, with its look-alikes, in Explore";
        name.addEventListener("click", () => openPage(a.p.meta.id));
        lab.append(name);
      }
      row.append(ph, lab);
      row.addEventListener("mouseenter", () => drawGuesses([a], true));
      row.addEventListener("mouseleave", () => drawGuesses(done, false));
      box.append(row);
    }
    P.next = makeWhere();
    P.next.then((n) => warm(n.photos.slice(0, 2).map((p) => photoUrl(p))));
  }

  // ----- flow -----
  function nextRound() {
    if (P.mode === "sort") startSort(P.next || makeSort(P.focus));
    else startWhere(P.next || makeWhere());
  }
  function sameAgain() { if (P.round && P.round.kind === "sort") startSort(makeSort(P.round.target.id)); }
  function openPage(id) { const level = state.level; close(); metaPage.open(level, id); }
  function setMode(mode, { metas = null } = {}) {
    P.mode = mode;
    try { localStorage.setItem("meta-map-practice-mode", mode); } catch (_) { /* */ }
    for (const b of $("pr-mode").children) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
    P.next = null; P.round = null;
    map.getContainer().classList.remove("locating");
    state.grayMap = false;
    $("pr-title").textContent = "Getting photos…";
    $("pr-dots").textContent = ""; $("pr-count").textContent = "";
    if (mode === "sort") startSort(makeSort(P.focus));
    else startWhere(makeWhere());
  }
  function open({ focus = null, mode = null } = {}) {
    if (train.on) stopTraining();
    explore.close();
    metaPage.close();
    if (!$("home").hidden) hideHome();
    if (!$("viewer").hidden) closeViewer();
    setTools(false);
    P.focus = focus;
    P.open = true;
    root.hidden = false;
    document.body.classList.add("practicing");
    root.style.setProperty("--pr-topbar", `${document.querySelector(".topbar").offsetWidth + 12}px`);
    syncNav();
    $("pr-piles").textContent = "";
    $("pr-photo").querySelectorAll("img").forEach((x) => x.remove());
    setMode(focus ? "sort" : mode || P.mode);
  }
  function close() {
    if (!P.open) return;
    clearTimeout(P.timer); clearTimeout(P.viewTimer);
    P.open = false; P.round = null; P.next = null; P.pins = [];
    root.hidden = true;
    document.body.classList.remove("practicing");
    syncNav();
    map.getContainer().classList.remove("locating");
    pinLayer.clearLayers();
    nbLayer.clearLayers();
    showNeighbors(null);
    state.piles = null; state.grayMap = false;
    releaseMap();
    recolor();
    drawLabels();
  }
  function onLevel() { if (P.open) { P.focus = null; setMode(P.mode); } }
  // Map <-> Space under a screen that shows the map: pins follow once the dots have landed.
  function onView() {
    if (!P.open) return;
    pinLayer.clearLayers();
    clearTimeout(P.viewTimer);
    P.viewTimer = setTimeout(() => { if (P.round && root.dataset.view !== "where-play") { frame(P.round.set); drawPins(); } }, MORPH_MS + 80);
  }
  function key(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    if (e.key === "Escape" || e.key === "t") { close(); return true; }
    const view = root.dataset.view;
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (view === "sort-intro") play();
      // A Space within a moment of answering is GeoGuessr muscle memory (click the map, then Space to
      // confirm), not a wish to skip the reveal: ignore it.
      else if (view === "sort-play" || view === "where-play") { if (P.answered && performance.now() - (P.answeredAt || 0) > REVEAL_GRACE_MS) next(); }
      else nextRound();
      return true;
    }
    if (view === "sort-play" && /^[1-4]$/.test(e.key)) { answer(Number(e.key) - 1); return true; }
    if (view === "sort-summary" && e.key === "r") { sameAgain(); return true; }
    if ((view === "sort-play" || view === "where-play") && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      turnTo(P.turn + (e.key === "ArrowRight" ? 90 : -90)); return true;
    }
    if (e.key === "g") { setMode(P.mode === "sort" ? "where" : "sort"); return true; }
    if (/^[1-9]$/.test(e.key)) return false;            // level keys
    if (e.key === "m" || e.key === "s") return P.mode === "where";      // Where needs the world map
    return e.key !== "e";
  }
  map.on("click", (e) => { if (P.open && P.mode === "where") guess(e.latlng); });

  $("pr-turn").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) turnTo(Number(b.dataset.t)); });
  $("pr-photo").addEventListener("click", () => { if (P.answered) next(); });
  $("pr-exit").addEventListener("click", close);
  $("pr-mode").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b && b.dataset.mode !== P.mode) setMode(b.dataset.mode); });
  // While a Where question is open the map must not name or show what is under the cursor.
  const blindMap = () => P.open && root.dataset.view === "where-play" && !P.answered;
  const allowsSpace = () => !(P.open && P.mode === "where");          // placing needs the world map
  // A question is on screen and not answered yet: Street View would give the answer away.
  const questionOpen = () => P.open && (root.dataset.view === "sort-play" || root.dataset.view === "where-play") && !P.answered;
  return { open, close, onLevel, onView, key, blindMap, allowsSpace, questionOpen, isOpen: () => P.open };
})();
