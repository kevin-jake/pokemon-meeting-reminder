// @ts-check
'use strict';
/**
 * Overlay renderer for one monitor. Main sends a `scene:play` per pass: the
 * Pokémon walks in along the bottom of the work area and either walks straight
 * through, or (on the monitor under the cursor) pauses mid-screen on the idle
 * GIF while the banner pops and the cry plays. A time-based rAF loop drives
 * the motion; CSS only handles the final opacity fade. The same window may be
 * asked to play several passes, so every play call resets the state.
 */

/** @typedef {import('../main/overlay').PassPayload} PassPayload */

const WALK_PX_PER_SEC = 200;
const PAUSE_MS = 2500;
const BANNER_GAP_PX = 10;
const TITLE_MAX = 40;
const FADE_SAFETY_MS = 1500;
const CRY_VOLUME = 0.5;

const stage = /** @type {HTMLElement} */ (document.getElementById('stage'));
const actor = /** @type {HTMLElement} */ (document.getElementById('actor'));
const sprite = /** @type {HTMLImageElement} */ (document.getElementById('sprite'));
const banner = /** @type {HTMLElement} */ (document.getElementById('banner'));
const bannerText = /** @type {HTMLElement} */ (document.getElementById('banner-text'));
const dismissBtn = /** @type {HTMLButtonElement} */ (document.getElementById('dismiss'));

/**
 * @type {{
 *   onScene(cb: (p: PassPayload) => void): void,
 *   onStop(cb: () => void): void,
 *   sceneDone(): void,
 *   dismiss(): void,
 *   setClickable(clickable: boolean): void,
 * }}
 */
const api = /** @type {any} */ (window).overlayApi;

let rafId = 0;
let finishing = false;

api.onScene((payload) => playWalker(payload));
api.onStop(() => finish(true));

// The window is click-through. Main forwards mouse moves anyway, so we ask to
// become clickable only while the cursor is over the Dismiss button.
let clickable = false;
document.addEventListener('mousemove', (e) => {
  const over = !dismissBtn.hidden && e.target === dismissBtn;
  if (over !== clickable) {
    clickable = over;
    api.setClickable(over);
  }
});
dismissBtn.addEventListener('click', () => api.dismiss());

/** @param {string} title */
function truncate(title) {
  const t = title.trim() || 'Meeting';
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

/** @param {PassPayload} p */
function renderBanner(p) {
  bannerText.replaceChildren();
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = `${p.shiny ? '✨ ' : ''}${p.displayName}: `;
  const when = p.minutesUntil <= 0 ? 'starting now' : `in ${p.minutesUntil} min`;
  bannerText.append(name, `${truncate(p.meetingTitle)} · ${when}`);
  banner.classList.toggle('urgent', p.urgent);
  dismissBtn.hidden = !p.urgent;
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
  audio.play().catch((err) => console.warn('cry failed', err));
}

/** @param {PassPayload} p */
function playWalker(p) {
  cancelAnimationFrame(rafId);
  finishing = false;
  stage.classList.remove('fade');

  const W = window.innerWidth;
  const H = window.innerHeight;
  const size = p.spriteSize * p.spriteScale;
  sprite.width = size;
  sprite.height = size;
  setSprite(p, 'walk');
  renderBanner(p);

  const ltr = p.direction === 'ltr';
  const startX = ltr ? -size : W;
  const endX = ltr ? W : -size;
  // Without a pause the sprite walks straight through to the far edge.
  const stopX = p.pause ? W * (0.35 + Math.random() * 0.3) - size / 2 : endX;
  const pauseMs = p.pause ? PAUSE_MS : 0;
  const walkInMs = (Math.abs(stopX - startX) / WALK_PX_PER_SEC) * 1000;
  const walkOutMs = (Math.abs(endX - stopX) / WALK_PX_PER_SEC) * 1000;
  const y = H - size;

  /** @type {'walkIn' | 'pause' | 'walkOut'} */
  let phase = 'walkIn';
  const t0 = performance.now();
  if (p.playCry && !p.pause) playCry(p.cry);

  /** @param {number} x */
  function place(x) {
    actor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    const bw = banner.offsetWidth;
    const bh = banner.offsetHeight;
    // Keep the banner on screen even when the sprite is near the edges.
    const bx = Math.min(Math.max(x + size / 2 - bw / 2, 8), W - bw - 8);
    const by = y - bh - BANNER_GAP_PX;
    banner.style.transform = `translate3d(${bx}px, ${by}px, 0)`;
  }

  /** @param {number} now */
  function frame(now) {
    const t = now - t0;
    let x;
    if (t < walkInMs) {
      x = startX + (stopX - startX) * (t / walkInMs);
    } else if (t < walkInMs + pauseMs) {
      x = stopX;
      if (phase !== 'pause') {
        phase = 'pause';
        setSprite(p, 'idle');
        banner.classList.remove('pop');
        void banner.offsetWidth; // restart the animation
        banner.classList.add('pop');
        if (p.playCry) playCry(p.cry);
      }
    } else if (t < walkInMs + pauseMs + walkOutMs) {
      if (phase !== 'walkOut') {
        phase = 'walkOut';
        setSprite(p, 'walk');
      }
      x = stopX + (endX - stopX) * ((t - walkInMs - pauseMs) / walkOutMs);
    } else {
      place(endX);
      finish(p.fadeOut);
      return;
    }
    place(x);
    rafId = requestAnimationFrame(frame);
  }

  place(startX);
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
