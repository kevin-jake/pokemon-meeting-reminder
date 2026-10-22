// @ts-check
/**
 * Pure motion math for the overlay scenes, shared by the renderer (loaded as a
 * plain <script>, exposes window.sceneMath) and the unit tests (CommonJS).
 * Coordinates are CSS px of one overlay window: x grows right, y grows down,
 * positions are the sprite box's top-left corner. Times are in ms.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else /** @type {any} */ (root).sceneMath = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** @typedef {'ltr' | 'rtl'} Direction */

  /**
   * @typedef {object} WalkPlan
   * @property {number} startX
   * @property {number} stopX    where the walker pauses (= endX when it does not)
   * @property {number} endX
   * @property {number} walkInMs
   * @property {number} pauseMs
   * @property {number} walkOutMs
   * @property {number} totalMs
   */

  /**
   * Where a parked sprite comes to rest: flush with the edge it is heading for.
   * @param {{ W: number, spriteW: number, direction: Direction }} o
   */
  function parkX({ W, spriteW, direction }) {
    return direction === 'ltr' ? W - spriteW : 0;
  }

  /**
   * A walker enters off-screen, optionally pauses with its centre at
   * `stopFraction` of the width, and leaves off-screen on the other side.
   * With `park` it instead stops at the far edge and stays there for good
   * (pauseMs and totalMs are Infinity).
   * @param {{ W: number, spriteW: number, pxPerSec: number, pauseMs: number, direction: Direction,
   *   pause?: boolean, stopFraction?: number, park?: boolean }} o
   * @returns {WalkPlan}
   */
  function walkPlan({ W, spriteW, pxPerSec, pauseMs, direction, pause = true, stopFraction = 0.5, park = false }) {
    const ltr = direction === 'ltr';
    const startX = ltr ? -spriteW : W;
    const endX = ltr ? W : -spriteW;
    const stopX = park ? parkX({ W, spriteW, direction }) : pause ? W * stopFraction - spriteW / 2 : endX;
    const walkInMs = (Math.abs(stopX - startX) / pxPerSec) * 1000;
    const walkOutMs = park ? 0 : (Math.abs(endX - stopX) / pxPerSec) * 1000;
    const holdMs = park ? Infinity : pause ? pauseMs : 0;
    return { startX, stopX, endX, walkInMs, pauseMs: holdMs, walkOutMs, totalMs: walkInMs + holdMs + walkOutMs };
  }

  /**
   * @param {WalkPlan} plan
   * @param {number} t  ms since the pass started
   * @returns {{ x: number, phase: 'walkIn' | 'pause' | 'walkOut' | 'done' }}
   */
  function walkPosition(plan, t) {
    const { startX, stopX, endX, walkInMs, pauseMs, walkOutMs } = plan;
    if (t < walkInMs) return { x: lerp(startX, stopX, t / walkInMs), phase: 'walkIn' };
    if (t < walkInMs + pauseMs) return { x: stopX, phase: 'pause' };
    if (t < walkInMs + pauseMs + walkOutMs) {
      return { x: lerp(stopX, endX, (t - walkInMs - pauseMs) / walkOutMs), phase: 'walkOut' };
    }
    return { x: endX, phase: 'done' };
  }

  /**
   * Horizontal extent of a flight: the banner trails behind the sprite, so the
   * flight starts and ends far enough out that both are fully off-screen.
   * @param {{ W: number, spriteW: number, bannerW: number, bannerGap?: number, direction: Direction }} o
   */
  function flightSpan({ W, spriteW, bannerW, bannerGap = 0, direction }) {
    const trail = bannerW + bannerGap;
    return direction === 'ltr'
      ? { startX: -spriteW, endX: W + trail }
      : { startX: W, endX: -spriteW - trail };
  }

  /**
   * Position of a flyer at normalised progress u in [0, 1]: x moves linearly
   * from off-screen to off-screen, y follows baseY + A·sin(2π·cycles·u), and
   * the sprite tilts gently along the curve (positive = clockwise).
   * @param {number} u
   * @param {{ W: number, spriteW: number, bannerW: number, bannerGap?: number, direction: Direction,
   *   cycles?: number, amplitude?: number, baseY: number, maxTilt?: number }} o
   * @returns {{ x: number, y: number, tilt: number }}
   */
  function flightPose(u, o) {
    const { cycles = 2, amplitude = 40, baseY, maxTilt = 12, direction } = o;
    const { startX, endX } = flightSpan(o);
    const k = clamp(u, 0, 1);
    const phase = 2 * Math.PI * cycles * k;
    const dyDu = amplitude * 2 * Math.PI * cycles * Math.cos(phase);
    const slopeDeg = (Math.atan2(dyDu, Math.abs(endX - startX)) * 180) / Math.PI;
    // Half the true slope reads as "gliding" rather than "diving".
    const tilt = clamp(slopeDeg / 2, -maxTilt, maxTilt) * (direction === 'ltr' ? 1 : -1);
    return { x: lerp(startX, endX, k), y: baseY + amplitude * Math.sin(phase), tilt };
  }

  /**
   * @typedef {object} FlightPlan
   * @property {number} travelMs  time spent moving across the screen
   * @property {number} pauseAtU  progress at which the flyer hovers (1 = no hover)
   * @property {number} pauseMs
   * @property {number} totalMs
   */

  /**
   * Timing for one flyer pass at constant ground speed, optionally hovering
   * with its centre at `stopFraction` of the width. With `park` it hovers at
   * the far edge for good instead (pauseMs and totalMs are Infinity).
   * @param {{ W: number, spriteW: number, bannerW: number, bannerGap?: number, direction: Direction,
   *   pxPerSec: number, pauseMs: number, pause?: boolean, stopFraction?: number, park?: boolean }} o
   * @returns {FlightPlan}
   */
  function flightPlan(o) {
    const { W, spriteW, pxPerSec, pauseMs, pause = true, stopFraction = 0.5, park = false } = o;
    const { startX, endX } = flightSpan(o);
    const travelMs = (Math.abs(endX - startX) / pxPerSec) * 1000;
    const stopX = park ? parkX(o) : W * stopFraction - spriteW / 2;
    const pauseAtU = park || pause ? clamp((stopX - startX) / (endX - startX), 0, 1) : 1;
    const holdMs = park ? Infinity : pause ? pauseMs : 0;
    return { travelMs, pauseAtU, pauseMs: holdMs, totalMs: travelMs + holdMs };
  }

  /**
   * @param {FlightPlan} plan
   * @param {number} t  ms since the pass started
   * @returns {{ u: number, phase: 'flyIn' | 'pause' | 'flyOut' | 'done', pauseT: number }}
   *   pauseT = ms spent hovering so far (for the bob), 0 outside the pause
   */
  function flightProgress(plan, t) {
    const { travelMs, pauseAtU, pauseMs, totalMs } = plan;
    const tStop = pauseAtU * travelMs;
    if (t >= totalMs) return { u: 1, phase: 'done', pauseT: 0 };
    if (t < tStop) return { u: t / travelMs, phase: 'flyIn', pauseT: 0 };
    if (t < tStop + pauseMs) return { u: pauseAtU, phase: 'pause', pauseT: t - tStop };
    return { u: (t - pauseMs) / travelMs, phase: 'flyOut', pauseT: 0 };
  }

  /** @param {number} a @param {number} b @param {number} k */
  function lerp(a, b, k) {
    return a + (b - a) * k;
  }

  /** @param {number} v @param {number} lo @param {number} hi */
  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  return { parkX, walkPlan, walkPosition, flightSpan, flightPose, flightPlan, flightProgress };
});
