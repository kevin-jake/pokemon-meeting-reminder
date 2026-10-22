// @ts-check
'use strict';
/**
 * Overlay renderer. M1 implements the walker scene only: the Pokémon walks in
 * along the bottom of the work area, pauses (idle GIF, banner pops), then
 * walks off the far edge. A time-based rAF loop drives the motion; CSS only
 * handles the final opacity fade.
 */

/** @typedef {import('../main/overlay').ScenePayload} ScenePayload */

const WALK_PX_PER_SEC = 200;
const PAUSE_MS = 2500;
const BANNER_GAP_PX = 10;
const TITLE_MAX = 40;
const FADE_SAFETY_MS = 1500;

const stage = /** @type {HTMLElement} */ (document.getElementById('stage'));
const actor = /** @type {HTMLElement} */ (document.getElementById('actor'));
const sprite = /** @type {HTMLImageElement} */ (document.getElementById('sprite'));
const banner = /** @type {HTMLElement} */ (document.getElementById('banner'));

/** @type {{ onScene(cb: (p: ScenePayload) => void): void, sceneDone(): void }} */
const api = /** @type {any} */ (window).overlayApi;

api.onScene((payload) => playWalker(payload));

/** @param {string} title */
function truncate(title) {
  const t = title.trim() || 'Meeting';
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

/** @param {ScenePayload} p */
function renderBanner(p) {
  banner.replaceChildren();
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = `${p.shiny ? '✨ ' : ''}${p.displayName}: `;
  banner.append(name, `${truncate(p.meetingTitle)} · in ${p.minutesUntil} min`);
  banner.hidden = false;
}

/**
 * Sets the walk or idle GIF with the right facing. Sprites face right; heading
 * left uses the species' left-facing walk GIF when it has one, else a CSS flip.
 * @param {ScenePayload} p
 * @param {'walk' | 'idle'} state
 */
function setSprite(p, state) {
  const headingLeft = p.direction === 'rtl';
  const useLeftGif = state === 'walk' && headingLeft && Boolean(p.sprites.walkLeft);
  const src = useLeftGif ? /** @type {string} */ (p.sprites.walkLeft) : p.sprites[state];
  if (sprite.src !== src) sprite.src = src;
  sprite.classList.toggle('flip', headingLeft && !useLeftGif);
}

/** @param {ScenePayload} p */
function playWalker(p) {
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
  const stopX = W * (0.35 + Math.random() * 0.3) - size / 2;
  const walkInMs = (Math.abs(stopX - startX) / WALK_PX_PER_SEC) * 1000;
  const walkOutMs = (Math.abs(endX - stopX) / WALK_PX_PER_SEC) * 1000;
  const y = H - size;

  /** @type {'walkIn' | 'pause' | 'walkOut'} */
  let phase = 'walkIn';
  const t0 = performance.now();

  /** @param {number} x */
  function place(x) {
    actor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    const bw = banner.offsetWidth;
    const bh = banner.offsetHeight;
    const bx = x + size / 2 - bw / 2;
    const by = y - bh - BANNER_GAP_PX;
    banner.style.transform = `translate3d(${bx}px, ${by}px, 0)`;
  }

  /** @param {number} now */
  function frame(now) {
    const t = now - t0;
    let x;
    if (t < walkInMs) {
      x = startX + (stopX - startX) * (t / walkInMs);
    } else if (t < walkInMs + PAUSE_MS) {
      x = stopX;
      if (phase !== 'pause') {
        phase = 'pause';
        setSprite(p, 'idle');
        banner.classList.remove('pop');
        void banner.offsetWidth; // restart the animation
        banner.classList.add('pop');
      }
    } else if (t < walkInMs + PAUSE_MS + walkOutMs) {
      if (phase !== 'walkOut') {
        phase = 'walkOut';
        setSprite(p, 'walk');
      }
      x = stopX + (endX - stopX) * ((t - walkInMs - PAUSE_MS) / walkOutMs);
    } else {
      place(endX);
      finish();
      return;
    }
    place(x);
    requestAnimationFrame(frame);
  }

  place(startX);
  requestAnimationFrame(frame);
}

let done = false;
function finish() {
  const signal = () => {
    if (done) return;
    done = true;
    api.sceneDone();
  };
  stage.addEventListener('transitionend', signal, { once: true });
  setTimeout(signal, FADE_SAFETY_MS);
  stage.classList.add('fade');
}
