# Coordinate frames & the rendering model

This is the reference for how GRAZE turns orbital positions into pixels: the
frames involved, the axis/scale mapping, how the globe is oriented in time, and
the one invariant that keeps satellites sitting over the right piece of ground.
Most spatial bugs in this project trace back to getting one of these wrong.

Related: [methodology.md](methodology.md) (how positions are computed),
[data-flow.md](data-flow.md) (how the data arrives).

## The three frames

| Frame | Axes | Units | Where it comes from |
| --- | --- | --- | --- |
| **ECI / TEME** (inertial) | x → vernal equinox, z → Earth's spin axis (north), y completes right-handed | km | satellite.js SGP4 output (`propagate`) |
| **Geodetic** | latitude / longitude / altitude | ° / ° / km | `eciToGeodetic(positionEci, gmst)` — for the sub-satellite point |
| **Three.js scene** | y → up, right-handed | 1 unit = **1000 km** | `eciToThreeJs` |

ECI is *inertial* — it does **not** rotate with the Earth. A satellite's ECI
position and the Earth's orientation are two separate things that must be
reconciled every frame (see the invariant below).

## ECI → scene: `eciToThreeJs`

[`conjunction-core/src/propagator.ts`](../packages/conjunction-core/src/propagator.ts)

```ts
// (x, y, z)_ECI  →  (x, z, -y) / 1000   scene
x: positionEci.x / KM_PER_SCENE_UNIT,   // KM_PER_SCENE_UNIT = 1000
y: positionEci.z / KM_PER_SCENE_UNIT,   // ECI north (z) → scene up (y)
z: -positionEci.y / KM_PER_SCENE_UNIT,
```

Two things happen at once: a **scale** (÷1000, so Earth's ~6371 km radius is
`EARTH_RADIUS = 6.371` scene units) and an **axis remap** that sends ECI's z-up
to Three.js's y-up while staying right-handed.

```
        ECI (z up)                     scene (y up)
             z  (north)                     y  (north)
             |                              |
             |____ y                        |____ x   (ECI x)
            /                              /
           x  (vernal equinox)           z  (= -ECI y)
```

At GMST = 0 the Greenwich meridian lies along ECI +x, which maps to scene +x —
that is where the textured globe's prime meridian sits at zero rotation, so the
mapping and the Earth texture agree.

The same helper is reused for the Sun direction — feeding it a 1000-km-scaled
unit vector keeps the result a unit vector while sharing the axis remap
(`sunDirectionScene` in [`scene/earth.ts`](../packages/conjunction-web/src/scene/earth.ts)).

## Orienting the globe in time: GMST

The Earth mesh spins about scene **+y** by the Greenwich Mean Sidereal Time:

```ts
// scene/earth.ts, per frame
earth.rotation.y = getEarthRotationRadians(currentTime); // = gstime(currentTime)
```

`getEarthRotationRadians` ([`analysis.ts`](../packages/conjunction-core/src/analysis.ts))
is just satellite.js `gstime` — the angle from the ECI x-axis (vernal equinox)
to the Greenwich meridian. Rotating an Earth-fixed mesh by this angle re-expresses
it in the ECI frame, so it lines up with the (inertial) satellite positions.

## The invariant (read this before touching the scene)

> **Orbits and markers live in `overlay`, which is parented to the _scene_ —
> not to the Earth mesh.** They are placed at raw `eciToThreeJs(positionEci)`
> coordinates and never rotate. The Earth mesh alone carries `rotation.y = GMST`.

That is what makes a marker sit over the correct ground point: the satellite is
fixed in the inertial frame, and the globe is turned *underneath* it by GMST so
the right geography ends up beneath it.

**Worked failure mode.** If the globe is *not* turned by GMST (e.g. `rotation.y`
left at 0 while markers stay at their ECI positions), every marker appears at its
**inertial longitude** — geographic longitude *plus* GMST — instead of its true
sub-satellite point. Concretely: an object over Alaska (≈143° W) with GMST ≈ 221°
shows up near 19° W, in the Atlantic off Iberia. The marker's *screen* position
is unchanged; only the geography under it is wrong. (This was the "camera skips
to the wrong place" bug — the fix was simply applying `rotation.y = GMST`.)

Corollary: because `overlay` is not parented to the Earth, `earth.rotation.y`
can **never** move a marker on screen — it only rotates the continents beneath
it. A marker that looks off-nadir is a *camera* framing issue, not a frame bug.

## One clock drives everything

A single instant — live wall-clock, or the scrubbed replay time — feeds the Sun
direction, the Earth's rotation, the day/night blend, and the satellite replay,
so they never disagree:

```ts
const currentTime = simulatedTime ?? new Date();
sunDirectionScene(currentTime, sunDirection);
earth.rotation.y = getEarthRotationRadians(currentTime);
```

`setSimulatedTime(date)` swaps between live time and a conjunction's replay time;
`setSimulatedTime(null)` reverts to live. The replay itself is driven by
`TimeAnimator` ([`scene/animator.ts`](../packages/conjunction-web/src/scene/animator.ts)),
which interpolates both trajectories and moves the two satellite markers.

## Selecting a conjunction: the eased transition

Selecting an event both **swings the camera** to look down the conjunction and
**turns the globe** to the new instant — in lock-step over one eased sweep, so
neither snaps (`focusOn` in `scene/earth.ts`):

- **Camera**: slerp the view direction from its current heading to the
  conjunction's TCA direction, lerp the radius (keeping the viewer's zoom). Runs
  before `controls.update()`; OrbitControls re-reads `camera.position` each frame,
  so there's no fight. A user drag cancels the sweep (`controls` `start` event).
- **Globe**: the loop always sets `earth.rotation.y = GMST(currentTime)`; during
  the sweep a **short-way `earthOffset`** (wrapped to ±π) is added and decayed to
  zero, so the geography glides — rather than jumps — from the previous
  orientation to the new one. (Without this, the globe re-orients in a single
  frame: the original "snap to an unrelated location.")

The camera aims at the midpoint of the two objects' ECI positions at TCA
(mapped through `eciToThreeJs`), and OrbitControls' target stays at the origin,
so the conjunction lands at the center of the disk (nadir).

## Shading (brief)

- **Earth** ([`scene/earth.ts`](../packages/conjunction-web/src/scene/earth.ts)):
  a `ShaderMaterial` blends the NASA Blue Marble (day) and Black Marble (night)
  textures by `dot(worldNormal, sunDirection)` with a soft terminator, and adds
  O'Neil atmospheric in-scattering (ported from NASA WorldWind) for aerial
  perspective on the day side and a night-limb glow.
- **Atmosphere** ([`scene/atmosphere.ts`](../packages/conjunction-web/src/scene/atmosphere.ts)):
  a slightly larger back-side shell running the same scattering model, sharing
  constants with the Earth so the limb halo and the ground stay consistent.
- **Starfield / Sun**: `scene/starfield.ts` (Hipparcos catalog, loaded async) and
  `scene/sun.ts` (a sprite in the Sun direction).

Because the globe rides a `ShaderMaterial`, a **blank canvas means the shader
failed to compile** — see [troubleshooting.md](troubleshooting.md).
