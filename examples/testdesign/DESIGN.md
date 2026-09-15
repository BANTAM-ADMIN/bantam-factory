# ASHWORTH ST — Authoritative Build Spec (DESIGN.md)

Single source of truth for the subway-station FPS. It supersedes `design/visual.md`,
`design/gameplay.md` and `design/engineering.md` wherever they disagree; those three remain
useful as *reference* for recipes and rationale, but **every number, name and signature in this
file wins**. Implementers read Sections 0–2 completely, then the sections for their modules.

Environment (verified 2026-09-01): three **r185** at `vendor/three/three.module.js` (+`three.core.js`),
addons at `vendor/three/addons/` (`SMAAPass()` takes no args; `UnrealBloomPass(resolution, strength,
radius, threshold)`; `OutputPass()`; `ShaderPass(shader, textureID)`; `EffectComposer(renderer)`;
`BufferGeometryUtils.mergeGeometries(geoms, useGroups)`; `CapsuleGeometry`, `InstancedMesh`,
`SkinnedMesh`, `FogExp2`, `PMREMGenerator`, `Points`, `Sprite`, `RoundedBoxGeometry`, `SimplexNoise`,
`Reflector` all exist). Node 22, `node serve.js 8080`, Playwright headless Chromium with SwiftShader
WebGL2. `test/harness.js` already exists and calls `window.__game.step(dt)` with `dt` in seconds.
Not a git repo. No bundler, no TypeScript, no framework, no external asset files of any kind.

---------------------------------------------------------------------------------------------------

## 0. Scope, tiers, and conflict resolutions

### 0.1 What we are building (user intent, verbatim requirements mapped to features)

| Requirement | Where it lives |
|---|---|
| Beautifully detailed 3D subway station, impressive | §3 (visual spec), `station.js`, `props.js`, `textures.js`, `materials.js`, `lighting.js`, `post.js` |
| FPS with humanoid/zombieoid enemies | §4.5, §5 (rig), `enemies.js`, `rig.js` |
| Visible ammo tracers, weapon recoil, muzzle flash, ≥ 2 weapons | §4.2–4.4, `weapons.js`, `viewmodels.js`, `particles.js` |
| SFX | §7, `audio.js` (all WebAudio synthesis) |
| Simple first wave; then a train pulls in, opens doors, releases wave 2; difficulty rises until the player loses | §4.6 (waves), §6 (train), `waves.js`, `train.js` |
| three.js, playable in the browser | `index.html` + importmap, static server |
| Headless-testable debug API | §9, `debug.js` |

### 0.2 Tiers

* **Tier 1 (must ship)**: everything in this document that is not tagged `[T2]`/`[T3]` **at the place where it is
  specified**. **That is the only tiering rule**: an item is Tier 2 only if it carries a `[T2]` tag in the module section /
  table row / constants comment that describes it; §3.9's SHOULD-HAVE list is an *index* of those tags, never a source of
  new ones (if the index and an in-place tag ever disagree, the tag wins and the index is fixed). The game is complete and
  reviewable at Tier 1. Line budgets: §2.0 — Tier 1 + tests ≈ 12.9 k, hard ceiling 13.5 k; the brief's "roughly 6 k–12 k" is a
  guideline and ~13 k is accepted, because the visual detail is what makes the project and is not what gets trimmed to hit a
  round number.
* **Tier 2 (do next, in the listed priority)**: tagged `[T2]`. Each is < 150 lines and isolated.
  **Gate**: no T2 item is started until `node test/smoke.js`, `node test/perf.js` and the `test/shots.js`
  review all pass on the Tier-1 build; T2 may add ≤ 1.5 k lines in total (≤ 15 k with tests).
* **Tier 3 (only if budgets allow)**: marked `[T3]`; the list lives in **Appendix B** and is never worked on
  before every T2 item the team wants is merged and the tests still pass. T3 descriptions are deliberately
  one line each — do not elaborate them in code before the gate.

### 0.3 Conflict resolutions (decisions are final; do not re-litigate)

| Topic | visual.md | gameplay.md | engineering.md | **Decision** and why |
|---|---|---|---|---|
| Station topology | Island platform 60 m between two tracks, stairs east to a mezzanine, fence west | Side platform 90 m, one track | Side platform 80 m, one track, back-wall doors | **Island platform, two tracks, east stair + mezzanine, west fence.** Every direction the player looks shows a hero tiled wall across a track; trains can alternate tracks so the show-piece never blocks half the view permanently; the mezzanine gives vertical variety for screenshots. Nav stays 2-D (stair/mezzanine do not overlap the platform in XZ). |
| Yaw convention | yaw 0 = +X | yaw 0 = −Z (three.js `rotation.y`) | yaw 0 = −Z | **yaw 0 = −Z, forward = (−sin yaw, 0, −cos yaw)**, maps to `camera.rotation.set(pitch, yaw, roll, 'YXZ')` without offsets. Visual's screenshot table is converted in §10. |
| `step` / `setTime` | — | `step(dt)` = one tick + render; `setTime(t)` fast-forwards by ticking | `step(n, render)`; `setTime` just sets the clock | **gameplay semantics** — `test/harness.js` already calls `step(dt)`; a `setTime` that skips ticks would break countdown state machines. |
| Viewmodel rendering | Child of camera in the main scene | Separate scene + second camera pass | Child of camera, near 0.05 | **Child of camera in the main scene** (one pass, muzzle light lights the gun for free, bloom works). Near plane **0.07** (`PLAYER.near`; 0.04 left a 24-bit depth buffer resolving only ~3–5 mm at 40–60 m, so the 3–6 mm offsets of puddles / tactile strips / decals shimmered in the distance — Appendix A, §10.3), viewmodel kept ≥ 0.12 m from the camera. |
| Weapons | Pistol + SMG (+ shotgun nice-to-have) | Pistol / rifle / shotgun with full tables | Pistol / rifle / shotgun constants | **Pistol / rifle / shotgun, gameplay.md numbers** (they are balanced against the wave table and the acceptance tests). Shotgun fires 9 thin tracers (visible tracers are a hard requirement; engineering's "no shotgun tracer" rejected). |
| Enemy archetypes & rig | Palette variants (commuter/worker/hoodie/nurse/brute), rig with ~22 bones | shambler/runner/brute stats + AI | 21-bone hierarchy with exact part table + 17 hit capsules | **Three archetypes (shambler/runner/brute) with gameplay stats; engineering's 21-bone rig + 17 capsules; visual palettes** map onto archetypes (shambler ∈ {commuter, worker, nurse}, runner = hoodie, brute = brute). |
| Lights | 14 point + 2 spot + muzzle + hemi | — | ≤ 12 | **17 real lights** (hemi 1 + platform 8 + **mezzanine 1** + wall lamps 2 + sodium 2 + train spots 2 + muzzle 1). The fixed count is a *stability* rule (every light exists from init so three.js never recompiles shaders mid-game), **not a cap**: the mezzanine point light was added at Tier 1 because without it the whole mezzanine — a hero area and the wave-1 spawn route the player faces at spawn — rendered at hemisphere-ambient only (§3.6.2). All created at init and kept in the scene (intensity 0 when off). **All 17 (and the two `SpotLight.target`s) are direct children of `scene`**; no light may ever sit under an object whose `visible` flag changes (r185 `projectObject()` skips invisible subtrees, which changes `numSpotLights` and forces a full shader recompile). Emergency strobes retask the 2 sodium lights. |
| Post chain | Render→Bloom→Output→SMAA→Grade | Render→VM→Bloom→SMAA→Output | Render→Bloom→SMAA→Output | **Render → Bloom → OutputPass → SMAA → Grade** (AA and grade operate on the tone-mapped LDR image; grain must not be anti-aliased). Bloom strength 0.45, radius 0.4, threshold 0.9, half-res (pass the **full** resolution to `UnrealBloomPass` — it halves internally; passing res/2 would make the first mip quarter-res). |
| Fog | Exp2 0.028 | — | Exp2 0.012 | **FogExp2 0x05070b, density 0.018** (platform readable end to end: 30 m → 75 % visible, 60 m → 31 %; tunnels vanish by ~100 m). |
| Environment map | CubeCamera capture of the real scene, PMREM | — | PMREM of a tiny procedural room | **CubeCamera capture of the built scene** (real tubes reflect in puddles/rails/train steel), once at init, 128 px. |
| Train consist | 3 × 15 m, alternates tracks | 4 × 18 m from −X | 4 × 17 m parks at x=0 | **4 cars × 14.4 m + 0.5 m gaps = 59.1 m, parks centred at x = 0, alternates tracks** (Track A wave 2, B wave 3, …). Track A trains run +X, Track B trains run −X. |
| Player eye / speeds | 1.70 | 1.65 / 4.2 / 6.6 | 1.62 / 4.5 / 7.0 | **gameplay.md** (feel doc wins on feel): eye 1.65, walk 4.2, sprint 6.6, radius 0.35. |
| Wave 1 sources | stairs, west gate | stairs + gates | back-wall doors | **Mezzanine service door (enemies walk down the stairs) + west fence gate**, alternating, cadence 3 s. Far from the player → tutorial pace. |
| Wave tuning | — | 10-row table + formulas | formula only | **gameplay.md table (§4.6.4)**, with train batch capped by our 12 doors and "late arrivals" from the two doors after the train leaves. |
| Event names | — | `enemy:killed` | `enemy-killed` | **kebab-case (`enemy-killed`)**, engineering catalogue + gameplay additions (§1.8). |
| Damage per part | — | head/torso/limb ×mult | 17 per-part multipliers | **17 capsules grouped into head/torso/arm/leg**, multipliers: head = weapon's headshot mult (brute cap 1.5), torso 1.0, limbs 0.75. |
| Textures/materials API | `textures.js` helpers + `MAT.*` registry in `materials.js` | — | single `textures.js` with `getTexture/getMaterial`, UVs in metres | **Both files**: `textures.js` = helpers + generators + `getTexture(name)`; `materials.js` = `MAT` registry via `getMaterial(name)`, AO strips, env capture (`bakeVertexAO` lives in `utils.js` **only**; `initMaterials(renderer, seed)` calls `initTextures(renderer, seed)`). **UVs in metres** for tiling surfaces (engineering) so textures land at physical size. |
| Shadows | none (blob + AO) | enemies cast, one light | none | **No shadow maps.** Blob shadows under enemies/player, vertex AO, AO strips. |
| Station name | ASHWORTH ST, line "6" green + "M" orange | "TERMINUS" | "Harbor Line — Terminal" | **ASHWORTH ST** (visual.md has the complete signage design). Page title "Ashworth St". |
| Health regen | — | 6 s delay, 5 HP/s | 5 s, 6 HP/s | **6 s / 5 HP/s.** |
| Spread crosshair, hit markers, damage arcs | minimal | detailed | detailed | **gameplay.md HUD** (§8), static DOM in `index.html` with fixed ids. |

Everything else: where only one doc speaks, it stands unless contradicted here.

---------------------------------------------------------------------------------------------------

## 1. SHARED CONVENTIONS

### 1.1 Units, axes, frames

* 1 unit = 1 metre, seconds, radians (degrees only in `constants.js` fields with a `Deg` suffix). Y up, right-handed.
* **X runs along the tracks.** −X = west (fence, catwalk, tunnel W). +X = east (stair, mezzanine, tunnel E).
* **Z runs across the station.** Track A is at **−Z (south)**, Track B at **+Z (north)**. The island platform is centred on z = 0.
* Origin (0,0,0) = centre of the platform walking surface. Platform floor y = 0. Trackbed y = −1.10. Rail head y = −0.95.
* **Yaw/pitch**: `yaw` about +Y, `pitch` about +X, `camera.rotation.order = 'YXZ'`, `camera.rotation.set(pitch, yaw, roll)`.
  `forward = (−sin yaw, 0, −cos yaw)`, `right = (cos yaw, 0, −sin yaw)`. yaw 0 looks −Z (toward Track A wall);
  **yaw = −π/2 looks +X (toward the stairs)**; yaw = +π/2 looks −X (toward the west fence); yaw = π looks +Z.
  `pitch ∈ [−1.45, +1.45]`, positive = up. `utils.yawFromDir(dx, dz) = Math.atan2(−dx, −dz)`.
* Player: capsule radius 0.35, height 1.80, eye height 1.65 (feet at `pos.y = floorHeightAt`).
* Enemy body radius = `ENEMY_TYPES[type].radius` (shambler 0.35, runner 0.32, brute 0.55) — one number per type, used for
  colliders, separation (`+ ENEMY.separationExtra`) and the corner-clearance arithmetic in Appendix A. §1.13 wins over any
  other radius quoted anywhere in this document.

### 1.2 Station coordinate layout (master table — also encoded in `constants.js`, §1.13)

| Element | X | Y | Z | Notes |
|---|---|---|---|---|
| Platform slab | −30 … +30 | top 0, thickness 0.30 | −5 … +5 | island; `MAT.floorSlab` on top, dark grime on the sides |
| Tactile strips | −30 … +30 | +0.005 | ±[4.40 … 5.00] | `MAT.tactile`, polygonOffset −1 |
| Edge nosing | −30 … +30 | 0 … −0.15 | faces z = ±5.0 | chipped concrete lip |
| **Edge barriers** (invisible) | −30.5 … +30.5 | −1.2 … 2.5 | ±[4.95 … 5.30] | mask PLAYER\|ENEMY\|NAV, surface `'none'` |
| Trackbed A / B | −160 … +160 | −1.10 | ±[5.0 … 9.0] | drainage trough (0.4 wide, 0.25 deep) at track centre |
| Track centre lines | | | **z = ±6.65** | gauge 1.435 → rails at z = ±5.9325 and ±7.3675, head y −0.95 |
| Third rails | −160 … +160 | −0.85 | z = ±8.35 | wall side, cover boards, insulator pedestals every 3 m |
| Trackside walls | −32 … +32 | −1.10 … 4.20 | z = ±9.0 | hero tiled surfaces (§3.3) |
| Station ceiling | −32 … +32 | 4.20 | −9 … +9 | with a hole x 30…39, \|z\| < 1.5 for the stairwell |
| Cross beams | x = −27 + 4.5k, k = 0..12 (13) | 3.80 … 4.20 | −9 … +9 | 0.5 wide in X |
| **Columns** | x = −27 + 4.5k, k = 0..12 | 0 … 3.80 | **z = ±3.0** | 26 cast-iron, r 0.17, plinth 0.55² × 0.25; colliders cyl r 0.28 (plinth) |
| Fluorescent troffers | x = −24.75 + 4.5k, k = 0..11 (12) | 3.55 | z = ±1.8 | 24 fixtures, 1.25 × 0.10 × 0.30 |
| Platform point lights | x = −22.5 + 7.5k, k = 0..7 (8) | 3.40 | z = 0 | see §3.6 |
| **Mezzanine point light** | 41 | 7.60 | 0 | the 17th light (`LIGHTS.mezz`, §3.6.2): lights the upper treads, the top landing, the turnstile line and the mezzanine floor from above (platform light #8 at (30, 3.4, 0) sits 1.4 m *below* the mezzanine slab and cannot light any upward-facing mezzanine surface) |
| **Mezzanine troffers** | x ∈ {38.5, 44.5} | 7.55 | z = ±3.0 | 4 fixtures (`MEZZ_TROFFERS`, indices 24–27), same housing/tubes/glow card as the platform ones, instanced with them (§3.6.3) |
| Wall bulkhead lamps | x = −27 + 6k, k = 0..9 (10 per wall) | 3.40 | z = ±8.8 | real point lights only at (−9, −8.7) and (+9, +8.7) |
| Benches | x ∈ {−24.75, −15.75, −6.75, 6.75, 15.75, 24.75} | 0 | z = 0 | back-to-back double, 1.8 long (X) × 1.0 wide (Z); box colliders 1.9 × 1.1 |
| Trash cans | x ∈ {−22.5, −13.5, −4.5, 4.5, 13.5, 22.5} beside columns | 0 | z = ±2.35 (alternating sign) | cyl colliders r 0.32 → 2.03 … 2.67, 6 cm clear of the plinth face at 2.725 |
| Vending machine | x = 9.0 | 0 | z = −2.30 (beside the south column; 0.8 deep → −2.70 … −1.90, clear of the plinth at −2.725) | box collider 0.95 × 0.8 |
| **Supply cabinet (resupply crate)** | x = 0 | 0 | z = −2.45 | 0.8 (X) × 1.7 (Y) × 0.45 (Z), faces +Z, status lamp; box collider |
| Hanging line signs | x = ±13.5 | plate 2.90 … 3.30 | z = ±2.0 | 4 signs, rods to the beam |
| Poster frames (walls) | x = −24 + 8k, k = 0..6 (7 per wall) | 0.45 … 2.35 | on z = ±9 faces | every other one backlit |
| DANGER 600 V plates | x = ±20 | −0.6 | on walls | 0.5 × 0.25 |
| Drain grates | x = ±15 | −0.005 | z = ±2.5 | 4, with puddles |
| **Player spawn** | 0 | 0 | 0 | yaw = −π/2 (facing the stairs) |
| Platform end rails (east) | x = 30 … 30.3 | 0 … 1.1 | \|z\| ∈ [1.35, 5.0] | steel guardrails; box colliders PLAYER\|ENEMY\|NAV |
| **Stair** | bottom landing 30 … 30.6 (y 0); run 30.6 … 37.8; top landing 37.8 … 39 (y 4.8) | 0 → 4.80 | \|z\| ≤ 1.2 | 24 risers × 0.20, treads 0.30; ramp for collision |
| Stairwell walls | 30 … 39 | stair … 8.20 | z = ±1.35 (0.3 thick) | tiled inside |
| **Mezzanine floor** | 30 … 48 | 4.80 (slab 4.50 … 4.80) | −6 … +6 | hole (stair well) x 30 … 37.8, \|z\| < 1.5 with railings |
| Mezzanine ceiling | 30 … 48 | 8.20 | −6 … +6 | |
| Mezzanine walls | x = 30 (west, above the well), x = 48 (east), z = ±6 | 4.80 … 8.20 | | tiled with band |
| **Turnstile line** | x = 41.5 (housings 41.05 … 41.95) | 4.80 … 5.80 | housings at z ∈ {−3, −2, −1, 0, 1} (0.2 thick → the z = 1 housing spans 0.9 … 1.1); passages 0.8 wide; **emergency gate z ∈ [1.2, 3.4] (open, 2.2 m)**; railings (`fare-rail`) \|z\| ∈ [3.4, 6] and [−6, −3.1], 0.05 thick, 1.0 high | box colliders; corner gap between the stair-wall end (39, 1.5) and the z = 1 housing corner (41.05, 1.1) = 2.09 m |
| Exit shutter | x = 48 face | 4.80 … 7.20 | −1.5 … +1.5 | rolled-down grille, warm slit, light shaft |
| **Mezzanine service door** (spawn) | x = 44 | 4.80 … 7.00 | z = 6.0 face, recess to 6.8 | "NO ENTRY", opens into the recess; the recess floor x ∈ [43.4, 44.6], z ∈ (6, 6.8] is walkable at 4.8 for `floorHeightAt` (§1.3 — outside the nav grid, spawn/exit only); the leaf and the three recess walls are colliders tagged `door` (§3.4), and the z = +6 mezzanine wall is split around the recess |
| **Nav keep-clear corridor** (mezzanine) | rect A: 37.8 … 42.5; rect B: 42.0 … 46.0 | 4.80 | A: −0.6 … 3.4; B: 1.0 … 5.7 | **nothing may register a PLAYER/ENEMY/NAV collider inside these rects** except the turnstile line itself (housings z ≤ 1.1, railing z ≥ 3.4 on x = 41.5) — this is the door → gate → landing route (`NAV_KEEP_CLEAR` in §1.13) |
| Agent booth (mezzanine) | centre 44.5, 2.2 along X | 4.80 … 7.20 | centre −4.2, 1.6 along Z (−5.0 … −3.4) | south side, east of the turnstiles; box collider + `booth-glass` |
| Fare machines ×2 | 47.5 (0.6 deep, backs to the east wall) | 4.80 … 6.40 | 2.2 and 3.2 (0.6 wide) | face −X; box colliders |
| System map lightbox | 34.5 (on the north wall) | 5.6 … 7.2 | z = 5.92 face | 1.6², emissive 0.9; BULLET only |
| Payphone bank (3) | 37.0 (on the south wall, 0.3 deep) | 5.9 … 6.9 | z = −5.85 | BULLET only |
| Mezzanine vending ×2 | 47.5 (0.8 deep, backs to the east wall) | 4.80 | −4.0 and −2.8 (0.95 wide) | face −X; box colliders |
| Mezzanine benches ×2 | 34.0 (1.8 long along X) | 4.80 | ±4.5 | on the side strips west of the corridor; box colliders 1.9 × 1.1 |
| Mezzanine trash cans ×2 | 37.0 | 4.80 | ±5.4 | cyl r 0.32 |
| Stanchions ×4 (+ belts) | 43.0, 44.2 | 4.80 … 5.80 | −1.2, −2.4 | queue line south of the corridor; cyl r 0.15 |
| Mop bucket, knocked-over wet-floor sign, manhole cover | (47.2, 5.2) / (47.0, 4.0) / (35.0, 3.5) | 4.80 | | bucket cyl r 0.2; the others have no walker colliders |
| **West fence + gate** | x = −30 (plane) | 0 … 2.2 | −5 … +5; gate z ∈ [−0.6, 0.6] | chain-link; gate hinge at z = +0.6, swings toward −X |
| Catwalk (visual, enemies spawn at the gate) | −42 … −30 | grating at 0 | \|z\| ≤ 0.6 | ends at a blue-lit emergency door at x = −42 |
| Tunnel segments | ±32 … ±158 (21 × 6 m per side) | ceiling 3.90 | full width | I-columns at z = 0 every 1.5 m for \|x\| ≥ 44 (they land on the central floor) |
| **Central floor** (between the tracks, beyond the platform) | 30 … 160 and −160 … −30 | −1.10 | −5 … +5 | `MAT.concreteRaw` blackened, `MAT.trackbed`-style oil streaks; the stair base, the catwalk posts and the I-columns stand on it; **low dividing wall** z ∈ [−0.3, 0.3], y −1.10 … −0.20 for \|x\| ≥ 44 (I-column plinth beam); BULLET colliders `floor-center` |
| Platform end walls | x ∈ [30, 30.3] and [−30.3, −30] | −1.10 … −0.30 | −5 … +5 | blackened concrete faces under the platform ends (the slab sides stop at −0.30) |
| Sodium lamps | x = ±38 + 12k | 3.0 | alternating walls z = ±8.8 | real point lights only at (−38, −8.8) and (+38, +8.8) |
| Signal heads | x = −44, −80 (Track A, south wall z = −8.8, facing +X) and x = +44, +80 (Track B, north wall z = +8.8, facing −X) | 3.0 | wall of the arriving track, at the tunnel the train comes from | 3 lenses |
| Tunnel end caps | x = ±160 | | | black planes |
| **Train (docked)** | centre x = 0, nose at ±29.55 | floor 0.00, roof 2.70 | centre z = ±6.65, body \|z\| ∈ [5.15, 8.15] | gap to platform 0.15 m |
| **Train door thresholds (docked)** | x ∈ {−27.15, −22.35, −17.55, −12.25, −7.45, −2.65, 2.65, 7.45, 12.25, 17.55, 22.35, 27.15} | 0 | z = ±5.15 | 12 doors on the platform side |
| **Train (parked / idle)** | centre x = dir · 300 (`TRAIN.parkX`, beyond the ±160 end caps and the fog) | | on its track | **never `visible = false`** (§6.3): the headlight spots must keep their scene-graph state |

### 1.3 Walkable floor — `station.floorHeightAt(x, z)`

Returns the floor height or `null` (not walkable). Implemented analytically in `station.js`:

```
if (x ≥ −30 && x ≤ 30 && |z| ≤ 5.0)                 → 0                       // platform (barriers stop at 4.95)
if (x > 30 && x ≤ 30.6 && |z| ≤ 1.2)                → 0                       // bottom landing
if (x > 30.6 && x ≤ 37.8 && |z| ≤ 1.2)              → (x − 30.6) · (4.8/7.2)  // stair ramp (0.6667 per m)
if (x > 37.8 && x ≤ 48 && |z| ≤ 6)                  → 4.8                     // top landing + mezzanine
if (x > 30 && x ≤ 37.8 && |z| ≥ 1.5 && |z| ≤ 6)     → 4.8                     // mezzanine side strips
if (x ≥ 43.4 && x ≤ 44.6 && z > 6 && z ≤ 6.8)       → 4.8                     // service-door recess (MEZZ_DOOR; spawn/exit only — outside the nav grid)
if (x ≥ −42 && x < −30 && |z| ≤ 0.6)                → 0                       // catwalk (enemy scripted exits only)
else → null
```
`station.walkable` = the same regions as rects `{minX,maxX,minZ,maxZ}` for clamping (the recess and the catwalk included, so
scripted exits are never clamped out of them). Spawning/`exiting` enemies (§4.5.2) lerp `y` toward `floorHeightAt` and keep
`spawnPoint.pos.y` while it is `null` — the y source is always defined (never `NaN`, never 0 on the mezzanine).

### 1.4 Colliders (`collision.js`)

```js
/** @typedef {{type:'box', min:[x,y,z], max:[x,y,z], tag:string, surface:Surface, mask:number, id:number}} BoxCollider */
/** @typedef {{type:'cyl', x:number, z:number, r:number, y0:number, y1:number, tag:string, surface:Surface, mask:number, id:number}} CylCollider */
/** Surface = 'concrete'|'tile'|'metal'|'glass'|'wood'|'plastic'|'paper'|'none' */
MASK = { PLAYER:1, ENEMY:2, BULLET:4, NAV:8, SOLID:15, WALKERS:3 }
```
* Movement is 2-D in XZ; a mover of radius r at feet height y participates only with colliders whose `[min.y, max.y]`
  overlaps `[y + 0.05, y + 1.0]` (so heads pass under signs and feet climb 0.25 m plinths without special cases).
* Edge barriers: `PLAYER|ENEMY|NAV`, surface `'none'` (bullets fly over the track). Enemies in state `exiting`
  ignore ENEMY colliders tagged `'edge'`/`'gate'`/`'door'` (the fence leaf is `gate`; the mezz service-door leaf **and the
  three walls of its recess** are `door`, §3.4). Enemies in the debug state `idle` never participate in collision resolution
  at all (§4.5.2).
* Static colliders registered in `init()` by `station.js` and `props.js`; `train.js` replaces the dynamic set
  `'train'` (BULLET only) whenever it moves.
* Broad phase: statics bucketed into 8 m slabs along X (built lazily on first query, invalidated by `addStatic`).

### 1.5 Nav grid (`nav.js`)

Uniform grid, cell 0.5 m, origin (−30, −6), **156 columns (x ∈ [−30, 48]) × 24 rows (z ∈ [−6, 6])**. Cell `(i, j)` covers
the half-open rect `[x0, x0 + 0.5) × [z0, z0 + 0.5)`, `x0 = −30 + 0.5i`, `z0 = −6 + 0.5j`. Cell blocked if
`floorHeightAt(cellCentre) === null` or any `MASK.NAV` collider inflated by `NAV.agentRadius = 0.3` overlaps it.
**Overlap test is strict** (touching edges never block): a box inflated to `[bx0, bx1] × [bz0, bz1]` blocks the cell iff
`bx0 < x0 + 0.5 && bx1 > x0 && bz0 < z0 + 0.5 && bz1 > z0`; a cylinder blocks iff the distance from the cell rect to its
centre is `< r + agentRadius`. (0.3 is deliberately less than the brute's 0.55: the grid decides topology, `resolveCircle`
handles the last centimetres; with 0.3 the 0.8 m turnstile passages leave 0.2 m < one cell and stay blocked, while the
1 m stair corridor keeps its 2 free rows `[−0.5, 0.5]`.)
Flow field = Dijkstra from the player's cell over 8-connected cells (no diagonal corner cutting; stair cells cost
×1.0 — no special casing). Each cell stores `dist` and a unit `(dirX, dirZ)` toward its best neighbour.
Recomputed when the player's cell changes, at most every 0.25 s. Enemies read `nav.flowAt(x, z, out)` = bilinear blend
of the 4 nearest cell centres **ignoring blocked cells** (their weight is 0, the rest renormalised); if all 4 are blocked
the result points from `(x, z)` toward `nearestWalkable(x, z)`; at the target cell it is zero. The catwalk strip is NOT in
the grid (x < −30 is outside); enemies there are in the scripted `exiting` state.
**Boot-time assertion** (`nav.build()`, after station/props colliders): a one-off Dijkstra from `PLAYER_SPAWN` must give a
finite `distanceAt` at `(44, 4.75)` (mezz-door exit), `(−28.9, 0)` (west-gate exit) and every docked train-door exit
`(doorX_i, ±4.0)` (§1.2 door x list); a failure throws (lands in `__game.errors`) and is also smoke check 3b. The expected
route for the mezzanine (verified by hand with the §1.13 numbers): gate cells `[41.5, 42) × [1.5, 3.0)` → west along
`z ∈ [1.5, 2.0)` to `[39.5, 40)` (stair-wall inflation ends at x 39.3, housing inflation starts at x 40.75) → south
through `[39.5, 40) × [1.0, 1.5)`, `[0.5, 1.0)`, `[0, 0.5)` → landing `[38, 39.5) × [0, 0.5)` → stair rows `[−0.5, 0.5)`.

### 1.6 Spawn points

```js
/** @typedef {{ id:string, kind:'door'|'gate'|'train', pos:THREE.Vector3, yaw:number, exitDir:THREE.Vector3,
 *              exitDist:number, busy:boolean, open?:()=>void, close?:()=>void }} SpawnPoint */
```
| id | kind | pos | yaw | exitDir | exitDist | owner |
|---|---|---|---|---|---|---|
| `mezz-door` | door | (44, 4.8, 6.55) | π (faces −Z) | (0,0,−1) | 1.8 → ends (44, 4.8, 4.75) | station |
| `west-gate` | gate | (−30.9, 0, 0) | −π/2 (faces +X) | (1,0,0) | 2.0 → ends (−28.9, 0, 0) | station |
| `train-0` … `train-11` | train | inside the car at door i: local (doorX, 0, +0.9) → world via the train group | toward the platform | toward z = 0 | 1.75 → ends at \|z\| = 4.0 | train |

### 1.7 Update loop and deterministic stepping (`main.js`)

```
FIXED_DT = 1/60, MAX_SUBSTEPS = 4
frame(nowMs):                                   // requestAnimationFrame (real-time mode only)
  dtReal = clamp((nowMs − lastMs)/1000, 0, 0.1); lastMs = nowMs
  if (!G.paused && !G.manual) acc += dtReal
  n = 0; while (acc ≥ FIXED_DT && n < MAX_SUBSTEPS) { stepOnce(); acc −= FIXED_DT; n++ }
  if (n === MAX_SUBSTEPS) acc = 0
  renderOnce()
stepOnce():                                     // the ONLY place update() is called
  G.time += FIXED_DT; G.frame++
  input.update(); player.update(dt); nav.update(dt); weapons.update(dt); enemies.update(dt);
  train.update(dt); waves.update(dt); particles.update(dt); decals.update(dt); lighting.update(dt);
  station.update(dt); props.update(dt); audio.update(dt); hud.update(dt); debug.recordTick()
renderOnce():
  player.render(); train.render(); enemies.render(); weapons.render(); particles.render(); lighting.render();
  post.render()                                  // composer.render() or renderer.render()
```
* No interpolation: rendering shows the state after the last tick (60 Hz tick = 60 Hz render; keeps screenshots deterministic).
* **Manual stepping** (`G.manual = true`): RAF does not advance the simulation **and does not render on its own**: the RAF
  callback only checks `G.renderDirty` (set by `resize`, cleared by any render) so a SwiftShader page is not starved by
  free-running renders. `__game.step(dt, n=1)` runs `n` ticks with `dt` (clamped to [1/240, 0.1]) then renders once.
  `__game.setTime(t)` ticks at 1/60 **without rendering** until `G.time ≥ t` (≤ 36 000 ticks per call), then renders once.
  `__game.renderOnce()` renders without ticking. `__game.start()` from script enables manual stepping by default (§9).
  **The boot warm-up render (§2.3) is performed through `renderOnce()`** and therefore counts toward `getPerf().renders`/`renderMs`:
  `getState().renders ≥ 1` and `fps > 0` hold immediately after `start()` with no further render (smoke check 2). In manual mode
  nothing else ever renders on its own — there is no "~30 fps idle re-render".
* **FPS / timing fields** (`getState().fps`, `getPerf()`): in real-time mode `fps` = EMA over the last 30 RAF frames. In
  manual mode `fps = 1000 / renderMs` where `renderMs` is the EMA of the wall-clock cost of the renders actually performed
  (never 0 once one render has happened); `stepMs` = EMA of the last 60 `stepOnce` costs; `renders` = count of renders so
  far (monotonic — the "is it rendering?" check); `initMs` = boot time (§1.11).
* All gameplay time comes from `dt` and `G.time`. State machines use **countdowns** (`this.t -= dt`), never comparisons
  against `G.time`, so `setTime` can never skip a transition. `G.time` is only used for oscillations (flicker, sway, dust).
* Forbidden in systems: `performance.now`, `Date.now`, `Math.random`, `requestAnimationFrame`, `setTimeout`, `setInterval`,
  `scene.add` in `update`. Allowed: `main.js` (frame pacing, fps), `audio.js` (voice micro-jitter), `hud.js` (fps text),
  `textures.js`/`materials.js`/`utils.bakeVertexAO` **at init only** (generator timing for the §1.11 init budget).

### 1.8 Event bus (`bus.js`) and catalogue

```js
export class Bus {
  constructor() { this.map = new Map(); this.ring = []; this.ringHead = 0; this.ringCap = 512; this.time = 0; }
  on(name, fn) -> off();  off(name, fn);  once(name, fn) -> off();  clear();
  emit(name, payload = {})   // synchronous; copies {t:this.time, type:name, data:summary(payload)} into the ring (numbers/strings/ids only)
}
```
`payload.pos`/`dir` fields are `THREE.Vector3` **scratch** — copy them if you keep them. `summary()` keeps primitive
fields and replaces objects with `id` where available (enemy → `enemyId`), so `__game.getEvents()` is JSON.

| Event | Payload | Emitter | Listeners |
|---|---|---|---|
| `game-start` | `{}` | main | hud, audio (ambience loop), waves |
| `game-restart` | `{}` | main | all (reset already called) |
| `game-over` | `{wave, kills, time, reason:'killed'\|'train'}` | waves | hud, audio, player, debug |
| `wave-intro` | `{wave}` | waves | hud, audio |
| `wave-start` | `{wave, count, source:'doors'\|'train'}` | waves | hud, audio (sting) |
| `wave-clear` | `{wave, kills, accuracy}` | waves | hud, audio (the crate is re-armed by **waves itself** via `station.crate.setArmed(true)`; station does not listen) |
| `wave-countdown` | `{wave, seconds}` | waves (each whole second of the breather) | hud |
| `train-called` | `{track:'A'\|'B', wave}` (`wave` = `G.waves.wave`, the incoming wave — waves sets it **before** calling `callTrain`) | **train only**: emitted inside `train.callTrain(track)` on the idle → arriving transition, exactly once per call (a `callTrain` while not idle emits nothing); waves and debug never emit it | lighting (emergency beat start, signal yellow), audio (distant rumble + alarm chime), hud ("WAVE n — INCOMING TRAIN") |
| `train-approach` | `{track, x}` | **train only**, same tick as `train-called`, immediately after it (T = 0, horn) | audio (horn + rumble loop), hud ("INCOMING TRAIN") |
| `train-brake` | `{}` | train (T = 5.0) | audio (screech), lighting (signal green), particles (brake sparks) |
| `train-enter` | `{}` | train (nose crosses the tunnel mouth, T ≈ 5.62) | lighting (troffers recover), audio (whoosh) |
| `train-stop` | `{}` | train (T = 15.0) | waves (spawn waiting enemies), audio (hiss), lighting (signal red, strobes end) |
| `train-chime` | `{}` | train (T = 15.8) | audio |
| `train-doors-open` | `{}` | train (leaves fully open; the train opens its own doors at `train-stop` + `TRAIN.doorsDelay`, §6.3 — waves never calls `openDoors`) | waves (release), audio |
| `train-doors-close` | `{}` | train (leaves fully closed) | audio |
| `train-depart` | `{}` | train | audio (motor whine, rumble) |
| `train-gone` | `{}` | train (parked at x = dir·`TRAIN.parkX`, never hidden) | waves (late arrivals) |
| `enemy-spawn` | `{enemy, type, spawnId}` | enemies | waves, audio |
| `enemy-exited` | `{enemy, spawnId}` | enemies | waves, station/train (door bookkeeping) |
| `enemy-hit` | `{enemy, part, group, damage, pos, normal, dir, weapon, killed, headshot}` | enemies.applyDamage | particles (blood), decals, audio, hud (hit marker) |
| `enemy-killed` | `{enemy, type, part, weapon, headshot, pos, dir}` | enemies | waves, hud, audio, weapons (drops [T2]) |
| `enemy-rest` | `{enemy, pos}` (`pos` = torso world position of the resting corpse) | enemies, when the corpse has landed and the 0.4 s twitch phase ended (§5.6) | decals (blood pool `FX.poolDelay` = 0.6 s later, at `pos`) |
| `enemy-stagger` | `{enemy}` | enemies | audio |
| `enemy-attack` | `{enemy, pos, kind:'swipe'\|'lunge'\|'slam'\|'charge'}` | enemies (windup start) | audio |
| `enemy-vocal` | `{enemy, pos, kind:'moan'\|'growl'\|'shriek'\|'death'\|'spawn'}` | enemies | audio |
| `enemy-footstep` | `{enemy, pos, heavy:boolean, drag:boolean}` | enemies (≤ 14 m from player) | audio |
| `player-hit` | `{damage, health, from:pos, enemy, heavy:boolean}` | player.applyDamage | hud (vignette, arc), audio, player (shake) |
| `player-death` | `{reason}` | player | waves (game over), hud, audio |
| `player-heal` | `{health}` | player | hud |
| `player-footstep` | `{pos, sprinting, surface}` | player | audio |
| `shot-fired` | `{weapon, origin, dir, muzzle, pellets}` | weapons | audio, hud (crosshair), particles (smoke) |
| `shot-hit-world` | `{pos, normal, surface, weapon, tag}` | weapons | decals, particles, audio |
| `weapon-empty` | `{weapon}` | weapons | audio, hud |
| `weapon-reload-start` | `{weapon, duration, empty}` | weapons | audio, hud |
| `weapon-reload-end` | `{weapon}` | weapons | audio |
| `weapon-switch` | `{weapon, prev}` | weapons | hud, audio |
| `ammo-pickup` | `{weapon, amount, pos}` | weapons [T2] | hud, audio |
| `resupply` | `{}` | waves (crate used; waves calls `station.crate.setArmed(false)` + `setOpen(true)` itself) | hud, audio |
| `spawn-door-open` / `spawn-door-close` | `{id, pos}` | station | audio |
| `light-flicker` | `{index, pos, kind:'flicker'\|'sputter'}` | lighting | audio |
| `emergency-start` / `emergency-end` | `{}` | lighting | audio (alarm chime) |
| `debug-message` | `{text}` | any | hud (toast) |

### 1.9 RNG and determinism

`utils.mulberry32(seed)` → `rng()` ∈ [0,1) with `rng.range(a,b)`, `rng.int(n)` (0..n−1), `rng.pick(arr)`, `rng.sign()`,
`rng.gauss()`, `rng.seed(n)`, `rng.state()`. **Two generators**: `G.rngBuild` (seed = `?seed=` or 1337, used by all
procedural *construction*: textures, prop placement, flicker schedules, posters) and `G.rng` (gameplay: spawns, spread,
AI jitter, effects; seed = the same value, reseeded by `__game.seed(n)` **without** rebuilding textures). Two runs with
the same seed and API sequence produce identical `getState()`, `getEnemies()`, `getEvents()`.

### 1.10 Pooling

`utils.Pool(capacity, factory)`: `acquire() → item` (**always returns**: an exhausted pool releases and returns its
oldest active item — "steal the oldest"), `tryAcquire() → item|null` (never steals), `release(item)`, `forEachActive(fn)`,
`active` count, `items[]`, `reset()`. Everything runtime-spawned is pooled and pre-added to the scene in `init()`: enemies
(32 — the one pool that uses `tryAcquire`, see §4.5.2 corpse eviction), tracers (96), casings (64), particles (2 × 4096
GPU), smoke sprites (48), muzzle flash planes (3), decals (holes 256 / splats 128 / pools 24), dropped mags (6), ammo boxes
(16 [T2]), positional audio voices (24 pooled `PannerNode` graphs, inside the 32-voice global cap of §7.1). Pools
`reset()` on restart. No geometry/material creation after `init()`. **Every pool is pre-added to the scene *visible with
something to draw* until the §2.3 warm-up render has run** (r185 `renderer.compile` only visits `traverseVisible`, and the
composer's render target selects different programs than the screen — so the warm-up is one real `renderOnce()` with one
instance of everything showing; only afterwards may pools empty themselves via `count = 0` / `drawRange 0` / scale 0).

### 1.11 Performance budgets (measured by `test/perf.js`, 24 alive + 10 corpses, 1080p)

| Item | Budget | Notes |
|---|---|---|
| Draw calls | ≤ 400 (target 300) | station ≤ 70 merged/instanced, props ≤ 50, tunnels ≤ 12, train ≤ 60, **enemies 2 each** (material group + `eyeGlow` group; 24 alive + 10 corpses = 68) + 1 blob shadow batch, effects ≤ 10, viewmodel ≤ 6, **glow batches ≤ 3** (§3.6.4) + individual sprites ≤ 8 (train lenses/tails), post 5 |
| Triangles | ≤ 1.5 M (target 900 k) | enemy ≤ 3.5 k; station ≤ 350 k; tunnels ≤ 120 k; train ≤ 120 k; props ≤ 250 k |
| Real lights | **17** exactly (see §3.6.2) | no `castShadow` anywhere; `renderer.shadowMap.enabled = false`; all direct scene children; the count never changes at runtime (`BUDGET.lights`) |
| Textures | `renderer.info.memory.textures` ≤ **260** (`BUDGET.textures`; includes composer/bloom/SMAA/PMREM/luminance render targets and one bone texture per SkinnedMesh); registry GPU textures (`textures.getTextureStats().gpuTextures`) ≤ **180** (`BUDGET.canvasTextures`); ≤ **250 MB** GPU estimate | hero colour maps 1024²; **normal/roughness maps of non-hero surfaces 512²**; enemy-atlas roughness 512²; registry cached by name |
| Shader programs | ≤ **64** (`BUDGET.programs`) | post alone ≈ 13 (bloom 8, SMAA 3, output, grade); fog on/off doubles the sprite/basic variants; share materials; clone only for per-object uniforms |
| **Init time** | ≤ **5 s** on a desktop GPU (the real budget, `BUDGET.initMsDesktop`, measured with `?debug=1`); headless SwiftShader at 1280×720: **informational** — `BUDGET.initMsHeadless` = 45 000 ms is a *warning* threshold in smoke/perf, never a failing assertion (SwiftShader's shader JIT alone costs 100–500 ms per program × ~60 programs, plus ~170 canvas textures with mipmaps, PMREM and the AO bakes — a hard assert there would only produce spurious reds); `waitReady(90000)` stays | measured boot → `ready` (`getPerf().initMs`, per-generator timings via `getInitTimings()`); rules: **fbm is evaluated once** into cached 256² noise tiles (`textures.noiseTile(seed, octaves)`), generators sample the tile with a per-texture rotation/offset/scale instead of calling noise per pixel; per-pixel work uses one `ImageData` pass per map; vertex AO bakes ≤ 1.5 s total (occluder lists per element, ≤ 3 k vertices per bake); PMREM once; no generator > 400 ms on SwiftShader (`dev/textures.html` prints the table) |
| Update CPU | ≤ 4 ms per tick with 24 enemies | flow field ≤ every 0.25 s; spatial hash for separation |
| GPU frame | ≤ 14 ms @ 1080p on GTX 1660-class | bloom half-res, SMAA, no SSAO |
| Allocation | zero per tick in steady state | scratch vectors, pools |

Quality: `post.setQuality('low'|'high')`; `?lowfx=1` = pixel ratio 1, bloom quarter-res, no SMAA, no dust motes — **only ever on
explicit request**. `headless` (see §9.1) implies **pixel ratio 1 and nothing else**: the full post chain (bloom half-res, SMAA, grade)
and the dust motes stay on. Rationale: the verification agents load `/` with no flags and judge "beautifully detailed / impressive"
from that frame, and in manual mode rendering happens only on `step()`/`renderOnce()` (§1.7), so per-frame GPU cost on SwiftShader
affects neither correctness nor determinism. `?post=0` (alias of `?nopost=1`) is the opt-out; `?post=1` is accepted and a no-op.
Pixel ratio (high quality, not headless) = `min(devicePixelRatio, POST.maxPixelRatio)`,
**capped at 1.0 when `innerWidth × devicePixelRatio > POST.maxPixelWidth` (2560)** so DPR-2 laptops do not render 2.25× the fragments.

### 1.12 Code conventions

* ES2022 modules, **named exports only**. `import * as THREE from 'three'`; addons via `'three/addons/<path>.js'`.
  2-space indent, semicolons, `const` by default. JSDoc typedefs for exported shapes.
* Every **system** exports one class: `constructor(G)` (store `G` only), `init()`, `update(dt)`, optional `render()`,
  `reset()`, `dispose()`. Systems never import other system modules; they reach each other via `G.<system>` from
  `init()` onward and via `G.bus`. Leaf modules (importable by anyone): `constants.js`, `bus.js`, `utils.js`,
  `collision.js`, `textures.js`, `materials.js`. Helper modules importable only by their owner: `rig.js` (enemies),
  `viewmodels.js` (weapons).
* Module-level scratch: `const _v1 = new THREE.Vector3();` — no allocations in `update`/`render`.
* Scene-graph rules: `createContext` does `scene.add(camera)` (the viewmodel is a camera child and would otherwise never
  render); every light and every `SpotLight.target` is a direct child of `scene`; nothing that must keep rendering is ever
  parented under an object whose `visible` flag or presence in the scene changes (park it far away instead).
* Layers (`LAYERS`): viewmodel meshes `layers.set(LAYERS.VIEWMODEL)` (exclusively); effect pools (tracers, casings, mags, both
  `Points`, smoke sprites, flash planes, dust motes), decals, blob shadows and enemies `layers.set(LAYERS.NO_ENV)` — **exclusively,
  not also on 0**: the layer test is a bitmask OR, so anything left on layer 0 would still be rendered by a layer-0 camera and the
  guarantee below would be false; the main camera `layers.enable(VIEWMODEL)` + `layers.enable(NO_ENV)` (it renders 0 | 1 | 2); the
  env-capture `CubeCamera` and the luminance sampler camera render layer 0 only (`layers.set(0)`), so the gun, effects and enemies
  are never baked into the environment map or the luminance reading. Lights are not layer-filtered in r185 — nothing to do there.
* Static meshes: `matrixAutoUpdate = false`, `updateMatrix()` once. Per-frame instanced pools: `instanceMatrix.setUsage(DynamicDrawUsage)`.
* Colours: hex ints; colour textures `colorSpace = SRGBColorSpace`; data textures `NoColorSpace`.
* If a spec point is ambiguous, pick the simplest reading that keeps the API and add `// DESIGN NOTE:` at the top of the module.
* Nobody edits another agent's file; signature changes go through the integrator and this document.

### 1.13 `src/constants.js` (verbatim — the integrator writes this exactly; all others import from it)

```js
import * as THREE from 'three';

export const FIXED_DT = 1 / 60;
export const MAX_SUBSTEPS = 4;
export const DEFAULT_SEED = 1337;
export const VERSION = '1.0.0';

// ---- World layout (metres) -------------------------------------------------------------------
export const PLATFORM = { xMin: -30, xMax: 30, zMin: -5, zMax: 5, y: 0, thickness: 0.30 };
export const TACTILE = { inner: 4.4, outer: 5.0 };
export const EDGE_BARRIER = { zInner: 4.95, zOuter: 5.30, yMin: -1.2, yMax: 2.5, xMin: -30.5, xMax: 30.5 };
export const TRACK = { centerZ: 6.65, gauge: 1.435, bedY: -1.10, railTopY: -0.95, thirdRailZ: 8.35, thirdRailY: -0.85,
  zMin: 5.0, zMax: 9.0, xMin: -160, xMax: 160, tieSpacing: 0.6, troughW: 0.4, troughD: 0.25 };
export const WALLS = { z: 9.0, xMin: -32, xMax: 32, yMin: -1.10, yMax: 4.20 };
export const WALL_BANDS = [ // [yFrom, yTo, materialName]
  [-1.10, 0.00, 'concreteRaw'], [0.00, 0.45, 'tileBase'], [0.45, 2.40, 'tileWhite'],
  [2.40, 2.95, 'mosaicName'], [2.95, 3.40, 'tileWhite'], [3.40, 4.20, 'concretePainted'] ];
export const CEILING_Y = 4.20;
export const BEAMS = { x0: -27, pitch: 4.5, count: 13, w: 0.5, y0: 3.80, y1: 4.20 };
export const COLUMNS = { x0: -27, pitch: 4.5, count: 13, z: 3.0, r: 0.17, plinth: 0.55, plinthH: 0.25, top: 3.80, colliderR: 0.28 };
export const TROFFERS = { x0: -24.75, pitch: 4.5, count: 12, z: 1.8, y: 3.55, w: 1.25, h: 0.10, d: 0.30 };   // 24 platform fixtures, indices 0..23
export const MEZZ_TROFFERS = { xs: [38.5, 44.5], zs: [-3.0, 3.0], y: 7.55, count: 4, firstIndex: 24 };      // 4 mezzanine fixtures, indices 24..27 (§3.6.3); same w/h/d
export const BENCHES = { xs: [-24.75, -15.75, -6.75, 6.75, 15.75, 24.75], z: 0, len: 1.8, w: 1.0, h: 0.85 };
export const TRASH_CANS = { xs: [-22.5, -13.5, -4.5, 4.5, 13.5, 22.5], zAbs: 2.35, r: 0.30, colliderR: 0.32 };
export const VENDING = { x: 9.0, z: -2.30, w: 0.95, h: 1.85, d: 0.80 };
export const CRATE = { pos: [0, 0, -2.45], w: 0.8, h: 1.7, d: 0.45, interactDist: 1.6, interactCosAngle: 0.766 };
export const HANGING_SIGNS = { xs: [-13.5, 13.5], zs: [-2.0, 2.0], yBottom: 2.90, w: 1.2, h: 0.4 };
export const POSTERS = { x0: -24, pitch: 8, count: 7, yBottom: 0.45, w: 1.4, h: 1.9 };
export const DRAINS = { xs: [-15, 15], zs: [-2.5, 2.5] };
export const STAIR = { xLanding0: 30, xRun0: 30.6, xRun1: 37.8, xTop1: 39, rise: 4.8, halfW: 1.2, wallHalfW: 1.35, wallT: 0.30, risers: 24 };
export const MEZZ = { xMin: 30, xMax: 48, zMin: -6, zMax: 6, y: 4.8, slabT: 0.30, ceilY: 8.2, wellZ: 1.5 };
export const TURNSTILES = { x: 41.5, zs: [-3, -2, -1, 0, 1], housingW: 0.9, housingH: 1.0, housingT: 0.2, gateZ: [1.2, 3.4],
  railZ: [[3.4, 6], [-6, -3.1]], railT: 0.05, railH: 1.0 };
// Mezzanine dressing positions (props.js) — all outside NAV_KEEP_CLEAR (see §1.2); [x, z] on the mezzanine floor (y 4.8)
export const MEZZ_PROPS = {
  booth: { x: 44.5, z: -4.2, w: 2.2, d: 1.6, h: 2.4 },
  fareMachines: [{ x: 47.5, z: 2.2 }, { x: 47.5, z: 3.2 }], fareMachine: { w: 0.6, d: 0.6, h: 1.6 },   // face -X
  vending: [{ x: 47.5, z: -4.0 }, { x: 47.5, z: -2.8 }],                                                // face -X
  benches: [{ x: 34.0, z: 4.5 }, { x: 34.0, z: -4.5 }],
  cans: [{ x: 37.0, z: 5.4 }, { x: 37.0, z: -5.4 }],
  stanchions: [[43.0, -1.2], [43.0, -2.4], [44.2, -1.2], [44.2, -2.4]], stanchionR: 0.15,
  map: { x: 34.5, z: 5.92, size: 1.6, yBottom: 5.6 }, payphones: { x: 37.0, z: -5.85, count: 3 },
  mopBucket: [47.2, 5.2], wetFloorDown: [47.0, 4.0], manhole: [35.0, 3.5], extinguisher: [30.1, -4.0],
};
// Door -> gate -> landing route. No PLAYER/ENEMY/NAV collider may intrude (turnstile line excepted); asserted by nav.build().
export const NAV_KEEP_CLEAR = [ { xMin: 37.8, xMax: 42.5, zMin: -0.6, zMax: 3.4 }, { xMin: 42.0, xMax: 46.0, zMin: 1.0, zMax: 5.7 } ];
export const SHUTTER = { x: 48, zMin: -1.5, zMax: 1.5, yMin: 4.8, yMax: 7.2 };
export const MEZZ_DOOR = { x: 44, z: 6.0, w: 1.2, h: 2.2, recess: 0.8 };   // recess floor x ∈ [43.4, 44.6], z ∈ (6, 6.8] is walkable at MEZZ.y (§1.3); leaf + recess walls are colliders tagged 'door' (§3.4)
export const WEST_FENCE = { x: -30, h: 2.2, gateZ: [-0.6, 0.6], hingeZ: 0.6 };
export const CATWALK = { xMin: -42, xMax: -30, halfW: 0.6, doorX: -42 };
export const TUNNEL = { segLen: 6, count: 21, xStart: 32, ceilY: 3.9, columnPitch: 1.5, columnFromX: 44, columnSize: 0.25,
  lampX0: 38, lampPitch: 12, lampY: 3.0, signalXs: [44, 80], signalY: 3.0, endCapX: 160,
  centerFloor: { zHalf: 5.0, y: -1.10, eastX0: 30, westX1: -30 }, divider: { zHalf: 0.3, y0: -1.10, y1: -0.20, fromX: 44 } };
export const SPAWN_POINTS = {
  'mezz-door': { kind: 'door', pos: [44, 4.8, 6.55], yaw: Math.PI, exitDir: [0, 0, -1], exitDist: 1.8 },
  'west-gate': { kind: 'gate', pos: [-30.9, 0, 0], yaw: -Math.PI / 2, exitDir: [1, 0, 0], exitDist: 2.0 },
};
export const PLAYER_SPAWN = { pos: [0, 0, 0], yaw: -Math.PI / 2, pitch: 0 };

// ---- Lighting / atmosphere ---------------------------------------------------------------------
export const LIGHTS = {
  hemi: { sky: 0xa9c4b0, ground: 0x2a1e14, intensity: 0.25 },
  platform: { xs: [-22.5, -15, -7.5, 0, 7.5, 15, 22.5, 30], y: 3.40, z: 0, color: 0xd6f0d9, intensity: 30, distance: 14, decay: 2 },
  mezz: { x: 41, y: 7.60, z: 0, color: 0xd6f0d9, intensity: 28, distance: 14, decay: 2 },   // the 17th light: upper treads, top landing, turnstile line, mezzanine floor (§3.6.2)
  wallLamps: [{ x: -9, y: 3.40, z: -8.7 }, { x: 9, y: 3.40, z: 8.7 }],
  wallLamp: { color: 0xffe2b8, intensity: 8, distance: 7, decay: 2 },
  sodium: [{ x: -38, y: 3.0, z: -8.8 }, { x: 38, y: 3.0, z: 8.8 }],
  sodiumLamp: { color: 0xff9a2a, intensity: 14, distance: 12, decay: 2 },
  emergency: { xs: [-15, 15], y: 3.40, z: 0, color: 0xff2a1a, intensity: 18, hz: 1.0, onTime: 0.2 },
  muzzle: { color: 0xffb050, distance: 10, decay: 2 },
  trainSpot: { color: 0xe6f0ff, intensity: 3000, angle: 0.35, penumbra: 0.6, distance: 90, decay: 2 },
  total: 17,   // hemi 1 + platform 8 + mezz 1 + wall 2 + sodium 2 + train spots 2 + muzzle 1 (§3.6.2)
};
export const FIXTURE_STATES = { steady: 16, flicker: 3, dead: 3, dying: 2 };  // of the 24 PLATFORM troffers (0..23), assigned by G.rngBuild; mezz fixtures 24..27 are steady except 26 = flicker (§3.6.3)
export const FOG = { color: 0x05070b, density: 0.018 };
export const ENV = { size: 128, intensity: 0.6, capturePos: [0, 1.6, 0] };   // intensity = scene.environmentIntensity, the FALLBACK for materials without their own envMap; every registry material carries envMap + its own §3.2 envMapIntensity (default 0.6) — §2.9
export const POST = { bloomStrength: 0.45, bloomRadius: 0.4, bloomThreshold: 0.9, exposure: 1.0,
  vignette: 0.45, grain: 0.06, ca: 0.0018, saturation: 0.92, maxPixelRatio: 1.5, maxPixelWidth: 2560 };

// ---- Player --------------------------------------------------------------------------------------
export const PLAYER = { radius: 0.35, height: 1.8, eyeHeight: 1.65, walkSpeed: 4.2, sprintSpeed: 6.6, backFactor: 0.85,
  accel: 40, friction: 12, stepHeight: 0.35, maxHealth: 100, regenDelay: 6.0, regenRate: 5.0, lowHealth: 30,
  fov: 75, sprintFov: 80, adsFov: 55, near: 0.07, far: 260, mouseSens: 0.0022, maxPitch: 1.45,   // near 0.07: depth precision for the 3–6 mm surface offsets at 40–60 m (§0.3, Appendix A); the viewmodel stays ≥ 0.12 m away
  bobWalkHz: 1.9, bobSprintHz: 2.6, bobAmpWalk: 0.035, bobAmpSprint: 0.05, bobLatWalk: 0.02, bobLatSprint: 0.03,
  footstepEvery: 0.55, deathCamTime: 0.8, deathFreezeAfter: 1.5 };

// ---- Weapons -------------------------------------------------------------------------------------
export const WEAPONS = {
  pistol:  { id: 'pistol', name: 'PISTOL', mode: 'semi', damage: 34, headMult: 3.0, rpm: 420, mag: 15, reserve: 90, maxReserve: 135,
             pellets: 1, spreadDeg: 0.5, moveSpreadDeg: 0.7, bloomDeg: 0.35, maxBloomDeg: 2.5, bloomRecoverDegPerS: 5, bloomDelay: 0.08,
             fullRange: 15, minRange: 35, minFactor: 0.7, kickPitchDeg: 1.3, kickYawDeg: 0.35, kickRamp: 0.04, kickRecover: 0.14,
             vmKickBack: 0.045, vmKickUpDeg: 2.5, reload: 1.35, reloadEmpty: 1.65, reloadTransfer: 0.70, lower: 0.22, raise: 0.28,
             raiseAfterSprint: 0.12, flashScale: 0.35, flashLight: 8, tracerRadius: 0.012, tracerLen: 0.9, casing: 'brass9', sfx: 'pistolShot' },
  rifle:   { id: 'rifle', name: 'CARBINE', mode: 'auto', damage: 24, headMult: 2.0, rpm: 720, mag: 30, reserve: 150, maxReserve: 270,
             pellets: 1, spreadDeg: 1.1, moveSpreadDeg: 0.9, bloomDeg: 0.28, maxBloomDeg: 4.0, bloomRecoverDegPerS: 6, bloomDelay: 0.06,
             fullRange: 22, minRange: 45, minFactor: 0.6, kickPitchDeg: 1.1, kickYawDeg: 0.3, kickRamp: 0.03, kickRecover: 0.11,
             vmKickBack: 0.03, vmKickUpDeg: 1.6, reload: 2.1, reloadEmpty: 2.5, reloadTransfer: 0.70, lower: 0.28, raise: 0.32,
             raiseAfterSprint: 0.15, flashScale: 0.45, flashLight: 10, tracerRadius: 0.012, tracerLen: 0.9, casing: 'brass556', sfx: 'rifleShot' },
  shotgun: { id: 'shotgun', name: 'SHOTGUN', mode: 'pump', damage: 13, headMult: 1.5, rpm: 65, mag: 6, reserve: 30, maxReserve: 48,
             pellets: 9, spreadDeg: 0.8, moveSpreadDeg: 0.6, bloomDeg: 1.2, maxBloomDeg: 3.0, bloomRecoverDegPerS: 4, bloomDelay: 0.15,
             patternRingDeg: [1.6, 2.3], patternRingCount: [3, 5], patternJitterDeg: 0.3,   // 1 centre + 3 @1.6deg + 5 @2.3deg; worst case 2.6deg pattern-only
             fullRange: 6, minRange: 18, minFactor: 0.25, kickPitchDeg: 4.0, kickYawDeg: 0.8, kickRollDeg: 0.6, kickRamp: 0.06, kickRecover: 0.26,
             vmKickBack: 0.09, vmKickUpDeg: 5.0, shotTime: 0.12, pumpTime: 0.80, pumpEjectAt: 0.25,
             reloadStart: 0.35, reloadShell: 0.55, reloadShellTransfer: 0.60, reloadEnd: 0.40, lower: 0.30, raise: 0.38,
             raiseAfterSprint: 0.18, flashScale: 0.7, flashLight: 18, tracerRadius: 0.006, tracerLen: 0.5, casing: 'hull12', sfx: 'shotgunShot' },
};
export const WEAPON_ORDER = ['pistol', 'rifle', 'shotgun'];
export const VIEWMODEL = { scale: 0.9, wallPushDist: 1.2, wallPushLower: 0.18, wallPushPitchDeg: -25 };   // §3.7 wall-push pose
export const RIFLE_PATTERN = [ // [pitchDeg, yawDeg] per consecutive shot; resets after 0.35 s without firing
  [1.10, 0.00], [1.15, 0.10], [1.20, -0.15], [1.20, 0.30], [1.10, 0.40], [1.00, 0.20],
  [0.95, -0.30], [0.90, -0.50], [0.85, -0.40], [0.85, 0.10], [0.80, 0.50], [0.80, 0.60] ];
export const GROUP_MULT = { torso: 1.0, arm: 0.75, leg: 0.75 };   // limbs; the head multiplier comes from damageMultiplier() below
/** THE ONE damage-multiplier function. weapons.js calls it when it computes the FINAL damage (§4.3); enemies.applyDamage never applies
 *  any multiplier (§2.20). head = min(WEAPONS[id].headMult, ENEMY_TYPES[type].headMultCap) (brute cap 1.5); torso 1.0; arm/leg 0.75. */
export function damageMultiplier(group, weaponId, enemyType) {
  if (group === 'head') return Math.min(WEAPONS[weaponId].headMult, ENEMY_TYPES[enemyType].headMultCap);
  return GROUP_MULT[group] ?? 1.0;
}
export const RECOIL = { holdTime: 0.05, vmSpringK: 220, vmSpringD: 18, vmRotK: 260, vmRotD: 20 };
export const BALLISTICS = { maxDist: 120, tracerSpeed: 280, tracerMinDist: 1.5, tracerMinTime: 0.035, tracerMaxTime: 0.11 };

// ---- Enemies -------------------------------------------------------------------------------------
export const ENEMY_TYPES = {
  shambler: { hp: 100, speed: 1.35, speedVar: 0.15, turnRateDeg: 180, radius: 0.35, attackRange: 1.5, damage: 12,
              windup: 0.45, active: 0.15, recover: 0.60, cooldown: 0.4, staggerThreshold: 30, staggerTime: 0.40, staggerCooldown: 1.5,
              headR: 0.14, headMultCap: 99, stride: 0.85, scale: 1.0, lean: 0.15, points: 1, vocalPitch: [0.9, 1.1],
              variants: ['commuter', 'worker', 'nurse'] },
  runner:   { hp: 70, speed: 4.4, speedVar: 0.10, turnRateDeg: 420, radius: 0.32, attackRange: 1.4, damage: 8,
              windup: 0.25, active: 0.12, recover: 0.45, cooldown: 0.3, staggerThreshold: 25, staggerTime: 0.35, staggerCooldown: 1.2,
              headR: 0.13, headMultCap: 99, stride: 1.7, scale: 0.97, lean: 0.42, points: 1, vocalPitch: [1.3, 1.5],
              variants: ['hoodie'], lunge: { minDist: 2.5, maxDist: 4.0, windup: 0.30, air: 0.35, recover: 0.8, speed: 7.5, apex: 0.35, damage: 14, range: 1.2, cooldown: 4.0 } },
  brute:    { hp: 450, speed: 1.1, speedVar: 0.05, turnRateDeg: 90, radius: 0.55, attackRange: 2.1, damage: 30, knockback: 4.0,
              windup: 0.70, active: 0.15, recover: 1.00, cooldown: 0.5, staggerThreshold: 90, staggerTime: 0.55, staggerCooldown: 3.0,
              headR: 0.17, headMultCap: 1.5, stride: 1.4, scale: 1.32, torsoW: 1.15, lean: 0.30, points: 3, vocalPitch: [0.55, 0.65],
              variants: ['brute'], charge: { minDist: 5, maxDist: 12, windup: 0.6, maxRun: 2.5, recover: 0.9, speed: 4.5, damage: 20, knockback: 5.0, cooldown: 8.0 } },
};
export const ENEMY = { poolSize: 32, corpseCap: 10, corpseTime: 9, corpseTimeBrute: 12, deathFallTime: 0.9, restTwitchTime: 0.4, sinkTime: 1.5, sinkDepth: 2.2,
  separationExtra: 0.35, exitSpeed: 1.6, waitingSway: 0.03, spawnTime: [0.6, 1.2], attackRing: 3, orbitDist: 2.4,
  hitFlashTime: 0.08, boundingR: 1.6, lodDistance: 45, vocalEvery: [3, 9], maxVoices: 6, hurtRateLimit: 0.25,
  flinchK: 140, flinchD: 15, limpK: 60, limpD: 9, heightVar: [0.94, 1.06] };

// ---- Waves ---------------------------------------------------------------------------------------
/** wave: [count, shamblers, runners, brutes, hpMult, speedMult, dmgMult, cadence, trainBatch, trainCadence, maxAlive, breather] */
export const WAVE_TABLE = [
  null,
  [ 5,  5,  0, 0, 1.00, 1.00, 1.00, 3.0,  0, 0,    8, 8],
  [ 8,  7,  1, 0, 1.00, 1.00, 1.00, 2.5,  8, 0.90, 10, 8],
  [11,  8,  3, 0, 1.05, 1.03, 1.00, 2.5, 11, 0.80, 12, 8],
  [14,  9,  4, 1, 1.10, 1.06, 1.10, 2.2, 14, 0.75, 14, 6],
  [18, 11,  5, 2, 1.15, 1.09, 1.15, 2.0, 18, 0.70, 16, 6],
  [22, 12,  7, 3, 1.20, 1.12, 1.20, 1.8, 20, 0.65, 18, 6],
  [26, 13,  9, 4, 1.30, 1.15, 1.30, 1.6, 22, 0.60, 20, 4],
  [30, 14, 11, 5, 1.40, 1.18, 1.40, 1.4, 24, 0.50, 22, 4],
  [35, 16, 13, 6, 1.50, 1.21, 1.50, 1.2, 26, 0.45, 24, 4],
  [40, 17, 15, 8, 1.60, 1.24, 1.60, 1.0, 28, 0.45, 24, 4],
];
export function waveConfig(n) {
  if (n <= 10) { const r = WAVE_TABLE[n]; return { wave: n, count: r[0], shamblers: r[1], runners: r[2], brutes: r[3], hpMult: r[4],
    speedMult: r[5], dmgMult: r[6], cadence: r[7], trainBatch: r[8], trainCadence: r[9], maxAlive: r[10], breather: r[11],
    source: n === 1 ? 'doors' : 'train' }; }
  const k = n - 10, count = 40 + 5 * k, brutes = 8 + k, runners = Math.round(0.38 * count);
  return { wave: n, count, shamblers: count - brutes - runners, runners, brutes, hpMult: 1.6 + 0.10 * k,
    speedMult: Math.min(1.5, 1.24 + 0.03 * k), dmgMult: 1.6 + 0.10 * k, cadence: Math.max(0.6, 1.0 - 0.05 * k),
    trainBatch: Math.min(count, 28 + 2 * k), trainCadence: 0.45, maxAlive: 24, breather: 4, source: 'train' };
}
export const WAVES = { introTime: 2.0, clearedTime: 3.0, wave1FirstSpawn: 2.0, sideStagger: 1.5, doorsCloseAfterBatch: 2.0,
  maxAliveHoldToClose: 6.0, lateArrivalDelay: 1.0 };
/** Track the train uses to deliver wave n (n >= 2): A when n is even, B when n is odd. Used by waves.js AND debug.skipToWave. */
export function trackForWave(n) { return n % 2 === 0 ? 'A' : 'B'; }

// ---- Train ---------------------------------------------------------------------------------------
export const TRAIN = { cars: 4, carLength: 14.4, carGap: 0.5, width: 3.0, height: 3.65, floorY: 0.0, roofY: 2.70, railTopY: -0.95,
  doorLocalX: [-4.8, 0, 4.8], doorW: 1.3, leafW: 0.65, doorH: 1.95, doorOpenTime: 1.2, doorCloseTime: 1.0,
  cruiseSpeed: 14, brakeDecel: 1.4, cruiseTime: 5.0, brakeTime: 10.0, startCenterX: -140, settleTime: 0.6, settleAmp: 0.10,
  chimeDelay: 0.8, doorsDelay: 1.4, departAccel: 1.2, goneX: 100, parkX: 300, tunnelMouthX: 32, windowsPerSide: 8, bogieInset: 3.2, wheelR: 0.42,
  headlightLocal: [[29.4, 1.9, -0.9], [29.4, 1.9, 0.9]], headlightAim: 60 };   // cab lens positions (train-local, car 3 +X end); spots aim +X local, 60 m ahead
export const TRAIN_LENGTH = TRAIN.cars * TRAIN.carLength + (TRAIN.cars - 1) * TRAIN.carGap;   // 59.1
export function trainCarCenterX(i) { const p = TRAIN.carLength + TRAIN.carGap; return -(TRAIN.cars - 1) * 0.5 * p + i * p; } // -22.35,-7.45,7.45,22.35
export const TRAIN_STATES = ['idle', 'arriving', 'stopped', 'doorsOpening', 'doorsOpen', 'doorsClosing', 'departing'];

// ---- Collision / nav -----------------------------------------------------------------------------
export const MASK = { PLAYER: 1, ENEMY: 2, BULLET: 4, NAV: 8, SOLID: 15, WALKERS: 3 };
export const NAV = { cell: 0.5, xMin: -30, zMin: -6, cols: 156, rows: 24, agentRadius: 0.3, recompute: 0.25,
  // nav.build() asserts finite distanceAt from PLAYER_SPAWN at these points (plus every docked train-door exit at |z| = 4.0)
  mustReach: [[44, 4.75], [-28.9, 0]] };

// ---- Effects -------------------------------------------------------------------------------------
export const FX = { tracers: 96, casings: 64, particles: 4096, smoke: 48, decalsHoles: 256, decalsSplats: 128, decalsPools: 24,
  dustMotes: 600, shaftMotes: 150, mezzMotes: 120, casingLife: 8, decalLife: 90, flashLife: 0.055, smokeLife: 0.6,
  decalOffset: 0.006, poolDelay: 0.6 };   // decals sit 6 mm off the surface (above the 5 mm tactile strip); pool 0.6 s after enemy-rest

// ---- Budgets / misc ------------------------------------------------------------------------------
export const BUDGET = { drawCalls: 400, triangles: 1_500_000, lights: 17, programs: 64,
  textures: 260,          // renderer.info.memory.textures (incl. render targets + bone textures)
  canvasTextures: 180,    // textures.getTextureStats().gpuTextures (registry only)
  gpuMB: 250, initMsHeadless: 45000, initMsDesktop: 5000, stepMs: 8 };   // initMsHeadless is a WARNING threshold (§1.11), initMsDesktop the real budget
export const LAYERS = { DEFAULT: 0, VIEWMODEL: 1, NO_ENV: 2 };   // §1.12: main camera renders 0|1|2; viewmodel on 1 EXCLUSIVELY; effects/decals/blob shadows/enemies on 2 EXCLUSIVELY; env/luminance cameras render 0 only
export const UP = new THREE.Vector3(0, 1, 0);
export const FONTS = {
  SIGN: 'bold 64px Helvetica, Arial, "Liberation Sans", "DejaVu Sans", sans-serif',
  MOSAIC: 'bold 200px Georgia, "Times New Roman", "DejaVu Serif", serif',
  STENCIL: '900 96px Impact, "Arial Black", "DejaVu Sans", sans-serif',
  MONO: 'bold 48px "Courier New", "DejaVu Sans Mono", monospace',
};
```

---------------------------------------------------------------------------------------------------

## 2. MODULE CONTRACTS

### 2.0 File layout, ownership, line budgets

```
index.html                 Integrator     ~90    importmap, canvas, static HUD DOM (ids in §8.1)
style.css                  Integrator     ~180   HUD/overlay styles
src/constants.js           Integrator     ~240   §1.13 verbatim
src/bus.js                 Integrator     ~60    Bus + event ring buffer
src/utils.js               Integrator     ~320   rng, math, Pool, SpatialHash, Spring, geometry helpers, ray tests, bakeVertexAO, bakeVertexPool
src/collision.js           Integrator     ~260   Colliders registry, raycast, circle resolve
src/main.js                Integrator     ~320   boot (two-phase construct/init), G, loop, opts, restart, resize, error capture
src/input.js               Integrator     ~170   keyboard/mouse → InputState; debug injection
src/debug.js               Integrator     ~320   window.__game
src/hud.js                 Integrator     ~340   DOM HUD, screens, hit markers, arcs, vignette
src/textures.js            Agent-TEX      ~1300  canvas helpers + noise tiles + every texture generator (~60 named recipes, §3.1) + getTexture registry
src/materials.js           Agent-TEX      ~280   MAT registry (getMaterial), aoStrip, env capture (no AO bake — that is utils)
src/decals.js              Agent-TEX      ~200   bullet holes / blood splats / pools (instanced ring buffers)
src/station.js             Agent-STATION  ~1400  platform, tracks, central floor, walls, ceiling, columns, tunnels (21 × 2 segments), stair, mezzanine (+ door recess, light pools), west end, colliders, floorHeightAt, spawn doors, crate, AO
src/props.js               Agent-STATION  ~850   benches, cans, vending, signs, posters, flyers/stickers, litter, cables, ducts, grilles, puddles, mezzanine dressing, 28 troffer housings, animated props
src/lighting.js            Agent-LIGHT    ~500   17 lights, 28 fixtures + states, glow batches, shafts, signals, emergency beat, env capture call, fog
src/post.js                Agent-LIGHT    ~210   composer chain, GradeShader, quality, resize, sampleLuminance
src/particles.js           Agent-LIGHT    ~480   GPU Points particles, tracers, casings, muzzle flash, smoke, dust motes, blob shadows
src/player.js              Agent-PLAYER   ~380   look, move, collide, bob, health, damage, death camera
src/weapons.js             Agent-PLAYER   ~700   3 weapon state machines, firing, ballistics, recoil, reload/pump/switch timelines, ammo
src/viewmodels.js          Agent-PLAYER   ~480   procedural gun + hand meshes, part poses
src/rig.js                 Agent-ENEMY    ~450   bone hierarchy, merged skinned geometry, hit capsules, animation clips
src/enemies.js             Agent-ENEMY    ~850   pool, AI/steering, hit volumes, damage, death, vocals, blob shadows
src/nav.js                 Agent-TRAIN    ~240   flow field + reachability assertion
src/train.js               Agent-TRAIN    ~620   train model, interior, doors, analytic motion, headlight driving, colliders, door spawn points
src/waves.js               Agent-WAVES    ~380   wave state machine, spawn queue, train orchestration, resupply, stats, game over
src/audio.js               Agent-WAVES    ~720   WebAudio engine, buses, reverb, positional voices, all recipes, bus subscriptions
test/harness.js            (exists)       —      withGame(fn, opts): serves root, launches SwiftShader Chromium
test/smoke.js              Agent-TRAIN    ~260   end-to-end: boot → nav → wave 1 → shoot → train → wave 2 → skip → game over → restart
test/perf.js               Agent-TRAIN    ~100   renderer.info budgets at wave 8
test/shots.js              Agent-LIGHT    ~140   screenshot checklist (§10.3) → test/shots/*.png
dev/*.html                 any agent      opt.   standalone harness pages (§2.27 template; not counted)
```
**Tier-1 game code ≈ 12.4 k + tests ≈ 0.5 k ≈ 12.9 k; hard ceiling 13.5 k** (`wc -l src/*.js index.html style.css test/*.js`).
The brief says "roughly 6 k–12 k"; **a Tier-1 total of ~13 k is accepted** — the per-file budgets above are sized to the recipe
tables they must implement (≈ 60 texture generators × 15–20 lines each incl. normal/roughness packing in §3.1; the §3.3/§3.4 element
list plus 42 tunnel segments, the stair, the mezzanine, colliders and AO in `station.js`), so no agent starts from an unfundable list
and no §3.9 MUST-HAVE detail is cut to hit a round number. Per-file figures are Tier-1 estimates with ±20 % tolerance; a file at
> 1.5× its budget means stop and talk to the integrator (prefer shorter recipes / fewer sub-variants *of the same item* over dropping
items). T2 adds ≤ 1.5 k on top (§0.2 gate; ≤ 15 k with tests). Tiering follows the single rule of §0.2: nothing in the module
descriptions below is optional at Tier 1 unless it is tagged `[T2]`/`[T3]` **where it is described**; the budgets assume dense,
table-driven code (loops over `constants` tables, not hand-unrolled geometry).

Agent packages (7 parallel agents): Integrator; TEX; STATION; LIGHT; PLAYER; ENEMY; TRAIN (+ nav, tests); WAVES (+ audio).
If fewer agents: merge LIGHT into TEX, TRAIN into STATION.

### 2.1 The context object `G` (built by `main.createContext`; fields added only by the integrator)

```js
G = {
  opts,              // { headless, manual, nopost, post, lowfx, debug, seed, viewer, wave, quality, audio }  (§2.3 parseOpts; `audio` is read by audio.init(), §2.24)
  bus,               // Bus
  rng, rngBuild,     // mulberry32 instances (§1.9)
  time: 0, frame: 0,
  renderer, scene, camera, canvas, hudRoot, overlayRoot,
  colliders,         // collision.Colliders
  envMap: null,      // set by lighting.init() (PMREM texture); scene.environment is set too
  stats,             // { shotsFired, shotsHit, headshots, kills, killsByType:{}, damageDealt, damageTaken, wavesCleared, bestStreak, timeSurvived }
  started: false, paused: false, gameOver: false, manual: false, lowHealth: 0,
  renderDirty: false, // manual mode: RAF renders only when true (§1.7)
  hooks,             // { start(opts), restart(), stepOnce(), renderOnce() } — main.js's lifecycle functions, installed by createContext() so that
                     // debug.js and every system reach them through G (nobody imports main.js: it loads systems dynamically, a static import back would be a cycle)
  // systems, in init order (two-phase boot, see below):
  input, station, props, particles, decals, lighting, post, nav, player, weapons, enemies, train, waves, audio, hud,
};
```
**Two-phase boot.** Phase 1: `main.boot()` **constructs every system** (`new X(G)`; constructors store `G` and nothing
else) so that every `G.<system>` field exists before any `init()` runs. Phase 2: `init()` is called **in the order of the
list above**, and a system's `init()` may only call systems that appear **earlier** in that list (later ones exist but are
uninitialised — touching them is a bug). Hence: `particles`/`decals` are initialised before `player`/`weapons`/`enemies`
(blob-shadow indices, tracer/casing pools, decal buffers), `nav.init()` runs after station/props registered colliders and
before enemies, `lighting.init()` runs after station/props/particles so the env capture sees geometry (and after
`particles` so the shaft-mote anchors exist), `train.init()` after lighting (`getTrainSpots`), `audio.init()` after props
(`getHumSources`), `hud.init()` last (touches `post`, `weapons`, `waves`). The **tick order** in §1.7 is different on purpose
(gameplay dependencies, not construction ones). Environment vs. creation order: `materials.captureEnvironment(G)` (called from
`lighting.init()`) assigns the PMREM texture as **`material.envMap`** on every registry material handed out so far, and
`getMaterial`/`cloneMaterial` apply it to every material created afterwards (weapons, enemies, train init later), so creation order
does not matter — but do **not** rely on `scene.environment` alone: r185 overwrites `envMapIntensity` with `scene.environmentIntensity`
for any material whose own `envMap` is null (§2.9). `initMaterials(G.renderer, G.opts.seed)` (which calls `initTextures`) runs right
after `createContext` and before phase 1.

### 2.2 `index.html` (Integrator) — see §8.1 for the exact DOM
```html
<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Ashworth St</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="style.css">
<script type="importmap">{"imports":{"three":"./vendor/three/three.module.js","three/addons/":"./vendor/three/addons/"}}</script>
</head><body><canvas id="c"></canvas><div id="hud">…§8.1…</div><div id="overlay">…§8.1…</div>
<script type="module" src="./src/main.js"></script></body></html>
```

### 2.3 `src/main.js` (Integrator)
```js
export function parseOpts(search) -> opts
  // headless = ?headless=1 || (navigator.webdriver === true && ?headless !== '0'); manual = headless
  // lowfx = ?lowfx=1 ONLY (headless does NOT imply lowfx — §1.11); nopost = ?nopost=1 || ?post=0; post = !nopost (?post=1 is accepted, a no-op)
  // audio = ?audio=0 ? false : !headless   (debug.disableAudio()/enableAudio() flip it — before or after audio.init(), which reads it; §2.24)
  // debug = ?debug=1; seed = int(?seed) || DEFAULT_SEED; viewer = ?viewer=1; wave = int(?wave) || 0; quality = lowfx ? 'low' : 'high'
export function createRenderer(canvas, opts) -> WebGLRenderer
  // antialias:false, powerPreference:'high-performance', preserveDrawingBuffer:false, toneMapping ACESFilmic, exposure POST.exposure,
  // outputColorSpace SRGB, shadowMap.enabled=false,
  // pixelRatio = (opts.lowfx || opts.headless) ? 1 : (innerWidth * devicePixelRatio > POST.maxPixelWidth ? 1 : min(devicePixelRatio, POST.maxPixelRatio))
export function createContext(canvas, opts) -> G          // renderer, scene, camera (fov PLAYER.fov, near/far; camera.layers.enable(1) + enable(2); **scene.add(camera)**), bus, rng, rngBuild, colliders, stats,
                                                           // G.hooks = { start: o => start(G, o), restart: () => restart(G), stepOnce: () => stepOnce(G), renderOnce: () => renderOnce(G) }
export async function boot() -> G                         // unless window.__NO_AUTOBOOT: createContext (hooks included), installDebugApi(G) (early: ready=false), initMaterials(renderer, opts.seed),
                                                           // phase 1: construct every system; phase 2: init in §2.1 order (each `await import()` in try/catch → NullSystem on failure),
                                                           // WARM-UP (the procedure below — one real renderOnce + one sampleLuminance, then pools empty themselves),
                                                           // start RAF, record getPerf().initMs + getPerf().programsBaseline, set __game.ready = true
export function start(G, { manual } = {})                  // idempotent; hides #start; if !headless && !manual: pointer lock (see below), audio.unlock() when G.opts.audio
                                                           // G.started = true; G.manual = manual ?? opts.manual; bus 'game-start'; waves.begin();
                                                           // then, if opts.wave >= 2 (?wave=N): debug.skipToWave(opts.wave) synchronously (the intro is skipped)
                                                           // the start-screen click handler calls start(G, {manual:false}); __game.start() calls start(G, {manual:true}) unless told otherwise
export function restart(G)                                 // **G.time = 0; G.frame = 0; bus.ring cleared (ringHead = 0); bus.time = 0**; G.gameOver = false; G.paused = false;
                                                           // waves.reset(); enemies.reset(); train.reset(); player.reset(); weapons.reset(); particles.reset(); decals.reset();
                                                           // lighting.reset(); station.reset(); props.reset(); hud.reset(); audio.reset(); nav.reset(); stats reset; bus 'game-restart'; waves.begin()
                                                           // (manual/real-time mode is preserved; the RNG is NOT reseeded — call __game.seed(n) for determinism runs)
export function stepOnce(G); export function renderOnce(G)   // §1.7; renderOnce clears G.renderDirty and bumps getPerf().renders
```
**Warm-up — the "no mid-game shader compile" guarantee (every agent's pools must cooperate).** `renderer.compile()` is *not*
sufficient in r185: it only visits `scene.traverseVisible()` (a pool hidden with `visible = false` is skipped) and it compiles for
the render target bound at call time (the composer renders into a HalfFloat target with tone mapping off — a different program
object than the screen variant), so the first enemy/tracer/decal would compile mid-game (100–500 ms hitches on SwiftShader) and
`test/perf.js` would see `programs` change. Therefore:
1. Every system's `init()` leaves its pooled objects **in the scene, visible, with something to draw**: `InstancedMesh` pools with
   `count ≥ 1` (one instance parked at y = −50 or scale 0), `Points` with `drawRange ≥ 1`, sprites/planes parked at y = −50;
   `enemies.init()` leaves **one enemy of each of the 5 palette variants** posed at y = −50 (both material groups); `decals.init()` one
   instance of each of the 3 kinds; `particles.init()` one tracer, casing, dropped mag, smoke sprite, all 3 flash planes, both `Points`
   with one particle each, the dust motes, the blob-shadow batch; `lighting.init()` the glow batches (`count ≥ 1` each), the 3 shafts,
   the tubes, strobe heads emissive; the train parked at `TRAIN.parkX` **visible** (§6.3) with its doors, lens sprites and interior;
   `weapons.init()` all three viewmodels (the two holstered ones at scale 0, not `visible = false`); `hud` irrelevant (DOM).
2. `boot()` then performs **one full `renderOnce(G)`** — the real chain (`post.render()`: composer + bloom + SMAA + grade; it counts
   toward `getPerf().renders`, §1.7) with all 17 lights present — followed by **one `post.sampleLuminance()`** (its layer-0 render to
   the luminance target compiles the target variants of the layer-0 materials). `getInitTimings().compile` measures both.
3. Only then does `boot()` call `warmupDone()` on every system that exports it (optional method) and pools hide their placeholders:
   **`count = 0` / `drawRange 0` / scale 0 / park at y = −50**. `visible = false` on a pooled object is allowed from here on (its program
   is cached on the material) but never on a light (§0.3) and never on the train (§6.3).
4. `getPerf().programs` right after step 2 is recorded as **`getPerf().programsBaseline`**; `test/perf.js` and smoke check 14 assert
   `programs === programsBaseline` at every later sample — an increase means someone's material/variant was missing from step 1.
Also owns: `resize` → renderer/camera/post.resize(w, h) + `G.renderDirty = true`; `visibilitychange` → `G.paused` (not in headless);
pointer lock change → pause overlay (not in headless/manual); **pointer-lock requests**: `canvas.requestPointerLock()` returns a
Promise in Chromium and a rejection (the ~1 s re-request cooldown after Esc, or a call outside a user gesture) would otherwise surface
as an `unhandledrejection` and pollute `__game.errors[]` during real play, so always request it as
`const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => G.hud.setHint('CLICK AGAIN TO RESUME'));` and treat
**`pointerlockerror`** the same way: the pause/start screen shows "CLICK AGAIN TO RESUME" (`hud.setHint`) and the next click
re-requests — no automatic retry loop;
global `error`/`unhandledrejection`/`console.error` mirrored into `__game.errors[]`; exceptions inside `stepOnce` are caught,
pushed to `errors`, and rethrown once. **Module loading**: `main.js` imports each system with `await import('./x.js')` inside
`try/catch`; a module that fails to import is replaced by a `NullSystem` (no-op `init/update/render/reset/dispose`, one
`console.warn`, name pushed to `__game.nullSystems[]`) so the page always boots (`import` statements at the top of `main.js`
would take the whole page down).
FPS: real-time mode = EMA over the last 30 RAF frames (wall clock allowed here) → `hud.setFps`, `getState().fps`; manual
mode = `1000 / renderMs` of the renders actually performed (§1.7) — never 0 after the first render.
**Standalone**: `node serve.js 8080`, open `/?debug=1`; with `?viewer=1` no enemies/waves and OrbitControls fly-through.

### 2.4 `src/input.js` (Integrator)
```js
export class Input {
  constructor(G); init(); update(); reset(); dispose();
  attach(domElement); detach();
  // per-tick state (read by player/weapons/waves):
  move: THREE.Vector2          // x = strafe (+right), y = forward (+forward = camera −Z); |v| ≤ 1; from WASD/arrows or setMove
  moveWorld: THREE.Vector2|null // debug: world-space XZ direction; update() converts it into `move` each tick using G.player.yaw
                               //   (strafe = dot(dir, right), forward = dot(dir, forward)) so the direction stays world-fixed while the player turns
  lookDelta: {x:number, y:number}   // accumulated mouse pixels since last tick (cleared in update); each event clamped ±200 px
                               // (no lookAbsolute: debug look injection writes player.setLook() directly, §2.16)
  sprint, fire, fireJustPressed, fireJustReleased, ads, reload, interact, restart: boolean
  switchTo: number             // -1 or 0..2 (1/2/3 keys → 0..2), wheel: +1 next / -1 prev via cycle: number, lastWeapon: boolean (Q)
  // debug entry points:
  setMove(strafe, forward); setMoveWorld(dx, dz|null); addLook(dx, dy); pressFire(); holdFire(bool); pressReload(); pressSwitch(index); pressInteract(); setSprint(b); setAds(b)
}
```
Keys: WASD/arrows, Shift sprint, LMB fire, RMB ADS [T2], R reload, 1/2/3 weapon, wheel cycle (debounced 120 ms), Q last,
E interact, Enter/click restart on game over, Esc = browser pointer-lock exit. Sensitivity `PLAYER.mouseSens` rad/px (×0.5 in ADS).
**Standalone**: `dev/player.html` prints the state object.

### 2.5 `src/utils.js` (Integrator)
```js
export function mulberry32(seed) -> rng              // rng(), .range(a,b), .int(n), .pick(arr), .sign(), .gauss(), .seed(n), .state()
export const clamp, lerp, damp(a,b,lambda,dt), smoothstep(e0,e1,x), easeInCubic, easeOutCubic, easeInOutCubic, easeOutBack, wrapAngle, lerpAngle, degToRad
export function yawFromDir(dx, dz) -> yaw; export function dirFromYaw(yaw, out:V3) -> out    // (-sin, 0, -cos)
export class Pool { constructor(n, factory); acquire() -> item (steals the oldest when exhausted); tryAcquire() -> item|null; release(item); forEachActive(fn); get active(); items[]; reset() }
export class SpatialHash { constructor(cell); clear(); insert(obj, x, z); query(x, z, r, out[]) -> out }
export class Spring { constructor(k, d); value, velocity, target; update(dt); impulse(v); reset() }      // scalar
export class Spring3 { constructor(k, d); value:V3, velocity:V3; update(dt); impulse(v:V3); reset() }
export function makeBox(w, h, d) -> BufferGeometry               // BoxGeometry with UVs scaled to metres (u *= size along that face)
export function makePlane(w, h) -> BufferGeometry                // PlaneGeometry (XY, +Z normal) with UVs in metres
export function transformGeo(geo, x, y, z, rx=0, ry=0, rz=0, sx=1, sy=1, sz=1) -> geo
export function mergeGeos(list, useGroups=false) -> BufferGeometry   // ensures every input has position/normal/uv/color; removes uv1/tangent
export function ensureColorAttr(geo, r=1,g=1,b=1)
export function bakeVertexAO(geo, occluders:{type:'box',min,max}|{type:'cyl',x,z,r,y0,y1}[], {radius=0.5, strength=0.45, floorY=null})
       // multiplies 'color' by (1 - strength * (1 - d/radius)) using distance from vertex to nearest occluder surface
       // THE ONLY implementation (materials.js has none); occluders pre-filtered by the caller to those within `radius` of the geometry's
       // bounding box; ≤ 3 k vertices per call; total bake time counts against the §1.11 init budget
export function setInstance(mesh, i, pos:V3, quat:Quaternion, scale:V3); export function hideInstance(mesh, i)
export function raySphere(o, d, c, r, maxDist) -> t|-1
export function rayCapsule(o, d, a, b, r, maxDist) -> t|-1
export function rayBox(o, d, min, max, maxDist, outNormal) -> t|-1
export function rayCylinderY(o, d, x, z, r, y0, y1, maxDist, outNormal) -> t|-1
export function circleVsBox(px, pz, r, min, max, out:{x,z}) -> bool     // writes pushed-out position
export function circleVsCircle(px, pz, r, cx, cz, cr, out) -> bool
export function closestPointSegment(p, a, b, out) -> out
export const TMP = { v1,v2,v3,v4:V3, q1:Quaternion, m1:Matrix4, e1:Euler, c1:Color }
```

### 2.6 `src/collision.js` (Integrator)
```js
export class Colliders {
  constructor(G);
  addStatic(c) -> c; addStaticBox(min[3], max[3], tag, surface, mask=MASK.SOLID) -> BoxCollider
  addStaticCyl(x, z, r, y0, y1, tag, surface, mask=MASK.SOLID) -> CylCollider
  removeStatic(c); setDynamic(key, list); clearDynamic(key)
  statics: Collider[]; dynamics: Map<string, Collider[]>
  raycast(origin:V3, dir:V3, maxDist, mask, out:RayHit) -> RayHit|null   // RayHit = { point:V3, normal:V3, dist, collider, surface, tag }
  resolveCircle(pos:V3, radius, mask, yFeet=pos.y, height=1.0, ignoreTags=null) -> pos   // 3 passes; mutates pos.x/z
  overlapsCircle(x, z, r, mask, yFeet=0, height=1.0) -> bool
  forEachInRange(xMin, xMax, mask, fn)
  debugGroup() -> THREE.Group      // wireframes (opts.debug)
}
```

### 2.7 `src/bus.js` (Integrator) — §1.8.

### 2.8 `src/textures.js` (Agent-TEX)
```js
export function initTextures(renderer, seed = DEFAULT_SEED)    // stores the build seed for rngFor() and renderer.capabilities.getMaxAnisotropy() for toTexture();
                                                               // called by materials.initMaterials(renderer, seed); safe to call once more with the same args
export function makeCanvas(w, h) -> { canvas, ctx }
export function rngFor(name) -> rng                            // mulberry32(hash(name) ^ buildSeed) — deterministic per texture; buildSeed from initTextures (DEFAULT_SEED before it)
export function noise2(x, y) -> [-1,1]; export function fbm(x, y, octaves=4, lac=2, gain=0.5) -> [-1,1]   // SimplexNoise seeded 12345 — use ONLY to build noise tiles
export function noiseTile(seed, octaves=4, size=256) -> Float32Array(size*size)   // cached seamless fbm tile in [0,1] (≤ 6 tiles total); generators sample it
export function sampleTile(tile, u, v, { rot=0, ox=0, oy=0, scale=1 }) -> number   // bilinear, wrapping; per-texture rotation/offset/scale hides the repetition
export function fillNoise(ctx, w, h, { scale, octaves, colorA, colorB, alpha })   // implemented with noiseTile/sampleTile in one ImageData pass — never per-pixel fbm()
export function grimeOverlay(ctx, w, h, { strength, bottomBias, rng })
export function drips(ctx, w, h, { count, color, maxLen, rng }); export function scratches(ctx, w, h, { count, color, maxLen, rng })
export function heightToNormal(heightCanvas, strength=2) -> HTMLCanvasElement       // Sobel → tangent-space RGB
export function packRoughMetal(roughCanvas, metalCanvas|null) -> HTMLCanvasElement  // G = roughness, B = metalness (three reads G/B)
export function toTexture(canvas, { srgb=true, repeat=[1,1], wrap=THREE.RepeatWrapping, aniso=true, mipmaps=true }) -> THREE.CanvasTexture
export function textOnCanvas(ctx, text, { font, size, color, x, y, align='center', letterSpacing=0, maxWidth, stroke, strokeWidth, rotate=0 })
export function lineBullet(letter, colorHex, size=256) -> HTMLCanvasElement
export function getTexture(name, variant=0) -> TextureSet     // ALWAYS the set object, even for single-map textures ({ map } or { alphaMap }); cached; generator table §3.1
/** @typedef {{ map?:THREE.Texture, normalMap?:THREE.Texture, roughnessMap?:THREE.Texture, metalnessMap?:THREE.Texture, emissiveMap?:THREE.Texture, alphaMap?:THREE.Texture }} TextureSet */
export const getTextureSet = getTexture                        // alias (same function) — kept so either name works
export function getTextureStats() -> { canvases, gpuTextures, estimatedBytes, timings:{name:ms} }   // gpuTextures counts CanvasTextures created; feeds getPerf()
export function disposeAllTextures()
export const TEXTURE_META   // name -> { size:[w,h], meters:[w,h]|null, maps:[...] }
export const TEXTURE_NAMES  // for dev/textures.html
```
Rules: colour maps sRGB; data maps `NoColorSpace`; anisotropy from `initTextures(renderer, seed)` (there is no `setRenderer`);
generators must use `rngFor(name)` only; fonts from `FONTS`. Tiling textures are seamless (draw with wrap-around or mirror the edge 8 px).
**Init budget** (§1.11): every generator is timed (`performance.now`, allowed here at init) into `getTextureStats().timings`; no
generator may call `fbm()`/`noise2()` per pixel — sample `noiseTile` instead; hero textures (1024²) ≤ 400 ms each on SwiftShader.
**Standalone**: `dev/textures.html` — grid of every texture on planes + every material on spheres, OrbitControls; prints the timing table.

### 2.9 `src/materials.js` (Agent-TEX)
```js
export function initMaterials(renderer, seed = DEFAULT_SEED)   // once, before any getMaterial; calls textures.initTextures(renderer, seed) first
export function getMaterial(name) -> THREE.Material             // cached shared instance (registry §3.2) — never mutate a shared material
export function cloneMaterial(name, overrides={}) -> Material    // uncached clone
export const MAT = new Proxy({}, ...)                            // MAT.tileWhite === getMaterial('tileWhite')
export function makeAoStrip(length, width=0.35, alpha=0.55) -> THREE.Mesh   // gradient plane; caller positions it along a junction
export function makeBlobShadowMaterial() -> MeshBasicMaterial   // radial alpha, multiply-ish (transparent, depthWrite false)
export function captureEnvironment(G) -> THREE.Texture           // CubeCamera 128 at ENV.capturePos → PMREMGenerator → scene.environment (+ scene.environmentIntensity = ENV.intensity)
                                                                 // AND applyEnvironment(tex): material.envMap = tex, needsUpdate = true on EVERY material the registry has handed out so far
                                                                 // (shared instances and clones alike — the registry keeps a list of all of them); called by lighting.init(), i.e. BEFORE the
                                                                 // §2.3 warm-up (adding envMap changes the program). getMaterial/cloneMaterial apply the captured envMap to materials created later.
export function applyEnvironment(tex)                            // the loop above; idempotent; also used by the ?dispose-test rebuild
export function getEnvironment() -> THREE.Texture|null           // the captured PMREM texture (null before capture)
export function disposeAllMaterials()
export const MATERIAL_NAMES
```
**Why `envMap` is assigned per material** (r185 `WebGLRenderer.setProgram`): for every `MeshStandard`/`Physical`/`Lambert`/`Phong`
material whose own `material.envMap === null`, three.js overwrites the `envMapIntensity` uniform with `scene.environmentIntensity`
whenever `scene.environment` is set. The per-material intensities of §3.2 (rail 1.2, chrome 1.2, glass 1.5, puddle 2.0, trainSteel 1.2)
would be silently ignored and the hero reflections in S1/S2/S5 would go flat. With `material.envMap` set, each material's own
`envMapIntensity` is honoured; `scene.environment` stays set only as the fallback for anything created outside the registry.
`ShaderMaterial`s (glow batches, particles) are unaffected either way.

### 2.10 `src/decals.js` (Agent-TEX)
```js
export class Decals {
  constructor(G); init(); update(dt); reset(); dispose();
  addBulletHole(pos:V3, normal:V3, surface:Surface)      // variant by surface: tile=bisque chip, concrete=dark, metal=bright scratch (0.04), glass=crack star (0.12), wood=dark hole
  addBloodSplat(pos:V3, normal:V3, size=0.35)
  addBloodPool(pos:V3, size=1.2)                          // floor only; grows 0.2 → size over 3 s
  addScorch(pos:V3, normal:V3, size=0.3)
}
```
Subscribes: `shot-hit-world` → hole (skips surface `'none'`); `enemy-hit` → floor splat under the hit point if the point is
within 2 m above the floor (direction = shot dir); **`enemy-rest`** (§1.8; the corpse has landed and stopped twitching) → pool
`FX.poolDelay` (0.6 s) later at the event's `pos` (the resting torso, so the pool is under the body, not where the kill happened).
`enemy-killed` is *not* used for pools.
Implementation: 3 `InstancedMesh` ring buffers of unit `PlaneGeometry` (holes 256, splats 128, pools 24), oriented
`quaternion.setFromUnitVectors(+Z, normal)` + random roll, offset `FX.decalOffset` = 0.006 m along the normal (above the
0.005 m tactile strip, so holes on the strip are visible), `polygonOffset` (factor −2, **units −4** — §3.2 depth-offset table),
`depthWrite false`, `transparent`, `renderOrder 1`; per-instance atlas index via `instanceColor` trick or a custom attribute.
Fade over the last 5 s of `FX.decalLife`. **Standalone**: `dev/particles.html` buttons.

### 2.11 `src/station.js` (Agent-STATION)
```js
export class Station {
  constructor(G); init(); update(dt); reset(); dispose();
  group: THREE.Group
  floorHeightAt(x, z) -> number|null                 // §1.3
  walkable: {minX,maxX,minZ,maxZ,y|'ramp'}[]
  spawnPoints: Record<'mezz-door'|'west-gate', SpawnPoint>   // open()/close() animate the leaf; busy managed by waves
  playerSpawn: { pos:V3, yaw:number, pitch:number }
  crate: { pos:V3, armed:boolean, setArmed(bool), setOpen(bool) }   // lamp green when armed, red when used; lid opens — driven by waves only (station never subscribes to wave events)
  getLightAnchors() -> { troffers:{pos:V3, index:number, mezz:boolean}[] /* 28: 24 platform (TROFFERS) + 4 mezzanine (MEZZ_TROFFERS, indices 24–27) */,
                         wallLamps:V3[], sodium:{pos:V3, side:-1|1}[], signals:{pos:V3, side:-1|1, x:number}[],
                         exitSigns:{pos:V3, rotY:number, blue?:boolean}[], emergency:V3[], shafts:{top:V3, bottom:V3, rTop:number, rBottom:number, color:number}[] }
  getPosterSlots() -> { pos:V3, rotY:number, w:number, h:number, backlit:boolean }[]    // 14 wall slots + 2 mezzanine
  getMosaicCenters() -> V3[]
}
```
Owns geometry (§3.3–3.4): platform slab + sides + nosing + tactile + expansion joints (texture), drains (recess),
trackbeds + troughs, **central floor between the tracks beyond the platform + platform end walls + the low I-column
divider (§3.3)**, ties (2 InstancedMesh per track: wood + concrete), rails (merged box profiles), third rails +
cover boards + pedestals (instanced), trackside walls (6 bands per wall, subdivided 64 × 4 with vertex AO + per-bay
tint), poster frame recesses, ceiling slab (with stairwell hole), beams, columns (2 InstancedMesh + rivets InstancedMesh
+ number plates), tunnels (21 segments per side: walls, ceiling, I-columns, cable brackets, niches, plaques; lamps/signals
are *anchors*; the east ceiling is notched where the stairwell shaft passes — x 32..37.8, |z| < 1.5, matching the mezzanine
slab hole — so the shaft stays open to the mezzanine ceiling instead of being capped by the tunnel roof), stair (24 merged
steps + risers, handrails, walls, top landing), mezzanine (floor with well hole, railings, walls (the z = +6 wall in two pieces
around the service-door recess; the west wall caps the shaft above the well at |z| < 1.5, y 4.8..8.2), ceiling, turnstile line housings, emergency
gate, shutter with padlock, service door leaf + tiled recess, "NO ENTRY", **baked light pools** under the 4 mezzanine troffers /
the mezzanine light on the floor, the top landing and the upper treads — §3.3), west fence + gate leaf + catwalk + emergency door
stub, tunnel end caps, AO strips at every wall/floor and wall/ceiling junction, floor stencils. Registers all static colliders
(§3.4 table; the recess walls and the leaf tagged `door`). `walkable` includes the recess rect and the catwalk (§1.3). Animates: gate/door leaves
(`open()` rotates 0 → 100° over 0.6 s, `close()` back over 1.2 s, emits `spawn-door-open/close`), crate lid.
Vertex AO via `utils.bakeVertexAO`. Merge by material into ≤ 70 draw calls; ≤ 350 k tris. **Never creates lights.**
Registers **no** PLAYER/ENEMY/NAV collider inside `NAV_KEEP_CLEAR` except the turnstile line (`turnstile` ×5, `fare-rail` ×2).
**Standalone**: `dev/station.html` — `createContext` + `new Station(G).init()` + temp HemisphereLight + OrbitControls; `?debug=1` shows collider wireframes.

### 2.12 `src/props.js` (Agent-STATION)
```js
export class Props {
  constructor(G); init(); update(dt); reset(); dispose();
  group: THREE.Group
  getHumSources() -> V3[]     // vending machines (audio loop anchors)
}
```
Owns (§3.5): benches (6 + 2 mezzanine), trash cans (6 + 2 + overturned one), vending machine (+2 mezzanine), hanging
signs (4), posters in frames (from `station.getPosterSlots()`), flyers, stickers, graffiti decals, DANGER/NO TRESPASSING/
column plates, wet-floor signs, fire extinguisher cabinets, hose reels, ceiling services (conduit bundle, cable tray with
sagging cables, ducts with flanges and grilles, fire main with valves, sprinkler pipe), wall conduits + junction boxes,
hanging cable loops at tunnel mouths, litter InstancedMeshes (newspapers 24, cups, bottles, cans), track debris, puddles
(10, `MAT.puddle` + edge rings), mezzanine dressing (agent booth, 2 fare machines, system map lightbox, payphones,
stanchions, mop bucket, manhole cover), troffer housings (InstancedMesh **28** = 24 platform `TROFFERS` + 4 mezzanine `MEZZ_TROFFERS` — tubes belong to lighting), exit-sign boxes
(emissive faces belong to lighting), signal head housings, emergency lamp housings. Animated: fan in the booth, hanging
sign sway (±0.5°, 3 s), vending display flicker, fare-machine screen colour cycle, drip from the ceiling leak (one falling smoke-atlas sprite every 4–12 s via `particles.smoke`; Tier 1).
Registers colliders for everything the player can bump (benches, cans, vending, booth, machines, cabinets, stanchions).
Mezzanine positions come from `MEZZ_PROPS` (§1.13) — all outside `NAV_KEEP_CLEAR`; `nav.build()` asserts it, so a prop
placed in the corridor fails the boot. ≤ 50 draw calls, ≤ 250 k tris. **Standalone**: `dev/station.html?props=1`.

### 2.13 `src/lighting.js` (Agent-LIGHT)
```js
export class Lighting {
  constructor(G); init(); update(dt); render(); reset(); dispose();
  lights: { hemi, platform:PointLight[8], mezz:PointLight, wallLamps:PointLight[2], sodium:PointLight[2], trainSpots:SpotLight[2], muzzle:PointLight }   // 17
  flashMuzzle(worldPos:V3, intensity:number)        // sets muzzle light pos/intensity; envelope: full 2 ticks, linear → 0 by tick 4
  sparkFlash(worldPos:V3, intensity=30, color=0xa0c8ff)   // reuses the muzzle light if it is idle (third-rail sparks)
  getTrainSpots() -> SpotLight[2]                   // both spots AND their .target objects are direct children of the scene (never re-parented);
                                                    // train.js writes spot.position / spot.target.position in world space every render(); lighting keeps ownership
  glowBatches: InstancedMesh[]                      // ≤ 3 billboard batches for every static glow quad (§3.6.4); setGlow(batch, i, pos, size, color, alpha)
  setFixtureState(index, 'steady'|'flicker'|'dead'|'dying')
  beginEmergency(); endEmergency()                  // §3.6.5; also driven by bus 'train-called' / 'train-enter' / 'train-stop'
  setSignal(side:-1|1, 'red'|'yellow'|'green')
  troffersDim: number                               // 1.0 normally, 0.3 during the emergency beat
}
```
Owns: all 17 lights (created in `init` as **direct scene children**, never added/removed/re-parented later; the two train
spots' `.target`s are `scene.add`ed too so their `matrixWorld` updates), `scene.fog = FogExp2(FOG)`, `scene.background`,
`captureEnvironment(G)` call (after station/props, before the §2.3 warm-up), fluorescent tubes (one InstancedMesh of **56** tubes =
28 fixtures × 2, with `instanceColor` driving emissive via `onBeforeCompile`; platform states per `FIXTURE_STATES` assigned with
`G.rngBuild`, the 4 mezzanine fixtures (indices 24–27) steady except 26 = flicker; a mezzanine fixture's factor modulates the
**mezzanine** light `LIGHTS.mezz` the way platform fixtures modulate their nearest platform light), glow cards under all 28
troffers (additive planes, one merged mesh), wall lamp globes, sodium lamps (bulb + hood + cage, 2 % breathing at 0.7 Hz), signal heads
(3 lens spheres + hoods; one lens emissive), EXIT signs (emissive canvas boxes; the shutter one flickers; the west one
blue), emergency strobe heads (emissive when strobing), light shafts (3 truncated cones, additive gradient, fresnel fade
via `onBeforeCompile`), and **every static glow quad batched** (§3.6.4: bulkhead lamps 20, signals 4, blue door 1, EXIT
halos, strobe halos in a fog-on batch; the 20 sodium halos in a fog-off batch) — no per-lamp `THREE.Sprite`. The interior
tube strips of the train are **train's** (uses `MAT.tubeLit`). Flicker schedules are seeded (`G.rngBuild`) and driven by
`G.time`; fixture flicker modulates its nearest platform light ×0.6 and emits `light-flicker`.
**Standalone**: `dev/station.html?lighting=1`.

### 2.14 `src/post.js` (Agent-LIGHT)
```js
export class Post {
  constructor(G); init(); render(); resize(w, h); reset(); dispose();
  composer: EffectComposer|null      // null when opts.nopost
  grade: ShaderPass                  // uniforms: time, hurt, health(lowHealth 0..1), vignette, grain, ca, saturation, lift, gamma, gain, dead
  setQuality('low'|'high'); quality
  setHurt(v); setLowHealth(v); setDead(v)   // hud/player call these
  sampleLuminance() -> number        // renders the scene without post (layer 0 only) to a 64×36 **FloatType** RT (RGBA32F) and reads it back with
                                     // readRenderTargetPixels(rt, 0, 0, 64, 36, new Float32Array(64*36*4)) — FloatType is always accepted by r185's
                                     // textureTypeReadable() and returns real floats. HalfFloatType would come back as PACKED 16-bit halves in a
                                     // Uint16Array that must be decoded per channel with THREE.DataUtils.fromHalfFloat and additionally needs
                                     // EXT_color_buffer_(half_)float; use that only as the fallback when float RTs are unsupported
                                     // (!renderer.extensions.has('EXT_color_buffer_float') → HalfFloat RT + Uint16Array + fromHalfFloat).
                                     // The read-back is LINEAR HDR (r185 skips tone mapping + colour-space conversion when rendering to a target); the
                                     // sampler then applies ACESFilmic (× exposure) and the linear→sRGB transfer per pixel on the CPU and returns the
                                     // mean Rec.709 luminance of the DISPLAY values (0..1). The §3.6.2 calibration numbers are display-referred.
                                     // sampleLuminanceLinear() returns the raw linear mean. The RT and its programs are created/compiled in the §2.3 warm-up.
  sampleLuminanceLinear() -> number
  renderInfo() -> { calls, triangles, points, lines, geometries, textures, programs }   // captured right after the last render
}
```
Chain: `RenderPass → UnrealBloomPass(new Vector2(w, h), POST.bloomStrength, POST.bloomRadius, POST.bloomThreshold) → OutputPass → SMAAPass → ShaderPass(GradeShader)`.
`UnrealBloomPass` halves the resolution it is given internally, so the **full** drawing-buffer size gives the intended half-res first mip.
Low quality (`?lowfx=1` or `setQuality('low')` only — never implied by headless, §1.11): pass `(w/2, h/2)` (→ quarter-res bloom), no
SMAA, pixel ratio 1. `?nopost=1` / `?post=0`: `renderer.render` only (grade effects absent).

### 2.15 `src/particles.js` (Agent-LIGHT)
```js
export class Particles {
  constructor(G); init(); update(dt); render(); reset(); dispose();
  emit(kind, pos:V3, { count=8, dir?:V3, spread=1, speed=4, life=0.6, size=0.1, gravity=-6, color?:number, drag=2, sizeEnd?:number, alpha=1 })
     // kind: 'spark'|'ember'|'flare' (additive Points) | 'chip'|'blood'|'dust'|'splinter'|'shard'|'fleck' (alpha Points)
  smoke(pos:V3, dir:V3, { count=1, size=0.12, sizeEnd=0.45, life=0.6, alpha=0.35 })   // pooled sprites, world scene
  tracer(from:V3, to:V3, radius=0.012, len=0.9)      // pooled InstancedMesh; travels at BALLISTICS.tracerSpeed; §4.4.2
  ejectCasing(kind:'brass9'|'brass556'|'hull12', pos:V3, vel:V3, angVel:V3)   // InstancedMesh, bounces on station.floorHeightAt
  dropMag(pos:V3, vel:V3, geometryKey)               // pooled dropped magazines (6)
  muzzleFlash(muzzleWorld:V3, dir:V3, scale, variant)   // 3 additive planes (cross + front disc) attached to the camera-space muzzle for FX.flashLife
  impact(pos:V3, normal:V3, surface:Surface, weaponId)  // dispatches §4.4.4 table (particles + smoke); decals/audio listen to the bus themselves
  blood(pos:V3, dir:V3, { count=10, headshot=false })
  groundRing(pos:V3, radius)                          // brute slam dust ring (12 dust sprites)
  blobShadows: InstancedMesh                          // 40 discs; index 0 = player, 1 + poolSlot = enemies (slots 0..31 → 1..32), 33..39 reserved (§5.7); written via setBlob(i, pos, radius, alpha)
  setBlob(i, pos:V3, radius, alpha)
  tracersActive: number; casingsActive: number; particlesActive: number   // for getPools()
}
```
Two `THREE.Points` (additive / alpha), capacity `FX.particles` each, custom `ShaderMaterial` with attributes
`aPos0, aVel, aBorn, aLife, aSize, aSizeEnd, aColor, aAlpha, aTile` and uniforms `uTime` (advanced by dt, not wall clock),
`uGravity`, `uScale`. GPU integrates `p = p0 + v·t + ½·g·t²` with drag approximated by `v·(1−e^{−drag·t})/drag`; alpha
fades with `t/life`; `gl_PointSize = aSize·uScale/−mv.z` clamped ≤ 256. CPU writes only new particles (ring buffer,
`addUpdateRange`). Casings: CPU integration, gravity 9.81, bounce restitution 0.35 vertical / 0.7 horizontal, rest after
3 bounces or |v| < 0.15, life `FX.casingLife`, emits `casing-bounce` audio via `G.audio.play('casingBounce',{pos})`
directly (allowed: audio is a system in G). Dust motes: `Points` of `FX.dustMotes` in the platform volume + `FX.mezzMotes` (120)
in the mezzanine volume (x 31–47, y 4.9–8.0, |z| < 5.8) + 150 per shaft (from `station.getLightAnchors().shafts`), CPU sine
drift, brighten within 2 m of any of the 28 troffers (every 10 ticks); on in headless too (§1.11), off only under `lowfx`. Frustum
culling off on pools. Subscribes: `shot-fired` → smoke + embers; `shot-hit-world` → `impact`; `enemy-hit` → `blood`;
`train-brake` → brake sparks at the leading bogie while speed > 3 m/s. ≤ 10 draw calls total.
**Standalone**: `dev/particles.html` with a button per emitter.

### 2.16 `src/player.js` (Agent-PLAYER)
```js
export class Player {
  constructor(G); init(); update(dt); render(); reset(); dispose();
  pos: V3 (feet), vel: V3, yaw, pitch, roll, health, alive, dead, sprinting, ads, crouching:false
  recoil: { pitch, yaw, roll }         // applied additive offsets (radians) — weapons writes recoilTarget, player integrates
  recoilTarget: { pitch, yaw, roll }
  viewRoot: THREE.Group                // child of camera; weapons attaches viewmodels; player applies bob/sway/sprint offsets + the wall-push pose (§3.7) to it
  eye: V3                              // world eye position; refreshed by update() AND by syncCamera() (so it is current after setLook/teleport without a tick)
  getForward(out:V3) -> out; getRight(out:V3) -> out
  getAimRay(outOrigin:V3, outDir:V3)   // origin computed ON DEMAND from pos + (0, eyeHeight + bobY, 0) + lateral bob; dir from base yaw/pitch + recoil (no spread) — never reads a cached camera matrix
  aimAt(x, y, z)                       // sets base yaw/pitch so (base + recoil) points at the point; calls syncCamera()
  setLook(yaw, pitch)                  // writes base yaw/pitch directly (recoil untouched), clamps pitch, calls syncCamera() — used by debug.setLook
  syncCamera()                         // writes camera.position/rotation and `eye` from the current state without ticking (idempotent; update() calls it last)
  applyDamage(amount, fromPos:V3, enemy, { knockback=0, heavy=false } = {})   // god mode skips subtraction; emits 'player-hit'; death → 'player-death'
  heal(amount); setHealth(h)
  teleport(x, z, yaw?, pitch?)         // writes pos (y from station.floorHeightAt, nearest walkable if null), zeroes vel, optional yaw/pitch, then syncCamera()
  shake(amplitudeRad, time)            // additive random pitch/yaw noise decaying linearly
  god: boolean
}
```
Behaviour: §4.1. Camera: `camera.position = pos + (0, eyeHeight + bobY, 0) + lateral bob·right`;
`camera.rotation.set(pitch + recoil.pitch + shakePitch, yaw + recoil.yaw + shakeYaw, roll + recoil.roll + bobRoll, 'YXZ')`.
Movement uses `G.colliders.resolveCircle(pos, PLAYER.radius, MASK.PLAYER, pos.y)` and `G.station.floorHeightAt`.
Enemy push (§4.1.3). Footsteps every `PLAYER.footstepEvery` m (0.42 sprinting) → `player-footstep`. Death camera §4.7.
**Standalone**: `dev/player.html` — station + colliders + player + temp light; WASD walk.

### 2.17 `src/weapons.js` (Agent-PLAYER)
```js
export class Weapons {
  constructor(G); init(); update(dt); render(); reset(); dispose();
  current: WeaponState; list: WeaponState[3]; index: number; lastIndex: number
  // `index`/`current` (and therefore getState().weapon) become the TARGET weapon on the very tick switchTo() is called; the outgoing
  // viewmodel (list[lastIndex].vm) plays 'lowering' for its `lower` time, then the new one plays 'raising' for its `raise` time.
  // current.state reads 'lowering' → 'raising' → 'ready' during that window and canFire() is false throughout (§4.2.2).
  switchTo(indexOrId) -> string        // returns the target id; 0..2 or 'pistol'|'rifle'|'shotgun'; emits weapon-switch {weapon:target, prev} immediately
  switchLast(); reload() -> boolean; fire() -> boolean   // fire(): press-and-release this tick; returns true if a shot happened synchronously
  setTrigger(bool); triggerDown: boolean
  getAmmo() -> { mag, reserve }; getAmmoAll() -> { pistol:{mag,reserve}, rifle:{...}, shotgun:{...} }
  getName() -> string; getSpreadDeg() -> number; getState() -> WeaponState.state
  addAmmo(weaponId, rounds); resupplyAll()          // reserves → max; mags untouched
  infiniteAmmo: boolean
  canFire() -> boolean
}
/** @typedef {{ id, def, mag, reserve, state:'ready'|'firing'|'pumping'|'reloading'|'lowering'|'raising'|'holstered',
 *   nextShotTime:number(countdown), bloomDeg, recoilIndex, sinceLastShot, reloadT, reloadPhase, reloadEmpty, vm:Viewmodel }} WeaponState */
```
Firing: §4.2–4.3. Calls: `G.player.getAimRay`, `G.enemies.raycast`, `G.colliders.raycast(…, MASK.BULLET)`, `G.enemies.applyDamage`,
`G.particles.tracer/muzzleFlash/ejectCasing/dropMag`, `G.lighting.flashMuzzle`, writes `G.player.recoilTarget`, `G.hud.onShot()`,
emits `shot-fired`, `shot-hit-world`, `weapon-*`. Ammo drops [T2]: listens `enemy-killed`. Viewmodels from `viewmodels.js`,
attached to `G.player.viewRoot`. **Standalone**: `dev/player.html?weapons=1` — fire at test boxes with each surface type.

### 2.18 `src/viewmodels.js` (Agent-PLAYER, imported only by weapons.js)
```js
export function buildViewmodel(id:'pistol'|'rifle'|'shotgun') -> Viewmodel
/** @typedef {{ group:THREE.Group, parts:{ frame, slide?, bolt?, charging?, foreend?, mag, hammer?, trigger, handL:Group, handR:Group, shell?:Mesh },
 *   muzzle:Object3D, ejectPort:Object3D, rest:{pos:[3], rot:[3]}, ads:{pos,rot}, sprint:{pos,rot}, lowered:{pos,rot}, drawCalls:number }} Viewmodel */
export function poseFire(vm, id, t)                  // slide/bolt reciprocation, t ∈ [0,1] over 0.12 s; slide held back when empty (setSlideLocked)
export function setSlideLocked(vm, locked)
export function poseReload(vm, id, t, empty)         // §4.3.4 timelines; t ∈ [0,1] of the full reload
export function poseShotgunReload(vm, phase:'start'|'shell'|'end', t)
export function posePump(vm, t)                      // fore-end stroke t ∈ [0,1] over pumpTime
export function poseSwitch(vm, t, lowering:boolean)
export function resetPose(vm)
```
Geometry: §3.7. ≤ 6 draw calls and ≤ 12 k tris per weapon. Materials from `materials.js` (`gunmetal`, `polymer`, `brass`, `gunWood`, `skinHands`, `sightGlow`).
**Standalone**: `dev/viewmodels.html` — three guns on a turntable with sliders for fire/reload/pump/switch time.

### 2.19 `src/rig.js` (Agent-ENEMY, imported only by enemies.js)
```js
export const BONE_NAMES   // 21, depth-first order of §5.1
export const PART_NAMES   // 17 parts of §5.2
export const PART_GROUP   // part -> 'head'|'torso'|'arm'|'leg'
export const HIT_CAPSULES // part -> { bone, a:[3], b:[3], r }
export function buildRigGeometry(type:'shambler'|'runner'|'brute', variant:string) -> BufferGeometry   // cached per (type, variant); skinIndex/skinWeight/partId/color/uv
export function createSkeleton(type, scaleParams) -> { bones:Bone[], byName:Record<string,Bone>, root:Bone, skeleton:Skeleton }
export function applyScaleParams(byName, { legScale, torsoW, headScale, bodyScale })
export const CLIPS = { walk, idle, waiting, spawn, attack, lunge, charge, stagger, flinch, death, corpse }   // (out:PoseBuffer, extras, ctx) => void
export function blendPoses(out, a, b, w); export function applyPose(byName, pose, extras)
export class PoseBuffer { data:Float32Array(63); extras:{ pelvisY, rootTiltX, rootTwistY, rootY, rootZ } }
export function makeVariantMaterial(variant) -> MeshStandardMaterial   // from materials.js enemy atlas per variant
```

### 2.20 `src/enemies.js` (Agent-ENEMY)
```js
export class Enemies {
  constructor(G); init(); update(dt); render(); reset(); dispose();
  spawn(type, spawnPoint:SpawnPoint|null, mods:{hpMult, speedMult, dmgMult}, opts:{ pos?:V3, yaw?, state?:'waiting'|'exiting'|'chase'|'idle', hp?:number }) -> Enemy|null
      // state 'idle' with no opts.yaw: the enemy faces the player (yawFromDir(player.pos − pos)) and holds the idle clip (arms hanging, §5.5)
  killAll({ silent = false } = {}) -> number; kill(enemy, weaponId='debug')
      // silent: every alive enemy → 'inactive' at once — NO enemy-killed/enemy-rest events, no stats, no corpses (existing corpses untouched);
      // the path waves.skipToWave uses. The loud default (debug killAllEnemies) goes through kill() per enemy: events, stats, death animation.
  forceExit(enemy)                     // waves calls this for an enemy still 'waiting'/'exiting' inside a closing train door: places it at the door
                                       // threshold (spawnPoint.pos + exitDir·(exitDist − 0.9)), sets exitTravelled accordingly and continues 'exiting'
  raycast(origin:V3, dir:V3, maxDist, out:EnemyHit) -> EnemyHit|null    // nearest capsule across hittable enemies; `out` is REQUIRED (caller-owned scratch), never allocated
  applyDamage(enemy, part, damage, point:V3, dir:V3, weaponId) -> { killed, headshot, staggered }   // `damage` is FINAL (rule below); emits enemy-hit / enemy-killed / enemy-stagger
  alive: Enemy[]; aliveCount: number; corpseCount: number; totalKilled: number
  forEachAlive(fn); nearestTo(pos:V3) -> Enemy|null; byId(id) -> Enemy|null; getAll() -> Enemy[] (alive + corpses)
  aiEnabled: boolean; speedScale: number
  hitVolumeCenter(enemy, group:'head'|'torso', out:V3) -> out
}
/** @typedef {{ id, type, def, variant, state:'inactive'|'waiting'|'spawning'|'exiting'|'chase'|'attack'|'lunge'|'charge'|'stagger'|'dead'|'corpse'|'sinking'|'idle',
 *   pos:V3, vel:V3, yaw, hp, maxHp, speed, dmgMult, scale, radius, phase, root:Group, mesh:SkinnedMesh, bones:Record<string,Bone>,
 *   attackPhase, t:number, cooldowns:{attack, stagger, lunge, charge, vocal, hurt}, spawnPoint:SpawnPoint|null, exitTravelled,
 *   flinch:Spring3-ish, capsules:Float32Array(17*7), boundingR, blobIndex, corpseT, killedBy }} Enemy */
/** @typedef {{ enemy:Enemy, part:string, group:string, point:V3, normal:V3, dist:number }} EnemyHit */
```
Behaviour: §4.5 (AI, steering, attack ring), §5 (rig/animation). Uses `G.nav.flowAt`, `G.station.floorHeightAt`,
`G.colliders.resolveCircle(…, MASK.ENEMY)`, `G.player.applyDamage`, `G.particles.setBlob/groundRing`, `G.decals`
via bus, `G.audio` via bus. States `waiting`/`spawning`/`exiting`/`chase`/`attack`/`lunge`/`charge`/`stagger`/`idle` are hittable; `dead`+ are not.
**`update(dt)` does everything that affects hits**: AI, steering, pose evaluation, `applyPose`, `root.updateMatrixWorld(true)` and
the capsule refresh (§5.3) — so `aimAtEnemy`/`raycast` are exact right after `setTime()` with no render. `render()` only does
visual LOD decisions, blob-shadow writes and the hit-flash emissive; it never moves a bone. Each enemy is a `SkinnedMesh` with
two material groups = **2 draw calls** (budgeted in §1.11); a one-draw-call variant (eye emissive from the `partId` attribute via
`onBeforeCompile`) is [T2].
**Damage ownership (verbatim; mirrored in §4.3):** `damage` passed to `applyDamage` is **FINAL**. `weapons.js` computes it from
`hit.group` (returned by `enemies.raycast`), `constants.damageMultiplier(group, weaponId, enemy.type)` (= `min(WEAPONS[id].headMult,
ENEMY_TYPES[type].headMultCap)` for the head, `GROUP_MULT` otherwise) and the range falloff. `applyDamage` subtracts it **unchanged**
(`enemy.hp -= damage` — no multiplier of any kind on the enemy side) and only derives `headshot = (PART_GROUP[part] === 'head')` and
the stagger decision from `damage`/`part`; `weaponId` is carried for the `enemy-hit`/`enemy-killed` payloads and `killedBy`. Smoke
checks 4/5/7 (hp 66 / 32 / kill at 102) depend on the multiplier being applied exactly once.
**Synchronous spawn (verbatim; mirrored in §5.3):** `spawn()` (and `forceExit`) evaluates the initial clip for the requested state
(`idle`/`chase` → locomotion or idle pose facing the player; `waiting`/`exiting` → their poses), applies it, calls
`root.updateMatrixWorld(true)`, refreshes `enemy.capsules` and `mesh.boundingSphere` and writes the blob-shadow instance **before
returning**, so `aimAtEnemy`/`raycast`/`hitVolumeCenter` are exact on a freshly spawned enemy with no tick in between (smoke checks
4 and 7 do `spawnEnemy → aimAtEnemy → fire()` back to back). **`idle` enemies skip collision resolution entirely** (no
`resolveCircle`, no separation, no player push, no walkable clamp — §4.5.3), so an aim taken on them is never invalidated by a push.
**Standalone**: `dev/rig.html` — one enemy of each type on a treadmill; sliders phase/speed; buttons cycle states; tri count readout.

### 2.21 `src/nav.js` (Agent-TRAIN)
```js
export class Nav {
  constructor(G); init(); update(dt); reset(); dispose();
  build()                                        // rasterize floorHeightAt + MASK.NAV colliders (init, after station/props) with the strict half-open test of §1.5;
                                                 // then a one-off Dijkstra from PLAYER_SPAWN and the reachability assertion (NAV.mustReach + the 24 docked door exits
                                                 // (doorX_i, ±4.0)) — throws Error('nav: unreachable …') listing the failing points; also asserts no NAV collider
                                                 // other than tags 'turnstile'/'fare-rail' overlaps NAV_KEEP_CLEAR, and that the scripted mezz-door exit segment
                                                 // (44, 6.55) → (44, 4.75) (swept with radius 0.35 at feet y 4.8) crosses no WALKERS collider other than tag 'door' (§3.4)
  setTarget(x, z)                                // player pos; recompute if the cell changed and ≥ NAV.recompute elapsed
  flowAt(x, z, out:THREE.Vector2) -> out         // unit dir toward the target; bilinear over the 4 nearest cell centres ignoring blocked cells (§1.5); zero at the target cell
  isWalkable(x, z) -> bool; nearestWalkable(x, z, out:Vector2) -> out; distanceAt(x, z) -> number (Infinity if unreachable or off-grid)
  randomWalkable(minDistFromTarget, out) -> out
  debugMesh() -> Object3D
  cols, rows, cell, blocked:Uint8Array, floorY:Float32Array, dist:Float32Array, dirX:Float32Array, dirZ:Float32Array
}
```
`update(dt)` calls `setTarget(G.player.pos.x, G.player.pos.z)` itself (runs right after `player.update`).

### 2.22 `src/train.js` (Agent-TRAIN)
```js
export class Train {
  constructor(G); init(); update(dt); render(); reset(); dispose();
  state: 'idle'|'arriving'|'stopped'|'doorsOpening'|'doorsOpen'|'doorsClosing'|'departing'
  track: 'A'|'B'; dir: -1|1 (A = +1); T: number (seconds since callTrain, scaled); timeScale: number
  centerX: number; noseX: number; speed: number; doorOpenAmount: number (0..1)
  callTrain(track:'A'|'B')                       // idle → arriving (T = 0): emits train-called {track, wave: G.waves.wave} and then train-approach — the ONLY emitter of both (§1.8);
                                                 // ignored (no events) in any other state (callers that need a fresh train call reset() first)
  openDoors()                                    // stopped → doorsOpening → doorsOpen (emits train-doors-open). The train calls this ITSELF at train-stop + TRAIN.doorsDelay
                                                 // (T = 16.4, §6.3); the export exists for dev/train.html and debug only — waves never calls it
  closeDoors()                                   // doorsOpen → doorsClosing → departing (auto)
  reset()                                        // any state → idle: parks the group at x = dir·TRAIN.parkX (visible), doors shut, doorOpenAmount 0, spots intensity 0,
                                                 // colliders.clearDynamic('train'), no events emitted (lighting.endEmergency() is the caller's job — waves.skipToWave does it; debug.skipToWave only delegates)
  getDoorSpawnPoints() -> SpawnPoint[12]         // world positions recomputed from group matrix; valid while docked
  isDocked() -> boolean
  group: THREE.Group                             // position.z = dir·(−TRACK.centerZ)…; rotation.y = track==='A' ? 0 : π; NEVER visible = false
}
```
Model/motion/timeline: §6. Headlights: `render()` copies the cab lens world positions (`TRAIN.headlightLocal` through the
group matrix) into `spot.position` and `spot.position + cabForward·TRAIN.headlightAim` into `spot.target.position` for the two
scene-owned spots from `G.lighting.getTrainSpots()` — **no re-parenting, ever**. `colliders.setDynamic('train', …)` whenever
`x` changes while `|centerX| < 200`; cleared when parked.
**Standalone**: `dev/train.html` — station + lighting + train; buttons call/open/close; timeline readout.

### 2.23 `src/waves.js` (Agent-WAVES)
```js
export class Waves {
  constructor(G); init(); update(dt); reset(); dispose();
  wave: number; state: 'idle'|'intro'|'active'|'cleared'|'breather'|'train'|'gameover'
                                                 // `wave` = the wave being played OR, from `train-called` onward, the INCOMING wave (§4.6.1); getState().wave mirrors it
  begin()                                        // idle → intro(1)
  skipToWave(n)                                  // works from ANY non-gameover state: G.enemies.killAll({silent:true}) (no events/stats), clears the queue, G.train.reset() +
                                                 // G.lighting.endEmergency(), sets wave = n SYNCHRONOUSLY, then → train via callTrain(trackForWave(n)) (n ≥ 2; breather skipped)
                                                 // or intro (n = 1). getState().wave === n immediately after the call. waves NEVER restarts the game: from 'gameover' the
                                                 // integrator's debug.skipToWave calls G.hooks.restart() first (§2.26, §9.3) — waves.js has no import of and no reference to main.js.
  skipBreather(); callTrainNow()
  queue: {type, source:'train'|'door'}[]; spawnedThisWave; totalThisWave; breatherRemaining; killsThisWave; shotsThisWave; hitsThisWave
  config: ReturnType<typeof waveConfig>|null; nextTrack: 'A'|'B'
  resupply() -> boolean                          // crate use (E) — also __game.resupply()
}
```
Behaviour: §4.6. Uses `G.enemies.spawn/forceExit/byId/killAll({silent})`, `G.train.callTrain/closeDoors/reset/getDoorSpawnPoints` (never
`openDoors` — the train opens its own doors, §6.3; never emits `train-called` — the train does, §1.8),
`G.station.spawnPoints`, `G.station.crate.setArmed/setOpen` (waves is the **only** writer of crate state), `G.weapons.resupplyAll`,
`G.player.heal`, `G.hud.prompt`, listens to train/enemy/player events, emits wave events, `game-over`. When it calls `closeDoors()`
it calls `enemies.forceExit` on every enemy still `waiting`/`exiting` with `exitTravelled < 0.9` at a train door (the "teleported to
the threshold" rule of §6.4). The spawn queue — and every `G.rng` draw of a wave — is built lazily at the `intro → active` transition
(wave 1) or on `train-stop` (waves ≥ 2), never in `begin()`/`reset()` (§4.6.2), so `seed(n)` right after `restart()` fully determines the run.
**Standalone**: `dev/waves.html` — text log of the state machine with a fake enemy counter (no rendering required).

### 2.24 `src/audio.js` (Agent-WAVES)
```js
export class Audio {
  constructor(G); init(); update(dt); reset(); dispose();
  enabled: boolean; ctx: AudioContext|null; state: 'enabled'|'disabled'|'locked'
  // init(): reads G.opts.audio (false when headless or after debug.disableAudio() — which may run BEFORE init(), which is why the flag lives on
  //         G.opts and not on this object): false → state 'disabled', no AudioContext ever; true → 'locked' until unlock()
  unlock()                                        // creates/resumes the context (user gesture or headless autoplay); no-op while G.opts.audio === false
  disable(); enable()                             // disable(): sets G.opts.audio = false, never creates a context, suspends an existing one, every play() returns null;
                                                  // enable(): sets G.opts.audio = true and calls unlock()
  play(name, { pos?:V3, gain=1, rate=1, delay=0 } = {}) -> Voice|null
  startLoop(name, { pos?, gain } = {}) -> LoopHandle|null; stopLoop(handle, fadeTime=0.3); setLoopParam(handle, param, value)
  setListener(pos:V3, forward:V3, up:V3); setDuck(lowpassHz|null); setMasterGain(v)
  master, sfxBus, ambBus, uiBus, reverb
  voicesActive: number
}
```
Engine + recipes + bus subscriptions: §7. **Standalone**: `dev/audio.html` — a button per recipe, a positional slider.

### 2.25 `src/hud.js` (Integrator)
```js
export class Hud {
  constructor(G); init(); update(dt); reset(); dispose();
  showStart(); hideStart(); showPause(); hidePause(); showGameOver(stats, reason)
  banner(text, sub='', seconds=2.0); prompt(text|null); toast(text, seconds=2)
  hitMarker(kind:'hit'|'head'|'kill'); damageFrom(worldPos:V3); onShot()
  setFps(fps); setHidden(bool); hidden: boolean
  setHint(text|null)                   // start/pause screen hint line (e.g. "CLICK AGAIN TO RESUME" after a pointerlockerror)
}
```
Behaviour: §8. Reads `weapons.getAmmo/getName/getSpreadDeg/getState`, `player.health`, `waves.*` (`#wave-label` shows `waves.wave`,
which already is the incoming wave during the train, §4.6.1), `train.state`. Subscribes to the bus.
Calls `G.post.setHurt/setLowHealth/setDead`.

### 2.26 `src/debug.js` (Integrator)
`export function installDebugApi(G) -> api` — sets `window.__game` (§9) immediately in `boot()` with `ready = false`. The returned `api` also carries
`recordTick()` (called by `main.stepOnce`: step-time EMA, event-ring bookkeeping), `setReady()` and `setProgramsBaseline(n)` (§2.3 warm-up step 4).
Lifecycle calls go through **`G.hooks`** (`start`/`restart`/`stepOnce`/`renderOnce`, §2.1) — `debug.js` imports nothing from `main.js` (that would
be a static cycle main → debug → main). `debug.skipToWave(n)` is `if (G.gameOver) G.hooks.restart(); G.waves.skipToWave(n); return getState()` (§9.3).

### 2.27 Dev harness template (`dev/*.html`)
```html
<!doctype html><html><head><meta charset="utf-8"><title>dev: station</title><link rel="stylesheet" href="../style.css">
<script type="importmap">{"imports":{"three":"../vendor/three/three.module.js","three/addons/":"../vendor/three/addons/"}}</script></head>
<body><canvas id="c"></canvas><div id="hud"></div><div id="overlay"></div><script type="module">
  window.__NO_AUTOBOOT = true;
  import * as THREE from 'three'; import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
  const { createContext, parseOpts } = await import('../src/main.js');
  const { initMaterials } = await import('../src/materials.js'); const { Station } = await import('../src/station.js');
  const G = createContext(document.getElementById('c'), parseOpts(location.search)); initMaterials(G.renderer, G.opts.seed);
  G.scene.add(new THREE.HemisphereLight(0xaab4c0, 0x332f2a, 1.2));
  const station = new Station(G); station.init();
  G.camera.position.set(-20, 2, 0); const controls = new OrbitControls(G.camera, G.canvas); controls.target.set(0, 1, 0);
  (function loop() { controls.update(); G.renderer.render(G.scene, G.camera); requestAnimationFrame(loop); })();
</script></body></html>
```

### 2.28 Cross-module call map (every arrow resolves to an export above)

| Caller | Calls |
|---|---|
| main | every system's `init/update/render/reset` (+ optional `warmupDone`); `post.render/sampleLuminance` (warm-up); `debug.installDebugApi`; installs `G.hooks`; `hud.showStart/hidePause/showPause`; `audio.unlock`; `waves.begin` |
| player | `station.floorHeightAt`, `colliders.resolveCircle`, `enemies.forEachAlive` (push), `post.setHurt/setLowHealth/setDead`, `particles.setBlob`, `input.*` |
| weapons | `player.getAimRay/recoilTarget/viewRoot/vel/sprinting`, `enemies.raycast/applyDamage`, `colliders.raycast`, `particles.tracer/muzzleFlash/ejectCasing/dropMag`, `lighting.flashMuzzle`, `hud.onShot`, `input.*` |
| enemies | `nav.flowAt/isWalkable/nearestWalkable`, `station.floorHeightAt/walkable`, `colliders.resolveCircle/raycast`, `player.pos/applyDamage`, `particles.setBlob/groundRing/blood`, `train.isDocked` |
| nav | `station.floorHeightAt`, `colliders.statics` (NAV mask), `player.pos` |
| train | `lighting.getTrainSpots` (writes `position`/`target.position` only), `colliders.setDynamic/clearDynamic`, `particles.emit` (brake sparks via bus), `audio` via bus; the sole emitter of every `train-*` event incl. `train-called`; opens its own doors |
| waves | `enemies.spawn/aliveCount/killAll({silent})/forceExit/byId`, `train.callTrain/closeDoors/reset/getDoorSpawnPoints/state` (never `openDoors`), `station.spawnPoints/crate.setArmed/setOpen`, `weapons.resupplyAll`, `player.heal/pos/getForward`, `hud.prompt/banner`, `input.interact`, `lighting.endEmergency` (skipToWave only); never `main.*` / `G.hooks` |
| lighting | `station.getLightAnchors`, `materials.captureEnvironment`, `train.state/noseX` (signals), `G.time` |
| props | `station.getPosterSlots/getLightAnchors`, `colliders.addStatic*`, `particles.smoke` (ceiling drip) |
| particles | `station.floorHeightAt` (casings), `player.vel` (casing inheritance), `camera` (flash parent), `audio.play('casingBounce')` |
| decals | bus only (`shot-hit-world`, `enemy-hit`, `enemy-rest`) |
| audio | bus + `player.pos/getForward`, `train.centerX/speed`, `props.getHumSources` |
| hud | `weapons.*`, `player.health/yaw`, `waves.*`, `train.state`, `post.setHurt/…`, `stats` |
| debug | everything through `G`; lifecycle through `G.hooks.start/restart/stepOnce/renderOnce` (never an import of `main.js`); look/teleport go to `player.setLook/teleport/aimAt` directly (never through `input`), movement to `input.setMove/setMoveWorld`; `killAllEnemies` → `enemies.killAll()` (loud), `skipToWave` → restart hook if game over, then `waves.skipToWave` |

---------------------------------------------------------------------------------------------------

## 3. VISUAL SPEC

The station in one paragraph: a deep, low, early-20th-century two-track station with an **island platform 60 m long**,
tiled walls across both tracks carrying a green mosaic band reading **ASHWORTH ST**, two rows of riveted cast-iron
columns in institutional green, a concrete ceiling crowded with pipes, cable trays and humming fluorescent troffers
(some dead, some stuttering), puddles on a stained floor reflecting the tubes, tunnels dissolving into blue-black with
amber sodium lamps and signal lights, an east stair to a mezzanine with turnstiles and a shuttered exit leaking a slit
of daylight, and a west chain-link gate onto a catwalk lit by one blue lamp. Palette: fluorescent green-white
(#d6f0d9) against warm brown grime, sodium amber (#ff9a2a), ice-white headlights (#e6f0ff), red strobes (#ff2a1a).
**The station must never look flat-lit: alternating pools of light are the identity.**

### 3.1 Texture generator table (`getTexture(name, variant)`; all canvas; sizes in px; `meters` = physical coverage of one tile)

| name | size | meters | maps | recipe (condensed from visual.md §3/§5; follow it) |
|---|---|---|---|---|
| `tileWhite` (v0,v1) | 1024² | 2×2 | map, normal, rough | 100×200 mm running-bond glazed tiles (51×102 px), grout 2 px #7d7568; per-tile HSL jitter (h 45–60, s 4–9 %, l 84–92 %), glaze radial sheen, 1 px bevel; 30 % craze hairlines; 3 % chipped corners (#6a5d50), 1 % missing (#4f463c mortar); grime strength 0.35 bottomBias 0.7 + 6 drips; smear band at 1.0–1.3 m on v1; roughness 0.22 body / 0.9 grout / 0.75 chips (+0.35 where grimy); normal from height (body 1, grout 0, bevel ramps, chips −0.6) strength 1.6 |
| `tileBase` | 512² | 1.5×1.5 | map, normal, rough | 150 mm tiles, HSL h150 s35 l14–20, roughness 0.18, grout #3a3a36, 6 % chips, mop-line smear bottom 20 % |
| `mosaicName` | 2048×256 | 8×0.55 | map, normal, rough | 20 px tesserae, 2 px grout #5a5147, field #1c4a38 jittered; Greek-key border rows (cream #e8dcb8 / ochre #b8862c / black #17181a); "ASHWORTH ST" in FONTS.MOSAIC 170 px letterSpacing 10 sampled per tessera (coverage > 0.5 → #efe6cf, 0.2–0.5 → #a89c78, 1-tessera black outline); diamond motifs; line bullet "6" at the far left; per-tessera random 2 px tilt in the normal |
| `mosaicStair` | 2048×256 | 8×0.55 | same | text "← TRAINS   EXIT →" |
| `concretePainted` | 1024² | 4×4 | map, normal, rough | base #cfcabb, fbm mottle ±8 %, 2000 speckles, 6 peeling patches (#9c968c inner, curl highlight), 5 rust drips #7a3a14 α0.35; rough 0.85 (peeled 0.95); normal strength 0.6 + patch edges |
| `concreteLeak` | 1024² | 4×4 | same | as above + one big leak stain (#6d6355 α0.5) with efflorescence ring (#e6e2d8 α0.4) — ceiling near drains |
| `concreteRaw` | 1024² | 4×4 | map, normal, rough | base #6a6660, formwork seams every 0.6 m (h) / 2.4 m (v), form-tie holes, soot band bottom 25 % → #1e1c1a, whitewash band 1.5–2.5 m (#d8d4c8 α0.6 eroded); rough 0.95; normal 1.5 |
| `floorSlab` | 1024² | 3×3 | map, normal, rough | base #8e8a80, fbm ±6/±4 %, 4000 aggregate dots, 8 trowel arcs, expansion joint on the +u edge (4 px #3f3b36), 3 cracks, 5 stains (coffee/oil with iridescent ring), 40 gum spots, 20 butts, centre wear band u 0.3–0.7 (+5 % L, rough −0.15); rough 0.7 / wear 0.5 / oil 0.25 / gum 0.4 |
| `tactile` | 512² | 0.6×0.6 | map, normal, rough | #d9b921 faded, fbm ±10 %, 10×10 domes r 18 px spacing 51 px with highlight/rim, worn tops (v > 0.7) #9a8a2a, 30 rubber scuffs, 3 cm dark rubber edge; normal domes strength 2.5 |
| `trackbed` | 1024² | 4×4 | map, normal, rough | base #3a3835, oil trough centre 40 % → #141414 (rough 0.3), 3000 gravel dots, rust bands at u = 0.5 ± 0.18, water blotches (#101418 α0.6, rough 0.1), 12 litter rects |
| `nosing` | 512×128 | 2×0.3 | map, normal, rough | concrete lip, heavy chipping along the top edge |
| `steelRust` | 512² | 1×1 | map, normal, roughMetal | base #4b3a2e, rust blooms #8a4a1c/#c2712f, 200 pits, 12 remaining-paint patches #2e3436 (metal 0.6 in B), rough 0.8/0.5 |
| `steelGalv` | 512² | 1×1 | map, rough | base #9a9d9c spangle (60 translucent polygons ±6 %), streaks, oxidation blotches; rough 0.45, metalness constant 0.75 |
| `ironGreen` | 512×1024 | column UV | map, normal, rough | base #1f3d2b, vertical brush strokes, chip mask (fbm > 0.62 && v < 0.35 \|\| fbm > 0.75) → primer #8a6a4a with rim, inner rust #5a2e14; rough 0.5/0.8; chips −0.5 height |
| `wood`, `woodWorn` | 512×128 | 1×0.25 | map, rough | base #7a5a34, 40 grain Béziers α0.25 #4a341c, 2 knots, varnish band; worn: centre #9a7a50 rough 0.35 |
| `tieWood`, `tieConcrete` | 256×64 | per tie | map, rough | creosote-black grain / cracked light concrete |
| `glassGrime` | 512² | 1×1 | alpha, rough | fingerprint ellipse clusters α0.08, wipe arcs, bottom dust gradient |
| `chainlink` | 256² | 0.1×0.1 | alpha, map | diamond lattice 2 px lines ±45°, 1 px white wire highlight |
| `rail` | 256×64 | 1×0.1 | roughMetal | polished head (rough 0.3, metal 0.9) vs rusted web/foot |
| `posters` (0..7) | 512×768 | none | map (+emissive for backlit) | 4 templates (big word / product / concert / PSA), palette per visual §5.6, paper grain, wheat-paste bubble, 3 of 8 torn revealing an older poster |
| `flyers` (0..2) | 256×340 | none | map | MISSING (tear-off fringe), SERVICE CHANGE, ROOM FOR RENT; taped |
| `stickers` | 512² (4×4 atlas) | none | map+alpha | 16 stickers 128 px |
| `graffiti` (0..5) | 512×256 | none | map+alpha | 3–5 pseudo-letters as quadratic curves, lineWidth 18–30, drop-shadow outline #101010 offset (4,6), 3 drips; 20 % throw-up bubble style; 2 are black-marker scrawls |
| `signHanging` (A,B) | 1024×340 | none | map | black #111214, 1 cm white border, bullet + "Uptown & The Bronx →" (A) / "← Downtown & Brooklyn" (B) in FONTS.SIGN |
| `signExit`, `signExitBlue` | 256×128 | none | map, emissive | "EXIT" green #1aa34a on white / "EMERGENCY EXIT" white on blue #3b6cff |
| `signDanger`, `signNoTrespass`, `signMezz`, `signNoEntry`, `signWetFloor`, `signBoothClosed`, `signStationClosed` | 512×256 | none | map | per visual §5.2/5.8 |
| `columnPlates` | 256² atlas | none | map | 26 plates "A-01".."B-13" |
| `stencilStandClear`, `stencilNoSmoking` | 1024×128 / 256² | 3×0.375 | map+alpha | FONTS.STENCIL yellow #d4b31a α0.85, 40 % worn fbm mask |
| `systemMap` | 1024² | none | map, emissive | cream, island blob, 6 coloured 45°-snapped random-walk lines, station dots, random-syllable names, legend, YOU ARE HERE |
| `vendingFront`, `vendingShelf`, `vendingDisplay` | 512×1024 / 512×1024 / 256×64 | none | map, emissive | "COLD DRINKS" red panel; 4 shelves × 6 cans with price tags; green 7-seg "EXACT CHANGE" |
| `fareScreen`, `boothGrille`, `payphoneKeypad`, `clockFace` | 256² | none | map(+emissive) | mezzanine props |
| `trainSide` | 1024×512 | 6×3.65 | map, normal, roughMetal | brushed stainless #b9bcbe, fine horizontal brush, lower-half corrugation 8 cm pitch in the normal, sill band, door outlines, grime under window corners, black rub-rail at 0.4 m, roof rivet line, 3-colour stripe (line green/white/black) 15 cm at 2.6 m; rough 0.35/0.5 |
| `trainInterior`, `trainFloor`, `trainSeat`, `trainAds` | 1024×512 / 512² / 256² / 1024×96 | various | map(+emissive) | interior wall with ad cards, speckled rubber floor, moulded seat normal, 10 mini posters |
| `trainRouteSign`, `trainSideSign` | 512×128 / 256×64 | none | emissive | amber LED dot-matrix "6  ASHWORTH ST" (dots 6 px); slow scroll variant |
| `skin` (0..2), `cloth` (0..4), `face` | 512² | 1×1 / none | map, rough | skin base colours per §5.4 with fbm mottling to grey-green/purple (#5a4a5a), 8–12 veins, 3–6 wounds; cloth fabric noise + tears + stains; face: sunken eyes, open mouth |
| `enemyAtlas` (per variant) | 1024² | none | map, rough | quadrants: TL face, TR skin, BL cloth-top, BR cloth-bottom (shoe tone) |
| `gunMetalRough`, `polymerNormal`, `gunWood`, `checkering` | 512² | 0.5×0.5 | rough / normal / map | brushed lines + 60 scratches + edge-wear mask; stipple; grain; pyramid grid |
| `muzzleFlash` | 512² (2×2 atlas) | none | map+alpha | radial white → orange (255,170,60) → 0 core, 6–8 spikes, faint ring; 4 variants |
| `spriteAtlas` | 512² (4×4) | none | map+alpha | 4 smoke puffs, spark streak, blood drop, chip, flare, dust dot, ring, glow |
| `decalHoles`, `decalBlood`, `decalPool`, `decalGlassCrack` | 256² (2×2) / 1024² (4×4… 8 splats) / 512² / 256² | none | map+alpha | pockmarks with chipped ring; maroon #4a0a0a splats with #7a1010 centres and drips; radial pool; crack star |
| `glowRadial`, `shaftGradient`, `lensStar`, `blobShadow` | 128² / 64×256 / 256² / 128² | none | alpha | radial gradient; vertical α 0.35 → 0; 6-point star streak; radial α 0.5 → 0 |

Packing: `roughMetal` textures carry roughness in G and metalness in B and serve as both `roughnessMap` and `metalnessMap`.
Every tiling texture that is seen at eye level gets **two seeds** (variants 0/1) alternated per bay. Resolution tiers:
hero colour maps 1024² (`tileWhite`, `concretePainted`, `concreteLeak`, `concreteRaw`, `floorSlab`, `trackbed`, `trainSide`,
`enemyAtlas` colour), **all normal/roughness maps 512²** except `tileWhite`'s (1024², the one surface read at 1 m), mid 512²,
labels 256² or atlas. Estimated GPU total ≤ 250 MB with mipmaps (`getTextureStats().estimatedBytes`), registry GPU textures ≤ 180.
**Noise rule** (§1.11): all fbm/simplex use goes through `noiseTile`/`sampleTile`; a generator that needs "different" noise
rotates/offsets/scales the tile per call (`rngFor(name)`), it never re-evaluates noise per pixel.

### 3.2 Material registry (`getMaterial(name)` / `MAT.name`) — all MeshStandardMaterial unless stated, `envMapIntensity 0.6` unless stated

| name | notes |
|---|---|
| `tileWhite`, `tileWhiteB` | map+normal+rough, `vertexColors:true` |
| `tileBase`, `mosaicName`, `mosaicStair`, `concretePainted`, `concreteLeak`, `concreteRaw`, `floorSlab`, `tactile`, `trackbed`, `nosing` | as §3.1, `vertexColors:true` |
| `rail` | roughMetal map, metalness 0.9, roughness 0.35, envMapIntensity 1.2 (two bright specular lines are mandatory) |
| `railRust`, `steelRust`, `steelGalv`, `ironGreen` (vertexColors), `chrome` (metal 0.95 rough 0.2, envMapIntensity 1.2), `steelPainted` (dark grey powder coat) | |
| `wood`, `woodWorn`, `tieWood`, `tieConcrete` | |
| `glass` | MeshPhysicalMaterial transmission 0, roughness 0.05, transparent, opacity 0.25, envMapIntensity 1.5, depthWrite false |
| `glassDirty` | as glass + `alphaMap`/`roughnessMap` = glassGrime, opacity 0.35 |
| `trainGlass` | as glass tinted #2a3038, opacity 0.5 |
| `trainSteel` | trainSide map + corrugation normal + roughMetal, metalness 0.85, envMapIntensity 1.2 |
| `trainInterior`, `trainFloor`, `trainSeatOrange` (#f28c28 rough 0.4), `trainSeatYellow` (#f5c02a) | |
| `tubeLit` | MeshBasicMaterial color (2.4, 2.9, 2.6) `toneMapped:false` — instanced tubes scale it via instanceColor; `tubeDead` Standard #b9bdb5 rough 0.6 |
| `emissiveWarm` (train interior strips, #fff2cc × 2.5), `emissiveExit`, `emissiveExitBlue`, `emergencyRed` (#ff2a1a, intensity animated), `sodiumLamp` (#ffa33a × 6), `headlight` (white × 6), `tailLight` (red × 4), `led` (green/amber tiny) | MeshBasic or Standard with emissive; `toneMapped:false` on the Basic ones |
| `puddle` | MeshPhysicalMaterial #202020, roughness 0.04, metalness 0, clearcoat 1, clearcoatRoughness 0.03, envMapIntensity 2.0, transparent 0.85, polygonOffset −1 |
| `puddleEdge` | Standard #5e5a52 rough 0.35, transparent 0.6 |
| `aoStrip` | MeshBasic black, gradient alpha map, transparent, depthWrite false, polygonOffset −1 |
| `blobShadow` | MeshBasic black, blobShadow alpha, transparent, depthWrite false |
| `additive` | MeshBasic AdditiveBlending, transparent, depthWrite false, `toneMapped:false` — base for flashes, glow-batch quads, shafts (cloned per use with its own map) |
| `tracer` | MeshBasic #ffd9a0 additive, transparent, depthWrite false, `toneMapped:false`; instanceColor carries brightness ×2.5 |
| `casingBrass` (0.85,0.65,0.3) metal 0.9 rough 0.35; `casingHull` red plastic rough 0.6 | |
| `decalHole`, `decalBlood`, `decalPool` | Standard transparent, polygonOffset −2, depthWrite false; pool roughness 0.3 |
| `enemy-<variant>` (commuter, worker, nurse, hoodie, brute) | enemyAtlas map, roughness 0.85 (0.65 skin areas via roughnessMap), `vertexColors:true`; hi-vis stripes emissive 0.4 grey on `worker` |
| `eyeGlow` | Standard emissive #b7c95a intensity 1.5 |
| `skinHands` | skin-0 map, rough 0.65 |
| `gunmetal` (metal 0.85 rough 0.4 + gunMetalRough), `polymer` (#1c1c1e rough 0.7 + stipple normal), `brass`, `gunWood`, `sightGlow` (emissive #ff8a1a × 2 / tritium green on the pistol) | viewmodels |
| `chainlink` | alphaTest 0.5, DoubleSide, metal 0.6, rough 0.5, #8a8d90 |
| `paper` (posters/flyers, rough 0.8), `posterBacklit` (emissive = map × 0.6), `signBlack` (#111214 rough 0.3), `signEnamel`, `plastic` (yellow wet-floor, rough 0.6), `rubber` (rough 0.9) | |

Environment: `captureEnvironment(G)` (materials.js) renders a `CubeCamera(0.1, 200, WebGLCubeRenderTarget(128))`
at `(0, 1.6, 0)` **after** station, props and lighting fixtures exist (lights on, fog on), runs `PMREMGenerator.fromCubemap`,
sets `scene.environment` and `scene.environmentIntensity = ENV.intensity`. Once, never per frame.

### 3.3 Station geometry (station.js) — build notes per element

* **Platform**: BoxGeometry 60 × 0.30 × 10 at y = −0.15; top face `MAT.floorSlab` (UVs in metres → 3 m repeat, joints every
  6 m align with the texture's +u joint); sides `MAT.concreteRaw` blackened + 3 conduit cylinders (r 0.03, y −0.45) along
  each side; nosing strips (0.15 × 0.15) `MAT.nosing`; tactile planes 60 × 0.6 at y 0.005 (polygonOffset −1); 4 drain grates
  (0.6 × 0.3, 12 bars) in 5 mm recesses at `DRAINS`; floor stencils "STAND CLEAR OF THE PLATFORM EDGE" every 15 m along both
  strips; vertex colours: darken to 0.6 within 0.4 m of columns/benches/walls (subdivide the top face 120 × 20).
* **Trackbeds**: per track a 320 × 4 plane at y −1.10 (`MAT.trackbed`, 4 m repeat) with the trough as a recessed 0.4 × 0.25 strip
  mesh; ties: BoxGeometry 2.6 × 0.15 × 0.25 every 0.6 m from −160 to 160 (534/track), wood instanced; inside |x| < 32 alternate ties
  concrete (second InstancedMesh); rails: profile (head 0.07 × 0.04 `MAT.rail`, web 0.02 × 0.10 + foot 0.15 × 0.02 `MAT.railRust`)
  as long boxes 320 m; third rail (box 0.06 × 0.1) + cover board (0.2 × 0.02 wood) + insulator pedestals every 3 m (instanced).
  Track debris: 40 papers, 12 bottles, 6 cups instanced along the trough (`G.rngBuild`).
* **Trackside walls** (z = ±9, x −32..32): one PlaneGeometry per band (`WALL_BANDS`), subdivided 64 × 4, vertex AO (bottom row
  0.55 → 1.0 at 0.5 m; darken toward the ceiling corner), per-bay tint ±5 % L / ±2 % hue; tile variants alternate per bay.
  The mosaic band's 8 m repeat is centred so "ASHWORTH ST" is centred at x = −20, −12, −4, 4, 12, 20 (repeat origin x = −24 + 8k,
  name centred in each repeat); poster frames at `POSTERS` x (between names, i.e. at the repeat boundaries) — frame recess is
  a 1.5 × 2.0 × 0.05 dark box; every other slot backlit. "TO MEZZANINE →" enamel signs at x = 24 both walls (y 3.1);
  DANGER plates at x = ±20, y −0.6; junction boxes with conduit; graffiti decal slots at x ∈ [26, 31] and [−31, −26], y 0.6–2.4.
* **Ceiling**: plane 64 × 18 at 4.20 (`MAT.concreteLeak` variant near drains, `concretePainted` elsewhere), hole at x 30..39, |z| < 1.5;
  beams (13) 0.5 × 0.4 × 18 with extra rust streaks; portal steps at x = ±32 (box y 3.9..4.2 spanning z −9..9 minus the stairwell).
* **Columns** (26): shaft CylinderGeometry r 0.17 h 3.55 (16 seg) at y 0.25..3.80 `MAT.ironGreen` (V along height), plinth
  0.55 × 0.25 × 0.55 with chamfer, capital flange 0.5 × 0.04 × 0.5 + box to the beam; rivets InstancedMesh 26 × 24 spheres r 0.012;
  number plates (atlas UV offset per column) at y 1.7; per-column `instanceColor` ±6 %. Flyers/signs are props.
* **Tunnels** (per side 21 segments × 6 m, `TUNNEL`): ceiling slab at 3.9, side walls z = ±9 `MAT.concreteRaw` (with soot/whitewash),
  I-columns at z = 0 every 1.5 m for |x| ≥ 44 (0.25 × 0.25 with flanges, grimy black + rust), 4 cables on brackets at y 2.8
  (TubeGeometry, sag 0.05), conduit at y 1.2, every 2nd segment a sodium lamp anchor, every 4th a signal anchor, every 3rd a refuge
  niche (0.8 × 0.6 dark) + plaque, every 5th a trough puddle + trash bags. Graffiti on the first two segments. Beyond |x| > 100 no cables.
  End caps: black planes at x = ±160.
* **Central floor** (`TUNNEL.centerFloor`): the strip between the two trackbeds is never a void. Two planes at y −1.10, z ∈ [−5, 5]:
  east x ∈ [30, 160] and west x ∈ [−160, −30], `MAT.concreteRaw` blackened (vertex colour 0.45) with oil streaks and the trough
  litter instancing continuing across it; the stair base (x 30..39, |z| ≤ 1.35), the catwalk posts (x −42..−30) and every tunnel
  I-column stand on it. For |x| ≥ 44 a **low dividing wall** (`TUNNEL.divider`: z ∈ [−0.3, 0.3], y −1.10 … −0.20, rough concrete,
  cable brackets on its faces) carries the I-columns as a plinth beam. **Platform end walls**: blackened concrete faces at
  x ∈ [30, 30.3] and [−30.3, −30], y −1.10 … −0.30, z −5 … 5, so the slab never floats. All BULLET colliders (`floor-center`,
  `end-wall`, `divider`).
* **Stair**: 24 boxes (tread 0.30, rise 0.20, width 2.4) merged; tread tops use a 512 × 128 tread texture with an anti-slip nosing stripe;
  risers `MAT.tileBase`; vertex AO in the step corners; three handrails (TubeGeometry r 0.025 brushed steel, returns at both ends;
  centre rail on posts every 1.2 m); stairwell walls (z = ±1.35, 0.3 thick, from the stair surface to 8.2) tiled with `mosaicStair`
  band at 2.4 above the local stair height (band follows the slope: build the wall as a parallelogram strip per band); a solid
  concrete base under the stair (from −1.1 to the stair underside); "Exit  Ashworth St & 3 Av ↑" enamel sign halfway; a steel-grate
  landing at the top (x 37.8..39) with the street-grate light shaft above (anchor).
* **Mezzanine**: floor slab (30..48 × −6..6, thickness 0.3, top 4.8) with the well hole (x 30..37.8, |z| < 1.5) and railings (r 0.02
  tubes, 1.1 high, posts every 1.5 m) around the well; walls: west x = 30 (y 4.8..8.2 — above the well the wall is the stairwell's
  continuation), east x = 48 with the shutter opening, north/south z = ±6; all tiled with the band composition scaled to a 3.4 m
  wall (base 0..0.45, white 0.45..2.4, band 2.4..2.95, white to 3.4); ceiling 8.2 painted concrete with fewer services (one conduit run +
  fire main); turnstile housings (5 boxes 0.9 × 1.0 × 0.2 at `TURNSTILES.zs`, stainless caps, tripods r 0.02 chrome, green LED slots);
  emergency gate (16 bars, hinged open at z 1.2..3.4, 2.2 m clear) with "ALARM WILL SOUND"; railings (`fare-rail`) elsewhere on the
  x = 41.5 line (|z| ∈ [3.4, 6] and [−6, −3.1]); nothing else may stand in `NAV_KEEP_CLEAR` (§1.2); exit shutter
  (plane 3 × 2.4 slat texture `steelGalv` with normal-mapped curls, padlock + 30-link chain, "STATION CLOSED — USE ALTERNATE EXIT"
  paper), warm emissive plane 5 cm behind (#ffd9a0 × 3) + street-grate shaft anchor at (44, 8.2, −3) → floor; service door recess at
  `MEZZ_DOOR` (steel leaf 1.2 × 2.2 × 0.05 with keypad, "NO ENTRY"); manhole cover; light shaft anchors: street grate (cool #cfe0ff),
  shutter slit (warm), platform vent at bay 4 (greenish, over Track A).
* **West end**: fence plane 10 × 2.2 `MAT.chainlink` at x = −30 with posts every 2.5 m; gate leaf 1.2 × 2.0 (hinge z = +0.6, opens toward −X);
  "NO TRESPASSING / AUTHORIZED PERSONNEL ONLY" sign; catwalk: grating plane 12 × 1.2 (alpha grid) at y 0 on posts down to the central floor (y −1.10),
  handrails; at x = −42 a concrete stub wall with the blue-lit emergency door (`emissiveExitBlue` lamp above, blue glow quad in lighting's batch 0 — the only blue light).
* **AO strips**: 0.35 m gradient planes along every wall/floor and wall/ceiling junction, under benches/machines, around column plinths.

### 3.4 Static colliders registered by station.js (all `MASK.SOLID` unless stated)

| tag | shape | surface | mask | notes |
|---|---|---|---|---|
| `floor` | box y ∈ [−0.3, 0], platform rect | concrete | BULLET | |
| `floor-mezz`, `floor-stair` (as 6 stepped boxes) | boxes | concrete | BULLET | bullets hit the stair |
| `ceiling` | box y ∈ [4.2, 4.5] | concrete | BULLET | plus mezzanine ceiling |
| `beam` ×13 | boxes | concrete | BULLET | |
| `wall-a`, `wall-b` | boxes z ∈ ±[9.0, 9.3], x ∈ [−32, 32], y ∈ [−1.1, 4.2] | tile | BULLET | |
| `tunnel-wall`, `tunnel-ceiling`, `tunnel-column` | boxes | concrete / metal | BULLET | columns also NAV-irrelevant (off-grid) |
| `trackbed` | boxes y ∈ [−1.4, −1.1] | concrete | BULLET | rails: 4 thin boxes surface metal BULLET |
| `floor-center` ×2, `end-wall` ×2, `divider` ×2 | boxes (§3.3 central floor) | concrete | BULLET | |
| `edge` ×2 | `EDGE_BARRIER` boxes | none | PLAYER\|ENEMY\|NAV | exiting enemies ignore |
| `end-rail` ×2 | x 30..30.3, \|z\| ∈ [1.35, 5] | metal | PLAYER\|ENEMY\|NAV\|BULLET | |
| `fence` | x ∈ [−30.15, −29.85], z ∈ [−5, 5], y ∈ [0, 2.2] | metal | PLAYER\|ENEMY\|NAV\|BULLET | gate leaf portion tagged `gate` (exiting enemies ignore) |
| `column` ×26 | cyl r 0.28, y 0..3.8 at column positions | metal | SOLID | |
| `stair-wall` ×2 | boxes z ∈ ±[1.2, 1.5], x ∈ [30, 39], y ∈ [0, 8.2] | tile | SOLID | |
| `well-rail` | boxes around the well (x 30..37.8 at z = ±1.5, y 4.8..5.9; x = 30, \|z\| ∈ [1.5, 6]) | metal | SOLID | |
| `mezz-wall` ×4, `shutter`, `turnstile` ×5, `fare-rail` ×2 | boxes; turnstile housings x ∈ [41.05, 41.95], z = zs ± 0.1, y 4.8..5.8; fare-rails x ∈ [41.475, 41.525], \|z\| ∈ [3.4, 6] and [−6, −3.1], y 4.8..5.8 | tile / metal | SOLID (shutter BULLET\|PLAYER\|ENEMY\|NAV) | the only NAV colliders allowed inside `NAV_KEEP_CLEAR`; the booth collider belongs to props |
| `door` (service door leaf) | box | metal | SOLID; exiting enemies ignore | |
| `crate` | box 0.8 × 1.7 × 0.45 at CRATE.pos | metal | SOLID | |
| `catwalk-rail` | boxes | metal | PLAYER\|BULLET | enemies never chase onto the catwalk (off-grid) |

props.js adds (positions from `BENCHES`/`TRASH_CANS`/`VENDING`/`MEZZ_PROPS`): `bench` (box 1.9 × 0.85 × 1.1) ×6, `bench-mezz` ×2,
`can` (cyl r 0.32) ×9, `vending` (box) ×3, `booth` (box 2.2 × 2.4 × 1.6, SOLID) + `booth-glass` (glass BULLET), `fare-machine` ×2
(box 0.6 × 1.6 × 0.6), `extinguisher` ×3 (BULLET), `hose-reel` ×2, `sign-hanging` ×4 (BULLET, y 2.9..3.3), `duct`/`tray`/`pipe`
(BULLET), `payphone` ×3 + 1 (BULLET), `map` (BULLET), `wet-floor` (plastic BULLET), `stanchion` ×4 (cyl r 0.15 SOLID), `bucket`
(cyl r 0.2 SOLID). None of them inside `NAV_KEEP_CLEAR`.

### 3.5 Props (props.js) — counts and construction (visual.md §6 is the reference; all instanced/merged, ≤ 3 draw calls per prop type)

| Prop | Count / placement | Construction |
|---|---|---|
| Bench (double, back-to-back) | 6 platform (`BENCHES`), 2 mezzanine (`MEZZ_PROPS.benches`: x 34, z ±4.5 — on the side strips, west of the nav corridor) | 3 cast-iron end frames (ExtrudeGeometry S-profile) `ironGreen`; 5 seat + 4 back slats per side (1.8 × 0.03 × 0.07 `woodWorn`), bolts merged; newspaper on 2, cup on 1, bag under 1 [T2] |
| Trash can | 6 platform (`TRASH_CANS`, \|z\| 2.35), 2 mezzanine (`MEZZ_PROPS.cans`: x 37, z ±5.4), 1 overturned near the fence | mesh basket (cylinder r 0.3 h 0.9 `chainlink` scaled 1 cm), black bag (squashed sphere, wrinkle normal), domed lid (Lathe) with "LITTER" ring, rusted base |
| Vending machine | 1 (`VENDING`, facing +Z), 2 mezzanine (`MEZZ_PROPS.vending`: x 47.5, z −4.0 / −2.8, backs to the east wall, facing −X) | body 0.95 × 1.85 × 0.8 #b8232b + dents; recessed `glassDirty` over the shelf canvas + backlight plane (×1.2); keypad, coin slot, display strip (flickers), delivery flap; hum source |
| Hanging line signs | 4 (`HANGING_SIGNS`) | box 1.2 × 0.4 × 0.03 `signBlack` with `signHanging` on ±Z faces; 2 rods r 0.012 to the beam; sway ±0.5° / 3 s |
| Posters | 14 wall slots + 2 mezzanine | plane in the frame recess, `paper` or `posterBacklit` (alternate); frames 4 thin dark-green boxes |
| Flyers / stickers | 6 columns get 1–2 flyers; 24 stickers on columns/machines/signs | planes 0.21 × 0.28 on tangent planes 2 mm off; stickers 0.06–0.1 |
| Graffiti | 6: tunnel-mouth walls (4, x ∈ ±[26, 31], y 0.6–2.4), west fence post (1), booth back (1) | planes with `graffiti-N`, polygonOffset −2 |
| Plates/signs | DANGER ×2, NO TRESPASSING, column plates (station), "No Standing" ×3, "WET PAINT" ×1, tunnel plaques (station) | boxes/planes |
| Wet-floor A-sign | 2 (one by the drain at (15, 0, 2.5), one knocked over on the mezzanine at `MEZZ_PROPS.wetFloorDown` (47, 4)) | two hinged planes 0.3 × 0.6 `plastic` with the pictogram canvas |
| Fire extinguisher cabinet | 2 platform walls (x ±10 under the band, recessed), 1 mezzanine; one with broken glass and no extinguisher | red box 0.35 × 0.7 × 0.2, `glassDirty` door, cylinder + hose tube + gauge |
| Hose reel / standpipe | 2 (platform wall ends) | red cabinet, coiled hose (5 tori), brass valve wheel |
| Ceiling services | full length | conduit bundle z −0.9 (3 cylinders + saddle brackets every 3 m, `steelGalv`); cable tray z +0.9 (U-channel + rungs, `steelRust`) with 6 sagging cables (CatmullRom tubes, 4 cm sag, black/grey/orange/blue); duct z −4.5 (0.6 × 0.4) + smaller z +4.5 (0.4 × 0.3) with flanges every 1.5 m and grilles every 9 m; fire main z +6.0 (r 0.09 dark red) with valve wheels every 12 m + drip stains; sprinkler pipes r 0.03 at z ±2.5 with heads every 3 m |
| Wall conduits + junction boxes | 8 per wall | cylinders r 0.02–0.05, torus elbows, clamps every 1.5 m, grey boxes 0.3 × 0.4 × 0.15 |
| Hanging cable loops | 2 per tunnel mouth | CatmullRom tubes r 0.015 black; one severed with an emissive copper tip that sparks every 6–14 s (particles + `lighting.sparkFlash`) [T2] |
| Litter | newspapers 24 (displaced 6 × 8 planes), cups 8, bottles 10, cans 8, coffee lids 6, takeout box 2 | InstancedMesh per type, placed near cans/columns/benches/stairs by `G.rngBuild` |
| Puddles | 10: around the 4 drains, under the ceiling leak (x 6, z −1), trough (2), mezzanine under the shutter, stair bottom, west end | ShapeGeometry 12-point fbm polygons 0.4–1.4 m at y 0.003 (`puddle`) + edge ring (`puddleEdge`); hero Reflector puddle [T3] |
| Ceiling grilles / vents | 4 | 0.6 × 0.6 slat-alpha planes in steel frames; the bay-4 one is the shaft source |
| Mezzanine dressing (`MEZZ_PROPS`) | booth at (44.5, −4.2), 2.2 (X) × 2.4 (Y) × 1.6 (Z) (bullet glass, counter, desk-lamp emissive sphere, "BOOTH CLOSED", fan rotating); 2 fare machines at (47.5, 2.2) / (47.5, 3.2) facing −X (blue, tilted emissive screen cycling); system map lightbox 1.6² on the north wall at x 34.5 (emissive 0.9); payphone bank (3) on the south wall at x 37 + 1 on a platform column; stanchions + belts (4) at (43 / 44.2, −1.2 / −2.4); mop bucket (47.2, 5.2); manhole cover (35, 3.5); extinguisher cabinet on the west wall at z −4; 2 trash cans, 2 benches (above); "Elevator out of service" plate on the south wall | per visual §6.4–6.7; **nothing inside `NAV_KEEP_CLEAR`** |
| Troffer housings | 24 InstancedMesh (`TROFFERS`), white enamel yellowed #e9e3cf, 2 rods each | tubes/glow are lighting's |
| Signal / emergency / exit / sodium housings | from `station.getLightAnchors()` | hoods, cages, boxes; emissive parts are lighting's |
| Tier-3 dressing (rats, cobwebs, shopping cart, stroller) | see Appendix B — not before the T2 gate | |

### 3.6 Lighting (lighting.js)

#### 3.6.1 Global
`renderer.toneMapping = ACESFilmic`, exposure `POST.exposure`. `scene.background = FOG.color`, `scene.fog = FogExp2(FOG)`.
`HemisphereLight(LIGHTS.hemi)`. Environment §3.2. Light units are physical (candela for point/spot; r155+).

#### 3.6.2 The 16 lights (created in `init`, kept forever)
| # | Light | Position / colour / intensity | Role |
|---|---|---|---|
| 1 | HemisphereLight | sky #a9c4b0 / ground #2a1e14 / 0.25 | ambient fill |
| 2–9 | PointLight ×8 | `LIGHTS.platform` (x −22.5 … 30 step 7.5, y 3.4, z 0), #d6f0d9, 30 cd, distance 14, decay 2 | key light; pools alternate along the platform |
| 10–11 | PointLight ×2 | (−9, 3.4, −8.7) and (9, 3.4, 8.7), #ffe2b8, 8 cd, dist 7 | warm light on the mosaic bands |
| 12–13 | PointLight ×2 | (−38, 3.0, −8.8) and (38, 3.0, 8.8), #ff9a2a, 14 cd, dist 12 | tunnel sodium pools; **retasked as red strobes** during the emergency beat |
| 14–15 | SpotLight ×2 | **scene children** (never under the train group), positioned each frame by `train.render()` at the cab lenses (`TRAIN.headlightLocal`), #e6f0ff, 3000 cd, angle 0.35, penumbra 0.6, distance 90, `.target` (also a scene child) 60 m ahead of the cab | headlights; intensity 0 when the train is idle (parked at ±300, still visible) |
| 16 | PointLight | muzzle, #ffb050, distance 10, decay 2, intensity 0 at rest | muzzle flash / third-rail spark flash |

Calibration (display-referred, §2.14: ACES + sRGB applied by the sampler): with the reference view of screenshot #1, `post.sampleLuminance()` should read 0.28–0.40; adjust
`LIGHTS.platform.intensity` (not exposure) if outside. Floor under a fixture ≈ 0.55 luminance, between fixtures ≈ 0.15,
tunnel walls at 20 m ≈ 0.05.

#### 3.6.3 Fluorescent troffers (24; the identity light)
Each: housing (props), two tubes (instanced CapsuleGeometry r 0.019 len 1.2 → one InstancedMesh of 48 with `instanceColor`
scaling `MAT.tubeLit` emissive via `onBeforeCompile`), end caps, and a **glow card** (1.4 × 0.5 additive plane 2 cm below,
α 0.35 → 0). States assigned by `G.rngBuild` per `FIXTURE_STATES`: 16 steady; 3 flicker (every 30–200 ms pick emissive
factor from {1.0, 0.78, 0.22, 0.05}); 3 dead (`tubeDead`, housing darker, glow card off); 2 dying (0.9× steady; every 3–8 s a
0.3 s stutter burst, emits `light-flicker {kind:'sputter'}`). A fixture's factor also multiplies its nearest platform PointLight
by `(0.4 + 0.6·factor)`; glow card alpha follows. One tube near the stair hangs by one end (25°) and swings [T3].

#### 3.6.4 Other emitters
* **Glow batches** (replaces per-lamp `THREE.Sprite`s — those would be 50+ draw calls): `lighting.glowBatches` = ≤ 3 `InstancedMesh`
  of a unit quad with a vertex-shader billboard (`ShaderMaterial`, additive, `depthWrite:false`, `toneMapped:false`, atlas
  `glowRadial`/`lensStar`; per-instance position from `instanceMatrix`, size/colour/alpha from `instanceColor` + a float
  attribute): batch 0 = fog-on halos (20 bulkhead lamps, 4 signals, EXIT signs, strobe heads, the blue door lamp), batch 1 =
  fog-off halos (the 20 sodium lamps: `fog` compiled out so the receding amber string survives the fog), batch 2 [T2] = dynamic
  extras. `setGlow(batch, i, pos, size, color, alpha)` per frame for the animated ones (breathing, flicker, strobes). The train's
  own 2 headlight lens quads + 2 tail markers may stay individual `Sprite`s (they move with the train; ≤ 8 individual sprites total).
* Wall bulkhead lamps (10/wall, props build the cage): globe sphere r 0.07 emissive #fff1d0 × 3 + glow quad 0.6 m α 0.4 (batch 0).
* Sodium lamps (tunnel, every 12 m from ±38, alternating walls): bulb `sodiumLamp`, hood, cage, glow quad 1.2 m amber α 0.5 (batch 1),
  `material.fog = false` on the bulb too so the receding string of amber dots survives the fog; 2 % breathing at 0.7 Hz.
* Signal heads at x = ±44, ±80 on the wall facing the arriving direction (Track A trains arrive from −X → signals on the
  south wall at x = −44/−80 face +X; Track B on the north wall at x = +44/+80 face −X): 3 lens spheres r 0.06 (red #ff1a1a,
  yellow #ffbb22, green #22ff55), hoods, one lens emissive at a time + glow quad (batch 0). Default red. `train-called` → yellow on that
  track's side; `train-brake` → green; `train-stop` → red. Trip-arm lever at the base.
* EXIT signs (emissive canvas boxes 0.35 × 0.2 × 0.08, intensity 2.5): stair bottom, stair top, mezzanine shutter (flickers),
  west gate (blue "EMERGENCY EXIT" variant at x = −42).
* Emergency twin-head units at x = −25, 0, 25 (y 3.5, both walls) + 2 mezzanine: heads dark normally; `emergencyRed` × 6 when strobing.
* Light shafts (3): truncated cones (`CylinderGeometry(rTop, rBottom, h, 24, 1, true)`), `additive` clone with `shaftGradient`
  alpha (0.35 → 0), fresnel fade `pow(abs(dot(normal, viewDir)), 1.5)` via `onBeforeCompile`, `depthWrite:false`, late renderOrder;
  colours: street grate #cfe0ff (±10 % over 4 s), platform vent greenish, shutter warm. 150 dust motes inside each (particles.js).
* Train headlight lens sprites, tail markers, interior strips: built by train.js from `MAT.headlight/tailLight/emissiveWarm`.

#### 3.6.5 Emergency beat (wave transition)
On `train-called`: over 0.6 s `troffersDim → 0.3` (tube emissive × dim, platform lights × dim), strobe heads on at 1 Hz
(200 ms on), the 2 sodium lights move to `LIGHTS.emergency` positions, colour #ff2a1a, intensity 18 pulsing with the strobes;
emit `emergency-start`. On `train-enter` (headlights appear): troffers recover to 1.0 over 1.5 s. On `train-stop`: strobes end,
sodium lights restored (position/colour/intensity), `emergency-end`. Reviewers must be able to capture red strobes + white
headlight sweep + green fluorescents in one frame during arrival.

#### 3.6.6 Muzzle / spark light
`flashMuzzle(pos, intensity)`: intensity per `WEAPONS[id].flashLight` for ticks 1–2, linear to 0 at tick 4, distance 10.
`sparkFlash` (third-rail shoe while the train moves, every 2–4 s; severed cable [T2]): #a0c8ff, 30 cd, one tick, only if the
muzzle light is idle.

### 3.7 Weapon viewmodels (viewmodels.js) — geometry

All primitives, merged per moving group, materials from §3.2. Local frame: gun points −Z, +Y up, +X right; the group is
attached to `player.viewRoot` (child of camera). Rest poses in camera space (camera at origin looking −Z); scale 0.9.

| Weapon | Parts (separate meshes in **bold** move) | Muzzle / eject port (local) | Rest pos / rot | ADS pos [T2] | Sprint pos |
|---|---|---|---|---|---|
| Pistol | frame 0.03 × 0.035 × 0.19 with chamfered dust cover; grip 0.032 × 0.11 × 0.055 tilted 18° with checkering normal; **slide** 0.032 × 0.03 × 0.19 with rear serrations (normal), ejection port inset, rear sight; **magazine** (visible base plate); **hammer**; trigger guard (half torus r 0.02); trigger; barrel stub r 0.006; tritium front dot `sightGlow` | (0, 0.02, −0.11) / (0.012, 0.03, −0.02) | (0.17, −0.15, −0.30) / (0, 0.04, 0) | (0, −0.085, −0.26) | rest + (−0.03, −0.05, 0.02), pitch −0.2, roll +0.15 |
| Rifle (carbine) | receiver 0.25 × 0.07 × 0.06; barrel r 0.009 len 0.30 + ridged muzzle device; handguard with 12 rail notches; **magazine** curved (3 stacked boxes, 12° total); stock with butt pad; **charging handle**; **bolt** (visible in the port); front/rear sights; red-dot tube with a lens plane + emissive dot `sightGlow` | (0, 0.045, −0.48) / (0.02, 0.04, −0.10) | (0.13, −0.14, −0.34) / (0, 0.04, 0) | (0, −0.075, −0.28) | as pistol |
| Shotgun | receiver 0.2 × 0.055 × 0.045; barrel r 0.012 len 0.5 above a tube magazine r 0.011; **fore-end** ribbed 0.16 (slides 0.085); wooden stock `gunWood`; brass bead; loading port; shell carrier with 4 red shells; **shell** mesh (used in reload) | (0, 0.04, −0.62) / (0.02, 0.03, −0.15) | (0.12, −0.15, −0.38) / (0, 0.05, 0) | (0, −0.09, −0.32) | as pistol |

Hands: palm box 0.09 × 0.03 × 0.18 + 5 capsule fingers, `skinHands`, dark sleeve capsule stubs; `handR` fixed to the grip,
`handL` a separate group (fore-end / handguard / under the pistol) that reloads animate. Lowered pose: rest + (0, −0.25, 0),
pitch −35°. All parts `renderOrder 10`, `frustumCulled = false`, `depthTest true`, `layers.set(LAYERS.VIEWMODEL)` (§1.12).
**Clipping policy**: the gun is rendered in the main pass with a normal depth test (a depth-cleared second pass would let far
transparent surfaces — puddles, glass — draw over the gun, and `depthTest:false` breaks the gun's own self-occlusion), so it
*can* intersect walls at point-blank range; the mitigation is the **wall-push pose** owned by player.js: each tick one
`colliders.raycast(eye, forward, VIEWMODEL.wallPushDist, MASK.BULLET)`; with `k = 1 − dist/1.2` the viewmodel is pulled toward
`rest + (0, −VIEWMODEL.wallPushLower·k, +0.10·k)` and pitched `VIEWMODEL.wallPushPitchDeg·k` (smoothed at 12/s). The shotgun's
0.62 m barrel (0.56 m at scale 0.9) is the longest; at the 0.35 m player radius plus push it never reaches the wall face.
Enemies at melee range may still clip the muzzle — accepted.

### 3.8 Post-processing (post.js)

Chain §2.14. `GradeShader` (write it inline): uniforms `tDiffuse, resolution, time, hurt (0..1), lowHealth (0..1), dead (0..1),
vignette 0.45, grain 0.06, ca 0.0018, saturation 0.92`.
```
uv' = uv; r = length(uv − 0.5)
chromatic aberration: sample R at uv + (uv−0.5)·r·ca·2, G at uv, B at uv − (uv−0.5)·r·ca·2
lift/gamma/gain: shadows lifted toward #0a1410 × 0.04, highlights pushed toward #f0fff2 (mix by luminance)
saturation: mix(luma, rgb, saturation); red channel preserved: rgb.r = max(rgb.r, original.r · 0.9)
lowHealth: saturation × (1 − 0.4·lowHealth); dead: mix toward grey by dead, grain × (1 + 2·dead)
hurt: rgb += vec3(0.35, 0.02, 0.02) · hurt · smoothstep(0.2, 0.9, r)
grain: hash(uv · resolution + time) · grain · (1 − luma)
vignette: rgb *= smoothstep(0.9, 0.3, r · vignette · 2.0)   (tune so corners drop ≈ 35 %)
```
`setQuality('low')`: bloom quarter-res, SMAA disabled, pixel ratio 1. `?nopost=1` bypasses the composer (used by `sampleLuminance`).

### 3.9 Visual priorities

**MUST-HAVE (Tier 1)**: island platform + both tracks (rails/ties/third rail/trough) + trackside walls with the full band
composition + ceiling with beams + columns with rivets/chips + tunnels with I-columns, sodium lamps, signals, fog;
texture recipes tileWhite (2 seeds), tileBase, mosaicName, concretePainted, concreteRaw, floorSlab, tactile, trackbed,
steelRust, ironGreen, trainSide, skin/cloth/face with normal + roughness maps; vertex AO + AO strips + blob shadows; puddles
with env reflection; PMREM capture; troffers with 4 states + 8 platform lights + wall lamps + signal heads + emergency beat +
sodium glow + train spots + muzzle light; signage (mosaic, 4 hanging signs, EXIT signs, floor stencils, 8 posters (2+ backlit),
column plates, DANGER plates, 3 graffiti); props: benches, cans, vending, wet-floor sign, litter, ceiling services, drains,
extinguisher cabinet, west fence + gate + catwalk + blue door; stair + mezzanine (floor, walls, ceiling, turnstile line,
shutter with warm slit, one light shaft, EXIT sign, service door); post chain with grade; enemies (3 archetypes, 5 palette
variants, all animation states, eye glow, blood puffs + decals, blob shadows); weapons (3 viewmodels with moving parts, flash,
tracers, casings, recoil/sway/bob, reload/pump/switch animations); train (4 cars, corrugated steel, lit interior with seats/
poles/strips/ads, animated doors, cab with route sign + headlights + spots, bogies with spinning wheels, choreography, chime);
dust motes; impact sparks/dust; bullet holes.

**SHOULD-HAVE [T2]**: second-seed variants everywhere + per-bay tints; sticker atlas + flyers; mezzanine dressing (booth, fare
machines, map, payphones); duct grilles + platform shaft + steam vent + ceiling drip; track debris; overturned can; sign sway;
train rumble camera shake; third-rail sparks; brake sparks; wall blood spatter; growing pools; headshot head-hide; hoodie cone,
hard hats; ADS; ammo drops; damage arcs; decals of all surfaces; severed sparking cable.

**NICE-TO-HAVE [T3]**: see **Appendix B** (moved out of the spec body on purpose; nothing there is planned, budgeted or
described beyond one line until the T2 gate of §0.2 has passed).

---------------------------------------------------------------------------------------------------

## 4. GAMEPLAY SPEC

Pillars in priority order: (1) **gun feel** — every shot produces a tracer, a flash that lights the scene, a camera kick,
a viewmodel kick, a casing, a sound, an impact; (2) **readable enemies** — three silhouettes distinguishable at 30 m;
(3) **the train is the show-piece** — scripted, cinematic, deterministic; (4) **escalation until death** — no win state.

### 4.1 Player controller (player.js)

#### 4.1.1 Look
Mouse deltas (`input.lookDelta`) × `PLAYER.mouseSens` (× 0.5 in ADS). `pitch` clamped ±`PLAYER.maxPitch`. Final camera
rotation = base (yaw, pitch) + recoil offsets (§4.2.5) + bob/roll (§4.1.4) + shake (§4.7). FOV 75 (sprint 80 over 0.2 s,
ADS 55 over 0.15 s [T2]). Attract mode on the start screen (real-time mode only): yaw drifts ±10° at 0.05 Hz.

#### 4.1.2 Movement
| Parameter | Value |
|---|---|
| Walk / sprint speed | 4.2 / 6.6 m/s (sprint needs `input.move.y > 0.3`) |
| Backpedal & pure strafe factor | 0.85 |
| Acceleration / friction | 40 m/s² toward desired velocity; no input: `vel *= exp(−12·dt)` |
| Capsule | r 0.35, height 1.8; feet at `pos.y = floorHeightAt(x, z)` |
| Step height | 0.35 (plinths); stairs are a ramp via `floorHeightAt` |
| Gravity / jump / crouch | none in Tier 1 (edge barriers), crouch [T3] |
Desired velocity = `normalize(move.x·right + move.y·forward) · speed`. Sprinting: FOV up, bob up, viewmodel to the sprint pose,
**cannot fire** (trigger ignored); releasing sprint or pressing fire cancels sprint and adds `raiseAfterSprint` before firing.

#### 4.1.3 Collision (each tick, after integration)
1. `y = floorHeightAt(x, z)`; if `null` → revert to the previous position (and try the X-only / Z-only moves so you slide along the barrier).
2. `colliders.resolveCircle(pos, 0.35, MASK.PLAYER, pos.y)` (3 passes).
3. Enemies within 2 m (alive, not corpses): circle overlap → push player 30 %, enemy 70 %.
4. Ensure `floorHeightAt` is still non-null after push-out; else revert.

#### 4.1.4 Head bob, roll, viewmodel sway
`bobPhase += 2π·f·dt` while moving (f = 1.9 Hz walk, 2.6 sprint); at rest the phase eases to the nearest multiple of π over
0.25 s. Vertical `A_v·|sin φ|` (0.035 walk / 0.05 sprint / 0.012 ADS); lateral `A_l·sin(φ/2)` (0.02 / 0.03); roll
`0.6°·strafe + 0.35°·sin(φ/2)` sprinting. Footstep on each zero crossing of `sin φ` (alternating L/R) → `player-footstep`.
Viewmodel (applied to `viewRoot`): sway `swayYaw += (−dx·0.0006 − swayYaw)·min(1, 12dt)` clamped ±0.06 rad (same for pitch);
breathing `y += 0.002·sin(2π·0.3·t)`, `x += 0.001·sin(2π·0.17·t)`; walk `x += 0.006·sin(φ/2)`, `y −= 0.004·|sin φ|`.

#### 4.1.5 Health
Max 100; regen 5 HP/s after 6 s without damage; low-health state ≤ 30 (`G.lowHealth = clamp((30 − h)/30)`). Damage §4.7.

### 4.2 Weapons (weapons.js)

#### 4.2.1 Stat table (authoritative copy in `constants.WEAPONS`)
| Stat | Pistol | Rifle (CARBINE) | Shotgun |
|---|---|---|---|
| Mode | semi (press per shot; 80 ms click buffer) | auto | pump: 0.12 s shot + 0.80 s pump |
| Damage / pellet | 34 | 24 | 13 × 9 pellets |
| Headshot mult (brute cap 1.5) | 3.0 | 2.0 | 1.5 |
| Limb mult | 0.75 | 0.75 | 0.75 |
| RPM | 420 (143 ms) | 720 (83.3 ms) | 65 |
| Mag / start reserve / max reserve | 15 / 90 / 135 | 30 / 150 / 270 | 6 / 30 / 48 |
| Base spread (stationary) | 0.5° | 1.1° | aim 0.8° + fixed pellet pattern (1 centre + 3 on a 1.6° ring + 5 on a 2.3° ring, jitter ≤ 0.3°; pattern-only worst case 2.6°) |
| Moving spread add | +0.7° | +0.9° | +0.6° |
| Bloom / shot, max, recovery | +0.35°, 2.5°, 5°/s after 80 ms | +0.28°, 4.0°, 6°/s after 60 ms | +1.2°, 3.0°, 4°/s after 150 ms |
| Range full / min factor | 15 m / 0.7 @ 35 m | 22 m / 0.6 @ 45 m | 6 m / 0.25 @ 18 m |
| Camera kick pitch / yaw | 1.3° × rng(0.9,1.15) / rng(−0.35, 0.35) | pattern `RIFLE_PATTERN` × rng(0.9,1.1), yaw + rng(−0.08,0.08); i ≥ 12 uses row 11 with yaw ± rng(0.35) | 4.0° × rng(0.95,1.1) / rng(−0.8,0.8) + roll rng(−0.6°,0.6°) |
| Kick ramp / recovery | 40 / 140 ms | 30 / 110 ms | 60 / 260 ms |
| Viewmodel kick back / up | 0.045 m / 2.5° | 0.03 m / 1.6° | 0.09 m / 5° |
| Reload tactical / empty | 1.35 / 1.65 s (transfer at 70 %) | 2.1 / 2.5 s (transfer at 70 %) | start 0.35 + 0.55/shell (ammo at 60 % of the shell) + end 0.40 |
| Switch lower / raise | 0.22 / 0.28 | 0.28 / 0.32 | 0.30 / 0.38 |
| Raise delay after sprint | 120 ms | 150 ms | 180 ms |
| Tracer | 1 (r 0.012, 0.9 m) | 1 | 9 thin (r 0.006, 0.5 m) |
| Casing | brass 9 mm on shot | brass 5.56 on shot | red 12 ga hull on the pump stroke (t = 0.25) |
| Muzzle flash scale / light | 0.35 m / 8 cd | 0.45 m / 10 cd | 0.7 m / 18 cd |
TTK vs a 100 HP shambler: pistol 3 body / 1 head; rifle 5 body / 3 (2 head + 1 body); shotgun ≤ 6 m one shot if ≥ 8 pellets land.

#### 4.2.2 State machine
`ready | firing | pumping | reloading | lowering | raising | holstered`.
* `ready → firing` when trigger (semi: `fireJustPressed`, or buffered ≤ 80 ms) && `mag > 0` && cooldown ≤ 0 && `canFire`
  (not sprinting, not lowering/raising, raise-after-sprint elapsed). Fires this tick, `cooldown = 60/rpm`; back to `ready` next tick
  (pistol/rifle) or `pumping` for 0.80 s (shotgun; hull ejected at 0.25 s; `pumpBack` sfx at 0.12, `pumpForward` at 0.55).
* Trigger on empty → `weapon-empty` (`dryFire`, rate-limited 4/s) and auto-reload after 0.25 s if reserve > 0.
* `ready|pumping → reloading` on R when `mag < magSize && reserve > 0`. Pistol/rifle: at 70 % of the duration `n = min(magSize − mag, reserve)`
  transfers. Shotgun: start → shell loop (`while mag < 6 && reserve > 0 && !cancel`) → end; firing (if mag > 0), switching or
  sprinting cancels after the current shell. Switching cancels pistol/rifle reloads (ammo transferred only if past 70 %).
* `any → lowering (t_lower) → raising (t_raise) → ready` on switch. **`index`/`current`/`getState().weapon` flip to the target on the
  tick the switch is requested** (so `switchWeapon(2); step()` reports `'rifle'`), `weapon-switch` is emitted then, `t_lower` is the
  *outgoing* weapon's `lower` (its viewmodel animates down), `t_raise` the incoming weapon's `raise`; `weaponState` reads
  `'lowering'`/`'raising'` and `canFire()` is false until `'ready'` (pistol→rifle: 0.22 + 0.32 = 0.54 s). A switch during
  `lowering` retargets (index changes again, the lowering continues). Wheel debounced 120 ms.
* Sprint keeps `ready` but `canFire = false`; the viewmodel plays the sprint pose.

#### 4.2.3 Firing a shot
```
origin = eye; baseDir = camera forward INCLUDING recoil offsets (recoil moves the shot — that is why it matters)
for i in pellets: dir = perturb(baseDir, spreadDeg [+ patternOffset(i) rotated by a random per-shot angle for the shotgun])
   hit = trace(origin, dir, BALLISTICS.maxDist)                 // §4.3
   tracer from muzzleWorld (+ forward·0.15) to hit.point (or origin + dir·120) unless dist < 1.5 m
   enemy hit → enemies.applyDamage(...) ; world hit → emit shot-hit-world
mag−− (unless infiniteAmmo); bloom += bloomDeg (≤ max); recoil kick (§4.2.5); viewmodel kick (§4.2.6)
particles.muzzleFlash(muzzleWorld, dir, flashScale·rng(0.8,1.2), variant); lighting.flashMuzzle(muzzleWorld, flashLight)
particles.ejectCasing(kind, ejectWorld, right·rng(1.8,2.8) + up·rng(1.2,2.0) + back·rng(0.2,0.6) + playerVel, randomAngVel 20–40 rad/s)  (shotgun: on the pump instead)
emit shot-fired {weapon, origin, dir, muzzle, pellets}; stats.shotsFired++ (a shotgun shot counts once; "hit" if any pellet hit an enemy); hud.onShot()
```
`spreadDeg = base + moveAdd·clamp(|vel|/walkSpeed, 0, 1.4) + bloom` (× 0.35/0.30/0.6 in ADS [T2]). `perturb`: uniform disc
(radius `sqrt(rng())·spread`, uniform angle) around `baseDir` using camera right/up. **Shotgun pattern** (`patternRingDeg`,
`patternRingCount`, `patternJitterDeg`): pellet 0 on the aim axis, pellets 1–3 at 1.6° (angles 0°/120°/240°), pellets 4–8 at 2.3°
(36° + 72°k); the whole pattern is rotated by one random per-shot angle and every pellet jittered inside a 0.3° disc; the shared
aim spread (`spreadDeg`, 0.8° stationary with no bloom) is applied once to `baseDir`. **Guarantee** (arithmetic, not luck):
pattern-only cone ≤ 2.6° → 0.159 m at 3.5 m; pattern + stationary aim spread ≤ 3.4° → **0.178 m at 3.0 m**, inside the 0.20 m
chest capsule when aimed at its centre (`hitVolumeCenter(enemy, 'torso')` = the chest capsule midpoint) → all 9 pellets hit a
standing target at ≤ 3.0 m regardless of seed (smoke check 7 tests at 3.0 m). At 3.5 m the total cone is 0.208 m, so 8–9 of 9.

#### 4.2.4 Reload / pump / switch timelines (poses in viewmodels.js; sfx cue times)
* **Pistol** (t ∈ [0,1] of 1.35 s / 1.65 s empty): 0–0.20 roll left 25°, pitch down 10°, move (−0.02, −0.03, +0.02), off-hand to the mag (`reloadStart`
  at 0.02); 0.20–0.30 mag slides −0.15 m along the grip then hides; `particles.dropMag` (`magOut` at 0.22); 0.30–0.75 off-hand dips out and returns
  with a fresh mag; 0.75–0.85 mag inserts (`magIn` at 0.83; transfer at 0.70 of total); 0.85–1.0 return. Empty: 0.85–0.92 slide pulled back 0.06,
  0.92–0.97 snaps forward (`slideRack` at 0.95). Slide held back (−0.04) while `mag == 0`.
* **Rifle** (2.1 / 2.5 s): tilt right 20°; mag out + drop 0.15–0.30; hand away/back 0.30–0.70; mag rocks in 12° about z 0.70–0.85 (`magIn` 0.82;
  transfer at 0.70 of total); tap 0.85–0.90; return. Empty: charging handle back 0.05 then release (`boltRack`) 0.90–0.97.
* **Shotgun**: start (0.35 s) roll right 30° so the port faces the camera; each shell (0.55 s): shell mesh from below to the port (0–0.35), push in
  (0.35–0.45, `shellInsert`, ammo +1 at 0.33 s), hand retreats; end (0.40 s): roll back, `pumpShort` if the reload started with `mag == 0`.
* **Pump** (0.80 s): fore-end back 0.085 m (0.10–0.30, `pumpBack` 0.12, hull at 0.25), hold (0.30–0.45), forward (0.45–0.65, `pumpForward` 0.55);
  the gun dips 0.01 and rolls 3°.
* **Switch**: lowering = translate (0, −0.25, 0) + pitch −35° ease-in over `lower` (`holster`); raising = reverse with ease-out-back 1.2 (`draw`).

#### 4.2.5 Camera recoil (player integrates; weapons writes `recoilTarget`)
On a shot: `target.pitch += kickPitch; target.yaw += kickYaw (; target.roll += kickRoll)`. Applied offset moves toward the target over the
ramp time (`applied += (target − applied)·min(1, dt/rampRemaining)`). Recovery starts `RECOIL.holdTime` after the last shot:
`target *= exp(−dt/τ)`, τ = recovery/3. While the player pulls the mouse down during recovery, consume the pull from `target.pitch`
first (`consumed = min(−dPitch, target.pitch); target.pitch −= consumed; basePitch += dPitch + consumed`) so counter-recoil never
over-returns. Rifle pattern index resets after 0.35 s without firing. ADS halves camera kick [T2].

#### 4.2.6 Viewmodel kick springs
`vel.pos.z += kickBack·k1; vel.rot.x += kickUp·k2; vel.rot.z += rng(−1,1)·kickUp·0.3; vel.pos.x += rng(−1,1)·kickBack·0.25`;
`acc = −K·offset − D·vel` with `RECOIL.vmSpringK/D` (pos) and `vmRotK/D` (rot) — a pistol shot peaks at 0.045 m / 2.5° and settles in ~250 ms;
rifle sustained fire floats the gun up-right and settles ~300 ms after release.

### 4.3 Ballistics and hit feedback

`trace(origin, dir, maxDist)`: `world = colliders.raycast(origin, dir, maxDist, MASK.BULLET)`;
`enemy = enemies.raycast(origin, dir, world ? world.dist : maxDist, _enemyHit)` (module scratch `out`, required); return the nearer.
No penetration; corpses are not hittable.
Enemy raycast: bounding sphere at the pelvis (r `ENEMY.boundingR`·scale) then the 17 capsules (`utils.rayCapsule`), head first, nearest wins.
Cost target < 0.05 ms with 24 enemies.

Damage: `dmg = weapon.damage × mult(group) × falloff(dist)`, `mult(head) = min(weapon.headMult, def.headMultCap)`, torso 1.0, arm/leg 0.75;
`falloff = 1` up to `fullRange`, lerp to `minFactor` at `minRange`, clamped. `enemies.applyDamage` returns `{killed, headshot, staggered}`.
Wave HP multipliers apply to max HP at spawn, never to damage.

Feedback: HUD hit marker (white body / yellow head / red + 30 % larger on kill; shotgun one marker per shot by best outcome), `hitMarker`
sounds (§7), enemy flinch (§5.5), blood burst (§4.4.5), crosshair contracts 15 % for 100 ms. No damage numbers, no health bars.

Stats (`G.stats`): shotsFired, shotsHit, headshots, kills, killsByType, damageDealt, damageTaken, wavesCleared, bestStreak (kills within 3 s
windows), timeSurvived; `accuracy = shotsHit/shotsFired`; `score = Σ points × (headshot ? 2 : 1)` (game-over screen only).

### 4.4 Effects (particles.js + decals.js) — all pooled, zero runtime allocation

#### 4.4.1 Muzzle flash
Three additive planes at the muzzle (cross of two 0.35 × 0.35 perpendicular quads along the barrel + a 0.25 forward-facing disc),
`muzzleFlash` atlas variant random, random roll, scale `flashScale × rng(0.8, 1.2)`, lifetime 55 ms (scale 0.6 → 1.0 in 15 ms, then opacity → 0),
`depthTest false`, `renderOrder 20`. Rifle adds 2 side cards (40 ms). Plus the muzzle light (§3.6.6), 1 smoke puff (shotgun 3) from the
muzzle at 1.5 m/s decaying to drift (0, 0.3, 0), 0.12 → 0.45 m over 0.6 s, α 0.35 → 0; every 4th rifle shot and every shotgun shot 2–3 embers.

#### 4.4.2 Tracers
`InstancedMesh(96)` of a unit cylinder (6 radial segments, no caps) along +Z, `MAT.tracer`, instanceColor brightness ×2.5 (blooms).
Spawn from `S` = muzzle world (+ forward·0.15) to `E` = hit point (or 120 m); skip if dist < 1.5 m. Speed 280 m/s; total time clamped
[35, 110] ms. Per tick `head = min(dist, v·age)`, `tail = max(0, head − len)`; place from `S + dir·tail` to `S + dir·head`
(`Matrix4.lookAt`, scale.z = length, xy = radius); brightness 1 until the head arrives, then fade over 40 ms while the tail catches up.
Shotgun: 9 instances of radius 0.006, len 0.5. `frustumCulled = false`.

#### 4.4.3 Casings
`InstancedMesh(64)` cylinders: 9 mm r 0.0045 × 0.019, 5.56 r 0.0045 × 0.045 (scaled per instance), 12 ga hull r 0.0095 × 0.06 red.
Gravity 9.81; on `y ≤ floorHeightAt + r`: vy × −0.35, vxz × 0.7, ω × 0.5; `casingBounce` (`hullBounce` for the hull) on the first two
bounces within 6 m of the player; rest after 3 bounces or |v| < 0.15; life 8 s then shrink 0.3 s. Dropped magazines (6 pooled, same
physics, `magDrop` on first contact).

#### 4.4.4 Impacts (by surface) — `particles.impact(pos, normal, surface, weapon)`; decals & audio listen to `shot-hit-world`
| Surface | Particles | Puff | Decal | Sound |
|---|---|---|---|---|
| concrete / tile | 6–10 grey chips 0.01 m at 2–5 m/s along the reflected dir ±40°, gravity, 0.6 s | dust 2 sprites 0.15 → 0.5 m, 0.5 s, α 0.5 → 0 | dark chip 0.06 (tile: bisque chip) | `impactConcrete` / `impactTile` |
| metal | 10–16 additive sparks 4–8 m/s, gravity × 0.5, 0.35 s, short trails | tiny grey puff 0.2 s | scratch 0.04 | `impactMetal` (20 % `ricochet`) |
| glass | 8 white-cyan shards 0.7 s | none | crack star 0.12 | `impactGlass` |
| wood | 5–8 tan splinters 0.5 s | light brown puff | hole 0.05 | `impactWood` |
| plastic / paper | 4 flecks | none | hole 0.04 | `impactSoft` |
| none (edge barrier) | nothing | | | |

#### 4.4.5 Blood
Burst: 8–14 particles (0.006–0.014 m, colour (0.35, 0.02, 0.02)) along the reflected dir ±60° at 1.5–4 m/s, gravity, 0.5 s + 2 mist sprites
(0.1 → 0.35 m, α 0.35 → 0, 0.4 s). Headshot kills: 24 particles + 4 mist upward. Floor splat decal under the hit (random of 8, 0.25–0.5 m).
Death pool: decals listens to `enemy-rest` (emitted by enemies when the corpse has landed and finished twitching, §5.6) and adds
the pool `FX.poolDelay` = 0.6 s later at the event's torso position (so it sits under the body, which travels up to 0.5 m during
the fall); grows 0.2 → 1.2 m over 3 s (roughness 0.3). Keep blood dark (#4a0a0a), never bright red.

#### 4.4.6 Effects budget
Worst case (shotgun on metal at 3 m): 3 flash planes + 1 light + 3 smoke + 9 tracers + 1 hull + 9 × 12 sparks + 9 decals — all pooled.
Effects draw calls ≤ 10 (tracers 1, casings 1, mags 1, points 2, smoke 1, flash 3, blob shadows 1).

### 4.5 Enemies — archetypes, AI, steering (enemies.js)

#### 4.5.1 Archetypes (authoritative in `constants.ENEMY_TYPES`)
| | Shambler | Runner | Brute |
|---|---|---|---|
| Silhouette | 1.75 m, sagging, arms raised forward, head lolling | 1.7 m lean, leaning forward 25°, arms pumping, hood | 2.3 m, 1.6× shoulder width, hunched, huge forearms, exposed ribs |
| Variants (palette) | commuter (skin #8a9478, shirt #d9dad2 + tie, trousers #2b2d33), worker (skin #7a8a6a, hi-vis #ff7a1a with reflective stripes, hard hat 50 %), nurse (skin #6f8a70, scrubs #4aa0a0) | hoodie (skin #6e7a66, hoodie #3a3a44, jeans #2f3a52, white sneakers) | brute (skin #5e6650, torn shirt, one forearm a pale bone) |
| HP / speed (±var) / turn | 100 / 1.35 (±15 %) / 180°/s | 70 / 4.4 (±10 %) / 420°/s | 450 / 1.1 walk, 4.5 charge / 90°/s |
| Radius | 0.35 | 0.32 | 0.55 |
| Attack | swipe: range 1.5, dmg 12, windup 0.45 / active 0.15 / recover 0.60, cd 0.4 | swipe: 1.4, 8, 0.25/0.12/0.45, cd 0.3; **lunge [T2]**: trigger 2.5–4 m, windup 0.30, airborne 0.35 at 7.5 m/s (apex 0.35), dmg 14, range 1.2, recover 0.8, cd 4 | slam: 2.1, 30 + knockback 4 m/s, 0.70/0.15/1.00, cd 0.5; **charge [T2]**: trigger 5–12 m, windup 0.6 (roar), run 4.5 m/s ≤ 2.5 s, 20 dmg + 5 m/s knockback, recover 0.9, cd 8 |
| Stagger | dmg ≥ 30 or any headshot; 0.40 s; cd 1.5 | ≥ 25 or headshot; 0.35 s; cd 1.2 | ≥ 90 or headshot ≥ 60; 0.55 s; cd 3.0; immune while charging |
| Head sphere r | 0.14 | 0.13 | 0.17 |
| Points / vocal pitch | 1 / 0.9–1.1 | 1 / 1.3–1.5 | 3 / 0.55–0.65 |
Per-instance at spawn (`G.rng`): height scale 0.94–1.06, `legScale 0.92–1.08`, `torsoW 0.9–1.15`, tint ±10 % L, phase offset, limp side (shambler), vocal timer.

#### 4.5.2 State machine
```
inactive → waiting (in train, doors shut) → exiting (scripted walk) → chase ⇄ attack(windup→active→recover) → chase
        → spawning (door/gate, 0.6–1.2 s wake) ↗            ↓ stagger (hit ≥ threshold)        ↓ hp ≤ 0 from any state
runner: chase → lunge [T2] → chase   brute: chase → charge [T2] → chase                 dead (fall) → corpse → sinking → inactive
idle (debug: never moves/attacks)
```
* **waiting**: idle sway inside the car; no collision; hittable (through open doors only in practice).
* **spawning** (door/gate): placed at `spawnPoint.pos`, slumped, arms rising over 0.6–1.2 s; `enemy-vocal {kind:'spawn'}`.
* **exiting**: move along `exitDir` at `ENEMY.exitSpeed` until `exitDist` (y lerps to `floorHeightAt`); ignores edge/gate/door colliders and
  the walkable clamp; walk anim; the first one out of each train door pauses 0.4 s and lifts its head (telegraph); emits `enemy-exited` → chase.
* **chase**: steer (§4.5.3); attack when `dist ≤ attackRange && |angleTo player| ≤ 35° && cooldown ready`; lunge/charge triggers as in the table.
* **attack**: windup (tracks the player at 50 % turn rate), active (on the first tick with `dist ≤ range + 0.2 && |angle| ≤ 60°`, apply damage
  once via `player.applyDamage(dmg·dmgMult, pos, enemy, {knockback})`), recover. Emits `enemy-attack` at windup start.
* **stagger**: movement stops, flinch amplified ×1.8, steps back 0.25 m over the duration, cancels any attack (even active). `enemy-stagger`.
* **dead**: emit `enemy-killed`, death vocal, death animation (§5.6), removed from steering/collision (others walk through); when the
  body has landed and the 0.4 s twitch phase ends → `enemy-rest {enemy, pos}` (§1.8, blood pool trigger); corpse 9 s (brute 12),
  then sinks `ENEMY.sinkDepth` over 1.5 s → inactive. `corpseCap` 10 → the oldest sinks early; the pool uses `tryAcquire()` and, when
  it returns null, sinks the oldest corpse instantly and retries (alive enemies are never stolen).
* **idle** (debug only, `spawnEnemy(…, {state:'idle'})`): never moves or attacks, holds the **idle clip with hanging arms** (§5.5 —
  upperArm.x ≈ −0.2, lowerArm.x ≈ −0.3, so no arm capsule sits in front of the chest), faces the player at spawn unless `opts.yaw`
  is given, is hittable and counts as alive.
* Targeting: only the player; enemies always know where the player is (no perception model).
* LOD: beyond `ENEMY.lodDistance` animate every 2nd tick; behind the camera (dot < −0.3, > 15 m) skip animation.
* Vocals: per-enemy timer `rng.range(3, 9)` s → `enemy-vocal` (moan / shriek / grumble by type) when within 25 m; growl at attack windup; hurt grunt
  rate-limited 0.25 s; death vocal; global cap 6 voices (nearest win — audio.js enforces).

#### 4.5.3 Steering (XZ, per alive chase/exiting/windup enemy)
```
seek  = nav.flowAt(pos) (chase) | exitDir (exiting) | toward waypoint
sep   = Σ neighbours within R = r_i + r_j + 0.35: (pos − pos_j)/d · (1 − d/R)          (SpatialHash cell 2 m rebuilt each tick)
avoid = nearest column/box within 2.5 m in the front half-plane: tangent on the side nearer to seek, weight (1 − d/2.5)
wall  = inward normal if within 0.5 m of the walkable bounds and heading out
desired = normalize(seek·1.0 + sep·1.6 + avoid·2.2 + wall·2.5) · speed · speedScale
vel += (desired − vel) · min(1, 8·dt); pos += vel·dt; yaw → heading at turnRate; head leads up to 0.3 rad toward the player
then: colliders.resolveCircle(pos, radius, MASK.ENEMY, y); enemy-vs-enemy push (equal split); player push (§4.1.3); clamp to walkable (unless exiting); y = floorHeightAt
stuck: if moved < 0.2 m in 1.5 s → random nudge 1 m
```
**Attack ring**: at most `ENEMY.attackRing` (3) enemies inside `attackRange + 0.3`; extra chasers stop at `orbitDist` 2.4 m and orbit
(tangential component ±0.6, side by id parity) until a slot frees; brutes always get a slot (displacing a shambler).

### 4.6 Wave director and the train orchestration (waves.js)

#### 4.6.1 States
`idle → intro (2.0 s banner) → active → cleared (3.0 s banner + wave stats; HUD shows pulsing
“WAVE CLEARED — STATION SECURE” so the player always sees the transition) → breather (pulsing “NEXT TRAIN IN 0:0X” countdown;
crate re-armed by waves; skippable) → train
(arrival → doors → spawn → depart) → active (next wave) … → gameover` (from any state on death).
**Wave numbering**: `waves.wave` (= `getState().wave`, HUD `#wave-label`) increments to n+1 **at `train-called`** — the breather ends,
the train is called for wave n+1, the HUD reads "WAVE n+1 — INCOMING TRAIN" for the ≈ 17.6 s of the arrival. `wave-start {wave:n+1,
source:'train'}` still fires at `train-doors-open` (the gameplay start of the wave; the banner "WAVE n+1" and the sting are tied to
it). `wave-clear {wave:n}` is emitted before the increment. `skipToWave(n)` sets `wave = n` synchronously (§9.3).
Wave 1 has no train: spawning begins at the end of the intro from the two doors.

#### 4.6.2 Spawn queue
Each wave builds `queue = [{type, source}]` of `config.count` entries: constrained shuffle (`G.rng`; brutes never in the first 25 %, ≤ 2 runners in
any 3 consecutive), the first `trainBatch` tagged `train` (waves ≥ 2), the rest tagged `door` (late arrivals, eligible after `train-gone` + 1 s).
`maxAlive` per config; spawns are held while `aliveCount ≥ maxAlive`.
* **Wave 1**: 5 shamblers alternating `mezz-door`, `west-gate`, `mezz-door`, `west-gate`, `mezz-door` at T = 2, 5, 8, 11, 14 s after the intro
  (cadence 3.0); speed variation biased slow (0.85–1.05). First contact ≈ 20–25 s (they walk in from far away).
* **Waves ≥ 2**: on `train-stop` spawn `min(trainBatch, 12)` enemies `waiting`, one per door (door order shuffled). On `train-doors-open`:
  door i's enemy starts `exiting` after `i · trainCadence`; whenever a door's enemy has exited (`enemy-exited`), the next `train` entry spawns
  `waiting` at that door and exits after `trainCadence` (skip a door if an enemy is still within 1.2 m of its threshold). When the train batch is
  exhausted (or `aliveCount ≥ maxAlive` for > 6 s — remaining train entries are re-tagged `door`) + 2.0 s → `train.closeDoors()`.
  The train departs on its own; `train-gone` + 1 s → late arrivals from `mezz-door`/`west-gate` alternating at `cadence` with a 1.5 s side stagger.
* **Clearability invariants** (a wave must clear through the real damage path — killing every enemy that ever appears; smoke exercises exactly
  this and no debug kill-all): queue entries are consumed **only on successful spawn** — a failed spawn (pool exhaustion) leaves the entry queued
  for retry, and pool slots are released at `sinking → inactive` (§4.5.2) so the queue always drains. An enemy killed mid-transit releases its
  door: station door → `sp.busy = false` + `spawn-door-close`; train door → **hand-off**: the next `train` entry spawns into the same door, so the
  delivery chain can never be killed by player fire. Hard cap: after `WAVES.doorsOpenMax` (25 s) of open doors, remaining `train` entries are
  re-tagged `door` and the doors close — the phase always terminates. Verified waves 1–10 in natural flow (max wave: 40/40 spawned & cleared).
* `active → cleared` when the queue is empty and `aliveCount === 0` (debug-spawned enemies count).
* Door bookkeeping: a door/gate `open()`s when its enemy spawns and `close()`s 1.5 s after `enemy-exited`.

#### 4.6.3 Breather, resupply, calling the train
`breather` seconds per config (8 / 6 / 4). HUD "NEXT TRAIN IN 0:08". The crate (`station.crate`) is armed by **waves** (`crate.setArmed(true)`)
at `begin()` and at every `cleared`; waves is the only module that writes crate state (station only animates the lamp/lid it is told to). Player within `CRATE.interactDist` and looking within 40° → prompt "E — RESUPPLY"; E → reserves to max (mags untouched),
`health = min(100, health + 50)`, `crateOpen` sfx, lid opens, lamp red, `resupply` event. During the breather after resupplying, E shows
"E — CALL TRAIN" and ends the breather. Breather end → `wave = n+1`, `train.callTrain(trackForWave(n+1))` (`constants.trackForWave`: A when the
wave number is even, B when odd → A for wave 2, B for 3, A for 4 …; `skipToWave` uses the same function).
Ammo drops [T2]: every brute kill and 12 % of other kills drop a box (pool 16, emissive stripe, 25 s life, blinks the last 5 s); walking within
1.0 m grants one magazine of the current weapon's reserve (`ammo-pickup`).

#### 4.6.4 Tuning table (authoritative in `constants.WAVE_TABLE` / `waveConfig`)
| Wave | count | S / R / B | hpMult | speedMult | dmgMult | door cadence | trainBatch | trainCadence | maxAlive | breather |
|---:|---:|:---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 5 | 5/0/0 | 1.00 | 1.00 (slow bias) | 1.00 | 3.0 | — | — | 8 | 8 |
| 2 | 8 | 7/1/0 | 1.00 | 1.00 | 1.00 | 2.5 | 8 | 0.90 | 10 | 8 |
| 3 | 11 | 8/3/0 | 1.05 | 1.03 | 1.00 | 2.5 | 11 | 0.80 | 12 | 8 |
| 4 | 14 | 9/4/1 | 1.10 | 1.06 | 1.10 | 2.2 | 14 | 0.75 | 14 | 6 |
| 5 | 18 | 11/5/2 | 1.15 | 1.09 | 1.15 | 2.0 | 18 | 0.70 | 16 | 6 |
| 6 | 22 | 12/7/3 | 1.20 | 1.12 | 1.20 | 1.8 | 20 | 0.65 | 18 | 6 |
| 7 | 26 | 13/9/4 | 1.30 | 1.15 | 1.30 | 1.6 | 22 | 0.60 | 20 | 4 |
| 8 | 30 | 14/11/5 | 1.40 | 1.18 | 1.40 | 1.4 | 24 | 0.50 | 22 | 4 |
| 9 | 35 | 16/13/6 | 1.50 | 1.21 | 1.50 | 1.2 | 26 | 0.45 | 24 | 4 |
| 10 | 40 | 17/15/8 | 1.60 | 1.24 | 1.60 | 1.0 | 28 | 0.45 | 24 | 4 |
Beyond 10: `count = 40 + 5k`, `brutes = 8 + k`, `runners = round(0.38·count)`, `hpMult = 1.6 + 0.1k`, `speedMult = min(1.5, 1.24 + 0.03k)`,
`dmgMult = 1.6 + 0.1k`, `cadence = max(0.6, 1 − 0.05k)`, `trainBatch = min(count, 28 + 2k)`, `trainCadence 0.45`, `maxAlive 24`, `breather 4` (k = n − 10).
Expected death around wave 7–9 for a competent first-time player. Ammo check (wave 5, torso accuracy 100 %): ≈ 110 rifle rounds — one load-out
with misses; the crate refills between waves; from wave 8 drops and headshots become necessary.

#### 4.6.5 Score / kills
`kills` counts bodies (HUD). `score` §4.3.

### 4.7 Player damage, death, game over, restart

* `applyDamage`: `health −= amount` (god mode skips), `lastDamage = 0`, `player-hit` (HUD vignette flash 0.55 → 0 over 0.5 s, directional arc,
  `playerHurt` sfx rate-limited 0.2 s), camera shake 0.5° for 0.2 s (brute 1.0° / 0.35 s), knockback `vel += normalize(pos − from)·knockback`,
  viewmodel jolt 0.02 m down. `health ≤ 30`: heartbeat loop (70 → 110 bpm at 5 HP), master low-pass 0.35 duck, grade desaturation.
* Death (`health ≤ 0`): `dead = true`, `player-death {reason}`; camera pitch → −35°, eye → 0.45 m over 0.8 s (ease-in), roll → 20°, viewmodel drops
  out; the world keeps simulating 1.5 s (enemies loom), then freezes (enemies idle-animate at 0.3×). HUD fades; after 1.5 s `#gameover` shows
  "YOU DIED" (or "HIT BY TRAIN" [T3]) + stats; pointer lock released; `gameOver` sfx; master low-pass sweeps to 600 Hz.
* Restart (R / click / Enter / `__game.restart()`): full soft reset (§2.3: `G.time = 0`, `G.frame = 0`, event ring cleared, every
  system `reset()`) → intro(1). RNG is **not** reseeded unless `seed()` is called.

---------------------------------------------------------------------------------------------------

## 5. HUMANOID RIG AND ANIMATION (rig.js / enemies.js)

One `SkinnedMesh` per enemy (one draw call), procedurally built skeleton, rigid binding (one bone per vertex), animation =
bone rotations computed per tick by layered clip functions. No physics engine; deaths are kinematic.

### 5.1 Bone hierarchy (21 `THREE.Bone`, bone-local offsets in metres at scale 1; depth-first order = `BONE_NAMES`)
```
root (Group: pos = enemy.pos, rotation.y = yaw, scale = def.scale × bodyScale; local forward = −Z)
└ pelvis        (0, 0.96·legScale, 0)
   ├ spine      (0, 0.14, 0)
   │  └ chest   (0, 0.20, 0)
   │     ├ neck (0, 0.26, 0)  └ head (0, 0.10, 0)
   │     ├ shoulderL (−0.24·torsoW, 0.20, 0) └ upperArmL (0,0,0) └ lowerArmL (0,−0.30,0) └ handL (0,−0.28,0)
   │     └ shoulderR (+0.24·torsoW, 0.20, 0) └ upperArmR (0,0,0) └ lowerArmR (0,−0.30,0) └ handR (0,−0.28,0)
   ├ hipL (−0.11, −0.04, 0) └ upperLegL (0,0,0) └ lowerLegL (0,−0.44,0) └ footL (0,−0.42,0)
   └ hipR (+0.11, −0.04, 0) └ upperLegR (0,0,0) └ lowerLegR (0,−0.44,0) └ footR (0,−0.42,0)
```
Tune pelvis height 0.94–0.96 in `dev/rig.html` so the soles touch y = 0.
Yaw: `enemy.yaw = atan2(−dx, −dz)` for facing `(dx, dz)`. Variation: `legScale` on upperLeg/lowerLeg `scale.y` (+ pelvis height
compensation), `torsoW` on chest `scale.x` (shoulders' children counter-scaled `1/torsoW`), `headScale`, `bodyScale`.
Brute: `def.scale 1.32`, `torsoW 1.15`, arms `scale 1.15`; runner: limbs `scale.x/z 0.9`. Bones are children of the mesh (`mesh.add(pelvis)`).

### 5.2 Parts (17, rigidly bound; `partId` attribute; atlas quadrant UV remap)
| part | bone | geometry (bone-local) | atlas |
|---|---|---|---|
| pelvis | pelvis | Box 0.34 × 0.24 × 0.22 at (0, 0.02, 0) | cloth-bottom |
| spine | spine | Capsule r 0.15 len 0.10 at (0, 0.08, 0) | cloth-top |
| chest | chest | Box 0.42 × 0.30 × 0.26 at (0, 0.12, 0), 2×2×2 segments, top verts x −8 % (taper); torn-shirt jagged hem via vertex colour threshold | cloth-top |
| neck | neck | Capsule r 0.06 len 0.08 at (0, 0.05, 0) | skin |
| head | head | Capsule r 0.115 len 0.06 at (0, 0.11, 0), 6 cap / 12 radial, scale y 1.15; + jaw box 0.09 × 0.05 × 0.08 (child of head; opens on shambler wind-up / runner shriek / brute impact / death, rests agape on the corpse); 2 eye spheres r 0.016 `eyeGlow`; hood cone for hoodie | face (front +Z; cylindrical wrap, front at uL 0.5) |
| upperArmL/R | upperArm | Capsule r 0.06 len 0.28 at (0, −0.15, 0) (brute r 0.085) | cloth-top |
| lowerArmL/R | lowerArm | Capsule r 0.05 len 0.26 at (0, −0.14, 0) (brute r 0.075; one is a pale bone capsule r 0.03) | skin |
| handL/R | hand | Box 0.08 × 0.16 × 0.04 at (0, −0.08, 0) + 2 finger capsules (shambler: spread claws) | skin |
| upperLegL/R | upperLeg | Capsule r 0.085 len 0.40 at (0, −0.22, 0) | cloth-bottom |
| lowerLegL/R | lowerLeg | Capsule r 0.065 len 0.40 at (0, −0.22, 0) | cloth-bottom |
| footL/R | foot | Box 0.10 × 0.06 × 0.26 at (0, −0.01, 0.07) (toes +Z), UVs remapped into the atlas shoe band (dark sole + tread notches) | cloth-bottom (shoe band) |
Extras merged into the same geometry (group 0): belt + metal buckle (all variants), tie + cross-body bag strap (commuter),
hi-vis vest panels (worker), white coat + nurse cap + cross badge + stethoscope torus (nurse), hood + drawstrings + backpack + straps (hoodie),
 brow ridge + pale tusks + exposed bone capsule + shoulder slabs + torn-sleeve threshold (brute). ~2.6–3.2 k tris total
(`CapsuleGeometry(r, len, 4, 10)`). The worker's two 3 cm reflective bands are geometry in group 1 (`eyeGlow`) alongside the eyes.

Build (`buildRigGeometry(type, variant)`, cached): per part create → place → add `skinIndex [boneIdx,0,0,0]` (Uint16) + `skinWeight [1,0,0,0]` +
`partId` (Uint8) + `color` (vertex AO 0.55 under arms/crotch/neck ring, hands/feet 0.8, 3-octave noise bruising patches ×0.85) + UV remap into
the quadrant (`u' = u·0.5 + qx`, `v' = v·0.5 + qy`; head: cylindrical mapping, face front at +Z / uL 0.5; belt & friends map into the
"sticker row" of 8 64×128 px swatches at cloth-top vL 0.86..1; feet into the cloth-bottom shoe band vL 0.82..1) → body parts merged, glow parts
merged, then `mergeGeometries([body, glow], true)` → groups [0 = enemy atlas material, 1 = `eyeGlow`] → `computeBoundingSphere()` then
radius `max(r, ENEMY.boundingR)`. Vertex colours are neutral: per-part AO × 3-octave bruise (×0.85); pale parts (tusks/bone) get >1 to read lighter.
Per pool slot: own bones + `Skeleton` + `SkinnedMesh(geo, [clone, MAT.eyeGlow])`, `mesh.bind(skeleton)`, `frustumCulled = false`,
`castShadow = false`. Material: 5 clones per slot at pool build (32 × 5 = 160 objects sharing ≤ 6 programs) for hit flash
(`emissive = #5a1111` for 0.08 s on the hit enemy's clone only) and ±10 % luminance tint. Variant switch at spawn =
`mesh.geometry = GEO[type][variant]`, `mesh.material = [slot.mats[variantName], MAT.eyeGlow]`.

**Facing & face-visibility convention (verified):** `enemies.js` writes `root.rotation.y = e.yaw + π`
(`MODEL_YAW_OFFSET`), which maps the rig's model front (local +Z, where the face is painted) onto
`dirFromYaw(e.yaw)` = the AI facing direction — verified numerically: with a chasing enemy the camera sits on
the model's +Z side. Debug spawns *without* an explicit `yaw` face the station **origin** (not the player), so a
front-view probe must pass `yaw: yawFromDir(player − pos)` or it will photograph the back of the head (the seam
side of the cylindrical wrap — intentionally featureless). Face-quadrant feature coordinates (local, front at uL
0.5): sunken sockets + eyeball glint at vL 0.55 (3D emissive eye spheres just in front), lid crease, nostrils at
vL 0.42, open toothed mouth at vL 0.30 (directly above the jaw box), brow band at vL ≈ 0.71. An earlier
"monochrome faceless enemy" report was a combination of (a) probes viewing the back of the head and (b) an
over-wide brow formula that darkened the whole face quadrant uniformly — fixed by making it a real 0.09-wide band.

### 5.3 Hit capsules (bone-local `a`, `b`, `r`; world via `bone.matrixWorld`, `r` × bone world scale) — `HIT_CAPSULES`
| part | a | b | r | | part | a | b | r |
|---|---|---|---|---|---|---|---|---|
| head | (0,0.02,0) | (0,0.21,0) | 0.125 (def.headR overrides) | | pelvis | (−0.12,0.02,0) | (0.12,0.02,0) | 0.14 |
| neck | (0,0,0) | (0,0.10,0) | 0.07 | | spine | (0,0.02,0) | (0,0.14,0) | 0.16 |
| chest | (0,0.02,0) | (0,0.24,0) | 0.20 | | upperArm | (0,0,0) | (0,−0.30,0) | 0.07 |
| lowerArm | (0,0,0) | (0,−0.28,0) | 0.06 | | hand | (0,0,0) | (0,−0.16,0) | 0.05 |
| upperLeg | (0,0,0) | (0,−0.44,0) | 0.095 | | lowerLeg | (0,0,0) | (0,−0.42,0) | 0.075 |
| foot | (0,0,0) | (0,0,−0.20) | 0.06 | | | | | |
`PART_GROUP`: head, neck → `head`; chest, spine, pelvis → `torso`; arms/hands → `arm`; legs/feet → `leg`. Capsule world data is refreshed once per
tick **inside `enemies.update()`**, after the pose is applied (`root.updateMatrixWorld(true)` for hittable enemies only), into
`enemy.capsules` (Float32Array 17 × 7) — never in `render()`, so a `setTime()` without a render leaves capsules exact.
`hitVolumeCenter(enemy, 'torso')` = the world midpoint of the chest capsule; `'head'` = the head capsule midpoint.
Test order: head first, then torso, then limbs; nearest hit wins.

### 5.4 Textures per variant (textures.js `enemyAtlas`)
Skin generator (512²): base colour per variant, fbm mottling toward grey-green and purple (#5a4a5a bruising), 8–12 dark veins (thin Béziers α 0.35),
3–6 wounds (red-black ellipses with a lighter necrotic rim); greasy forehead spot (roughness 0.35) vs 0.65 elsewhere. Cloth: fabric noise + wear +
jagged tears revealing skin + stains; roughness 0.85. Face (front quadrant): sunken dark eye sockets, open mouth, nose wedge; eyes are the emissive
spheres. Brute chest: dark rib stripes. Worker: hi-vis with two 3 cm reflective stripes (emissive 0.4 grey, roughness 0.2).

### 5.5 Animation layers
Pose buffer: `Float32Array(21 × 3)` Euler XYZ per bone + `extras {pelvisY, rootTiltX, rootTwistY, rootY, rootZ}`. Final pose = weighted blend of the
active clips (weights damped toward targets at 8/s), then the **flinch spring** (additive), then `applyPose`. `speedRatio = |vel| / def.speed`;
`phase += 2π·|vel|/def.stride·dt`. Let `L = sin φ`, `R = sin(φ + π)`, `kneeL = max(0, sin(φ + 0.6))`, `kneeR = max(0, sin(φ + π + 0.6))`, `bob = (1 − cos 2φ)/2`,
`A = clamp(speedRatio, 0.35, 1.0)`.

**Locomotion**
| joint | shambler | runner | brute |
|---|---|---|---|
| upperLeg.x | 0.45·A·L (limp leg × 0.55 + 0.25 offset, foot drags 1 cm above the floor) | 0.95·A·L | 0.5·A·L |
| lowerLeg.x | 0.75·kneeL (limp 0.35) | 1.25·kneeL | 0.65·kneeL |
| foot.x | −0.2·upperLeg.x | −0.3·upperLeg.x | −0.2·upperLeg.x |
| pelvisY | 0.96·legScale − 0.02·bob (− 0.03 on the limp step) | − 0.05·bob | − 0.04·bob |
| pelvis.z / .y | 0.12·L / 0.05·L | 0.04·L / 0.12·L | 0.10·L / 0.06·L |
| spine.x (lean) | 0.15 + 0.05·bob | 0.42 | 0.30 + 0.03·bob |
| chest.y | −0.06·L | −0.16·L | −0.08·L |
| head.x / .y / .z | −0.25 + 0.1·sin(0.7φ) / 0.2·sin(0.43φ) / 0.15 | −0.1 / small / 0 | 0.1 / 0.15·sin(0.5φ) / 0 |
| upperArm.x / .z | −1.35 + 0.08·L (raised) / ±0.2 | −0.5 + 0.9·R / ±0.15 | −0.15 + 0.35·R / ±0.5 |
| lowerArm.x | −0.3 + 0.1·sin(1.3φ) | −1.2 | −0.5 |
| hand.x | 0.3 | 0 | −0.3 |
| twitch | spine.z += 0.04·sin(3.1t + phase) | | |
Foot planting: after posing, lower `root.position.y` by `min(footYL, footYR)` (≤ 0.06 m) computed from bone world matrices.
`speedRatio < 0.1` → blend (0.25 s) to **idle**: breathing chest.x ±0.02 @ 0.35 Hz, weight shift pelvis.z ±0.03 @ 0.2 Hz, head drift; shamblers sway ±0.05;
**arms hang** in idle for every type: upperArm.x −0.2 (± 0.03 breathing), upperArm.z ±0.12, lowerArm.x −0.3, hand.x 0.1 — the raised
locomotion arms blend down with the rest of the pose, so an `idle` enemy has no arm capsule in front of its chest (smoke checks 4/7).
**waiting** (in the train): idle + subtle forward lean toward the doors. **spawn**: from slumped (spine.x 0.6, head.x 0.5, arms hanging) into locomotion over the spawn time.

**Attack overlays** (weight 0 → 1 over 0.08 s, 1 → 0 over 0.25 s in recover):
* Shambler swipe: windup both upperArm.x → −2.0, spine.x −0.1, head.x −0.4; active upperArm.x → −0.6 in 0.15 s, lowerArm.x → −0.9, spine.x +0.35; recover ease back.
* Runner swipe: one-armed, alternating arms, faster. Lunge [T2]: windup deep crouch (upperLeg.x +0.9, lowerLeg.x 1.6, spine.x 0.6, arms back); airborne
  arms forward (upperArm.x −1.6), legs trailing (upperLeg.x −0.5), spine.x 0.3, root y parabola apex 0.35; land crouch 0.2 s then recover.
* Brute slam: windup arms high (upperArm.x −2.6, .z ±0.4), spine.x −0.25, root +0.05; active arms down (upperArm.x −0.3, lowerArm.x −0.4), spine.x +0.5,
  root.y −0.1, `particles.groundRing`, camera shake 0.6° for 0.3 s if the player is within 6 m. Charge [T2]: run cycle × 1.8 amplitude, spine.x 0.5, arms out.

**Flinch** (additive spring `f = {spineX, spineZ, headX, headY, armLX, armRX, rootDip}`, K 140, D 15): on damage `spineX += 0.35·(front? −1 : +1)·clamp(dmg/40, 0.5, 1.5)`,
`spineZ += 0.25·(left? +1 : −1)`; head hits `headX −0.6, headY ±0.5`; arm hits that arm `.x −0.8`; leg hits root dips 0.06 + that upperLeg.x +0.4.
Stagger multiplies impulses × 1.8 + root steps back 0.25 m. The material swaps to the "wounded" tint after 40 % damage (darker, blood smear via `color`).

### 5.6 Death (kinematic)
Pick: `back` if the killing hit came from the front (dot(hitDir, facing) < −0.3) and was strong (shotgun or dmg ≥ 40); `forward` if killed while
`speedRatio > 0.5`; else `crumple` (60 % weight). back/forward: root rotates about the horizontal axis ⊥ hitDir through the feet, `ω += 7·dt` from
`ω0 = 1.5 rad/s` until 90°, 6° bounce over 0.15 s, root translates 0.5 m along hitDir, pelvis ends at y 0.18; limbs spring (K 60, D 9) to random limp
targets (thigh 0.1–0.4, shin 0.2–0.8, arms ±0.6–1.4, head ±0.5); `back` arms fly up first (upperArm.x −2.2 → limp). crumple: legs buckle (upperLeg.x
+1.2, lowerLeg.x 2.0 over 0.35 s), root.y → 0.35 then 0.18, spine folds, then tips sideways (root.z ±1.4 rad over 0.5 s from 0.25 s), arms limp.
After landing: `ENEMY.restTwitchTime` = 0.4 s of small twitches (30 % chance per 0.1 s, impulses × 0.05) then still → emit
`enemy-rest {enemy, pos: torso world position}` (decals adds the blood pool 0.6 s later, §4.4.5). Headshot kills: head part scaled to 0 + big
burst [T2]; gib chunk [T3]. `bodyThud` when the body lands. Sink: `rootY → −ENEMY.sinkDepth` over `sinkTime`, then release.

### 5.7 Blob shadows
`particles.setBlob(enemy.blobIndex, pos, 0.45·scale, alpha)`; alpha 0.5 alive, fades with the sink. Player uses blob index 0.

---------------------------------------------------------------------------------------------------

## 6. THE TRAIN (train.js)

### 6.1 Consist and dimensions (`constants.TRAIN`)
4 cars × 14.4 m, 0.5 m gaps → 59.1 m; car body 3.0 wide × 3.65 tall above the rail head (roof y 2.70, floor y 0.00 level with the platform,
sill 0.15 m from the platform edge). Car centres (train-local x) −22.35, −7.45, 7.45, 22.35; 3 door pairs per car per side at car-local x
−4.8, 0, +4.8 (leaf 0.65 × 1.95, pair 1.3 wide) → 12 doors per side. Windows 8 per side per car (1.0 × 0.8, sill 1.15) + door windows.
Bogies 3.2 m from each car end (frame 2.2 × 0.5 × 2.0, 4 wheels r 0.42 × 0.1, axle boxes, third-rail shoe beam on the wall side, "600 V" plate).
Train-local frame: +X = the cab (leading) end; +Z = **platform side**. `group.rotation.y = 0` on Track A (z = −6.65, runs +X),
`π` on Track B (z = +6.65, runs −X) — the same model serves both tracks and the platform side is always local +Z.

### 6.2 Model (built once, geometry shared, ≤ 60 draw calls, ≤ 120 k tris)
* Body: cross-section `Shape` 3.0 × 3.65 with top corners r 0.35 and 3° tumblehome above the sill, `ExtrudeGeometry` 14.4 m (steps 1) capped by
  end boxes; window openings = wall pillars as boxes + `MAT.trainGlass` planes inset 2 cm with black rubber gasket outlines; `MAT.trainSteel`
  (UVs in metres, corrugation below the windows); door outlines and the stripe come from the texture; roof: 2 AC pods (galvanised, grilles),
  antenna, roof conduit; underframe: equipment box, pipes; couplers; diaphragm gaskets (0.9 box, striped normal) between cars.
* Doors: the platform-side (local +Z) leaves are **separate meshes** (24 leaves = 2 per door × 12 doors) that slide ±0.68 m
  along X into an 0.08 m wall thickness (leaf thickness 0.04, no pocket needed); the far side is merged static. Windows in leaves, black rubber
  edges, "STAND CLEAR OF THE CLOSING DOORS" stencil on the edges, door track strip above, amber door LEDs (blink while opening/closing).
* Cab (car 3, +X end): two big windows, wiper, LED route sign (`trainRouteSign`, emissive × 3, slow scroll), line bullet plate, 2 headlight
  discs r 0.12 (`headlight`) + lens sprites 1.0 m (`lensStar`, `fog:false`, additive; these 2 + the 2 tail sprites are the only individual
  sprites the train owns) + the 2 **scene-owned** SpotLights from `lighting.getTrainSpots()` — `train.render()` writes
  `spot.position = group.localToWorld(TRAIN.headlightLocal[i])` and `spot.target.position = spot.position + cabForwardWorld · 60`
  every frame (the spots and their targets stay direct scene children; the train never re-parents, hides or removes them) —
  + 2 beam cones (§3.6.4 method, 25 m, α 0.12, shown only while moving in the tunnel); red tail markers (car 0 −X end: emissive spheres + sprites).
  Side destination LED strips over the doors ("6 · to Ashworth St").
* Interior (visible through windows and open doors; enemies stand inside): speckled rubber floor, 2 longitudinal bench seats (orange/yellow alternating,
  moulded-pan normal), 8 stanchion poles r 0.02 chrome + hand loops, ad-card strip along the ceiling, route-map card, 2 fluorescent strips per car
  (`emissiveWarm`, flicker once on stop), grab bars by each door, 2 newspapers on seats. Graffiti marker scrawl on one window [T2].
* Wheels rotate by `distance / wheelR` (visible from the platform edge below the sill).
* Dynamic bullet colliders (`colliders.setDynamic('train', list)`, rebuilt whenever `x` changes while `|centerX| < 200`; cleared when parked):
  per car **wall slabs that exclude the door openings** so bullets pass through open doors and hit waiting enemies inside: far half-body
  box (local z ∈ [−1.5, 0]), roof slab, floor slab, 2 end caps, and 4 platform-side wall slabs between/around the 3 door openings (local z ∈
  [1.42, 1.5]); plus 1 collider per platform-side door leaf (2 per door, sliding with the leaf, so a closed door is solid and an open one
  is a real hole; glass approximated as metal). ≈ 9 per car + 24 leaves = 60 dynamic colliders, all `metal` BULLET.

### 6.3 Motion (analytic in `T`, deterministic; `T += dt · timeScale`; positions are the train **centre** along the track, sign `dir`)
```
cruise   T ∈ [0, 5):        c(T) = −140 + 14·T                       (nose −110.45 → −40.45; speed 14)
brake    T ∈ [5, 15):       τ = T − 5; c = −70 + 14τ − 0.7τ²         (speed 14 − 1.4τ; nose crosses the mouth −32 at T ≈ 5.62 → 'train-enter')
settle   T ∈ [15, 15.6):    c = 0.10·sin(2π(T−15)/0.6)·(1 − (T−15)/0.6)   (lurch-and-settle; state 'stopped' at T = 15.0, 'train-stop')
stopped  chime at T = 15.8 ('train-chime'); waves calls openDoors() (default at T = 16.4 if waves has not yet) → 'doorsOpening' 1.2 s → 'doorsOpen' (T ≈ 17.6, 'train-doors-open')
doorsOpen until waves calls closeDoors() → 'doorsClosing' 1.0 s → 'train-doors-close' → 'departing' ('train-depart')
depart   τ from depart:     c = 0.6·τ²   (accel 1.2; tail clears the mouth +32 at c = 61.55, τ ≈ 10.1 s); 'train-gone' + 'idle' at c ≥ 100 (τ ≈ 12.9 s)
parked   idle:              c = TRAIN.parkX (300) on the last track used — the group stays VISIBLE (beyond the ±160 end caps and the fog);
                            `group.visible = false` is forbidden (§0.3 lights rule); reset() jumps straight here
world:   group.position.x = dir · c   (dir = +1 Track A, −1 Track B);  noseX = dir·(c + 29.55)
```
`train-brake` at T = 5.0; brake squeal plays while `speed < 9.8` (T ≥ 8); brake sparks while `speed > 3`. Headlight spots: intensity ramps 0 → full
over T 0–1, off after `train-stop` + 2 s (interior strips stay on), tail markers on; on departure headlights on again. Third-rail shoe sparks
every 2–4 s while moving (`lighting.sparkFlash`). Camera rumble: `player.shake(0.003 · proximity, 0.1)` per tick while the train moves within 40 m
[T2]; dust motes gust [T2].

### 6.4 Choreography timeline (T seconds since `callTrain`; Track A wave 2; Track B mirrors in X)
| T | State / event | Audio | Visual |
|---|---|---|---|
| 0.0 (`callTrain()`) | `train-called` | alarm chime, distant rumble fades in | emergency beat starts (§3.6.5): troffers dim to 30 % over 0.6 s, red strobes at 1 Hz, signal → yellow |
| 0.0 | `arriving`; `train-approach` | horn (two-tone 1.2 s, low-passed), rumble loop | headlight glow deep in the tunnel (sprites, `fog:false`), beam cones sweep the I-columns |
| 0.5 | | | HUD banner "INCOMING TRAIN" |
| 5.0 | `train-brake` | screech begins (band-passed noise + 2–3.4 kHz resonant sweep) | signal → green; brake sparks at the leading bogie |
| 5.62 | `train-enter` (nose at −32) | rumble full, wind whoosh | headlights blow out in bloom; troffers recover over 1.5 s; the train streams along the platform |
| 13.1 | tail inside the station (speed 2.6) | screech tails off | interior lights flicker |
| 15.0 | `stopped`; `train-stop` | final squeal, compressor hiss 2 s | 0.6 s lurch-settle; strobes end; signal → red; **waiting enemies spawned at the 12 doors (visible through windows)** |
| 15.8 | `train-chime` | ding-dong (E5–C5) + garbled PA burst 1.5 s | door LEDs blink amber |
| 16.4 | `doorsOpening` (waves calls `openDoors()`) | pneumatic hiss, rubber slap at the end | leaves slide 0.68 m over 1.2 s; enemies visible standing inside |
| 17.6 | `doorsOpen`; `train-doors-open` → **wave N active** (`wave-start`; the HUD has read "WAVE N — INCOMING TRAIN" since T = 0, §4.6.1) | first groans | enemies step off the sill (`exiting`, stagger `trainCadence`), first one per door pauses to sniff |
| var. | batch drained + 2.0 s → waves calls `closeDoors()` → `doorsClosing` | short chime, hiss, slam | **waves** calls `enemies.forceExit()` on any enemy still inside a closing door (placed at the threshold, keeps exiting) |
| +1.0 | `train-doors-close` → `departing`; `train-depart` | motor whine (sawtooth through a rising LPF), rumble, rail ticks | cars pull away; interior light streaks |
| +10.1 | tail clears the east mouth | rumble fades (LPF closing), distant horn | tail lights recede into the fog |
| +12.9 | `train-gone`; `idle`, parked at x = dir·300 (visible) | | late arrivals begin at the doors (waves) |
Between-wave downtime (wave 2): cleared banner 3 s + breather 8 s (skippable) + 17.6 s of arrival = the arrival is the show; the player is safe
until the doors open.

### 6.5 Door spawn points
`getDoorSpawnPoints()` → 12 `SpawnPoint {id:'train-i', kind:'train', pos: group.localToWorld(doorX_i, 0, +0.9), yaw: facing local +Z, exitDir: world
direction toward z = 0, exitDist: 1.75, busy}` recomputed when docked. Enemies `waiting` at a door must not intersect the door leaves (they stand
0.9 m inside). `isDocked()` = state ∈ {stopped, doorsOpening, doorsOpen, doorsClosing}.

---------------------------------------------------------------------------------------------------

## 7. AUDIO (audio.js) — everything synthesized with WebAudio at init; no files

### 7.1 Graph
```
voices ─┬─> sfxBus (Gain 1.0) ──┬──────────────────────────────> duckFilter (BiquadFilter lowpass, 20 kHz normally) ─> master (Gain 0.8) ─> compressor ─> destination
        │                        └─> reverbSend (Gain 0.25) ─> convolver ─> reverbReturn (Gain 1.0) ─┘
loops ──┴─> ambBus (Gain 0.7) ───┘             (compressor: threshold −14 dB, knee 20, ratio 4, attack 0.004, release 0.25)
ui ────────> uiBus (Gain 0.6) ──> master (no reverb)
```
Impulse response: procedural stereo 2.2 s, `noise · e^(−3.2t)` with a one-pole low-pass sweeping 7 kHz → 900 Hz over the tail + 6 early
reflections (11–48 ms, decaying) — "concrete hall", RT60 ≈ 1.6 s, pre-delay 15 ms. Noise buffers (white, pink, brown; 2 s, looped) pre-generated.
`AudioContext` created only in `unlock()` (`latencyHint:'interactive'`); `disable()` never creates one and suspends an existing one; in headless mode
audio starts disabled unless `__game.enableAudio()`. `visibilitychange` (non-headless) → suspend/resume.
Voices: `play()` builds a small node graph (fire-and-forget) scheduled at `ctx.currentTime + delay`, disconnects on `ended`; **cap 32 voices**
in flight (LRU-steal the oldest non-loop); per-name rate limit 25 ms. Positional (`opts.pos`): one of **24 pooled `PannerNode`s**
(`utils.Pool`, the §1.10 number — a positional request when all 24 are busy steals the oldest positional voice) configured `equalpower`,
`inverse`, refDistance 2, maxDistance 60, rolloff 1.3; listener pose set each tick from the camera. Priority when starved: weapon > player hurt > train > attack vocals >
impacts > steps > groans. Audio never affects state; it may use `Math.random()` for micro-jitter.

### 7.2 Recipes (`RECIPES[name] = (ctx, dest, opts) => Voice`) — notation: `noise(kind) → filter → env → dest`; ± = random jitter
| name | recipe |
|---|---|
| `pistolShot` | white → BPF 1.8 kHz Q 0.8, env 1.0 → 0.001 over 0.13 s; + sine 180 → 55 Hz sweep 0.09 s gain 0.7 (thump); + 2 ms square click 3 kHz. Reverb send 0.45. rate ±4 % |
| `rifleShot` | white → BPF 1.3 kHz Q 0.9, 0.10 s; + saw 220 → 70 Hz 0.06 s through LPF 1.5 kHz (crack); + sine 140 → 45 Hz 0.1 s. Gain 0.85; rate ±5 % |
| `shotgunShot` | brown → LPF 900 Hz 0.28 s (1.0) + white → BPF 2.5 kHz 0.05 s + sine 110 → 35 Hz 0.18 s; mechanical clack 40 ms later. Gain 1.0, reverb 0.55 |
| `dryFire` | white → HPF 3 kHz 6 ms + triangle 1.1 kHz 12 ms, gain 0.35 |
| `reloadStart`, `magOut`, `magIn`, `slideRack`, `boltRack`, `shellInsert`, `pumpBack`, `pumpForward`, `pumpShort`, `magDrop` | filtered noise clicks 20–60 ms with resonant peaks 600 Hz–2.5 kHz; `magIn` = 2 clicks 60 ms apart; racks = 2 HPF clicks 80 ms apart + metallic ring (sines 1.9/2.6/3.4 kHz 120 ms gain 0.12); `magDrop` = heavier clack + LP thud |
| `holster`, `drawPistol`, `drawRifle`, `drawShotgun` | pink → BPF 1 kHz 120 ms gain 0.2 (cloth) + metallic tap |
| `casingBounce` / `hullBounce` | 2 decaying sines 2–6 kHz "tink" (pitch ±15 %) / LP noise 30 ms dull; positional |
| `footstep` (L/R pan), `footstepMetal` | pink → LPF 300–600 Hz 45 ms gain 0.25 (× 1.3 sprint; 0.25 crouch); metal adds a 900 Hz ring |
| `enemyStepLight`, `enemyStepHeavy`, `enemyDrag` | brown → LPF 250 Hz 60 ms gain 0.18; heavy + 50 Hz thump (global LP thump within 8 m); drag = filtered noise 120 ms; positional |
| `moan` (shambler) | saw + square detuned ±7 cents, f0 80–160 Hz, vibrato 4–6 Hz depth 6 Hz → LPF sweeping 300 → 900 → 400 Hz + BPF formant 650 Hz Q 4 (30 %); A 0.25 s, hold, R 0.4 s, 0.9–1.7 s; gain 0.5; reverb 0.5; positional |
| `shriek` (runner) | as moan at 1.3× pitch with rapid pitch chirps (3–5 per s), brighter LPF |
| `grumble` (brute) | moan sub-octave through a waveshaper (distortion), tremolo 3 Hz |
| `growl`, `attackShriek`, `bruteRoar` | as moan/shriek/grumble, f0 60–110, A 0.05 s, 0.45 s, LPF 400 → 1400 Hz + noise → BPF 800 Hz 30 %; gain 0.6; brute roar adds a 40 Hz component on the dry bus |
| `spawnGroan` | moan variant with a rising glide |
| `hurtGrunt`, `deathMoan`, `bodyThud` | short grunt / moan gliding −30 % over 0.8 s + `bodyThud` at +0.7 s / sine 70 → 40 Hz 0.2 s gain 0.6 + brown LPF 200 Hz 0.15 s |
| `hitFlesh`, `headshot`, `hitMarker`, `killMarker` | brown → LPF 350 Hz 70 ms 0.6 + sine 95 Hz 50 ms + white → BPF 1.2 kHz 15 ms; headshot + HPF 2.5 kHz crack 25 ms + sine 900 → 300 Hz 40 ms; markers: 2 sine ticks 1.8 kHz 18 ms 40 ms apart (ui, 0.25) / + 600 Hz tick |
| `impactConcrete`, `impactTile`, `impactMetal`, `impactGlass`, `impactWood`, `impactSoft`, `ricochet` | white → BPF 2.8 → 1.1 kHz sweep 60 ms + LP tail 90 ms 0.35 (rate ±15 %); tile + sine ping 3.2 kHz 40 ms; metal = sines 1.7/2.3/3.1 kHz decaying 0.35 s + HPF click; glass = HPF 4 kHz 30 ms + 3 sines 4–7 kHz 0.2 s; wood = LP thock; soft = 4 ms LP tap; ricochet = metal + sweep 3.5 → 1.2 kHz 0.25 s; positional |
| `playerHurt` | brown → LPF 500 Hz 120 ms 0.7 + sine 55 Hz 0.25 s + saw 220 → 110 Hz 0.15 s through LPF 600 Hz (grunt) |
| `heartbeat` (loop) | sine 50 Hz double-thump per beat, rate 70 → 110 bpm by health, gain by (1 − health/30) |
| `crateOpen`, `ammoPickup`, `uiClick` | latch click + rummage 0.7 s / 2 sines 880/1320 Hz 60 ms + click / triangle 1.6 kHz 20 ms |
| `waveSting`, `waveClear`, `gameOver` | saw A1 + E2 → LPF 500 → 2 kHz 1.4 s 0.5 + noise swell / 3 rising sines C4 E4 G4 0.12 s each 0.3 (ui) / saw 110 → 55 Hz 2.5 s through LPF 800 → 200 Hz + brown fade 0.6 |
| `alarmChime` | 2 alternating sines 740/620 Hz 0.3 s each × 3 (emergency beat), gain 0.3 |
| `trainRumble` (loop) | brown → LPF 110 Hz + sine 38 Hz AM by LFO 1.7 Hz depth 30 % + pink → BPF 250 Hz 0.2; positional at the train front; gain by speed; LPF cutoff by distance |
| `railTick` | short LP click, repeated at `speed / 12 m` rate while moving [T2] |
| `trainHorn` | 2 saws 311/370 Hz (D#4/F#4) → LPF 1.2 kHz (tracking distance), 1.2 s, gain 0.5 |
| `brakeScreech` | BP noise + sine 2.6–3.4 kHz random-walk pitch (per 40 ms) + white → BPF 3 kHz Q 8 30 %, sustained while braking, fade 1 s; positional at the leading bogie |
| `trainStopHiss`, `doorChime`, `paVoice`, `doorHiss`, `doorThunk`, `motorWhine` (loop) | HP noise 2 s; sines E5 659 → C5 523 Hz 0.28 s each; noise through 3 moving formant BPFs 1.5 s; white → HPF 2.2 kHz 0.7 s (reversed for close) + sine 90 Hz 80 ms thunk; saw through an LPF sweeping up with speed |
| `ambience` (loop) | 120 Hz sine 0.05 + 240 Hz 0.02 (hum) + pink → LPF 380 Hz 0.05 (ventilation) + slow-LFO brown (tunnel wind) + random drips every 4–12 s (sine 1.4 → 0.9 kHz 25 ms, positional at random drain/leak points) |
| `vendingHum` (loop) | 60 Hz + 120 Hz sines 0.03 + pink LPF 200 Hz; positional at `props.getHumSources()` |
| `buzzTick`, `sputter` | square 120 Hz 40 ms through HPF 800 Hz 0.08; sputter = 3 ticks; positional at the fixture |
| `hingeCreak`, `gateClang` | saw 180 → 120 Hz 0.4 s LPF 900 Hz 0.15; metal clang (sines 1.1/1.9 kHz 0.4 s + noise) |
| `sparkZap` | white → HPF 3 kHz 40 ms + square 2.2 kHz 30 ms, gain 0.3, positional |

### 7.3 Bus subscriptions (inside audio.js; no other module knows sound names except `particles` → `casingBounce/hullBounce`)
`shot-fired` → `WEAPONS[weapon].sfx`; `weapon-empty` → dryFire; `weapon-reload-start` → per-weapon cue schedule (§4.2.4 times, scaled by duration);
`weapon-switch` → holster + draw; `shot-hit-world` → impact by surface; `enemy-hit` → hitFlesh/headshot + hitMarker (killMarker on kill);
`enemy-killed` → deathMoan (+ bodyThud); `enemy-vocal` → moan/shriek/grumble/spawnGroan by type/kind; `enemy-attack` → growl/attackShriek/bruteRoar;
`enemy-footstep` → step light/heavy/drag; `enemy-stagger` → hurtGrunt; `player-hit` → playerHurt; `player-footstep` → footstep (surface);
`player-death`/`game-over` → gameOver + stop loops + LPF 600 Hz; `game-start` → ambience + vendingHum loops; `wave-start` → waveSting; `wave-clear` → waveClear;
`train-called` → alarmChime + distant rumble; `train-approach` → trainHorn + rumble loop; `train-brake` → brakeScreech; `train-stop` → trainStopHiss, rumble fade;
`train-chime` → doorChime (+ paVoice); `train-doors-open` → doorHiss; `train-doors-close` → doorHiss(reverse) + doorThunk; `train-depart` → motorWhine + rumble;
`train-gone` → stop loops; `spawn-door-open` → hingeCreak (+ gateClang for the gate); `light-flicker` → buzzTick/sputter; `emergency-start` → alarmChime;
`resupply` → crateOpen; `ammo-pickup` → ammoPickup. Continuous: `update` sets the listener from the camera, rumble gain/LPF from `train.speed`/distance,
heartbeat from `player.health`.

---------------------------------------------------------------------------------------------------

## 8. HUD (hud.js + index.html + style.css)

HTML/CSS only, no canvas UI, no web fonts (`system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`; numbers in
`"Courier New", "DejaVu Sans Mono", monospace`). All elements exist statically in `index.html` (ids below); `hud.js` only queries
them once in `init()` and per tick touches `textContent`, `style.transform`, `style.opacity` and classes — numeric text only when it changes,
≤ 20 property writes per tick when idle.

### 8.1 `index.html` DOM (ids used by hud.js — exact)
```html
<canvas id="c"></canvas>
<div id="hud">
  <div id="crosshair"><span class="ch-bar ch-t"></span><span class="ch-bar ch-b"></span><span class="ch-bar ch-l"></span><span class="ch-bar ch-r"></span><span id="ch-dot"></span></div>
  <div id="hitmarker"><span></span><span></span><span></span><span></span></div>
  <div id="sprint-glyph" class="hidden">»</div>
  <div id="prompt"></div>
  <div id="banner"><div id="banner-text"></div><div id="banner-sub"></div></div>
  <div id="wave-box"><div id="wave-label">WAVE 1</div><div id="wave-sub"></div></div>
  <div id="kills-box"><span id="kills-icon">☠</span><span id="kills-num">0</span></div>
  <div id="health-box"><div id="health-bar"><div id="health-ghost"></div><div id="health-fill"></div></div><div id="health-num">100</div></div>
  <div id="ammo-box"><div id="ammo-name">PISTOL</div><div id="ammo-line"><span id="ammo-mag">15</span><span id="ammo-sep">/</span><span id="ammo-reserve">90</span></div>
       <div id="reload-bar"><div id="reload-fill"></div></div><div id="ammo-pips"></div><div id="reload-label" class="hidden">RELOAD</div></div>
  <div id="damage-arcs"></div>
  <div id="vignette"></div>
  <div id="toast"></div>
  <div id="fps" class="hidden">60</div>
</div>
<div id="overlay">
  <div id="start" class="screen"><h1>ASHWORTH ST</h1><p class="sub">LAST STOP</p><p id="start-hint">CLICK TO ENTER</p>
       <ul id="controls"><li>WASD move · Shift sprint</li><li>Mouse aim · LMB fire · R reload</li><li>1 / 2 / 3 weapons · wheel cycle · E interact</li></ul></div>
  <div id="pause" class="screen hidden"><h2>PAUSED</h2><p>click to resume</p></div>
  <div id="gameover" class="screen hidden"><h1 id="go-title">YOU DIED</h1><p id="go-reason"></p><table id="go-stats"></table><p id="go-hint">PRESS R OR CLICK TO RESTART</p></div>
</div>
```
`style.css`: full-window canvas; `#hud` absolute, `pointer-events:none`; `#overlay` `pointer-events:auto`; `.hidden { display:none !important }`;
`.screen` centred flex column with a dark translucent scanline backdrop over the live scene; `#banner` black-enamel sign style (black plate,
1 cm white inner border, white uppercase, letter-spacing animated 0.3 em → 0.1 em); classes `.hit .head .kill` on `#hitmarker`; `.pulse`; `.low`
(amber) / `.empty` (red) on `#ammo-mag`; `.arc` elements inside `#damage-arcs`; `.pip`/`.pip.off` in `#ammo-pips`; keyframes `hitpop`,
`killpop`, `bannerin`, `bannerout`, `toastin`.

### 8.2 Elements and behaviour
* **Crosshair**: 4 bars 2 × 9 px + centre dot, white with a dark outline; gap px = `6 + tan(spreadDeg°)·(viewportH/2)/tan(fov/2)` (the gap *is* the
  spread cone); contracts 15 % for 100 ms on hit (`onShot`/`hitMarker`); hidden in ADS and during sprint (`#sprint-glyph` shows instead).
* **Hit marker**: 4 diagonal 10 px bars; `hitMarker('hit'|'head'|'kill')` toggles the class → CSS animation scale 1.3 → 1, opacity 1 → 0 (120 ms; kill 200 ms, 30 % larger, red; head yellow).
* **Ammo** (bottom right): mag 42 px bold, reserve 22 px, weapon name small caps; `.low` at ≤ 30 % mag, `.empty` + pulsing RELOAD at 0; during reload
  the digits are replaced by `#reload-bar` progress; pips = one bar per round (max 30).
* **Health** (bottom left): 220 × 14 px bar, white → amber (≤ 50) → red (≤ 30), numeric; `#health-ghost` shrinks over 0.6 s after damage.
* **Wave / kills**: `#wave-label` "WAVE 3" (= `waves.wave`; during the train it already shows the incoming wave); `#wave-sub` "NEXT TRAIN IN 0:08" (breather) / "INCOMING TRAIN" (pulsing, train) / "3 LEFT" (active);
  `#kills-num` pops (scale 1.3 → 1, 150 ms) on increment.
* **Banner**: `banner(text, sub, seconds)` — fade in 0.2 s, hold, fade out 0.4 s. Used for "WAVE n" (wave 1 sub = controls reminder), "WAVE n CLEARED"
  (sub = kills / accuracy), "INCOMING TRAIN", "ARRIVING — WAVE n — STAND CLEAR OF THE CLOSING DOORS" (at `train-doors-open`).
* **Prompt** (60 px below centre): "E — RESUPPLY", "E — CALL TRAIN", "RELOAD" (pulsing when mag 0 and not reloading); `prompt(null)` hides.
* **Damage arcs**: up to 6 concurrent 120 × 12 px red gradient wedges on a 140 px circle, rotated to the attacker's bearing relative to the camera yaw
  (recomputed each tick), life 1.2 s with 0.4 s fade; a repeat from the same source refreshes its arc.
* **Vignette**: `#vignette` radial gradient rgba(120,0,0,α); persistent α = lerp(0.15, 0.45, lowHealth) pulsing +0.12 per heartbeat when health ≤ 30;
  damage flash 0.55 → 0 over 0.5 s adds on top. Also calls `post.setHurt(flash)`, `post.setLowHealth(lowHealth)`, `post.setDead(dead)`.
* **Screens**: `#start` (title, hint, controls; attract-mode camera drift behind), `#pause`, `#gameover` (title "YOU DIED"/"HIT BY TRAIN", stats
  table: wave reached, kills by type, headshots, accuracy, damage dealt, time survived, shots fired, best streak, score; restart hint).
* **FPS** `#fps` when `?debug=1` or `__game.showFps(true)`. `setHidden(true)` hides `#hud` entirely (screenshots).
* **Toast**: `#toast` small text for `debug-message` (2 s).
Nothing is projected from 3-D except the damage arcs (bearing only). No enemy health bars, no floating text, no minimap.

---------------------------------------------------------------------------------------------------

## 9. DEBUG API — `window.__game` (debug.js)

Installed by `boot()` **before** asset generation (so tests can call `disableAudio()`/`seed()` early); `ready` flips to `true` after the warm-up render.
Every call is synchronous and returns JSON-able data (no THREE objects). Angles radians, positions `[x, y, z]`. Calls that need a started game throw
`Error('game not started')`. **Startup detection**: `opts.headless` is true when `?headless=1` **or** `navigator.webdriver === true` (Playwright) unless
`?headless=0` — headless implies pixel ratio 1, low quality unless `?post=1`, no pointer lock, audio disabled by default, manual stepping on `start()`.

### 9.1 Lifecycle
| Member | Behaviour |
|---|---|
| `ready: boolean`, `version: '1.0.0'`, `errors: string[]`, `nullSystems: string[]` | `errors` mirrors `window.onerror`, unhandled rejections, `console.error`, and exceptions thrown inside `stepOnce` (a failed `nav.build()` reachability assertion lands here); `nullSystems` lists modules that failed to import and were replaced by `NullSystem` (must be empty for every test) |
| `disableAudio()` / `enableAudio()` | disable: no `AudioContext` is ever created; `getState().audio === 'disabled'`. Call before `start()` (works any time). |
| `seed(n)` | reseeds `G.rng` (gameplay). Textures/placement keep the build seed. |
| `start(opts?)` | starts from the start screen without pointer lock; `opts.manual` defaults to `true` (RAF keeps rendering the last state at ~30 fps but never advances the simulation). Idempotent. Enters `intro(1)`. |
| `restart()` | full soft reset (§2.3), works any time: **`G.time`/`G.frame` return to 0 and the event ring is cleared**, so `setTime(3)` after `restart()` fast-forwards 3 s of the new game; `getState().mode === 'playing'`, `wave === 1`, `waveState === 'intro'`. |
| `pause()` / `resume()` | toggle `G.paused` (real-time mode). |
| `setManualStepping(bool)` | `true`: sim advances only via `step`/`setTime`; `false`: real-time RAF. |
| `step(dt = 1/60, n = 1) -> State` | run `n` ticks of `dt` (clamped [1/240, 0.1]) **then render once**. Works in either mode. |
| `setTime(t) -> State` | fast-forward: tick at 1/60 **without rendering** until `G.time ≥ t` (no-op if `t ≤ time` — note `restart()` resets `time` to 0; ≤ 36 000 ticks per call), then render once. State that affects hits (enemy poses/capsules, player eye) is exact after `setTime` because it is produced in `update()`, not `render()`. |
| `fastForward(seconds) -> State` | `setTime(time + seconds)`. |
| `renderOnce()` | render without ticking. Not required for correctness after `setLook`/`teleport`/`aimAt` (they sync the camera/eye immediately, §2.16) — use it to refresh the pixels before a screenshot. In manual mode nothing else renders (§1.7). |
| `setTrainTimeScale(k)` | multiplies the train's `T` advance (default 1). |

### 9.2 Input injection (persistent until changed)
| Call | Behaviour |
|---|---|
| `setLook(yaw, pitch)` | `player.setLook`: sets base yaw/pitch (recoil offsets untouched) and syncs the camera/eye at once. yaw 0 → −Z; **−π/2 → +X (stairs)**; +π/2 → −X (fence); π → +Z. pitch > 0 up. |
| `look(dYaw, dPitch)` | relative look (obeys recoil-consumption). |
| `lookAt(x, y, z)` / `aimAt(x, y, z)` | base yaw/pitch so that the eye ray (incl. recoil) hits the point (`lookAt` ignores recoil; `aimAt` compensates). |
| `aimAtEnemy(id, group = 'torso') -> boolean` | `aimAt` on the enemy's `hitVolumeCenter`; `'head'` or `'torso'`; false if not hittable. |
| `move(dir)` | **World-space XZ direction vector** (the brief's `move(dirVector)`): accepts `{x, z}`, `{x, y, z}` (y ignored), `[x, z]`, `[x, y, z]` (y ignored), or two numbers `move(dx, dz)`; magnitude clamped to 1; `move(null)`/`move(0, 0)` stops. Persists until changed; re-projected onto the player's current heading every tick (`input.moveWorld`). `move(1, 0)` walks toward +X (the stairs) whatever the yaw; `move(0, −1)` walks toward −Z (Track A). |
| `moveWorld(dx, dz)` | alias of `move`. |
| `moveLocal(strafe, forward)` | player-local: `strafe` +1 = right, `forward` +1 = the camera's forward (−Z at yaw 0, i.e. `(−sin yaw, 0, −cos yaw)`); magnitude clamped to 1; `moveLocal(0, 0)` stops. Persists. |
| `setSprint(bool)` / `setAds(bool)` | held keys. |
| `fire() -> boolean` | press-and-release this tick; buffered 80 ms like a click; returns true if a shot fired synchronously (exact for semi and auto). |
| `setTrigger(bool)` | hold/release (full-auto across steps). |
| `reload() -> boolean` | R; true if a reload started. |
| `switchWeapon(n) -> string|null` | **1-based**: 1 pistol, 2 rifle, 3 shotgun; or `'pistol'|'rifle'|'shotgun'`; returns the target id. `0` or any other value returns `null` and `console.warn`s "switchWeapon is 1-based (1 pistol, 2 rifle, 3 shotgun)" (never silently maps to the pistol). `getState().weapon` reads the target on the next `step()`; `weaponState` is `'lowering'` then `'raising'` for lower + raise seconds (pistol→rifle 0.54 s) before firing is possible (§4.2.2). |
| `interact()` | E. |
| `teleport(x, z, yaw?, pitch?)` | `player.teleport`: feet at `(x, floorHeightAt(x,z), z)` (nearest walkable if null), velocity zeroed, camera/eye synced immediately; collider push-out applies on the next tick. |

### 9.3 Game manipulation
| Call | Behaviour |
|---|---|
| `killAllEnemies() -> number` | kills every alive enemy (`weapon:'debug'`, no headshot) **and empties the spawn queue** so the wave clears on the next tick. |
| `killEnemy(id)` | kills one. |
| `spawnEnemy(type, x, z, opts?) -> id` | `'shambler'|'runner'|'brute'` at (x, floor, z) in `chase` immediately (current wave multipliers); `opts.hp`; `opts.state:'idle'` = never moves/attacks; `opts.yaw`. Counts toward `enemiesAlive` (the wave will not clear until it dies) but not the queue. |
| `skipToWave(n) -> State` | **Works from any state** (`intro`/`active`/`breather`/mid-`train`/`gameover`): from `gameover` it first calls `restart()`; then kills every enemy silently, clears the queue, `train.reset()` + `lighting.endEmergency()` (a train mid-arrival is parked), **sets `wave = n` synchronously** (`getState().wave === n` on return, before any step) and calls `train.callTrain(trackForWave(n))` → `waveState 'train'`, `trainState 'arriving'` (n ≥ 2; breather skipped; enemies arrive ≈ 17.6 s later at `train-doors-open`) or enters `intro` (n = 1). `?wave=N` makes `start()` do this automatically. |
| `skipBreather()` | ends the breather → train. |
| `callTrain()` | `waves.callTrainNow()`: ends the breather and calls the train (no-op outside `breather`). |
| `setGodMode(bool)` / `setInfiniteAmmo(bool)` | as named. |
| `setEnemySpeedScale(k)` / `setEnemyAI(bool)` | global speed multiplier / `false` freezes all enemies in idle (screenshot composition). |
| `resupply()` | crate effect from anywhere. |
| `setHealth(h)` | clamps 0–100; 0 triggers death. |
| `giveAmmo()` | alias of `resupply()` without the heal. |
| `setQuality('low'|'high')` | post/pixel-ratio toggle. |
| `hideHud(bool)` / `showFps(bool)` | screenshot helpers. |
| `screenshotHint()` | teleports to (−24, 0.4), `setLook(−π/2, −0.05)`, hides nothing; returns the checklist entry #1. |
| `setTuning(path, value)` / `getTuning()` | e.g. `('WEAPONS.rifle.damage', 30)` writes into the live constants objects (numbers only). |

### 9.4 State inspection
```js
getState() -> {
  mode: 'menu'|'playing'|'gameover', started, paused, manual, audio: 'enabled'|'disabled',
  time, frame, fps, renders, stepMs, renderMs,        // fps: real-time = RAF EMA; manual = 1000/renderMs of the renders actually done (> 0 after the first render); renders = monotonic count (§1.7)
  wave, waveState: 'idle'|'intro'|'active'|'cleared'|'breather'|'train'|'gameover',
  enemiesAlive,                                       // every non-dead enemy: waiting/spawning/exiting/chase/attack/…/idle, debug-spawned included
  enemiesQueued, enemiesTotalThisWave, enemiesSpawned, corpses, breatherRemaining,
  playerHealth, playerPos: [x,y,z], playerYaw, playerPitch, playerAlive,
  weapon: 'pistol'|'rifle'|'shotgun', weaponState, ammo: { mag, reserve }, ammoAll: { pistol:{mag,reserve}, rifle:{…}, shotgun:{…} },
  spread,                                             // degrees
  recoil: [pitch, yaw],                               // applied camera recoil offsets (radians)
  trainState: 'idle'|'arriving'|'stopped'|'doorsOpening'|'doorsOpen'|'doorsClosing'|'departing',
  trainTrack: 'A'|'B'|null, trainNoseX, trainCenterX, trainSpeed, trainT, trainDoors: 0..1,
  gameOver, gameOverReason: null|'killed'|'train', kills, score, crateArmed, lowHealth,
  emergency: boolean, drawCalls, errors: number
}
getEnemies()  -> [{ id, type, variant, state, hp, maxHp, pos:[x,y,z], yaw, headPos:[x,y,z], distToPlayer, alive }]   // alive + corpses
getEnemy(id)  -> entry | null
getStats()    -> G.stats + accuracy
getEvents(since = 0) -> { next, events: [{ i, t, type, data }] }     // 512-entry ring (§1.8)
getWaveConfig(n) -> waveConfig(n)
getRenderInfo() / getPerf() -> { calls, triangles, points, lines, geometries, textures, canvasTextures, textureMB, programs, lights, fps, stepMs, renderMs, renders, initMs }
                               // textures = renderer.info.memory.textures (RTs + bone textures included); canvasTextures/textureMB from textures.getTextureStats()
getInitTimings() -> { total, textures:{name:ms}, aoBake, envCapture, compile }   // §1.11 init budget breakdown
getPools()    -> { tracers:{live,cap}, casings, particles, smoke, decals:{holes,splats,pools}, enemies:{alive,corpses,free}, voices }
getLevelInfo() -> { bounds, playerSpawn, cratePos, spawnPoints:['mezz-door','west-gate'], train:{ centerX:0, parkX:300, doorXs:[…12], tracks:{A:-6.65,B:6.65} },
                    mezz:{ turnstileX:41.5, gateZ:[1.2,3.4], keepClear:NAV_KEEP_CLEAR }, nav:{ cell:0.5, agentRadius:0.3 },
                    api:{ move:'world-xz {x,z}|{x,y,z}|[x,z]|[x,y,z]|(dx,dz)', moveLocal:'(strafe, forward); forward = camera -Z', switchWeapon:'1-based: 1 pistol, 2 rifle, 3 shotgun',
                          yaw:'0 = -Z, -pi/2 = +X (stairs)', wave:'increments at train-called; skipToWave(n) sets it synchronously' } }   // plain JSON, no functions
floorHeightAt(x, z) -> number|null      // station.floorHeightAt (separate call — functions are not JSON-able through page.evaluate)
navDistanceAt(x, z) -> number|-1        // nav.distanceAt from the player's current cell; -1 when unreachable/off-grid (Infinity is not JSON)
sampleLuminance() -> number   // §2.14 (post-free 64×36 render, display-referred; > 0.02 means "not black"); sampleLuminanceLinear() for the raw mean
G                              // raw context for ad-hoc inspection
```
Determinism guarantee: with `disableAudio()`, `seed(n)`, manual stepping and only `step`/`setTime`, two runs with the same API sequence produce
identical `getState()`, `getEnemies()` (positions to 1e-6) and `getEvents()` types/times. Rendering need not be pixel-deterministic.

---------------------------------------------------------------------------------------------------

## 10. TEST HARNESS AND SCREENSHOT CHECKLIST

### 10.1 `test/harness.js` (exists — do not modify without the integrator)
`withGame(async (page, api) => {…}, { url:'/index.html', query:'?seed=7', viewport:{width,height} })` serves the repo root on a free port, launches
SwiftShader Chromium (`--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist --autoplay-policy=no-user-gesture-required`),
collects `errors[]`/`logs[]`, and exposes `api.game(method, ...args)`, `api.state()`, `api.step(n = 60, dt = 1/60)` (calls `__game.step(dt)` n times),
`api.waitReady(timeout = 60000)` (polls `__game.ready === true`), `api.shot(name)` → `test/shots/<name>.png`. Because Playwright sets
`navigator.webdriver`, the game auto-detects headless (§9) — tests need no query flags, but may pass `?post=1` for beauty shots.

Typical script:
```js
const { withGame } = require('./harness');
await withGame(async (page, api) => {
  await api.waitReady(90000);
  await api.game('disableAudio'); await api.game('seed', 42); await api.game('start');
  await api.game('setTime', 20);                       // wave 1 in progress, no renders
  const s = await api.state();                         // s.wave === 1, s.enemiesAlive > 0
  const e = (await api.game('getEnemies')).find(e => e.alive);
  await api.game('aimAtEnemy', e.id, 'head'); await api.game('fire'); await api.game('step', 1/60);
  await api.shot('headshot');
}, { query: '?seed=42' });
```

### 10.2 `test/smoke.js` (Agent-TRAIN) — `node test/smoke.js`; exit 1 on any failed check; writes `test/shots/results.json`
Checks, in order (each named; failures collected, script continues):
1. **boot**: `ready` within 90 s; `getState().mode === 'menu'`; `errors.length === 0`.
2. **start**: `disableAudio(); seed(7); start()` → `mode 'playing'`, `wave 1`, `waveState ∈ {intro, active}`, `manual === true`, `getState().renders ≥ 1`
   and `fps > 0` (manual-mode fps = achievable render rate, §1.7).
3. **wave1**: `setTime(8)` → `enemiesAlive ≥ 1`; `setTime(22)` → `enemiesAlive ≥ 3`, all `shambler`, `distToPlayer` decreasing over two 2 s samples for every
   enemy in `chase` (the mezzanine ones come down the stairs through the emergency gate — §1.5 corridor). `shot('01-wave1')`.
3b. **nav**: `navDistanceAt(44, 4.75) > 0`, `navDistanceAt(−28.9, 0) > 0`, and for every `x` of `getLevelInfo().train.doorXs`: `navDistanceAt(x, 4.0) > 0 &&
   navDistanceAt(x, −4.0) > 0` (player at spawn; −1 = unreachable = fail); `floorHeightAt(33, 0) ≈ 1.6` (stair ramp), `floorHeightAt(44, 4.75) === 4.8`,
   `floorHeightAt(0, 5.2) === null`.
4. **shoot**: `teleport(0, 0, π/2)` (face −X); `id = spawnEnemy('shambler', −6, 0, {state:'idle'})` (faces the player, arms hanging); `aimAtEnemy(id,'torso')`;
   `fire()` → true; the newest `enemy-hit` event has `enemyId === id`; **expected `group === 'torso'` and `getEnemy(id).hp === 66`** (assert `hp === 100 − event.damage`
   unconditionally; assert `hp === 66` when `group === 'torso'`; a non-torso group is a failure of the idle pose, report it); `ammo.mag === 14`; events contain
   `shot-fired`; `getPools().tracers.live === 1` after one `step`. Then `fastForward(0.2)` (pistol cooldown 143 ms) and `fire(); step(1/60)` → `shot('02-firing')`
   (second torso hit: `hp === 32`, `mag === 13`).
5. **headshot**: `aimAtEnemy(id,'head'); fastForward(0.2); fire()` → `hp ≤ 0` (34 × 3 = 102 ≥ 32), an `enemy-killed {headshot:true}` event, `kills ≥ 1`, pistol `mag === 12`.
6. **rifle**: `switchWeapon(2)` returns `'rifle'`; `step()` → `weapon === 'rifle'`, `weaponState ∈ {lowering, raising}`; `fastForward(0.7)` → `'ready'`; `setTrigger(true);
   fastForward(0.5)` → rifle mag decreased by 6 ± 1; `recoil[0] > 0` while firing; `setTrigger(false); fastForward(0.6)` → `recoil[0] < 0.002`. Also `switchWeapon(0) === null`
   (1-based API) and `weapon` still `'rifle'`.
7. **shotgun**: `switchWeapon(3); fastForward(0.8)`; `id2 = spawnEnemy('shambler', −3, 0, {state:'idle'})` (3.0 m); `aimAtEnemy(id2,'torso'); fire()` → `hp ≤ 0` (9 × 13 = 117 ≥ 100:
   all 9 pellets by the §4.2.3 guarantee at 3.0 m), `weaponState === 'pumping'`, `mag === 5`, tracers live = 9 on the next step.
8. **reload**: `switchWeapon(1); fastForward(0.7)` → pistol `mag === 12` (three shots in 4–5), `reserve === 90`; `reload()` true, `weaponState 'reloading'`, `fastForward(1.5)` →
   `mag === 15`, `reserve === 87` (general form: `reserve === 90 − (15 − m0)`).
9. **damage/death/restart**: `spawnEnemy('shambler', px + 1.0, pz)`; `fastForward(3)` → `playerHealth < 100` + a `player-hit` event; `setHealth(5); fastForward(6)` → `gameOver`,
   `mode 'gameover'`; `shot('08-gameover')`; `restart()` → `mode 'playing'`, `playerHealth 100`, `wave 1`, `time === 0`, `getEvents().events.length === 0` or only `game-restart`/`wave-intro`.
10. **wave clear → train** (continues from the `restart()` above; `setGodMode(true)` first — the player stays at spawn while 8 shamblers arrive): `setTime(3)` → `waveState 'active'`;
    `killAllEnemies(); step()` → `waveState 'cleared'`; `fastForward(3.5)` → `'breather'`; `skipBreather(); step()` → `waveState 'train'`, `trainState 'arriving'`, `trainTrack 'A'`,
    **`wave === 2`** (increments at `train-called`); `fastForward(4)` → `trainT ≈ 4`, `trainNoseX ≈ −54.5` → `shot('03-train-approach')`; `fastForward(2)` → `trainNoseX > −32`;
    `fastForward` to `trainT ≥ 15.2` → `trainState ∈ {stopped, doorsOpening}`, `|trainCenterX| < 0.15`, `enemiesAlive ≥ 1` (waiting inside); `shot('04-train-stopped')`;
    `fastForward(2.6)` → `'doorsOpen'`, `wave === 2`, `waveState 'active'`, a `wave-start {wave:2, source:'train'}` event; `shot('05-doors-open')`; `fastForward(10)` →
    `enemiesAlive ≥ 4`, ≥ 4 enemies in state `chase`, and every `chase` enemy has `|pos[2]| ≤ 4.65` (they are on the platform); loop `fastForward(1)` until
    `trainState === 'departing'` (≤ 40 s) → `shot('06-train-depart')`; loop until `'idle'` (≤ 30 s) → `|trainCenterX| ≥ 300` (parked, not hidden), `emergency === false`.
11. **skipToWave** (from wave 2 `active` with enemies alive — any state is legal): `skipToWave(5)` → **synchronously** `wave === 5`, `waveState 'train'`, `trainState 'arriving'`,
    `trainTrack === 'B'` (`trackForWave`: **Track A when n is even, Track B when n is odd**), `enemiesAlive === 0`; loop `fastForward(5)` until `enemiesAlive > 0` (≤ 60 s) →
    `getWaveConfig(5).count === 18`, shambler `maxHp === 115`, `enemiesAlive ≤ 16`; keep looping (≤ 120 s) until an `enemy-spawn {type:'brute'}` event appears, calling `killEnemy(id)`
    on the nearest enemy whenever `enemiesAlive ≥ 16` (**not** `killAllEnemies()`, which empties the queue); `shot('07-wave5')`. Then `skipToWave(3)` while the wave is active →
    `wave === 3`, `trainTrack 'B'`, `trainState 'arriving'` (mid-game re-skip parks and re-calls the train).
12. **determinism**: `restart(); seed(7)` then checks 3–4 again (`setTime(8)`, `setTime(22)`, the same `spawnEnemy`/`aimAtEnemy`/`fire` sequence) → identical `getEnemies()`
    positions (1e-6) and `getEvents()` types/times to the first run (`restart()` resets `time` to 0, so the `setTime` targets are the same).
13. **errors**: `errors.length === 0 && getState().errors === 0`.
14. **perf sanity**: `getPerf()` → `calls ≤ 400`, `triangles ≤ 1.5e6`, `lights ≤ 16`, `programs ≤ 64`, `stepMs ≤ 8` (avg last 60), `initMs ≤ 20000`, `sampleLuminance() > 0.02` on every shot.
15. **beauty** (`--post`): reload with `?post=1&seed=7&wave=3`, viewport 1280×720, `start(); setTime(40)`; `shot('09-beauty')`.

### 10.3 `test/shots.js` (Agent-LIGHT) — `node test/shots.js`; the reviewer's screenshot checklist → `test/shots/S1..S9.png` at 1920×1080 with `?post=1`
Setup per shot: `disableAudio(); seed(1337); start(); setTime(12)` (flicker schedule settled), then `teleport(x, z); setLook(yaw, pitch); step(1/60, 3)`; capture.
Yaw/pitch in **this document's convention** (§1.1).

| # | Name | teleport (x, z) | setLook (yaw, pitch) | State | Must be visible | Judge (1–5; < 3 on a must-have goes back) |
|---|---|---|---|---|---|---|
| S1 | Platform vista | (−24, 0.4) | (−1.5708, −0.05) | wave 1 idle | full platform receding to the stair; both column rows; troffers with ≥ 1 dead and ≥ 1 flickering; hanging signs; mosaic band on both walls; benches, cans; a puddle reflection in the foreground; fog dimming the far end | depth and rhythm; alternating light pools; repetition broken; bloom restrained (tubes glow, tile does not) |
| S2 | Trackside wall detail | (0, 1.2) | (0, −0.08) | wave 1 idle | across Track A: rails with specular lines, third rail + cover board, DANGER plate, base tile, white tile chips/grime, "ASHWORTH ST" tesserae, a backlit and a torn poster, a bulkhead lamp; tactile strip + STAND CLEAR stencil in the foreground | material fidelity at 3–5 m: normals readable, grime gradient, mosaic resolved, no blur |
| S3 | Tunnel mouth, train arriving | (−22, −4.2) | (1.27, 0.0) | `skipToWave(2)`, `setTrainTimeScale(1)`, step until `trainState === 'arriving' && trainNoseX > −60` | tunnel I-columns strobing in the headlight beams, sodium string receding, green signal, cables, graffiti at the mouth, red strobes on the platform wall, route sign readable, headlight sprites blooming, fog | drama and readability; no hard cone edges on the beams |
| S4 | Stair and mezzanine | (46, −0.5) | (1.5708, −0.35) | any | looking back down the stairs: handrails, tread nosings, tiled stairwell with the "← TRAINS" band, the street-grate shaft across the turnstiles, EXIT sign glow; pan yaw ±0.6 for the shutter slit | vertical variety; daylight shaft vs green fluorescents; no z-fighting on the stair |
| S5 | Train doors open | (0, 2.0) | (3.1416, −0.05) | `skipToWave(3)` (Track B), step until `trainState === 'doorsOpen'` | the stopped car filling the frame: corrugated stainless, the stripe, an open door pair with the lit interior (seats, poles, ad strip), enemies stepping out, door LED, side destination sign, bogie wheels below the sill, tactile strip | train material + interior detail; doors correct; warm interior vs green station |
| S6 | Combat close-up | (−6, 0) | (−1.5708, −0.02) | `skipToWave(2)`, wait until an enemy is within 4 m, `aimAtEnemy(nearest,'torso')`, `switchWeapon(2)`, `fire(); step(1/60)` | rifle viewmodel with muzzle flash, a tracer in flight, an enemy mid-flinch with a blood puff, blood splats + bullet holes on floor/column, casings in the air, muzzle light on the nearest column, HUD legible | weapon detail (sights, mag, rail), flash quality, tracer readable, blood dark and grounded |
| S7 | Ceiling (bonus) | (0, 0) | (0, 1.1) | any | pipes, tray with sagging cables, duct, beams with rust streaks, a troffer close up with its glow card | |
| S8 | West gate (bonus) | (−27, 0) | (1.5708, 0) | any | fence, NO TRESPASSING, the blue emergency lamp down the catwalk, the overturned can | |
| S9 | Death (bonus) | — | — | `setHealth(1)`, spawn a shambler adjacent, step until `gameOver`, +1.5 s | tilted low camera, grey grade, game-over screen | |
Global checks on every shot: no z-fighting (tactile strip, decals, posters), no visible wall seams, no unlit black walls facing the camera, fog colour =
background, `sampleLuminance() > 0.02`, `getRenderInfo().calls ≤ 400`.

### 10.4 `test/perf.js` (Agent-TRAIN) — `node test/perf.js`
`?seed=3&wave=8&post=1`; `start(); setInfiniteAmmo(true); setGodMode(true)`; loop `fastForward(5)` until `enemiesAlive ≥ 20` (≤ 180 s, using `skipToWave` if
needed); `step(1/60, 5)`; `getPerf()` → assert `calls ≤ BUDGET.drawCalls`, `triangles ≤ BUDGET.triangles`, `lights ≤ 16`, `programs ≤ BUDGET.programs` (64),
`textures ≤ BUDGET.textures` (260, `renderer.info.memory.textures` incl. render targets and bone textures), `canvasTextures ≤ BUDGET.canvasTextures` (180),
`textureMB ≤ BUDGET.gpuMB` (250), `stepMs ≤ 8`, `initMs ≤ BUDGET.initMsHeadless`; also `programs` must be **unchanged** between a sample taken while the train is
`arriving` and one taken after `train-gone` (no mid-game shader recompiles — the §0.3 lights rule); report `renderMs` (SwiftShader, informational); pools: after
`killAllEnemies()` and `fastForward(15)` all effect pools report `live 0` (no leaks).
Exit 1 on violations; prints JSON.

---------------------------------------------------------------------------------------------------

## 11. INTEGRATION ORDER

0. **Hour zero (Integrator)**: `constants.js` (verbatim §1.13), `bus.js`, `utils.js`, `collision.js`, `index.html`, `style.css`, `main.js` booting with
   `NullSystem` stand-ins + a flat-lit placeholder floor, `debug.js` with `ready/errors/getState/step/setTime/start/pause/render`, `input.js`, `hud.js` skeleton.
   Post "hour zero ready". Others may copy `constants.js` from this document into their dev pages meanwhile.
1. **Look milestone** (TEX → STATION → LIGHT): `textures.js` + `materials.js` (`dev/textures.html`), `station.js` (`dev/station.html` with colliders),
   `props.js`, `lighting.js` + `post.js`. Gate: `?viewer=1` fly-through looks like the paragraph in §3; ≤ 130 draw calls without enemies; no seams at
   platform/wall joins; tiles read as tiles at 2 m; fixtures visibly emissive with restrained bloom; `sampleLuminance()` calibrated (§3.6.2).
2. **Walk milestone** (PLAYER + Integrator): `player.js` on the real colliders; walk the whole platform, up the stairs, through the emergency gate, without
   snagging on columns/benches; cannot fall onto the tracks; bob/sprint FOV work. Gate: `resolveCircle` never tunnels at sprint speed.
3. **Shoot milestone** (PLAYER + LIGHT + TEX + WAVES-audio): `weapons.js` + `viewmodels.js`, `particles.js`, `decals.js`, `audio.js`. Fire all three weapons at
   every surface type: tracers, flash + light, casings, decals, sparks/dust, sounds, recoil, reload/pump/switch animations. Gate: smoke checks 4–8 pass
   with `spawnEnemy` stubbed to a capsule.
4. **Enemy milestone** (ENEMY + TRAIN-nav): `rig.js`, `enemies.js`, `nav.js`. `spawnEnemy('shambler', 8, 0)` walks around columns to the player and attacks;
   `spawnEnemy('runner', 44, 4)` on the mezzanine comes down the stairs; head/limb multipliers; deaths and corpses. Gate: 24 alive + 10 corpses at 60 fps on the
   dev GPU; `enemies.raycast` matches the visuals (shoot the head → headshot).
5. **Loop milestone** (TRAIN + WAVES): `train.js`, `waves.js`. Wave 1 from the doors → clear → breather → train arrives on A, unloads wave 2, departs → wave 3
   on B → … → game over → restart. Gate: `node test/smoke.js` passes end to end.
6. **Polish**: `node test/perf.js`, `node test/shots.js` review against §10.3, grime/litter/poster/flicker/fog/exposure tuning, difficulty tuning (expected
   death wave 7–9), Tier-2 items in §3.9 order.

Merge procedure per milestone: the integrator wires the real module into `main.js` (replacing the NullSystem), runs the applicable tests, and files any
signature drift back to the owner. Never fix another agent's module silently.

---------------------------------------------------------------------------------------------------

## 12. DEFINITION OF DONE (all boxes ticked; mapped to the user's requirements)

**"Beautifully detailed 3D subway station … impressive"**
- [ ] `test/shots.js` S1–S6 each scored ≥ 3 by a reviewer on every must-have item; S1 shows alternating light pools, ≥ 1 dead + ≥ 1 flickering fixture, puddle reflections, fog.
- [ ] Every Tier-1 item in §3.9 present: two tracks with rails/ties/third rail, hero tiled walls with the mosaic "ASHWORTH ST", riveted columns with chipped paint, ceiling services, tunnels with sodium lamps/signals/I-columns, stair + mezzanine with turnstiles/shutter/light shaft, west fence/catwalk/blue door, posters (≥ 8 designs, ≥ 2 backlit), hanging signs, EXIT signs, floor stencils, benches/cans/vending/litter/puddles/cables.
- [ ] All textures procedural (canvas), normal + roughness maps on hero surfaces; env reflections visible on rails, puddles and train steel.
- [ ] Post chain live: bloom (restrained), SMAA, grade (vignette, grain, CA, hurt, low-health desaturation, death grey).

**"FPS with humanoid/zombieoid enemies"**
- [ ] Three archetypes with five palette variants, one `SkinnedMesh` per enemy, procedural walk/idle/attack/flinch/stagger/death animations, eye glow, blob shadows.
- [ ] Enemies path around columns, climb the stairs (mezzanine door → emergency gate → landing, smoke check 3b), exit the train onto the platform, attack with windup/active/recover; attack ring keeps them spread.
- [ ] Headshot/torso/limb multipliers verified by smoke checks 4–5; corpses persist then sink; pool never leaks.

**"Visible ammo tracers, weapon recoil, ≥ 2 weapons, muzzle flash, sfx"**
- [ ] Pistol, rifle, shotgun all usable from the start; every shot spawns a visible tracer (shotgun 9), a muzzle flash sprite **and** a light that visibly lights the nearest column, a casing, a smoke puff, an impact (particles + decal), and a synthesized sound.
- [ ] Camera recoil kicks and recovers (smoke check 6); the rifle follows `RIFLE_PATTERN`; the viewmodel kicks with springs; reload/pump/switch animations with sound cues; dry-fire + auto-reload; the slide locks back on empty.
- [ ] Audio: every cue in §7.3 produces a sound with sound on; reverb audible; positional moans pan; `disableAudio()` creates no `AudioContext`.

**"Simple first wave; then a train pulls in, opens its doors, releases wave 2; difficulty rises until the player loses"**
- [ ] Wave 1 = 5 slow shamblers from the mezzanine door and the west gate; no train.
- [ ] After clearing: cleared banner → breather (skippable, crate resupply) → emergency-light beat → the train arrives from the tunnel with horn, headlights sweeping the I-columns, brake squeal and sparks, stops aligned (`|centerX| < 0.15`), doors open in sync with the chime, enemies visible inside before the doors open, exit onto the platform; doors close; train departs into the fog; alternates tracks per wave.
- [ ] Waves 2–10 follow §4.6.4 (counts, runners from wave 2, brutes from wave 4, HP/speed/damage multipliers, cadence, maxAlive); beyond 10 the formulas continue; late arrivals after `train-gone`.
- [ ] Health, damage vignette + arcs, low-health heartbeat, regen, death camera, game-over stats, restart without reload (smoke check 9).

**"three.js, playable in the browser"**
- [ ] `node serve.js 8080` → `http://localhost:8080/` boots with the importmap only; click → pointer lock → play with keyboard/mouse; pause on lock loss.
- [ ] No external URLs (`grep -rn "http" src index.html style.css` shows only comments); no asset files (`find . -name "*.png" -o -name "*.jpg" -o -name "*.glb" -o -name "*.mp3" -o -name "*.wav" -o -name "*.ttf"` outside `test/shots` and `node_modules` returns nothing).
- [ ] 60 fps at 1080p on a GTX 1660-class GPU with 24 enemies alive and bloom on (`?debug=1` FPS counter); `node test/perf.js` passes (calls ≤ 400, tris ≤ 1.5 M, lights ≤ 16, programs ≤ 64, textures ≤ 260, no program-count change across a train cycle); headless boot ≤ 20 s.

**"window.__game debug API / headless tests"**
- [ ] Every member of §9 exists with the stated semantics, including the user's minimum: `start, setLook, move, fire, reload, switchWeapon, killAllEnemies, skipToWave, getState → {wave, enemiesAlive, playerHealth, ammo, weapon, trainState, gameOver, fps}, setTime, step, disableAudio`.
- [ ] `node test/smoke.js` passes with 0 errors; all screenshots non-black; determinism check 12 passes.
- [ ] `test/harness.js` unchanged and sufficient to drive the game (auto headless detection via `navigator.webdriver`).

**Engineering hygiene**
- [ ] No `Math.random`/`performance.now`/`Date.now`/`setTimeout`/`setInterval`/`requestAnimationFrame` in systems (grep), except main/audio/hud as allowed.
- [ ] No system imports another system module (`grep -n "from './" src/*.js` shows only constants/bus/utils/collision/textures/materials and the two owner-only helpers).
- [ ] Every system implements `init/update/reset/dispose` (+ `render` where specified); `?dispose-test=1` disposes and rebuilds without errors and `renderer.info.memory` returns to baseline ±5 %.
- [ ] `renderer.shadowMap.enabled === false`; no `castShadow`; static groups `matrixAutoUpdate = false`; no per-tick allocations in hot paths (minor GCs < 1/s idle).
- [ ] Total lines ≤ 12 k for Tier 1 + tests (`wc -l src/*.js index.html style.css test/*.js`); ≤ 13.5 k after the gated T2 items.

---------------------------------------------------------------------------------------------------

## Appendix A — numeric sanity (verified against §1.13)

* Docked train doors (train-local x = car centre ± 4.8 or 0): world x ∈ {−27.15, −22.35, −17.55, −12.25, −7.45, −2.65, 2.65, 7.45, 12.25, 17.55, 22.35, 27.15}, all inside ±30 (outermost leaf edge 27.8). Same set on both tracks by symmetry.
* Door spawn point local z +0.9 → world |z| = 5.75; exit 1.75 m → |z| = 4.0; nearest column collider (cyl r 0.28 at z 3.0) reaches |z| = 3.28: shambler (r 0.35) at 4.0 has 0.37 m clearance, brute (r 0.55) 0.17 m; the tactile strip inner edge (4.4) is not crossed after exiting.
* Nav walkable rows on the platform reach |z| = 4.65 (edge barrier at 4.95 inflated by 0.3 → row [4.0, 4.5) is the last free row; the strict test leaves it free because 4.65 > 4.5 only blocks [4.5, 5.0)). Player min |z| = 4.60 (barrier 4.95 − radius 0.35): the tactile strip is visible in front of the player. The docked door exits (doorX, ±4.0) sit in row [4.0, 4.5), which is free along the whole platform (column inflation ends at |z| 3.58) → `nav.build()`'s reachability assertion holds for all 24.
* Column corridor: plinth outer edge 3.275 → tactile 4.4 = 1.125 m walkway + 0.6 strip; enemies (r 0.35 / 0.55) and the player (r 0.35) pass along the platform edge.
* Turnstile passages 0.8 m: player passes (needs 0.70); nav inflation 0.3 each side leaves 0.2 m < one 0.5 m cell → blocked for enemies → they use the **emergency gate (z 1.2–3.4, 2.2 m clear → 3 open cell rows [1.5, 3.0))**. Corner between the stair-wall end (39, 1.5) and the z = 1 housing corner (41.05, 1.1): 2.09 m; inflated stair wall ends at x 39.3 / z 1.8, inflated housing starts at x 40.75 → the cells [39.5, 40) × [0, 2.0) are all free, giving the 8-connected route gate → [39.5, 40) × [1.5, 2) → [39.5, 40) × [0, 0.5) → landing [38, 39.5) × [0, 0.5) → stair rows [−0.5, 0.5). With the old numbers (x 40, gate to 2.8, inflation 0.4) the corner gap was 0.68 m and the route did not exist — do not move `TURNSTILES.x` below 41.0 or narrow the gate.
* Mezzanine dressing: the booth (43.4–45.6 × −5.0–−3.4), stanchions (z ≤ −1.05), fare machines/vending (x ≥ 47.1), benches (x ≤ 34.95) and cans (x 37, |z| ≥ 5.08) are all outside `NAV_KEEP_CLEAR`; the door exit (44, 4.75) → gate (41.75, 2.25) diagonal crosses only free cells.
* Stair ramp slope 4.8/7.2 = 0.667 (33.7°); 24 risers of 0.20 over 24 treads of 0.30 = 7.2 m run.
* Train motion: cruise 5 s (70 m), brake 10 s (70 m), stops at centre 0 exactly (−70 + 140 − 70); nose crosses the mouth at T ≈ 5.62 (speed 13.1 m/s); tail enters at T ≈ 13.1; departure tail clears at c = 61.55 (τ ≈ 10.1 s); gone at c = 100 (τ ≈ 12.9 s).
* Doors open at T ≈ 17.6 after `callTrain`; wave-2 downtime ≈ 3 + 8 + 17.6 s (skippable to ≈ 20.6).
* Lights: 1 hemi + 8 platform + 2 wall + 2 sodium + 2 spot + 1 muzzle = 16.
* Enemy counts: wave 1 = 5, 2 = 8, 5 = 18, 10 = 40, 12 = 50 with maxAlive 24, pool 32 (24 alive + ≤ 8 corpses; corpseCap 10 → the oldest sinks early when needed).
* TTK on a wave-1 shambler: pistol 3 body / 1 head (102); rifle 5 body (120) or 2 head + 1 body (96 + 24); shotgun ≤ 3.0 m 9 × 13 = 117 with all pellets inside the torso (pattern 2.6° + aim 0.8° = 3.4° → 0.178 m < 0.20 m at 3.0 m; 0.208 m at 3.5 m → 8–9 pellets). Wave-5 shambler HP 115: pistol 4 body, rifle 5 body, shotgun 1.
* Trash cans at |z| 2.35 (r 0.32 collider → 2.67) clear the plinth face (2.725) by 5.5 cm; the vending machine at z −2.30 (0.8 deep → −2.70) clears it by 2.5 cm.
* Draw calls at wave 8: station 70 + props 50 + tunnels 12 + train 60 + enemies 68 + blob 1 + effects 10 + viewmodel 6 + glow batches 3 + sprites 4 + post 5 ≈ 289 ≤ 400.
* Textures: ≈ 96 named entries × 1–3 maps ≈ 170 registry GPU textures + composer/bloom (≈ 13) + SMAA (5) + PMREM/cube (≈ 8) + luminance (1) + 32 bone textures ≈ 230 ≤ 260.
* Timeline sanity for smoke check 10: `restart()` → time 0; `setTime(3)` = intro over (2 s) + 1 s active; wave-1 first spawn at 2 + 2 = 4 s, so `killAllEnemies()` at 3 s kills nobody but empties the queue → `cleared` on the next tick.
* Fog: visibility factor exp(−(0.018·d)²): 30 m → 0.75, 60 m → 0.31, 100 m → 0.04; the ±160 end caps are invisible; the parked train at |x| ≈ 300 is behind the end caps and 5+ fog lengths away.

## Appendix B — Tier-3 list (one line each; not planned, budgeted or started before the §0.2 gate)

Reflector hero puddle (`objects/Reflector` on the drain puddle at (15, 2.5)) · GTAO half-res pass · RectArea mezzanine lights (would
break the 16-light rule — needs a light-count review) · stopped escalator beside the stair · rats (instanced, scripted paths under
benches) · cobwebs (alpha planes in ceiling corners) · swinging broken tube near the stair (§3.6.3) · carved bench initials ·
hopscotch chalk on the mezzanine · limb gibs on shotgun kills · turnstile tripod spin when the player passes · `Line2` tracers ·
puddle ripples from drips · weapon flashlight (17th light — same review) · track access (player can drop onto the trackbed; "HIT BY
TRAIN" game over) · shopping cart · stroller. Each must fit in < 150 lines, keep every §1.11 budget and every §10 test green.
