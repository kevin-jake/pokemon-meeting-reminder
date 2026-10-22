// @ts-check
'use strict';
/**
 * Overlay renderer for one monitor. Main sends a `scene:play` per pass:
 *  - walkers walk in along the bottom of the work area with the banner above
 *    their head;
 *  - flyers cross the upper half on a sine path (walk GIF, wings flap) with
 *    the banner trailing behind them.
 * Either one goes straight through, or (on the monitor under the cursor)
 * pauses mid-screen on the idle GIF while the banner pops and the cry plays.
 * A time-based rAF loop drives the motion (math in shared/scene-math.js); CSS
 * only handles the final opacity fade. The same window may be asked to play
 * several passes, so every play call resets the state.
 */

/** @typedef {import('../main/overlay').PassPayload} PassPayload */

/** @type {typeof import('../shared/scene-math')} */
const sceneMath = /** @type {any} */ (window).sceneMath;

const WALK_PX_PER_SEC = 200;
const FLY_PX_PER_SEC = 280;
const FLY_CYCLES = 2;
const FLY_AMPLITUDE_PX = 40;
const HOVER_AMPLITUDE_PX = 8;
const HOVER_PERIOD_MS = 1250; // PAUSE_MS is a whole number of periods, so the bob ends where it began
const TILT_SMOOTHING = 0.15; // per frame, so tilt eases in and out of the hover instead of snapping
const PAUSE_MS = 2500;
const BANNER_GAP_PX = 10;
const POINTER_FRESH_MS = 1000;
const TITLE_MAX = 40;
const FADE_SAFETY_MS = 1500;
const CRY_VOLUME = 0.5;
const MUSIC_VOLUME = 1;
const MUSIC_DUCK_VOLUME = 0.2; // while the cry plays, so it stays audible
const MUSIC_FADE_MS = 600;

const stage = /** @type {HTMLElement} */ (document.getElementById('stage'));
const actor = /** @type {HTMLElement} */ (document.getElementById('actor'));
const sprite = /** @type {HTMLImageElement} */ (document.getElementById('sprite'));
const banner = /** @type {HTMLElement} */ (document.getElementById('banner'));
const bannerName = /** @type {HTMLElement} */ (document.getElementById('banner-name'));
const bannerMeeting = /** @type {HTMLElement} */ (document.getElementById('banner-meeting'));
const actions = /** @type {HTMLElement} */ (document.getElementById('banner-actions'));
const joinBtn = /** @type {HTMLButtonElement} */ (document.getElementById('join'));
const dismissBtn = /** @type {HTMLButtonElement} */ (document.getElementById('dismiss'));

/**
 * @type {{
 *   onScene(cb: (p: PassPayload) => void): void,
 *   onStop(cb: () => void): void,
 *   onMusic(cb: (m: { url: string, loop: boolean }) => void): void,
 *   onMusicStop(cb: () => void): void,
 *   musicStarted(): void,
 *   musicDone(): void,
 *   sceneDone(): void,
 *   dismiss(): void,
 *   join(): void,
 *   setClickable(clickable: boolean): void,
 * }}
 */
const api = /** @type {any} */ (window).overlayApi;

let rafId = 0;
let finishing = false;

api.onScene((payload) => (payload.isFlyer ? playFlyer(payload) : playWalker(payload)));
api.onStop(() => finish(true));
api.onMusic(({ url, loop }) => startMusic(url, loop));
api.onMusicStop(() => stopMusic());

// The window is click-through. Main forwards mouse moves anyway, so we ask to
// become clickable only while the cursor is over a banner button.
let clickable = false;
/** @type {{ x: number, y: number, at: number } | null} last cursor position in this window */
let pointer = null;
document.addEventListener('mousemove', (e) => {
  pointer = { x: e.clientX, y: e.clientY, at: performance.now() };
  updateClickable();
});
document.documentElement.addEventListener('mouseleave', () => {
  pointer = null;
  updateClickable();
});

/**
 * Re-checks what is under the cursor. Also called every frame, because the
 * banner moves under a still cursor: it may only turn clickable on a recent
 * cursor position, but always turns back off, so the window never keeps
 * swallowing clicks once the button has moved away.
 */
function updateClickable() {
  const el = pointer && document.elementFromPoint(pointer.x, pointer.y);
  const overButton = el instanceof HTMLButtonElement && !el.hidden;
  const over = overButton && (clickable || performance.now() - /** @type {{ at: number }} */ (pointer).at < POINTER_FRESH_MS);
  if (over !== clickable) {
    clickable = over;
    api.setClickable(over);
  }
}

dismissBtn.addEventListener('click', () => api.dismiss());
joinBtn.addEventListener('click', () => api.join());

/** @param {string} title */
function truncate(title) {
  const t = title.trim() || 'Meeting';
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

/** @param {PassPayload} p */
function renderBanner(p) {
  bannerName.textContent = `${p.shiny ? '✨ ' : ''}${p.displayName}`;
  const when = p.minutesUntil <= 0 ? 'starting now' : `in ${p.minutesUntil} min`;
  bannerMeeting.textContent = `${truncate(p.meetingTitle)} · ${when}`;
  banner.classList.toggle('urgent', p.urgent);
  // Flyers tow the banner behind them; its tail points forward at the sprite.
  banner.classList.toggle('trail-left', p.isFlyer && p.direction === 'ltr');
  banner.classList.toggle('trail-right', p.isFlyer && p.direction === 'rtl');
  dismissBtn.hidden = !p.urgent;
  joinBtn.hidden = !p.meetingLink;
  joinBtn.textContent = p.meetingLink?.kind === 'join' ? 'Join' : 'Open invite';
  actions.hidden = dismissBtn.hidden && joinBtn.hidden;
  banner.hidden = false;
}

/**
 * Sets the walk or idle GIF with the right facing. Sprites face right; heading
 * left uses the species' left-facing walk GIF when it has one, else a CSS flip.
 * @param {PassPayload} p
 * @param {'walk' | 'idle'} state
 */
function setSprite(p, state) {
  const headingLeft = p.direction === 'rtl';
  const useLeftGif = state === 'walk' && headingLeft && Boolean(p.sprites.walkLeft);
  const src = useLeftGif ? /** @type {string} */ (p.sprites.walkLeft) : p.sprites[state];
  if (sprite.src !== src) sprite.src = src;
  sprite.classList.toggle('flip', headingLeft && !useLeftGif);
}

/** @param {string | null} url */
function playCry(url) {
  if (!url) return;
  const audio = new Audio(url);
  audio.volume = CRY_VOLUME;
  audio.addEventListener('playing', () => fadeMusic(MUSIC_DUCK_VOLUME, 150));
  const unduck = () => fadeMusic(MUSIC_VOLUME, 400);
  audio.addEventListener('ended', unduck);
  audio.addEventListener('error', unduck);
  audio.play().catch((err) => console.warn('cry failed', err));
}

/**
 * Background music lives in this window for the whole scene (main only sends
 * it to the monitor under the cursor), independent of the per-pass state.
 * @type {HTMLAudioElement | null}
 */
let music = null;
let musicStopping = false;
let musicFadeId = 0;

/**
 * @param {number} target
 * @param {number} ms
 * @param {() => void} [done]
 */
function fadeMusic(target, ms, done) {
  const audio = music;
  if (!audio || (musicStopping && !done)) return;
  cancelAnimationFrame(musicFadeId);
  const from = audio.volume;
  const t0 = performance.now();
  /** @param {number} now */
  const step = (now) => {
    // rAF timestamps are the frame start, which can precede t0; a negative k would
    // push the volume outside [0, 1], and the browser throws and leaves it stuck.
    const k = Math.min(1, Math.max(0, (now - t0) / ms));
    audio.volume = from + (target - from) * k;
    if (k < 1) musicFadeId = requestAnimationFrame(step);
    else done?.();
  };
  musicFadeId = requestAnimationFrame(step);
}

/**
 * Tells main once the track is audible (or has failed), so the sprite can
 * enter in sync with it.
 * @param {string} url
 * @param {boolean} loop  battle theme for the meeting-start alarm loops until dismissed
 */
function startMusic(url, loop) {
  music?.pause();
  musicStopping = false;
  const audio = new Audio(url);
  music = audio;
  audio.loop = loop;
  let signalled = false;
  const started = () => {
    if (signalled) return;
    signalled = true;
    api.musicStarted();
  };
  audio.addEventListener('playing', started, { once: true });
  audio.addEventListener('error', started, { once: true });
  // The battle theme hits at full volume the moment the sprite enters; the
  // calmer "in N min" tracks fade in.
  audio.volume = loop ? MUSIC_VOLUME : 0;
  audio.play().catch((err) => {
    console.warn('music failed', err);
    started();
  });
  if (!loop) fadeMusic(MUSIC_VOLUME, MUSIC_FADE_MS);
}

function stopMusic() {
  if (!music) {
    api.musicDone();
    return;
  }
  musicStopping = true;
  fadeMusic(0, MUSIC_FADE_MS, () => {
    music?.pause();
    music = null;
    api.musicDone();
  });
}

/**
 * Resets the shared state at the start of a pass and returns the sprite size.
 * @param {PassPayload} p
 */
function startPass(p) {
  cancelAnimationFrame(rafId);
  finishing = false;
  stage.classList.remove('fade');
  const size = p.spriteSize * p.spriteScale;
  sprite.width = size;
  sprite.height = size;
  sprite.style.setProperty('--tilt', '0deg');
  setSprite(p, 'walk');
  renderBanner(p);
  return size;
}

/**
 * The pause beat shared by both scenes: idle GIF, banner pop, cry.
 * @param {PassPayload} p
 */
function beginPause(p) {
  setSprite(p, 'idle');
  banner.classList.remove('pop');
  void banner.offsetWidth; // restart the animation
  banner.classList.add('pop');
  if (p.playCry) playCry(p.cry);
}

/** Pauses mid-screen somewhere in the middle 30 % so repeat reminders don't look identical. */
function randomStopFraction() {
  return 0.35 + Math.random() * 0.3;
}

/** @param {PassPayload} p */
function playWalker(p) {
  const size = startPass(p);
  const W = window.innerWidth;
  const H = window.innerHeight;
  // Without a pause the sprite walks straight through to the far edge.
  const plan = sceneMath.walkPlan({
    W,
    spriteW: size,
    pxPerSec: WALK_PX_PER_SEC,
    pauseMs: PAUSE_MS,
    direction: p.direction,
    pause: p.pause,
    park: p.park,
    stopFraction: randomStopFraction(),
  });
  const y = H - size;

  /** @type {string} */
  let phase = 'walkIn';
  const t0 = performance.now();
  if (p.playCry && !p.pause && !p.park) playCry(p.cry);

  /** @param {number} x */
  function place(x) {
    actor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    const bw = banner.offsetWidth;
    const bh = banner.offsetHeight;
    // Keep the banner on screen even when the sprite is near the edges.
    const bx = Math.min(Math.max(x + size / 2 - bw / 2, 8), W - bw - 8);
    const by = y - bh - BANNER_GAP_PX;
    banner.style.transform = `translate3d(${bx}px, ${by}px, 0)`;
    updateClickable();
  }

  /** @param {number} now */
  function frame(now) {
    const pos = sceneMath.walkPosition(plan, now - t0);
    if (pos.phase !== phase) {
      phase = pos.phase;
      if (phase === 'pause') beginPause(p);
      else if (phase === 'walkOut') setSprite(p, 'walk');
    }
    place(pos.x);
    if (phase === 'done') {
      finish(p.fadeOut);
      return;
    }
    rafId = requestAnimationFrame(frame);
  }

  place(plan.startX);
  rafId = requestAnimationFrame(frame);
}

/**
 * Flyers have no fly animation: the walk GIF (wings flap for birds and
 * dragons) moves along a sine path through the upper half of the screen.
 * On a paused pass the flyer hovers mid-screen, bobbing on its idle GIF.
 * @param {PassPayload} p
 */
function playFlyer(p) {
  const size = startPass(p);
  const W = window.innerWidth;
  const H = window.innerHeight;
  const bannerW = banner.offsetWidth;
  const geometry = {
    W,
    spriteW: size,
    bannerW,
    bannerGap: BANNER_GAP_PX,
    direction: p.direction,
    cycles: FLY_CYCLES,
    amplitude: FLY_AMPLITUDE_PX,
    // altitude is the sprite centre as a fraction of the height; keep the whole curve on screen.
    // A parking flyer skims the bottom so it hovers in the lower corner (bob included).
    baseY: p.park
      ? H - size - FLY_AMPLITUDE_PX - HOVER_AMPLITUDE_PX
      : Math.min(Math.max(p.altitude * H - size / 2, FLY_AMPLITUDE_PX), H - size - FLY_AMPLITUDE_PX),
  };
  const plan = sceneMath.flightPlan({
    ...geometry,
    pxPerSec: FLY_PX_PER_SEC,
    pauseMs: PAUSE_MS,
    pause: p.pause,
    park: p.park,
    stopFraction: randomStopFraction(),
  });
  const ltr = p.direction === 'ltr';

  /** @type {string} */
  let phase = 'flyIn';
  let tilt = 0;
  const t0 = performance.now();
  if (p.playCry && !p.pause && !p.park) playCry(p.cry);

  /** @param {number} x @param {number} y */
  function place(x, y) {
    actor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    sprite.style.setProperty('--tilt', `${tilt.toFixed(2)}deg`);
    const bh = banner.offsetHeight;
    // The banner trails behind, vertically centred on the sprite.
    const bx = ltr ? x - BANNER_GAP_PX - bannerW : x + size + BANNER_GAP_PX;
    const by = y + size / 2 - bh / 2;
    banner.style.transform = `translate3d(${bx}px, ${by}px, 0)`;
    updateClickable();
  }

  /** @param {number} now */
  function frame(now) {
    const prog = sceneMath.flightProgress(plan, now - t0);
    if (prog.phase !== phase) {
      phase = prog.phase;
      if (phase === 'pause') beginPause(p);
      else if (phase === 'flyOut') setSprite(p, 'walk');
    }
    const pose = sceneMath.flightPose(prog.u, geometry);
    const hovering = phase === 'pause';
    const bob = hovering ? HOVER_AMPLITUDE_PX * Math.sin((2 * Math.PI * prog.pauseT) / HOVER_PERIOD_MS) : 0;
    tilt += ((hovering ? 0 : pose.tilt) - tilt) * TILT_SMOOTHING;
    place(pose.x, pose.y + bob);
    if (phase === 'done') {
      finish(p.fadeOut);
      return;
    }
    rafId = requestAnimationFrame(frame);
  }

  const start = sceneMath.flightPose(0, geometry);
  tilt = start.tilt;
  place(start.x, start.y);
  rafId = requestAnimationFrame(frame);
}

/**
 * Ends the current pass. With `fade` the stage fades out first; otherwise the
 * sprite is already off-screen and the next window takes over immediately.
 * @param {boolean} fade
 */
function finish(fade) {
  if (finishing) return;
  finishing = true;
  cancelAnimationFrame(rafId);
  if (clickable) {
    clickable = false;
    api.setClickable(false);
  }
  if (!fade) {
    // The banner is clamped to stay on screen, so hide it or it lingers
    // on this monitor after the sprite has moved on to the next one.
    banner.hidden = true;
    api.sceneDone();
    return;
  }
  let signalled = false;
  const signal = () => {
    if (signalled) return;
    signalled = true;
    api.sceneDone();
  };
  stage.addEventListener('transitionend', signal, { once: true });
  setTimeout(signal, FADE_SAFETY_MS);
  stage.classList.add('fade');
}
