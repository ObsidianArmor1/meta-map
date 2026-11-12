// Rendering benchmark, loaded only with ?bench in the URL (for comparing browsers).
// Times full map draws (with a pixel read-back, so GPU work counts) at several zooms and modes, then one
// Guess reveal, and prints the numbers in a box at the top left. Leaves nothing behind.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frameAfter = () => new Promise((r) => requestAnimationFrame(() => r()));
  const box = document.createElement("pre");
  box.style.cssText = "position:fixed;z-index:99999;top:90px;left:20px;margin:0;padding:14px 18px;background:#000e;color:#fff;font:15px/1.5 ui-monospace,monospace;border:2px solid #5aa9ff;border-radius:10px;white-space:pre";
  document.body.append(box);
  const lines = [];
  const log = (s) => { lines.push(s); box.textContent = lines.join("\n"); };
  while (!gpu.gl || !state.ids) await sleep(300);
  await sleep(1500);
  hideHome();
  const g = gpu.gl;
  const timeDraw = (n = 5) => {
    const ts = [];
    const px = new Uint8Array(4);
    for (let k = 0; k < n; k += 1) {
      const t = performance.now();
      draw();
      g.readPixels(0, 0, 1, 1, g.RGBA, g.UNSIGNED_BYTE, px);    // waits for the GPU (finish() may not)
      ts.push(performance.now() - t);
    }
    ts.sort((a, b) => a - b);
    return `${ts[Math.floor(n / 2)].toFixed(0)} ms`;
  };
  const ua = (navigator.userAgent.match(/(Firefox|Chrome)\/[\d.]+/) || ["?"])[0];
  log(`BENCH ${ua}  dpr ${devicePixelRatio}  map ${map.getSize().x}x${map.getSize().y}  canvas ${gpu.canvas.width}x${gpu.canvas.height}`);
  log(`renderer: ${(() => { const d = g.getExtension("WEBGL_debug_renderer_info"); return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : "n/a"; })()}`);
  const at = async (z, label) => { map.setView([48, 15], z, { animate: false }); await sleep(200); log(`${label.padEnd(34)} ${timeDraw()}`); };
  await at(2.5, "world, colors (Mix)");
  await at(6, "zoom 6 Europe, colors (Mix)");
  await at(8, "zoom 8, colors (Mix)");
  plainDots = true; await at(6, "zoom 6, colors, plain dots"); plainDots = false;
  state.grayMap = true; recolor();
  await at(2.5, "world, gray (Guess question)");
  await at(6, "zoom 6, gray (Guess reveal)");
  await at(8, "zoom 8, gray (Guess reveal)");
  state.grayMap = false; recolor();
  log("Guess: opening a round…");
  let savedMode = null;
  try { savedMode = localStorage.getItem("meta-map-practice-mode"); } catch (_) { /* */ }
  practice.open({ mode: "where" });
  await sleep(7000);
  let t = performance.now();
  map.fire("click", { latlng: L.latLng(45, 10), containerPoint: map.latLngToContainerPoint([45, 10]) });
  const sync = performance.now() - t;
  await frameAfter();
  log(`Guess click: handler ${sync.toFixed(0)} ms, to next frame ${(performance.now() - t).toFixed(0)} ms`);
  await sleep(1500);
  log(`Guess reveal redraw                 ${timeDraw()}`);
  // Panning cost with each part of the reveal removed in turn (a few frames each, capped).
  const pan = async (label) => {
    const fr = [];
    let last = performance.now();
    for (let k = 0; k < 4; k += 1) {
      map.panBy([k % 2 ? 25 : -25, 8], { animate: false });
      await frameAfter();
      const n = performance.now(); fr.push(n - last); last = n;
      if (n - last > 15000) break;
    }
    fr.sort((a, b) => a - b);
    log(`pan: ${label.padEnd(32)} median ${fr[Math.floor(fr.length / 2)].toFixed(0)} ms, worst ${fr[fr.length - 1].toFixed(0)} ms`);
  };
  const layersOf = (test) => { const out = []; map.eachLayer((l) => { if (test(l)) out.push(l); }); return out; };
  await pan("full reveal");
  for (const l of layersOf((l) => l instanceof L.Polyline && !(l instanceof L.CircleMarker))) map.removeLayer(l);
  await pan("without the dashed line");
  for (const l of layersOf((l) => l instanceof L.CircleMarker)) map.removeLayer(l);
  await pan("without line and red dots");
  for (const l of layersOf((l) => l instanceof L.Marker)) map.removeLayer(l);
  await pan("without line, dots, pins");
  practice.close();
  try { if (savedMode === null) localStorage.removeItem("meta-map-practice-mode"); else localStorage.setItem("meta-map-practice-mode", savedMode); } catch (_) { /* */ }
  await sleep(500);
  await pan("normal Map, no practice");
  log("done");
})();
