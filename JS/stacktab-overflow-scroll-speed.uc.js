// ==UserScript==
// @name           Stack strip: faster + smooth mouse-wheel scroll
// @include        main
// ==/UserScript==

// Speeds up AND smooths wheel-scrolling of the overflowed tabs within a stack —
// the row that grows side arrow buttons and scrolls through the tabs when too
// many fit. This does NOT switch tabs; it only scrolls the strip.
//
// The element that actually scrolls is `#floorp-stack-scroller` (a horizontal
// hbox with overflowX; found live via a composedPath wheel probe). It is the
// PARENT of `#floorp-stack-items`, not the strip itself.
//
// Motion model: a cubic Hermite tween that CARRIES VELOCITY between notches.
//   - From a standstill (m0 = 0) it reduces to smoothstep — a symmetric
//     ease-in-out (the parabolic feel of Firefox's native tab-strip scroll).
//   - Mid-scroll, each new notch starts its tween at the CURRENT velocity, so
//     continuous scrolling builds/keeps momentum instead of re-easing from zero
//     on every event; it only decelerates (final velocity 0) when notches stop.
//   - The initial tangent is clamped to 3·distance (Fritsch–Carlson monotonic
//     bound) so a fast carry-over never overshoots and bounces back.
//
// Two knobs:
//   - SPEED : distance per notch (sensitivity), a multiple of the raw delta.
//   - GLIDE : tween duration in SECONDS. Higher = longer, more drawn-out ease;
//             lower = shorter/snappier.

(function () {
  const SPEED = 4;  // distance per notch (sensitivity)
  const GLIDE = 0.4;  // tween duration, seconds (0.25 snappy … 0.6 languid)

  function init() {
    let scroller = null; // scroller we're currently animating
    let startPos = 0;    // scrollLeft at the start of the current tween
    let target = 0;      // desired scrollLeft
    let m0 = 0;          // start tangent (position units over the full tween)
    let startT = 0;      // tween start timestamp (ms)
    let vel = 0;         // current velocity (px/sec), carried across notches
    let raf = null;

    function step(now) {
      if (!scroller) { raf = null; return; }
      const s = GLIDE > 0 ? Math.min(1, (now - startT) / (GLIDE * 1000)) : 1;

      // Cubic Hermite with endpoints startPos→target, tangents m0 and 0.
      const s2 = s * s, s3 = s2 * s;
      const h00 = 2 * s3 - 3 * s2 + 1;
      const h10 = s3 - 2 * s2 + s;
      const h01 = -2 * s3 + 3 * s2;
      scroller.scrollLeft = h00 * startPos + h10 * m0 + h01 * target;

      // Track instantaneous velocity so the next notch can start from it.
      const d00 = 6 * s2 - 6 * s;
      const d10 = 3 * s2 - 4 * s + 1;
      const d01 = -6 * s2 + 6 * s;
      vel = (d00 * startPos + d10 * m0 + d01 * target) / GLIDE;

      if (s >= 1) {
        scroller.scrollLeft = target;
        vel = 0;
        raf = null;
        return;
      }
      raf = requestAnimationFrame(step);
    }

    window.addEventListener("wheel", function (e) {
      if (e.ctrlKey) return; // leave Ctrl+wheel alone

      // composedPath() pierces shadow DOM, so this works whether or not the
      // stack UI lives inside a shadow root.
      const hit = e.composedPath().find(
        n => n && n.nodeType === 1 && n.id === "floorp-stack-scroller"
      );
      if (!hit) return;

      const raw = e.deltaY || e.deltaX;
      if (!raw) return;

      // Normalize wheel units to pixels so SPEED is consistent across mice/OSes
      // reporting pixels (deltaMode 0), lines (1), or pages (2).
      let px = raw;
      if (e.deltaMode === 1) px *= 16;
      else if (e.deltaMode === 2) px *= hit.clientWidth;
      px *= SPEED;

      e.preventDefault();
      e.stopImmediatePropagation();

      // Pointer moved to a different stack's scroller → retarget from it, at rest.
      if (hit !== scroller) {
        scroller = hit;
        target = hit.scrollLeft;
        vel = 0;
      }

      // Accumulate the target and start a fresh tween from the current position,
      // carrying the current velocity in as the start tangent.
      const max = hit.scrollWidth - hit.clientWidth;
      target = Math.max(0, Math.min(max, target + px));
      startPos = hit.scrollLeft;
      startT = performance.now();

      const delta = target - startPos;
      let tangent = vel * GLIDE; // px/sec → position units over the tween
      if (delta === 0 || Math.sign(tangent) !== Math.sign(delta)) {
        tangent = 0; // at target, or direction reversed → start from rest
      } else {
        // Fritsch–Carlson monotonic bound: |m0| ≤ 3·|delta| (no overshoot).
        tangent = Math.sign(delta) * Math.min(Math.abs(tangent), 3 * Math.abs(delta));
      }
      m0 = tangent;

      if (raf === null) raf = requestAnimationFrame(step);
    }, { capture: true, passive: false });

    console.log("[stack-wheel] loaded, SPEED =", SPEED, "GLIDE =", GLIDE);
  }

  if (gBrowserInit && gBrowserInit.delayedStartupFinished) {
    init();
  } else {
    const obs = (subject) => {
      if (subject === window) {
        Services.obs.removeObserver(obs, "browser-delayed-startup-finished");
        init();
      }
    };
    Services.obs.addObserver(obs, "browser-delayed-startup-finished");
  }
})();
