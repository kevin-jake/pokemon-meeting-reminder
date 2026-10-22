// @ts-check
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { walkPlan, walkPosition, flightPose, flightPlan, flightProgress } = require('../src/shared/scene-math');

const W = 1920;
const spriteW = 128;
const bannerW = 320;
const bannerGap = 10;

for (const direction of /** @type {const} */ (['ltr', 'rtl'])) {
  test(`flightPose (${direction}) starts and ends with sprite and trailing banner off-screen`, () => {
    const o = { W, spriteW, bannerW, bannerGap, direction, baseY: 300 };
    for (const u of [0, 1]) {
      const { x } = flightPose(u, o);
      // Sprite box plus the banner on its trailing side.
      const left = direction === 'ltr' ? x - bannerGap - bannerW : x;
      const right = direction === 'ltr' ? x + spriteW : x + spriteW + bannerGap + bannerW;
      assert.ok(right <= 0 || left >= W, `u=${u}: [${left}, ${right}] overlaps the screen`);
    }
    // And it really crosses the screen in the right direction.
    const dx = flightPose(1, o).x - flightPose(0, o).x;
    assert.ok(direction === 'ltr' ? dx > W : dx < -W);
  });

  test(`flightPose (${direction}) stays within the sine amplitude and tilts gently`, () => {
    const o = { W, spriteW, bannerW, bannerGap, direction, baseY: 300, amplitude: 40, cycles: 2, maxTilt: 12 };
    for (let u = 0; u <= 1; u += 0.01) {
      const { y, tilt } = flightPose(u, o);
      assert.ok(y >= 260 - 1e-9 && y <= 340 + 1e-9, `y=${y} at u=${u}`);
      assert.ok(Math.abs(tilt) <= 12);
    }
    // At u=0 the path heads down-screen, so the nose dips in the direction of travel.
    assert.equal(Math.sign(flightPose(0, o).tilt), direction === 'ltr' ? 1 : -1);
  });

  test(`walkPlan (${direction}) phases sum to the total and start/end off-screen`, () => {
    const plan = walkPlan({ W, spriteW, pxPerSec: 200, pauseMs: 2500, direction, stopFraction: 0.4 });
    assert.equal(plan.walkInMs + plan.pauseMs + plan.walkOutMs, plan.totalMs);
    assert.equal(plan.pauseMs, 2500);
    assert.equal(plan.stopX, W * 0.4 - spriteW / 2);
    assert.deepEqual(walkPosition(plan, 0), { x: plan.startX, phase: 'walkIn' });
    assert.deepEqual(walkPosition(plan, plan.walkInMs + 1), { x: plan.stopX, phase: 'pause' });
    assert.equal(walkPosition(plan, plan.walkInMs + 2500 + 1).phase, 'walkOut');
    const end = walkPosition(plan, plan.totalMs);
    assert.equal(end.phase, 'done');
    for (const x of [plan.startX, end.x]) assert.ok(x + spriteW <= 0 || x >= W, `x=${x} is on screen`);
  });
}

test('walkPlan without a pause walks straight through at constant speed', () => {
  const plan = walkPlan({ W, spriteW, pxPerSec: 200, pauseMs: 2500, direction: 'ltr', pause: false });
  assert.equal(plan.pauseMs, 0);
  assert.equal(plan.stopX, plan.endX);
  assert.equal(plan.totalMs, ((W + spriteW) / 200) * 1000);
  assert.equal(walkPosition(plan, plan.totalMs / 2).x, -spriteW + (W + spriteW) / 2);
});

test('flightPlan/flightProgress hover at the stop point and resume where they left off', () => {
  const geometry = { W, spriteW, bannerW, bannerGap, direction: /** @type {const} */ ('ltr') };
  const plan = flightPlan({ ...geometry, pxPerSec: 280, pauseMs: 2500, stopFraction: 0.5 });
  assert.equal(plan.totalMs, plan.travelMs + 2500);
  // The sprite's centre is at W/2 while it hovers.
  const pose = flightPose(plan.pauseAtU, { ...geometry, baseY: 0 });
  assert.ok(Math.abs(pose.x + spriteW / 2 - W / 2) < 1e-6);

  const tStop = plan.pauseAtU * plan.travelMs;
  assert.equal(flightProgress(plan, tStop - 1).phase, 'flyIn');
  const hover = flightProgress(plan, tStop + 1000);
  assert.equal(hover.phase, 'pause');
  assert.equal(hover.u, plan.pauseAtU);
  assert.ok(Math.abs(hover.pauseT - 1000) < 1e-6);
  const after = flightProgress(plan, tStop + 2500 + 1);
  assert.equal(after.phase, 'flyOut');
  assert.ok(Math.abs(after.u - plan.pauseAtU) < 1e-3);
  assert.deepEqual(flightProgress(plan, plan.totalMs), { u: 1, phase: 'done', pauseT: 0 });
});

test('flightPlan without a pause never hovers', () => {
  const plan = flightPlan({ W, spriteW, bannerW, bannerGap, direction: 'rtl', pxPerSec: 280, pauseMs: 2500, pause: false });
  assert.equal(plan.pauseMs, 0);
  assert.equal(plan.totalMs, plan.travelMs);
  for (let t = 0; t < plan.totalMs; t += 100) assert.notEqual(flightProgress(plan, t).phase, 'pause');
});
