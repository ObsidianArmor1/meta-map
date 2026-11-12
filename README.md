# Meta Map

**What it is for: exploring GeoGuessr metas and learning to recognize them.** Each meta is a look
shared by many places, found by clustering 2 million Street View locations by how they look. For
any meta the site shows what it looks like and what to look for, where it occurs, and what it is
confused with; then it lets you practice recognizing it (Practice on a meta's page, or Train for
all). The Space view and the Tools (color by place/look, linked view) are secondary: for
understanding how the metas relate and checking the clustering.
Open with `Open Meta Map.command` in the Geoguessr folder (serves this folder on 127.0.0.1:8793).

## How the metas are made

1. `pipeline/build_graph.py <work>`: 20 nearest visual neighbors per pano from the exact
   top-500 C-RADIOv4-H table, skipping neighbors within 3 km (same road / capture run).
2. `pipeline/cluster.py <work> <gamma>...`: Leiden (RB configuration, weighted) per resolution.
   Memberships for every run so far are in `pipeline/clusters/`.
3. `pipeline/aggregate.py <work> . 1:broad 10:regional 30:local 100:fine 300:micro`:
   writes `data/<level>/metas.json`: per-meta stats, 16 exemplars, urbanity mix and tag (relative
   to the meta's own countries), closest metas (where its visual links go when they leave), and
   overlaps with every other level (the lineage chips). `<work>` must hold `knn_graph.npz`,
   `clusters_g<gamma>.npy`, `headings.npy` and `cells_r5.npy`.
4. `pipeline/points.py <work> . <same levels>`: one dot per pano. `data/points/xy.f32` holds
   Web-Mercator positions in spatial order, `data/<level>/ids.u16` the meta of each dot, and
   `data/points/p/<k>.json` the pano ids (loaded on hover, 4,096 per file).
5. `pipeline/colors.py <work> . <same levels>`: colors every meta by its visual centroid
   (256-D projected C-RADIO from `final/geo-visual-sidecar-v1`), one PCA across all levels with
   equalised hues, so similar-looking metas share hues and colors stay stable across levels.
8. `pipeline/quiz.py <work> .`: `data/<level>/quiz.json`, the trainer's question panos. For each
   meta, up to 24 members (30 km+ apart, never gallery exemplars) that are clearly closer to their
   own meta's centroid than to any of its three closest look-alikes (top 40% of the meta's
   margins). About 10-13% of a meta's members are borderline (a look-alike fits them better), so
   random members made roughly a third of questions unfair. About 2.5 minutes for all levels.
7. `pipeline/distinct_colors.py . --write`: `data/<level>/colors.json`, the look colors adjusted
   for the map. Metas that border each other (sharing ~80 km neighborhoods, or cells in Space,
   without mixing through the same ~20 km cells) are pushed apart; metas that interleave are
   pulled gently together so mixed regions such as central Europe read calmly instead of as
   confetti; a spring holds each meta near its look color and chroma stays at 90% or more of the
   original. At micro: bordering pairs' weighted median dE 0.093 -> 0.161, interleaved pairs
   0.120 -> 0.104, median shift 0.04. The site uses these by default; `c` flips to the raw look
   colors (remembered). Pushing all neighbors apart, including interleaved ones, was tried
   first: borders improved but central Europe became confetti.
6. `pipeline/layout.py <work> .` (needs umap-learn): the Space view. UMAP on the same 3 km-excluded
   neighbor graph (15 columns, cosine distance), initialised from a PCA of the projected
   embeddings; about 5 minutes for 2M panos. Writes `data/points/space.f32` in dot order.
   umap-learn is not in the system Python; a venv created with `--system-site-packages` plus
   `pip install --no-deps umap-learn pynndescent` works without touching the system packages.

**Levels (since 2026-11-11):** four nested levels from the split study (`SPLIT_STUDY.md`, scripts in
`pipeline/split/`). Each level sits inside the one above.

| Level (data id) | Count | What it is | Membership file in `<work>` |
| --- | --- | --- | --- |
| Region (`region`) | 40 | big areas that look alike: the place-aware tree (merge the look pair that loses the fewest points) cut at 40 | `clusters_gR40.npy` |
| Sub-region (`subregion`) | 141 | the same tree, cut where a split is worth about half a point per round | `clusters_gS141.npy` |
| Scene (`scene`) | 558 | the kinds of road in each sub-region (town streets, highways, rural roads, unpaved roads, plus boat views), assigned per look family from SigLIP road probes; big ones split once more by look | `clusters_gSCN.npy` |
| Look (`micro`) | 4,272 | the Leiden γ300 looks: the 4,229 with 150+ locations (same ids, names and practice data as before), plus 43 small but self-contained ones (ids 4230-4272) | `clusters_g300s.npy` |

**Small looks.** The old rule hid every group under 150 locations. That also hid some of the most
distinctive roads in the corpus. One example is a western Omani dune road: 76 locations, its own island
in Space, and 96% of its look-alikes inside it, against 55% for a typical look. Remote roads get few
locations in a corpus spread for coverage. So small groups are now judged by how self-contained they
are, not only by size.
- Any Leiden γ300 group with 30-149 locations is shown if at least 70% of its members' visual-neighbor
  links stay inside it. That is 44 groups; one, a mix of indoor museum shots, was left out after looking
  at photos of all 44.
- `pipeline/split/small_looks.py` lists them (`results/small_looks.json`) and makes contact sheets.
- `clusters_g300s.npy` keeps those 43 plus every 150+ group; every other small group's locations get an
  id each, so they stay hidden.
- Build with `META_MIN=30` (aggregate, points, colors and typical read it; the default stays 150).
- Their names were written from the contact sheets and are marked `sure: low`.

Build them with the scripts above, using `META_MIN=30` and `R40:region S141:subregion SCN:scene 300s:micro`
as the levels (quiz.py and distinct_colors.py take `region subregion scene micro`). Region and sub-region names are
still to come (the site shows countries plus a note on their biggest looks). Scene names are generated
("Town streets: Poland · …") by `pipeline/split/site_labels.py`; copy `data/{region,subregion,scene}/labels.json`
from its output. The Look level keeps the data id `micro` so saved practice progress (stored per level id)
carries over.

The old levels (Leiden γ1 broad 38, γ10 regional 205, γ30 local 539, γ100 fine 1,541, γ300 micro 4,229)
were independent look-only runs. Their data is backed up in `Geoguessr/meta-map-old-levels-2026-11-11/`;
`data/{broad,regional,local,fine}` are left on disk but no longer listed in `data/levels.json`.

9. `pipeline/typical.py <work> . <same levels>`: `data/<level>/typical.json`, picks 17-64 of each
   meta's typical photos by aggregate.py's rule (its visual hubs, the members most often chosen as
   a nearest neighbor by other members, in that order, each over 40 km from those already chosen),
   as dot indices with their country. The meta page shows these after the 16 examples, before any
   random members. Checks that its first 16 match metas.json. About 3 minutes for all levels.
   Compact metas (one road) can have fewer than 64.
10. `nice -n 19 python3 -I pipeline/spread.py <work> . [levels]`: the full page's **Range** and
   **Edges** tabs. Typical photos are all from a meta's center, and practice questions come from its
   clearest members (quiz.py), but a real round is a random member. Range splits each meta's members
   by look into up to 18 sub-groups (spherical k-means on `visual256.i8.npy`; k = √size / 2,
   3 to 18; sub-groups under 1% dropped) and keeps the photo nearest each sub-group's middle, with its share;
   every member's sub-group goes to `data/<level>/range.u8` (dot order, 255 = none) so hovering a
   photo lights where that kind of look is. Edges are members that look nearly as much like one of
   the 4 closest look-alikes as like their own meta (lowest margin of own-centroid cos minus
   look-alike-centroid cos, among members above their meta's 20th percentile of own cos so strays
   stay out; 30 km apart; at most 8 per look-alike; up to 24), each paired with the look-alike's
   member that looks most like it. Writes `data/<level>/spread.json`. About 2 minutes per level.

## How the metas are named

Every meta has a name, a one-sentence note on what to look for, a kind (`place`, `capture` or
`mixed`) and a confidence, in `data/<level>/labels.json`. The site falls back to countries plus
urbanity for any meta without one. Names were made top-down (broad, then each finer level with
its parent's name as context) by vision labellers reading contact sheets, using these steps:

1. `pipeline/text_space.py <work>`: every pano's C-RADIO summary through the official SigLIP2-g
   adaptor, the same transform as the Lodestar text search (`<work>/siglip2m.f16.npy`, 6 GB,
   about 3 minutes on this Mac).
2. `pipeline/describe.py <work> . <gamma:level>...`: scores the traits in
   `pipeline/vocabulary.json` for every meta, relative to its parent and to the corpus, in
   per-pano standard deviations (`<work>/describe.json`). These are hints only.
3. `pipeline/sheets.py <work> . <levels>`: contact sheets, eight metas per sheet and six typical
   panos per meta, with siblings (same parent) kept together and separated by yellow lines.
4. `pipeline/label_batches.py <work> . <level> <sheets per batch>`: one brief per labeller with
   the rules, the sheets, and per-meta countries, urbanity, parent name and trait hints.
5. `pipeline/merge_labels.py <work> . <level>`: merges labeller output into `labels.json` and
   reports gaps, over-long names and siblings that share a name.

If the clustering is re-run, meta ids change and the labels must be redone.

## Using it

The site has three places, named the same and in the same order on the home screen and in the top
bar: **Explore** (the meta list and pages), **Map** (every pano as a dot in its meta's color) and
**Practice** (the trainer). The top bar holds those three, then **Level** (a menu: each level with
its one-line hint, keys `1`-`5`) and **Tools**. Before this the bar mixed places, views and settings
in one row (Explore | Map | Space, five level buttons, Train) and home named different things
(Practice vs Train, Space but no Map).

**Highlight countries** (the box under World | Space on the map): type a country and press Enter.
One country keeps its locations in their meta colors and dims everything else; up to four get one
color each (blue, amber, magenta, lime), so in Space you see which regions of look-space each fills
and whether they overlap. Labels in Space then name only the looks with at least a quarter of their
locations in those countries. Chips show each country's location count; click one to remove it,
Esc on the empty box clears all. Uses `data/points/cc.u8`, loaded on first use.

The map has two views of the same dots, switched by **World | Space** on the map itself, top right
(or `m` / `s`); the switch travels with the map into the practice screens. World places each pano where
it is; Space places it next to the panos that look most like it, so look-alike regions form
continents and distinctive metas show up as isolated islands. Switching animates every dot from
its place on the world map to its place in Space (about 1.7 s, in a frame that shows both), so you
can watch where each island comes from; switching again mid-flight reverses it. Meta names label
Space; **Names in Space** in Tools (or `l`) hides them, and the choice is remembered.
The site opens on a **home screen** (styled after the Blotto and Caption This home screens): the
wordmark, one line on what it is for, three tiles (Explore, Map, Practice), the level with a
hint ("205 looks, about country by country"), and "What is this?". The META MAP wordmark in the top
bar returns to it; links that point at a meta or the Space view skip it.

**Explore** (top bar, `e`, or the home tile) is a board of looks side by side (`explore.js`): one
column per meta, each a stack of its photos under its name, note and share, with a map beside the
board where each column's range shows in the column's color (hover a column to see only its range,
a photo to pin where it was taken; World | Space works there). What fills the board:

- **A country** (the start screen lists countries by coverage with their number of looks; or search
  "Poland"): its looks, largest share first, with exact shares and photos taken in that country
  (`data/points/cc.u8`, every dot's country, from `pipeline/countries.py`).
- **A spot on the board's map**: click anywhere for the looks around it (on the world map) or in that
  part of Space; the view stays and the spot is ringed.
- **A look and its look-alikes** (search a name, or Look-alikes on any column or on the map card).
- **Inside a look**: the finer looks it splits into, one level down, with ↑ back up.

Each column also has Practice (a sort round on it and its look-alikes). Six columns per page (`←` /
`→`), `Esc` back to the countries. Why columns: looks are learned by comparing them; a blind test
matched unseen photos to rows of pictures 41/48 times against 28/48 by name, and the sort piles
were the part of the site that worked. Two earlier versions went unused: a narrow side-panel list,
then a full-window catalog of every meta as a photo card with a page per meta (a copy is in the
session scratchpad, not in the repo): hundreds of near-identical road photos sorted by names that
do not carry the difference.

On the map, clicking a dot selects its meta (lit, the rest dimmed) and opens a slim bar under the
top bar: its name (click for the full page), level and number, countries, size, **Full page**,
Practice, ×, what to look for in one line, and the other metas around the click as chips. No
photos: the hover card shows the dot under the cursor and the full page shows big ones (an earlier
corner card with four small photos repeated both and covered the map).

**Full page** (`metapage.js`, `#meta/<level>/<id>`) is photo-first, after the userscript's V board:
a large grid of photos fills most of the window (2×2, 3×3 or 4×4, remembered; `←` / `→` page
through more: the 16 typical photos, up to 48 more by the same rule from `data/<level>/typical.json`,
then random members from across the range, tagged "random"), with tabs above it (`↑` / `↓`):
**Typical** (the meta's center); **Range** (one photo per sub-group of its looks, biggest first with
its share; hover lights that sub-group's dots in amber); **Edges** (pairs: a photo of this meta in a
blue frame that looks almost like a look-alike, beside that look-alike's closest photo in amber;
hover lights the look-alike; see `pipeline/spread.py`); **vs** each of its closest look-alikes (the grid split in half, this meta beside the
look-alike at the same size, both lit on the map); and **Inside** (the finer metas it splits into,
one big photo each; hover lights their dots in amber, click opens their page). A narrow column on
the left holds a small live map (hover a photo to pin it), the lineage, what to look for, Practice /
Show on map, the numbers (panos, countries, hold, location bits, urbanity, country shares). Clicking
a dot on the small map opens that dot's meta; the level menu jumps to the matching meta; Esc, V or
the "← Back to map" button (first in the bar, accent-colored, showing both keys) goes back to the map with
the meta selected. **V** opens it too, as in the userscript: from the map with a meta selected, or from
Explore for the column under the mouse. The first version laid the same content out as a
scrolling page of thumbnails, which were too small to learn from. The map is drawn only by its own
WebGL renderer plus a pin, which keeps it smooth in Firefox. Selected metas are framed clear of the card.

**Tools** holds
the extras, each with one line on what it is for (color by meta/place/look, the linked view,
names in Space, distinct colors, the Shift-hover sheet, keyboard shortcuts), so the default screen
stays calm.

Seeing how the two layouts correspond, from the big picture down to single photos:

- **Switching** Map/Space animates every dot between the two layouts (the big picture).
- **Color** in Tools (or `k` to cycle): meta, place or look. *Place* colors every dot by where
  it is on Earth (longitude one way, latitude the other); in the Space view that shows which
  islands come from where. *Look* colors every dot by where it sits in Space; on the map that
  shows which places look alike (Australia and South Africa come out the same blue). A miniature
  of the source layout in the same colors is the legend.
- **Shift + hover** on any pano, a map dot or any picture on the page (as in the trainer
  userscript): it fills nearly the whole window,
  in all four directions (ahead, right, behind, left). Pressing or releasing Shift updates it at
  once. Release to close.
- **Open in Google Street View**, as the userscript's board does: ⌘-click (Ctrl-click) or
  middle-click any photo or map dot opens that exact pano in Google Maps Street View in a new tab,
  facing the same way; so does a click while Shift holds the four-direction view open. Not on a
  practice question before you answer (it would give the answer away).
- **Option + hover**, in either view: a sheet of nine panos from under the cursor and what that patch
  is made of ("22,694 panos · Pacific Northwest conifer roads 40% · Sagebrush desert highways
  29% ..."). On the map they are nearby places; in Space, look-alike neighbors. `[` and `]`
  resize the area.
- **Linked view** in Tools (or `d`) adds the other layout as a corner inset with its own pan and zoom. Hover a dot
  in either for an amber ring on the same pano in the other; a lens (dashed circle) lights every
  pano under the cursor, white, in the other view. Swap makes the inset the main view; ⤢ enlarges
  it. It doubles as the legend for Place/Look coloring. (Two views side by side, plus the panel,
  left each too narrow to use.)

While training, the side panel hides with the **›** tab on its edge (or `p`).

The map is a dot-density map: every one of the ~2M panos is a dot in its meta's color (WebGL).
Overlapping metas interleave rather than competing for an area, dots follow the actual coverage,
and boundaries appear wherever the color changes. Zoomed out, where dots overlap each pixel shows
their average color (in linear light, opacity and saturation matched to plain dots) instead of
whichever dot was drawn last; from zoom 9, and whenever a meta is selected, searched or compared,
it draws plain dots. `b` flips to plain dots for comparison (`?paint=dots` starts that way).
Wider averaging was tried and dropped: smoother regions, but blotchy and less detailed.

- Hover a dot to see that exact pano; click to open its meta's card and see the metas "around here".
- In a meta, its dots stay lit and every other meta drops to a dark version of its own color, so
  the map keeps its shape and the switch to Space still shows where everything goes. Lineage chips jump to its match
  at other levels (keys 1-5 too), and the gallery opens a large viewer (arrow keys, Esc).
- Explore builds its groups as you scroll, so even the 4,229 micro metas keep the page light.
- Search filters both the list and the map by name, note or country (`red soil`, `kenya`, `#42`).
- **Tell apart from** on a meta's page: at the micro level, matching unseen panos to the right row
  of pictures succeeded 41/48 times in a blind test against 28/48 by name: the differences are
  visible but do not compress into words, so learn them there.
- **Compare on map** on a look-alike row: both metas on the map in cyan and amber, the share of one
  that has the other within 20 km, pairs of panos across their border (closest pairs, spread
  60 km apart, computed live from the dots), and their typical images side by side.
- The viewer turns each pano ahead / right / behind / left (up and down arrows): the embedding saw
  all four directions, so the clue is not always ahead. URLs like `#regional/46/13` reopen a compare.

## Training

**Practice** in the top bar (or `t`, the home tile, Practice on a meta's page or card) opens
**Practice** (`practice.js`) over the whole window, in one of two modes (**Sort | Guess** in its
bar, `g` switches, remembered).

**Sort.** A round takes a meta and its closest look-alikes as piles that stay on screen for the
whole round (three piles while the meta is new or shaky, four once its Leitner box reaches 2), and
shows about 16 fair photos one at a time. Press `1`-`4` or click a pile. A right answer moves on by
itself; a wrong one marks your pile red and the true pile green until Space. Each photo joins its
true pile's strip, so every pile fills with what that look really is. `←` / `→` turn the view;
Shift shows all four directions. Pick showed three photos and four fresh rows of three per
question, so each question took ~15 photos to read and its categories changed every time; fixed
piles let the categories build up over a round.

The map comes around the round, not during it (sorting stays photo-only, which the user preferred):

- **After** every round: the review sits next to the map, with each pile's range in its pile color
  (blue, amber, magenta, lime) and a pin where each photo was taken (red ring: missed; hover for the
  photo). Hover a pile or a confusion to see just those ranges and pins. Space starts the next
  round (spaced repetition, or the same meta when you came from its page), `R` repeats the piles,
  **Place these on the map** runs a Where round on them. World | Space on the map switches the review map.
- **Before**, only for a set you have never practiced: one screen with the piles' ranges, then
  Space to start. Not before every round: look-alike piles mostly cover the same ground (field-road
  piles all in Poland), so a map each time would cost a screen and tell little.

**Guess.** The learning loop of the in-game trainer, here: one location at a time (from 20,000
random locations), the map showing only gray coverage (no colors, no hover names), click where you
think it is. One click guesses: there is no timer, so GeoGuessr's place-then-confirm step would only add an input.
But a Space or Enter within 0.9 s of answering (GeoGuessr muscle memory: click, then Space) is ignored, so it cannot
skip the reveal; the same applies after a Sort answer. The reveal does not use metas: it shows the photo's own 100 closest look-alikes in
embedding space (exact C-RADIOv4-H top-500 neighbors, keeping the first 100 at least 3 km away so
they are similar places, not the same road) as red dots on the map, closest brightest (hover for
each photo), the 8 closest under the photo, and a diamond where the look points (the densest
similarity-weighted cluster of look-alikes), with what that click alone would have scored. Scores
use the GeoGuessr world curve, 5000 × exp(-km / 1492.7); five locations per round, ending on a map
of every photo, guess and look point (hover a row to see its look-alikes again). Following the look
alone scores near the maximum on most rounds: nearby capture runs make the closest look-alikes
regional even beyond 3 km. The look-alikes are drawn by the map's own WebGL renderer (its highlight pass, in red; hovering one
shows its photo in the normal hover card) and the gray coverage skips the Mix pass: as 100 Leaflet
canvas circles plus a dashed SVG line, Firefox took seconds per frame panning after the reveal,
stalling the whole machine (`?bench` in the URL runs `bench.js`, a draw and panning benchmark, to
compare browsers). The pool is `data/guess/` from `pipeline/guess_pool.py` (~12 MB, fetched
when Practice first opens). Guess replaced a Where mode that revealed a meta's whole range: rigid
metas are good for browsing, but a photo's own neighbors are sharper.

The old map trainer (`startTraining`: Pick, Place, Both, in the side panel) is still in `app.js`
but no longer has an entry point; Where replaced its Place mode.

Spaced repetition: each meta has a Leitner box per level, kept in this browser (`meta-map-train`
in localStorage); a meta you get wrong comes back within a few rounds, right answers push it
further out. Explore's cards show the record. When testing in a browser, save and restore that
key: it is the user's real progress.

## Panel numbers

- **Hold**: share of members' 20 visual neighbors (beyond 3 km) that are in the same meta.
- **Bits**: location information of the meta over res-3 cells, minus the same quantity
  for a random corpus subset of the same size (the null floor; see `data/levels.json`).
