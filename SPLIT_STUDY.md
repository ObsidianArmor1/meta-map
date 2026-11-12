# How to split the metas: study notes

The question: what should a meta be, and how should the 2M corpus be split into them?

The working definition: a meta is "when an image looks like *this*, how much does that narrow things down?"
- **Useful** means how much it narrows things down, and how reliably you can tell the look apart.
- **Big** means how often it shows up.

There were four passes on 2026-11-10:
- a first look
- a time-boxed pass, 18:10–19:40: second-eye scoring, look families, nested levels, blind checks
  - Blind checks: 4 sets of family pair sheets (`blind`, `blind2`, `blind4`, `blind5`) plus 2 sets of sibling recognition sheets (`blind3`, `blind6`), every one judged before its key was opened.
- a third pass, 21:33–22:20: how much of the split's sharpness comes from using place, and what a look-first version costs (section "Is place doing the work?", blind sets `blind7`, `blind8`). The split is viewable in the preview site `Geoguessr/meta-map-split` (127.0.0.1:8794).
- a fourth pass, 22:52–23:40 (with a break for a restart): a **scene** level between sub-regions and looks (section "Scenes", blind sets `blind11`, `blind12`).

The scripts and results are in `pipeline/split/`.

## Recommended split

| Level | Count | What it is | Realized (C-RADIO / SigLIP vote) |
| --- | --- | --- | --- |
| Regions | 40 | look-regions: places that look alike and sit close together | 3,314 / 3,350 |
| Sub-regions | 141 | the same tree, cut where a split is worth about half a point per round | 3,668 / 3,712 |
| **Scenes** | 558 | the road kinds inside a sub-region: town streets, highways, rural roads, unpaved roads (plus 6 boat and odd-capture scenes); big ones split once more by look. Built from whole families, so weather twins never split. Named "Kind: countries", plus the biggest look's name where a sub-region has the same kind twice | 3,678 / 3,717 |
| Looks | 4,229 | today's micro metas; **labels kept** | 3,757 / 3,796 |

The main ladder is strictly nested: look ⊂ scene ⊂ sub-region ⊂ region.

**Look families** (2,373, provisional, `family_of_atom_v5.npy`; the same look in another sky, season or light, about 80–90% acceptable in blind checks) are now off the main ladder. They are used to build scenes (a family never splits across scenes) and kept as an optional "twins" view.

They replace broad/regional/fine/local, which were independent look-only clusterings. Relabeling is needed for about 40 regions and 141 sub-regions. Scenes have generated names (kind + countries) that are usable as they are.

Ready for the naming pass:
- `results/regions_40.json`: countries, share, points, value and SigLIP consistency per region.
- `results/subregions_141.json`: the same per sub-region, plus its six biggest member looks (micro ids and names).
- `results/family_value.json`: per family, with member micro ids.
- `results/region_sheets/regions_{1,2}.jpg`: one row per region, with 7 images from its sub-regions' biggest looks, artifact looks skipped (`region_sheets.py`). Boat and ferry looks are now tagged like the artifacts.

**The regions are stable structure, not artifacts of how the tree was built.** Normalized mutual information against the regions built from γ1000 atoms is .85, and against the μ = 0 tree it is .95. For sub-regions it is .81 and .91.

They follow countries more than today's levels do (NMI vs country .72, against .67 for broad/regional) without being countries.

**Costs and options:**
- **Siblings are harder to tell apart by eye** than today's: 71% vs 92% in a blind test (48 judgments each, p = .017). The new levels pay off in points by asking for harder distinctions. Two later rounds scored 40/48 (83%) on the same tree, so the combined rate is 77% (74/96); the judge (Claude) had seen many sheets by then, so part of that rise may be practice.
- **The tree uses place on purpose.** At the sub-region level its groups are less look-pure than look-only clusters (see "Is place doing the work?"). A look-first variant exists, and a blind test could not tell the two apart.
- **Finer leaves (γ1000 atoms)** would add about 55 points at the sub-region level, but every leaf would need relabeling.
- **The family level is provisional.** Its remaining errors are all road-class mixes.

## Yardsticks

- **Points if known.** Suppose you know a location's group and click that group's single best spot. This is the expected GeoGuessr score, on the world curve 5000·e^(−km/1492.7).
  - Members are binned to H3 res-3 cells; candidate clicks are res-2 centers.
  - Knowing nothing scores **917**.
- **Realized points.** A location is assigned to the group its 20 visual neighbors vote for (none within 3 km), and you click that group's best spot. This penalizes groups that can't be told apart.
- **Second eye (SigLIP vote).** The same vote, using neighbors from the SigLIP2-adaptor space.
  - Exact kNN over all 2M for an 8k random sample.
  - This space is C-RADIO's summary token through the SigLIP2-g head, without the spatial quadrants. It is not a separate model, but it is a different metric from the fused graph the clusters were built on.
- **Keff.** The effective number of groups, exp(size entropy). Lopsided splits must be compared by Keff, not by raw count.
- **Neighbor ceiling: 4,221.** Place every location at the medoid of its 20 neighbors, with no metas. This is what Guess mode does.

## Findings

**1. The current levels ignore place, and the upper ones leave hundreds of points on the table.**
- Broad has an 8.6% "tropical Latin America" meta (BR/MX/CO/PY/PA) that scores 1,374, and a 6.5% Southeast Asia meta that scores 1,503.

**2. A place-aware tree wins at every size, and the second eye agrees.**
- **Tree:** start from the micro looks and repeatedly merge the visually linked pair that costs the fewest points, with a small coherence tie-break (μ = 1000).
- **Nesting:** cut at 150 and fold sub-regions under 2,000 locations into their cheapest linked neighbor. Then replay the remaining merges at sub-region level down to 40.

| Split | Groups | Keff | C-RADIO vote (pts / agree) | SigLIP vote (pts / agree) |
| --- | --- | --- | --- | --- |
| current broad (γ1) | 39 | 28 | 2,723 / .99 | 2,737 / .96 |
| **place regions** | **40** | **34** | **3,318 / .96** | **3,350 / .92** |
| current regional (γ10) | 206 | 171 | 3,366 / .97 | 3,403 / .90 |
| current fine (γ30) | 545 | 463 | 3,502 / .96 | 3,546 / .84 |
| **place sub-regions** | **141** | **106** | **3,666 / .93** | **3,712 / .86** |
| current local (γ100) | 1,572 | 1,379 | 3,645 / .93 | 3,689 / .77 |
| look families (v5) | 2,373 | 1,443 | 3,719 / .90 (v3) | 3,760 / .75 |
| current micro (γ300) | 4,581 | 4,059 | 3,752 / .90 | 3,796 / .69 |
| countries | 161 | 80 | 3,601 / .85 | 3,637 / .87 |

(Scores are on the 8k sample. Full-corpus C-RADIO numbers agree within about 10 points.)

- **40 regions score about as well as today's 206; 141 sub-regions beat today's 1,572.** This holds under both eyes.
- **Being place-aware costs a little recognizability.** SigLIP agreement is .92 vs .96 at about 40 groups, and .86 vs .90 at 141 vs 206.
- **C-RADIO agreement was flattering everything, increasingly at finer levels.** For micro it reads .90 under C-RADIO but .69 under SigLIP.
- **The groups are look-regions.** For example:
  - Balkans/Turkey dry hills
  - Alpine–Central Europe
  - NW Europe
  - Nordic/Baltic
  - southern Africa
  - Brazil/Paraguay
  - mainland SE Asia
  - IL/JO/PS/LB
  - Gulf
- Similar looks far apart stay split. Those are the traps worth learning.

**3. Where to cut.**
- Following the merge sequence, the points lost per merge rise smoothly. There is no sharp knee, but there are two natural points:
  - **Merges stay nearly free down to about 500 groups** (under 0.02 points per merge). Below that, a meta stops telling you more about *where*, and finer splits only help recognition.
  - **The cost per merge peaks near 40 groups** (about 16 points per round per merge) and falls below that. Those 40 are the most valuable distinctions in the tree, so they are the regions.
- **Sub-regions sit where a split is worth about 0.5–1 point per round** (about 150, or 141 after folding). Fewer than about 180 location groups survive folding at any cut, so a place-level of 500 doesn't really exist.
- **Starting atoms matter.** The same tree built from coarser atoms scores worse:

| Atoms | Sub-regions | Regions |
| --- | --- | --- |
| γ300 | 3,668 | 3,314 |
| γ100 | 3,584 | 3,197 |
| γ30 | 3,479 | 3,212 |

- **γ1000 atoms (15,366)** help the sub-region level:
  - 3,730 realized and 3,766 SigLIP for 142 groups, vs 3,668 / 3,712 from γ300, at a small agreement cost (.845 vs .864).
  - Regions don't change (3,308 vs 3,314).
- **The gain comes from cutting looks along borders.** Only 82.5% of a γ300 look's members fall in its majority γ1000 sub-region. Mapping each γ300 look onto the γ1000 sub-regions throws the gain away (3,662).
- **So:** keep today's looks and labels and use the γ300 tree, or adopt finer leaves for about +55 points at the sub-region level and relabel them.
- **Coherence weight μ** (SigLIP pts / agreement at sub-regions):

| μ | Sub-regions | Regions (40) |
| --- | --- | --- |
| 0 | 3,729 / .84 | 3,344 |
| **1000** | **3,712 / .86** | **3,350** |
| 2000 | 3,663 / .88 (132 groups) | 3,253 (agreement .92, no better than μ=1000) |
| 3000 | 3,576 / .91, lopsided: only 111 groups, largest 9% | — |

- μ = 1000 is the balanced choice.
- At the region level, a higher μ only loses points.
- At the sub-region level, every +.02 of agreement costs about 50 points.

**4. Consistency, measured honestly.**
- SigLIP-vote self-agreement per region runs from .82 to .99, with a median of .92.
- The least consistent regions:
  - Guatemala/Mexico .82
  - Kazakhstan/Kyrgyzstan .83
  - Indonesia .85
  - Poland–Italy–Central Europe .85
- Sub-regions (110 with at least 20 sampled locations): p10 .74, median .87, p90 .96.
- The 8k sample is too small for per-look numbers. Human right/wrong rates from Sort and Guess remain the real test.
- **Blind sibling test by eye** (`results/blind3/`: 12 sheets, condition hidden). Each sheet shows two sibling groups with 5 reference images each and 4 test images to assign.
  - First round: place-tree siblings **18/24**, today's γ10 siblings **22/24**.
  - Repeated with 12 fresh sheets (`blind_siblings2.py`, `results/blind6/`): **16/24** vs **22/24**.
  - **Combined: 34/48 (71%) vs 44/48 (92%)**, Fisher p = .017. The gap is real.
  - The misses cluster:
    - Mexican highland vs lowland sub-regions (failed in both rounds, 2/8 overall)
    - Thailand vs Vietnam/Cambodia rural
    - Turkish rural vs town sub-regions
    - Indian paddy vs scrub lanes
  - **No sibling split is cheap and confused at the same time.** Across all 242 sibling pairs, even the least valuable splits keep 0.6–0.9 points per round (median 2.7), and SigLIP cross-votes between any pair are at most about 6%.
  - So the hard pairs are separable in the image features, just subtle for a person working from 5 examples.
  - That argues for keeping them and teaching the difference, not merging.
  - **Seed for "how to tell apart" text** (`results/sibling_differences_demo.json`). I scored 3,000 images per sibling sub-region against 20 fixed SigLIP text probes and reported the largest standardized differences.
    - Some hits are right: Cambodian highways show "more red soil, flat plains, wooden houses" than Vietnamese avenues, and Cyprus/coastal Turkey shows more palms and olives than the interior.
    - Some are noise: "olive trees" turns up for Thailand.
    - It's usable as a draft for the naming pass, with a larger vocabulary and a human check, not as finished text.
  - The place-aware siblings split similar looks along geography: Mexican highland vs northern desert roads, Mongolian vs Russian steppe highways, Indian paddy lanes vs dry-scrub lanes.
  - Today's siblings split easy looks that often share a place: forest roads vs suburbs, towns vs highways.
- **That is the trade:** the new levels ask you to learn harder distinctions, because those are the ones worth points.
- **Where regions get mistaken for each other** (`results/region_confusions.json`, SigLIP vote): 8.1% of sampled locations vote for another region. The confusions are almost all between neighbors, so they cost few points. The top pairs:
  - NW Europe ↔ Central Europe
  - Central Europe ↔ Balkans
  - US/Canada south ↔ Canada/US north
  - Russia ↔ Kazakhstan/Kyrgyzstan
  - Iberia ↔ Balkans
  - Philippines ↔ Indonesia
  - Balkans ↔ Turkey/Georgia
  - Central Europe ↔ Nordic
- These are the region pages that most need a "how to tell them apart" section.
- The looks behind each confusion are listed in `results/region_confusion_looks.json`.
- **Weak spot: the "PL/IT/AT" Central Europe region.**
  - It shows up in 4 of the top 8 confusions.
  - It holds Italy's Mediterranean looks (stone-wall lanes, olive-grove lanes) next to Polish and Austrian ones.
  - Its six sub-regions:
    - Alpine CH/AT (consistency .89)
    - Italy (.89)
    - Slovenia/Austria forest lanes (.87)
    - Poland (.65)
    - Hungary/Croatia (.67)
    - Czechia/Slovakia (.55)
  - So Italy is already a clean sub-region. The real difficulty is the Central European plains (PL/CZ/SK/HU), which are genuinely hard to tell apart from each other.
  - That makes it the region most in need of a "how to tell apart" page, not necessarily a different cut.
- **For Explore,** a sub-region page should lead with "how it differs from its siblings" rather than "what it looks like".

**5. Bigness needs the family level.**
- Leiden at γ300 cuts common looks into equal pieces: micro shares are 0.02% at the median and 0.05% at p99.
- At the family level, shares spread to 0.03% at the median, about 0.10% at p90, and 0.26–0.34% at p99 (depending on the version), so "how common is this look" becomes readable.

**6. Look families: workable but imperfect.**
- **Labels from names.**
  - 109 "twin" pairs: the same country, mostly the same content words, differing in a sky/season/light word. Only 22 are strict, because the labelers named twins differently.
  - "Distinct" pairs: the same country, linked, no shared content word.
- **How well each signal separates them (AUC):** centroid cosine .81, link affinity .76, geographic overlap .60.
- **Learned condition subspace.** I took the top 16 directions of twin-pair centroid differences, cross-validated, and projected them out. Against hard negatives (distinct pairs with affinity ≥ .01), AUC rose from .59 to .72.
- **Method.** Average linkage on the projected centroids, merging only linked looks with the same dominant country, at θ = .95, then split by sub-region so the levels nest.
  - Held-out twin recall: .65.
  - Result: 1,781 families, or 2,082 after nesting.
- **Blind check.** 24 pair sheets, named by OS entropy and judged before opening the key:
  - **Family merges:** 11 of 15 acceptable (4 true twins, 7 same family), 4 wrong.
  - **Every wrong merge changed road class:** narrow/unlined vs lined roads, alleys vs town roads, hedge lanes vs open field roads.
  - **The name-based "distinct" labels are unreliable:** 4 of the 9 merges the names called distinct are true twins by eye.
  - **Recall is short:** 3 of the 5 kept-apart controls should have merged, for example pine-lined gravel roads vs clear-cut gravel roads.
- **Road class from Vali tags** (OSM HighwayType + surface, joined by pano ID, 47.5% of locations) separates the bad merges only weakly. Median road-class overlap is .88 for wrong merges vs .97 for twins. OSM classes are too coarse for "narrow lane vs lined two-lane".
- **Road probes in SigLIP text space work better.** Each probe scores a look by its mean x·(t_A − t_B) over members, z-scored:
  - lane lines vs no markings
  - wide two-lane vs single-track
  - paved vs dirt
- On the first blind set, a veto at a family-mean gap > 0.9 would catch all 6 wrong pairs while blocking 4 of the 18 acceptable ones. That was tuned on this set, so it was re-tested on a fresh one.
- **Families v2 (with the veto):**
  - 1,622 families (2,280 after nesting)
  - held-out twin recall .64 (vs .65 without the veto)
  - SigLIP 3,760 / C-RADIO 3,720
  - shares 0.03% (median) → 0.29% (p99)
- **Fresh blind set** (24 new pairs, new OS-entropy names, judged before the key):
  - v2 merges: 11 of 14 acceptable (5 twins, 6 family), 3 wrong.
  - Merges the veto blocked: 5 wrong, 5 fine. The veto is enriched for bad merges (50% vs about 25% overall), but it's a modest gain.
- **The remaining wrong merges are still road class:** suburban streets vs lined arterials, unlined wheatbelt roads vs lined highways. Two of them show almost no probe gap, because mean text scores per look are too blunt for lane markings.
- (v2 was then capped (v3) and given an artifact exclusion (v5). **v5 is the provisional family level:** `results/family_of_atom_v5.npy`.)

**7. Usefulness × bigness at the family level** (`results/family_value.json`). value = share × (points − 917), in points per round.
- **Value is concentrated:** on v5, 330 of 2,021 families hold 50% of the total and 893 hold 80%. That is a natural learning order. (The lists below were first computed on v2.)
- **Top families by value:**
  - Yellow-line NZ state highways: 17.0
  - Sunny tree-row field lanes (NW Europe): 12.0
  - NZ flush-median town roads: 11.7
  - Sunlit concrete house lanes (PH): 11.5
  - Polish gray-sky village roads: 11.4
- **Big but weak:**
  - trolleybus avenues and panel-block yards (RU/UA/KZ), about 2,400 pts
  - cut-bank mountain tracks (CO/EC), 2,560
  - cerrado red tracks (BR), 2,590
- **Small but sharp:**
  - limestone apartment blocks (IL/JO), 4,860
  - Ghana white-edged bonnet roads, 4,730
  - yellow-line altiplano two-lanes, 4,680
- **The largest family (28 looks, NZ highways) shows small countries still partly chain together.**
  - A cap of 16 looks per family costs little: held-out twin recall drops from .64 to .61, while a cap of 10 drops it to .57.
  - The capped version (`results/family_of_atom_v3.npy`, 2,306 families after nesting) is superseded by v5, which also keeps artifact looks apart (see "Still open").
  - The top-value list is unchanged apart from the split NZ family: 330 families hold 50% of the value on v5.

**8. Learning curve over sub-regions** (`results/learning_curve_subregions.json`).
- Suppose you learn sub-regions one at a time, best marginal gain first. A location in an unlearned sub-region gets the best click for "none of the ones I know".
- Expected points per round as you learn:

| Sub-regions learned | Points per round |
| --- | --- |
| 0 | 917 |
| 5 | 1,248 |
| 10 | 1,488 |
| 20 | 1,888 |
| 40 | 2,516 |
| 70 | 3,096 |
| 100 | 3,437 |
| all 141 | 3,652 |

- Returns diminish only slowly, so Explore can present sub-regions as a "learn next" ladder.
- **The ladder starts far from the default guess** (`results/learning_ladder_top12.json`). The "none of the above" click sits in Europe, so the first rungs are distinctive places far from it:
  1. Thailand/Vietnam villages
  2. Japan
  3. New Zealand towns
  4. Malaysia estates
  5. Philippines
  6. Australian motorways
  7. Kenya
  8. Andean highways
  9. Israel/Jordan
  10. rural Korea
- Europe's many sub-regions come later, because a European guess is already close.
- **Per meta learned, the new split pays far more.** The same ladder over today's 206 regional metas (γ10):

| Metas learned | New sub-regions | Today's regional |
| --- | --- | --- |
| 10 | 1,488 | 1,277 |
| 20 | 1,888 | 1,568 |
| 40 | 2,516 | 2,023 |
| 70 | 3,096 | 2,550 |
| 100 | 3,437 | 2,914 |
| 141 | 3,652 | 3,218 |

- That is +200 to +550 points per round for the same learning effort, in meta count.

**9. Shares are corpus shares, not in-game frequency.** The corpus was balanced for reference density, so "big" should eventually be weighted toward play relevance.

## Is place doing the work? (third pass)

**The concern:** the new levels look much sharper than the old ones on the map. Part of that is by design: the merge rule scores points, which depend on where locations are. Two groups in the same place merge at almost no point cost, whether or not they look alike. So how much of the sharpness is place, and what would a look-first version cost?

**Look purity** is the share of visual-neighbor links that stay inside the group. Size-weighted per meta, from the site's `metas.json`:

| Old level | Purity | New level | Purity |
| --- | --- | --- | --- |
| Broad (38) | .928 | Region (40) | .876 |
| Regional (205) | .841 | Sub-region (141) | .799 |
| Fine (1,541) | .681 | Family (2,021) | .658 |

Sub-regions are less pure than Regional despite having fewer groups (fewer groups normally means *higher* purity). They also carry slightly more location information (5.28 vs 5.24 bits).

**The frontier** (`frontier.py` → `results/frontier.json`, `frontier_res.json`). Purity here is over all links; points are the SigLIP vote on the 8k sample.

| Split | Keff | Largest | Purity | SigLIP pts |
| --- | --- | --- | --- | --- |
| Leiden γ1 | 27.7 | 8.6% | .929 | 2,737 |
| Leiden γ3 | 70.8 | 2.8% | .888 | 3,153 |
| Leiden γ10 | 171 | 1.4% | .841 | 3,403 |
| Tree μ10000, sub-regions (no size term) | 27.4 | 20% | .917 | 3,218 |
| Tree μ5000, sub-regions (no size term) | 46.4 | 15% | .883 | 3,439 |
| **Tree μ1000, sub-regions (current)** | 106 | 3.9% | .799 | **3,712** |
| Tree μ3000 r10, sub-regions | 116 | 2.0% | .814 | 3,674 |
| Tree μ3000 r3, sub-regions | 92 | 2.6% | .830 | 3,646 |
| Tree μ5000 r10, sub-regions | 116 | 2.0% | .826 | 3,620 |
| Tree μ10000 r10, sub-regions (**look-first**) | 108 | 2.1% | .838 | 3,541 |
| Tree μ10000 r10, sub-regions inside the current regions | 115 | 2.0% | .825 | 3,597 |
| **Tree μ1000, regions (current)** | 34.1 | 6.2% | .876 | **3,350** |
| Tree μ3000 r3, regions | 34.4 | 7.7% | .883 | 3,282 |
| Tree μ10000 r10, regions (look-first) | 36.7 | 8.2% | .877 | 3,054 |

`r` is the resolution of a modularity null term added to the coherence gain (`merge_mod.py`). Without it, the coherence gain is a raw link count that rewards merging big groups, so pure trees grow giants of 15–20%.

**What it shows:**
1. **Most of the gain is not bought with purity.** At the same Keff (27) and nearly the same purity (.917 vs .929), the tree beats Leiden γ1 by 481 points. At purity .883–.888 it beats Leiden γ3 by 286 points with fewer effective groups. Knowing where groups sit mainly helps choose *which* look-alike groups to merge.
2. **The current tree does spend some purity at the sub-region level.** Leiden at the same Keff would have purity of about .865 (interpolated between γ3 and γ10), at about 3,240 points. Along the tree's own curve, each .001 of purity costs about 2.5–4 points.
3. **At the region level there is nothing to buy.** Look-first regions are no purer (.877 vs .876) and score 296 points less.
4. **People can't see the difference** (blind sets `blind7`, `blind8`: 24 sheets, conditions hidden, pair ids recorded in the keys this time): current sub-region siblings 40/48, look-first 42/48 (Fisher p = .77).
5. **The practice-question margin favors look-first.** 80% of a look-first sub-region's members sit closer to their own centroid than to any look-alike, against 71% for the current ones (`quiz.py`). Practice questions would be a little cleaner.
6. **Building look-first sub-regions inside the current regions doesn't help:** .825 / 3,597, just below the μ5000 r10 point.
7. **Capture differences are a separate, smaller issue, and the same in both trees** (`capture_share.py` → `results/capture_share.json`, using the micro labels' `kind`).
   - 7 sub-regions (about 3% of locations) are mostly capture or mixed looks.
   - 26 of 242 sibling pairs (27 of 258 look-first) differ mainly in capture share.
   - In the blind sheets these were: car visible in frame (Brazil, Botswana), and Nepal's smeared older camera vs Bhutan.
   - They're real GeoGuessr clues, but about the camera, not the place, and they can change when coverage is updated.

8. **The points lead is not circular** (`merge_half.py`, `holdout.py` → `results/holdout.json`).
   - Locations were split into two random halves by res-5 cell.
   - A tree was built seeing only the first half (μ 500, which equals μ1000 at half the counts). Each group's best click was learned on that half, and points were scored on the unseen half.
   - Sub-regions (142): 3,681 learned vs 3,648 held out. Regions (40): 3,296 vs 3,302.
   - Leiden γ10: 3,370 vs 3,348. Leiden γ1: 2,700 vs 2,704.
   - Fitting and scoring on the same data inflates the tree by about 1% at most. Its lead over look-only clusters (about +300 with fewer groups at the sub-region level, about +600 at the region level) holds on unseen locations.
   - Caveat: small-group folding in `nested.py` still uses all locations. It only touches groups under 2,000 locations.

**Decision:** keep the current tree (μ1000) at both levels. The extra purity isn't visible to a person, and it costs 170 points per round at the sub-region level. The look-first variant is in the preview site as "Region · look-first" / "Sub-region · look-first" (keys 3–4) so it can be judged in real use. If real use favors it, the compromise is μ5000 r10: −92 points for +.027 purity.

## Scenes (fourth pass)

**The problem:** below sub-regions the old ladder jumped from 141 groups to 2,021 families (look twins, a rule you can't see from the site) and then 4,229 looks. Nothing said "what kinds of places are inside this sub-region".

**Place is used up by then.** The place tree cut at 500 groups scores only about 70 points more than at 141 (3,725 vs 3,654), and a finer place cut barely sorts road types. So a level below sub-region should be defined by look and road type within a place, not by finer geography.

**Candidates** (`scenes.py`, `scenes_typed.py`, `scenes_hybrid.py`; scored with `scenes.py eval` and `probe_r2.py`):
- **Clustered:** per sub-region, Ward clustering of family centroids (condition subspace projected out), optionally with a Vali road-class + urbanity profile appended (weight w).
- **Typed:** sub-region × road kind (town streets / highways / rural roads / unpaved roads), assigned per family from its mean SigLIP road probes.
- **Hybrid:** typed, then any typed scene over 4,000 locations is split by look (Ward, T 0.4; parts under 1,500 fold back).

Each candidate was checked with a signal it wasn't built from: Vali tags for probe-built ones, SigLIP probes for Vali-built ones.

| Split | Groups (Keff) | Realized / SigLIP | Look purity | Road mix, Vali (H, lower = cleaner) | SigLIP probes, share of the looks' gain over sub-region (lanes / width / paved / town) |
| --- | --- | --- | --- | --- | --- |
| Sub-regions | 141 (106) | 3,668 / 3,712 | .799 | 1.564 | 0 / 0 / 0 / 0% |
| Finer place cut, nested | 600 (192) | 3,733 / 3,773 | .773 | 1.490 | — |
| Clustered, look only | 611 (468) | 3,695 / 3,730 | .722 | 1.325 | 50 / 57 / 59 / 80% |
| Clustered + Vali profile (w 0.5) | 578 (452) | 3,690 / 3,729 | .721 | 1.244 (circular) | 53 / 64 / 70 / 76% |
| Typed | 397 (294) | 3,670 / 3,712 | .738 | 1.357 | (circular) 39 / 59 / 67 / 74% |
| **Hybrid (chosen)** | 558 (457) | 3,678 / 3,717 | .714 | 1.300 | (partly circular) 54 / 69 / 75 / 80% |
| Families | 2,373 (1,443) | 3,728 / 3,760 | .654 | 1.170 | 88 / 91 / 93 / 92% |
| Looks | 4,581 (4,059) | 3,757 / 3,796 | .586 | 1.108 | 100% |

**Findings:**
- **Scenes sort road type about half to four-fifths as well as all 4,229 looks, with an eighth as many groups.** They cost almost nothing in points: 25–60 points below a finer place cut, but the place cut doesn't sort roads.
- **Sibling scenes are easy to tell apart by eye.** `blind11`: 12 sheets, siblings inside one sub-region, typed vs clustered hidden, 48/48 right. Compare 77–88% for sibling sub-regions. Even the clustered siblings mostly differed in road kind.
- **The kind names match the photos.** `blind12`: 12 random scenes (3 per kind), 6 photos each, name the kind blind: 10/12.
  - One miss was a scene of boat and ferry views plus an Alaskan forest road called "rural roads". Fixed: looks named as boat, ferry, ship-deck, shallows, indoor or lit-tunnel views now form their own "boats and odd captures" kind, which never folds into a road kind. That makes 6 such scenes.
  - The other miss was narrow, worn Balkan paved roads called "unpaved roads", which is borderline.
- **Kinds agree with OSM.** Town streets are 57% residential-tagged (72% urban); highways are 63% motorway/trunk/primary.
  - "Tracks" are only 6% OSM tracks, but 61% unpaved by surface tag, against 5–9% for the other kinds. So they are shown as "unpaved roads": OSM classes roads by importance, not surface.
- **Why the hybrid:** it names itself (every scene is a road kind in a place), it beats look-only clusters on the independent Vali check, and people tell siblings apart perfectly. It gives up about 12 points to the Vali-profile clusters. Those score better on the SigLIP probes, but can't be named by kind.
- **Rural roads is the vaguest kind.** By OSM it's a spread of primary, secondary and minor roads. If scenes need tightening, split it by lane markings once a ground-measured channel exists.

**In the preview site:** levels are Region → Sub-region → Scene → Look (keys 1–4), then the look-first variants (5–6) and "Family (twins)" (7). Inside goes Sub-region → Scene → Look. Scene columns show "Town streets: Poland · …" with a note listing their biggest looks.

## Still open

- **Families need a road-class cue that sees the road itself.** Text probes on look means got the blind error rate from about 27% to about 21%.
  - A per-image version helps more: the *share* of a look's images scoring above the median on "lane lines" or "center line" (`results/lane_fraction_atoms.npy`).
  - Across all 48 judged pairs, a gap above 0.25 flags 13 of the 14 wrong merges, but also 15 of the 34 acceptable ones.
  - So it's a soft merge penalty, not a veto.
  - **Tested on a fresh blind set (`families_v4.py`, `results/blind4/`):** similarity − 0.1 × lane-share gap, with the veto and cap.
    - 14 of 16 merges acceptable (88%, against 79% for v2/v3).
    - Held-out twin recall falls from .61 to .42.
    - One of the two wrong merges is with an artifact look ("Dark purple-cast highway captures").
  - It's a precision/recall knob, not a free win. v5 (v3 + artifact exclusion) stays the provisional level. Use v4 if wrong merges matter more than missed twins.
  - The real fix is a lane-marking/width channel measured on the rectified ground in each image (see the memory note on rectifying before measuring ground texture).
  - Recall also needs work: a third of the kept-apart controls were twins.
  - **Third pass: a crude ground-measured marking channel (`ground_marks.py` → `results/ground_marks.json`).**
    - For each look's example photos, it measures the share of the lower-center road area covered by thin bright ridges (white or yellow), each brighter than both neighbors 6 px away. Wide uniform areas (car hood, sky, walls) don't count.
    - Sanity: the least-marked looks are sand and dirt tracks, the most-marked are motorways. Guardrails are false positives.
    - On the 76 earlier judged pairs (17 wrong), its gap separated wrong merges with AUC .78, against .71 for the SigLIP lane share, and .82 for the two combined (90% CI .71–.91).
    - **It did not hold up fresh.** v6 (`families_v6.py`: v5 − 0.03 × max of the two gaps) has 1,972 families before nesting (v5: 1,714) and held-out twin recall .57 (v5: .60).
    - Blind check `blind10` (12 hidden sheets): merges v6 undid were 3/6 wrong, merges it kept were 2/6 wrong (p = .5). One undone pair was a true twin (an Indian car-hood look).
    - On those 12 fresh pairs, the ridge gap's AUC was .63 against .91 for the SigLIP lane share (only 5 wrong pairs).
    - **Verdict:** frame-space ridges aren't enough, which matches the rectification lesson. v5 stays.
- **Capture-artifact looks.** About 120 micro names describe capture rather than place: smear, glare, purple/haze cast, washed-out.
  - The tree files them by place, which costs no points because capture runs are geographically batched.
  - But they blur what a region "looks like", and they turn up in wrong family merges.
  - Tag them, keep them as looks, and leave them out of family merging and of region "typical" images.
  - **Done for families (`families_v5.py`):**
    - 119 looks matched by name (capture artifacts plus boat/ferry/ship-deck views) are kept out of merging.
    - 2,373 families after nesting.
    - Held-out recall on non-artifact twins .60.
    - Points unchanged.
    - `family_value.json` was rebuilt on v5: 330 families hold 50% of the value.
  - The name match is crude. A view-statistics tag (see the memory note on view-level artifact statistics) would be better.
  - **Blind check of v5 itself** (`blind5.py`, `results/blind5/`: 12 fresh merges, judged before the key): 11 acceptable (8 true twins, 3 same family), 1 wrong (hedge-lined suburban through-roads with tight new-build brick rows, the same UK estate area but different looks).
- **A truly independent model** (not C-RADIO-derived) for the second eye.
- **Human consistency per meta** from Sort/Guess logs.
- **Play-relevance weights for "big".**
- **The tree optimizes points-if-known.** Merging on realized points (SigLIP vote) instead might buy back some recognizability.
  - A local test argues against simply merging hard sub-regions.
  - Folding the 5 least consistent sub-regions into the sibling they're most confused with costs 21 points (3,712 → 3,691) for +.006 agreement.
  - Even the hardest sub-regions carry real location value, so they're better kept and taught with a "how to tell apart" page.

## Proposal for the site (unchanged in spirit)

- **Levels:** Regions 40 → Sub-regions 141 → Scenes 558 → Looks 4,229 (look families kept as an optional twins view).
- **Every meta gets:**
  - *share* (big)
  - *points if known* (narrowing)
  - *value* = share × (points − 917), the points per round the meta is worth
  - *consistency* (SigLIP vote now, human rates later)
- **In Explore:**
  - At the region level, value is what to learn first.
  - At the look level, the useful lists are big-but-weak looks (tunnels, cane lanes, trolleybus avenues) and small-but-sharp ones (Ghana white-edged bonnet roads, Botswana paved-shoulder highways).

## Files

The work folder (clusterings, kNN graph, SigLIP vectors, thumbnails; 8 GB) now lives at `Geoguessr/meta-map-work`. A symlink remains at its old `/private/tmp/…/ab61d511…/scratchpad/work` path.

`pipeline/split/` (outputs in `results/`):
- `common.py`: the yardsticks.
- `merge.py`: the place-aware tree.
- `nested.py`: nested sub-regions and regions → `results/nested_look_sub_reg.npz`, which maps each γ300 atom id to its sub-region and region.
- `bends.py`: points along every merge → `results/points_by_K.json`.
- `region_table.py`: → `results/regions_40.json`.
- `siglip_knn.py`, `score_siglip.py`, `consistency.py`: the second eye → `siglip_scores.json`.
- `twins.py`, `nuisance.py`, `families.py`, `family_level.py`: look families → `family_of_atom.npy`.
- `blind_pairs.py`: the blind sheets → `results/blind/`, `blind_key.json`, `blind_judgments.json`.
- `road_probe.py`: SigLIP text road probes per look.
- `family_value.py`: → `results/family_value.json`.
- `subregion_table.py`: → `results/subregions_141.json`.
- `families_v5.py`: the provisional families (v3 + artifact looks kept apart) → `results/family_of_atom_v5.npy` via `family_level.py families_v5`.
- `blind5.py`: the v5 blind check → `results/blind5/`, `blind5_key.json`, `blind5_judgments.json`.
- `families_v4.py`: the lane-share penalty variant and its fresh blind set → `results/blind4/`, `blind4_key.json`, `blind4_judgments.json`.
- `sibling_differences.py <country codes>`: draft how-to-tell-apart cues → `results/sibling_differences_demo.json`.
- `blind_siblings.py`, `blind_siblings2.py`: the sibling recognition sheets → `results/blind3/`, `results/blind6/`, with keys and guesses.
- `nested.py <tag>`: also builds the γ1000/γ100/γ30 and μ0/μ3000 variants → `results/nested_<tag>_150.npz`.
- `families_v2.py`: families with the veto, plus the fresh blind set → `results/blind2/`, `blind2_key.json`, `blind2_judgments.json`.
- `road_tags.py`, `road_profile.py`: Vali road class and surface per location.
- Third pass:
  - `frontier.py [mu_rRES ...]`: purity vs points for Leiden and tree variants → `results/frontier.json`, `frontier_res.json`.
  - `merge_mod.py <mu> <tau> <gamma> <res>`: the tree with a modularity size term. Set `INSIDE=<nested npz>` to merge only within regions.
  - `blind7.py <nested tag> [name]`: current vs look-first sibling sheets, with pair ids in the key → `results/blind7/`, `blind8/`.
  - `capture_share.py`: capture-look share per sub-region and capture-driven sibling splits.
  - `merge_half.py` (`HALF=0`), `holdout.py`: the held-out points check → `results/holdout.json`.
  - `ground_marks.py`, `families_v6.py <LAM>`, `blind10.py`: the ground-marking channel, v6 families, and the undone-vs-kept blind check → `results/blind10/`, `blind10_key.json`, `blind10_judgments.json`.
  - Fourth pass: `scenes.py` (clustered + `eval`), `scenes_typed.py`, `scenes_hybrid.py` (chosen: `results/scenes_hybrid_s4000_t0.4.npy` → `meta-map-work/clusters_gSCN.npy`), `road_probe_pano.py` (per-location probes, `results/road_probe_pano.f16.npy`), `probe_r2.py`, `blind11.py`, `blind12.py`.
  - `site_labels.py`: placeholder labels for the preview site (looks = micro names; families = their largest look's name; regions and sub-regions stay unnamed but get a note with their look count and biggest looks).
- Preview site: `Geoguessr/meta-map-split` (serve with `python3 -I meta-map-split/serve.py 8794`). Levels built with the site's own pipeline from `meta-map-work/clusters_g{R40,S141,R40p,S137p,F5}.npy`. Its explore/metapage code has explicit parent and child levels so the look-first levels open the right Inside board.
- Earlier: `merge_look.py`, `final_cut.py`, `look_value.py`, `score_all.py`, `curve_realized.py`, `knn_ceiling.py`.
