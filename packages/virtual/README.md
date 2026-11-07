# @fulcrum/virtual

`@fulcrum/virtual` is a zero-dependency, framework-free vertical windowing engine. It accepts generic `{ id, kind }` rows and returns visible rows, spacers, measurements, and scroll corrections. It does not use React, the DOM, or browser APIs.

`createVirtualizer()` accepts kind-based size estimates, overscan, a maximum mounted-row count, a bottom threshold, and an optional cache from `snapshotCache()`. It supports measured per-kind medians, stable and end-relative anchors, deferred momentum-scroll corrections, pinned-bottom decisions, and a bounded action log.

Call `setOutline(items, { from, splices })` for an in-place update when `from` is the last outline. Other updates rebuild the layout. Apply `snapshot().rows`, `topSpacer`, `bottomSpacer`, and scroll results in your renderer.
