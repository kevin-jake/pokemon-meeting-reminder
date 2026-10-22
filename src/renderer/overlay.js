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
 * While the cursor rests on the Pokémon or its banner the pass is held: the
 * scene clock stops, the sprite stands still facing front, and main is told so
 * its pass timeout waits too. Moving the cursor away resumes the pass.
 * Dismiss / Join recalls the Pokémon into its Poké Ball before the fade.
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
const PAUSE_MS = 15000;
const BANNER_GAP_PX = 10;
const POINTER_FRESH_MS = 1000;
const TITLE_MAX = 40;
const FADE_SAFETY_MS = 1500;
const CRY_VOLUME = 0.5;
const MUSIC_VOLUME = 1;
const MUSIC_DUCK_VOLUME = 0.2; // while the cry plays, so it stays audible
const MUSIC_FADE_MS = 600;
// media/pokeball_sprite_sheet.png: 6 stacked 64 px frames, closed ball (0) to open with the red beam (5).
const BALL_FRAME_PX = 64;
const BALL_FRAMES = 6;
const BALL_SCALE = 3;
const BALL_RADIUS_PX = 7 * BALL_SCALE; // the closed ball is 14 px across, centred in its frame
const RETURN_BEAM_MS = 250;
const RETURN_SHRINK_MS = 450;
const RETURN_CLOSE_MS = 300;
const RETURN_WOBBLE_MS = 450;
// Same function list at both ends so the filter interpolates; the first one matches the CSS.
const SPRITE_FILTER = 'brightness(1) sepia(0) saturate(1) hue-rotate(0deg) drop-shadow(0 4px 3px rgba(0, 0, 0, 0.35))';
const RECALL_FILTER = 'brightness(0.9) sepia(1) saturate(8) hue-rotate(-50deg) drop-shadow(0 0 8px rgba(255, 60, 60, 0.9))';

const stage = /** @type {HTMLElement} */ (document.getElementById('stage'));
const actor = /** @type {HTMLElement} */ (document.getElementById('actor'));
const sprite = /** @type {HTMLImageElement} */ (document.getElementById('sprite'));
const banner = /** @type {HTMLElement} */ (document.getElementById('banner'));
const bannerName = /** @type {HTMLElement} */ (document.getElementById('banner-name'));
const bannerMeeting = /** @type {HTMLElement} */ (document.getElementById('banner-meeting'));
const actions = /** @type {HTMLElement} */ (document.getElementById('banner-actions'));
const joinBtn = /** @type {HTMLButtonElement} */ (document.getElementById('join'));
const dismissBtn = /** @type {HTMLButtonElement} */ (document.getElementById('dismiss'));
const ball = /** @type {HTMLElement} */ (document.getElementById('ball'));

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
 *   setHeld(held: boolean): void,
 * }}
 */
const api = /** @type {any} */ (window).overlayApi;

let rafId = 0;
let finishing = false;
/** @type {PassPayload | null} */
let current = null;
/** Where the sprite was last placed; the Poké Ball appears there. */
let actorBox = { x: 0, y: 0, size: 0 };
/** Where the banner was last placed, for the hover test. */
let bannerBox = { x: 0, y: 0, w: 0, h: 0 };
/** The cursor is on the Pokémon or its banner, so the pass clock is stopped. */
let held = false;
/** @type {Promise<void> | null} set while the Pokémon is being recalled */
let returning = null;

const BALL_BOX_PX = BALL_FRAME_PX * BALL_SCALE;
ball.style.width = `${BALL_BOX_PX}px`;
ball.style.height = `${BALL_BOX_PX}px`;
ball.style.backgroundSize = `${BALL_BOX_PX}px ${BALL_BOX_PX * BALL_FRAMES}px`;

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

/**
 * Whether the cursor rests on the sprite box or the (visible) banner. The
 * window is click-through, so this is a plain box test on where the frame
 * loop last placed them rather than a DOM hit test.
 */
function isHovered() {
  if (!pointer) return false;
  const { x, y } = pointer;
  const a = actorBox;
  const b = bannerBox;
  if (x >= a.x && x < a.x + a.size && y >= a.y && y < a.y + a.size) return true;
  return !banner.hidden && x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;
}

/**
 * Called every frame: tracks the hover and tells main when it changes, so the
 * pass timeout there pauses with the scene clock. Returns the new state.
 */
function syncHeld() {
  const next = isHovered();
  if (next !== held) {
    held = next;
    api.setHeld(next);
  }
  return held;
}

/** Ends a hold when the pass stops on its own (recall, stop) rather than by the cursor leaving. */
function releaseHold() {
  if (!held) return;
  held = false;
  api.setHeld(false);
}

// Main is told right away (the link opens, the music fades); the scene:stop
// that follows waits in finish() until the Pokémon is back in its ball.
dismissBtn.addEventListener('click', () => {
  recall();
  api.dismiss();
});
joinBtn.addEventListener('click', () => {
  recall();
  api.join();
});

/** @param {number} frame */
function ballFrame(frame) {
  return `0 ${-frame * BALL_BOX_PX}px`;
}

/** Freezes the pass and starts the return-to-ball animation. */
function recall() {
  if (returning || finishing || !current) return;
  cancelAnimationFrame(rafId);
  releaseHold();
  banner.hidden = true;
  updateClickable(); // the buttons are gone, so hand clicks back to the desktop
  returning = playRecall(current).catch(() => {}); // cancelled by a new pass
}

/**
 * Open ball with its beam at the Pokémon's feet (a flyer's centre), the
 * Pokémon turns red and shrinks into it, the ball snaps shut and wobbles.
 * @param {PassPayload} p
 */
async function playRecall(p) {
  const { x, y, size } = actorBox;
  const W = window.innerWidth;
  // Keep the ball on screen even when the sprite is half off an edge.
  const cx = Math.min(Math.max(x + size / 2, BALL_RADIUS_PX), W - BALL_RADIUS_PX);
  const cy = p.isFlyer ? y + size / 2 : y + size - BALL_RADIUS_PX;
  ball.style.backgroundImage = `url("${p.pokeball}")`;
  ball.style.backgroundPosition = ballFrame(BALL_FRAMES - 1);
  // left/top rather than a transform, so the pop and wobble below pivot on the ball itself.
  ball.style.left = `${cx - BALL_BOX_PX / 2}px`;
  ball.style.top = `${cy - BALL_BOX_PX / 2}px`;
  ball.hidden = false;

  ball.animate([{ scale: '0.3', opacity: 0 }, { scale: '1', opacity: 1 }], { duration: 150, easing: 'ease-out' });
  await sprite.animate([{ filter: SPRITE_FILTER }, { filter: RECALL_FILTER }], {
    duration: RETURN_BEAM_MS,
    fill: 'forwards',
  }).finished;

  // `translate` and `scale` compose with the CSS tilt/flip transform, so the
  // sprite shrinks about its centre while that centre slides into the ball.
  const dx = cx - (x + size / 2);
  const dy = cy - (y + size / 2);
  await sprite.animate(
    [
      { translate: '0 0', scale: '1', opacity: 1 },
      { translate: `${dx}px ${dy}px`, scale: '0', opacity: 0.4 },
    ],
    { duration: RETURN_SHRINK_MS, easing: 'ease-in', fill: 'forwards' },
  ).finished;

  await ball.animate([{ backgroundPosition: ballFrame(BALL_FRAMES - 1) }, { backgroundPosition: ballFrame(0) }], {
    duration: RETURN_CLOSE_MS,
    easing: `steps(${BALL_FRAMES - 1}, jump-start)`,
    fill: 'forwards',
  }).finished;

  await ball.animate(
    [{ rotate: '0deg' }, { rotate: '-20deg' }, { rotate: '15deg' }, { rotate: '-6deg' }, { rotate: '0deg' }],
    { duration: RETURN_WOBBLE_MS, easing: 'ease-in-out' },
  ).finished;
}

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
  // Every reminder can be dismissed; Join (which also ends it) needs a link.
  joinBtn.hidden = !p.meetingLink;
  dismissBtn.hidden = false;
  joinBtn.textContent = p.meetingLink?.kind === 'join' ? 'Join' : 'Open invite';
  actions.hidden = false;
  banner.hidden = false;
}

/**
 * Sets the walk or idle GIF with the right facing. Walk sprites face right;
 * heading left uses the species' left-facing walk GIF when it has one, else a
 * CSS flip. Idle sprites face the viewer, so they are never flipped.
 * @param {PassPayload} p
 * @param {'walk' | 'idle'} state
 */
function setSprite(p, state) {
  const headingLeft = p.direction === 'rtl';
  const useLeftGif = state === 'walk' && headingLeft && Boolean(p.sprites.walkLeft);
  const src = useLeftGif ? /** @type {string} */ (p.sprites.walkLeft) : p.sprites[state];
  if (sprite.src !== src) sprite.src = src;
  sprite.classList.toggle('flip', state === 'walk' && headingLeft && !useLeftGif);
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
  current = p;
  returning = null;
  for (const el of [sprite, ball]) for (const a of el.getAnimations()) a.cancel();
  ball.hidden = true;
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
 * The pause beat shared by both scenes: banner pop and cry (the frame loop
 * switches the sprite to idle).
 * @param {PassPayload} p
 */
function beginPause(p) {
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
  let elapsed = 0; // scene time; stands still while the pass is held
  let last = performance.now();
  if (p.playCry && !p.pause && !p.park) playCry(p.cry);

  /** @param {number} x */
  function place(x) {
    actor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    actorBox = { x, y, size };
    const bw = banner.offsetWidth;
    const bh = banner.offsetHeight;
    // Keep the banner on screen even when the sprite is near the edges.
    const bx = Math.min(Math.max(x + size / 2 - bw / 2, 8), W - bw - 8);
    const by = y - bh - BANNER_GAP_PX;
    banner.style.transform = `translate3d(${bx}px, ${by}px, 0)`;
    bannerBox = { x: bx, y: by, w: bw, h: bh };
    updateClickable();
  }

  /** @param {number} now */
  function frame(now) {
    const holding = syncHeld();
    if (!holding) elapsed += now - last;
    last = now;
    const pos = sceneMath.walkPosition(plan, elapsed);
    if (pos.phase !== phase) {
      phase = pos.phase;
      if (phase === 'pause') beginPause(p);
    }
    // Held or pausing, the Pokémon stands and looks at the viewer.
    setSprite(p, holding || phase === 'pause' ? 'idle' : 'walk');
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
  let elapsed = 0; // scene time; stands still while the pass is held
  let last = performance.now();
  if (p.playCry && !p.pause && !p.park) playCry(p.cry);

  /** @param {number} x @param {number} y */
  function place(x, y) {
    actor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    actorBox = { x, y, size };
    sprite.style.setProperty('--tilt', `${tilt.toFixed(2)}deg`);
    const bh = banner.offsetHeight;
    // The banner trails behind, vertically centred on the sprite.
    const bx = ltr ? x - BANNER_GAP_PX - bannerW : x + size + BANNER_GAP_PX;
    const by = y + size / 2 - bh / 2;
    banner.style.transform = `translate3d(${bx}px, ${by}px, 0)`;
    bannerBox = { x: bx, y: by, w: bannerW, h: bh };
    updateClickable();
  }

  /** @param {number} now */
  function frame(now) {
    const holding = syncHeld();
    if (!holding) elapsed += now - last;
    last = now;
    const prog = sceneMath.flightProgress(plan, elapsed);
    if (prog.phase !== phase) {
      phase = prog.phase;
      if (phase === 'pause') beginPause(p);
    }
    const pose = sceneMath.flightPose(prog.u, geometry);
    const hovering = phase === 'pause';
    // Held or pausing, the flyer levels out and looks at the viewer; the bob freezes with the clock.
    setSprite(p, holding || hovering ? 'idle' : 'walk');
    const bob = hovering ? HOVER_AMPLITUDE_PX * Math.sin((2 * Math.PI * prog.pauseT) / HOVER_PERIOD_MS) : 0;
    tilt += ((holding || hovering ? 0 : pose.tilt) - tilt) * TILT_SMOOTHING;
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
  releaseHold();
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
  const fadeOut = () => {
    stage.addEventListener('transitionend', signal, { once: true });
    setTimeout(signal, FADE_SAFETY_MS);
    stage.classList.add('fade');
  };
  // Let a recall finish before fading.
  if (returning) void returning.then(fadeOut);
  else fadeOut();
}
