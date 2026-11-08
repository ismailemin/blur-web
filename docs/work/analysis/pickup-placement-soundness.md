# Retail pickup placement: a labelled arc-fraction remap, not a projection

**Date:** 8 November 2026
**Scope:** `probes/powerups/retail-placement.mjs` and the page's power-up spawn.

## What the rule is

Each retail pickup has a retail route arc. The rule maps it onto the measured
course by the **normalized arc fraction**:

```text
fraction       = retail.arc / retail.routeLengthM
measuredArc    = fraction * layout.course.lengthMetres
sample         = nearest measured sample
appliedLateral = clamp(retail.lateral, -band, +band)
x/z            = sample.x/z + leftNormal(sample) * appliedLateral
y              = sample.groundY
```

Every output pickup records `retailArc`, `retailLateral`, `lateral`, `clamped`,
`clampedBy`, `fraction` and a `source` string naming the uid, route and rule.

## Why it is not a physical projection

The measured course is a **sub-course** of the retail route, and its arc origin
differs from the retail `MainLoop` origin:

| map | retail MainLoop | measured course | ratio | measured start → nearest MainLoop | measured end → nearest MainLoop |
| --- | ---: | ---: | ---: | --- | --- |
| amboy | 6,746.666 m | 2,060.595 m | 0.305 | 83.108 m at retail arc 5,572.740 m | 282.426 m at 657.510 m |
| gracia | 4,986.241 m | 624.914 m | 0.125 | 157.452 m at 2,000.170 m | 15.718 m at 2,436.710 m |
| river | 4,125.482 m | 310.395 m | 0.075 | 41.028 m at 2,608.170 m | 81.772 m at 2,922.310 m |

So the remap compresses the whole retail route onto the measured sub-course. It
places every retail pickup on the course the player drives, but a pickup's
position is **not** its retail world position. The module records
`physicalProjection: false` and the numbers above in its `soundness` block.

## What the page does

- `state.powerups.placementSource` is `retail-arc-fraction-remap` when the
  module is used, `provisional-measured-arc` otherwise.
- `state.powerups.retailSoundness` carries the per-map soundness block.
- Every spawned pickup's `source` says `retail-arc-fraction-remap`, never
  `retail-placement`.

## The physically sound alternative (not implemented)

Only pickups whose retail arc falls inside the measured sub-course's retail-arc
span can be placed at their retail position. From the numbers above that span is
roughly `[5,572.74 .. 6,746.67] ∪ [0 .. 657.51]` on Amboy — about 27 % of the
route, so roughly 22 of 82 pickups. The rest would be `unsupported`.

That is the correct next step if strict retail correspondence is required. It
needs the measured-arc ↔ retail-arc correspondence table, not a global fraction.
