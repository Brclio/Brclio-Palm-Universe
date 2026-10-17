// HISTORICAL SNAPSHOT: superseded by gesture-sequence.test.mjs on 2026-10-17. Do not use to validate current behavior.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GestureSequence } from '../public/gesture-sequence.js';

// These are behavioral acceptance scenarios derived from the source video's
// actions. They intentionally exercise the public API and no private fields.
const reportPath = new URL('../analysis/interaction-validation.json', import.meta.url);
const checks = [];
const EPSILON = 1e-7;

function hand(kind, x = .35, y = .60, overrides = {}) {
  const fingers = kind === 'open'
    ? { thumb: true, index: true, middle: true, ring: true, pinky: true }
    : kind === 'victory'
      ? { thumb: false, index: true, middle: true, ring: false, pinky: false }
      : kind === 'fist'
        ? { thumb: false, index: false, middle: false, ring: false, pinky: false }
        : { thumb: true, index: true, middle: false, ring: false, pinky: false };
  const gap = kind === 'open' ? .17 : kind === 'l' ? .18 : kind === 'pinch' ? .012 : kind === 'fist' ? .035 : .07;
  return {
    palm: { x, y: y + .08 }, index: { x: x - gap / 2, y },
    thumb: { x: x + gap / 2, y }, pinchCenter: { x, y }, handSize: .08,
    pinch: kind === 'pinch', pinchStrength: kind === 'pinch' ? .94 : kind === 'c' ? .3 : 0,
    openPalm: kind === 'open', fist: kind === 'fist', pointing: kind === 'point',
    victory: kind === 'victory', spread: kind === 'open' ? .9 : 0,
    extendedFingers: Object.values(fingers).filter(Boolean).length,
    fingerStates: fingers, ...overrides,
  };
}

function harness() {
  const events = [];
  const sequence = new GestureSequence({ onEvent: event => events.push(event) });
  let t = 0;
  let state = sequence.reset(t);
  return {
    sequence, events,
    get state() { return state; },
    get t() { return t; },
    frame(input, dt = .04) { t += dt; state = sequence.update(input, t); return state; },
    tick(dt = .016) { t += dt; state = sequence.tick(t); return state; },
    hold(input, seconds = .4) {
      const n = Math.ceil(seconds / .04);
      for (let i = 0; i < n; i++) this.frame(input, seconds / n);
      return state;
    },
    move(kind, from, to, seconds = .4, overrides = {}) {
      const n = Math.ceil(seconds / .04);
      for (let i = 1; i <= n; i++) {
        const p = i / n;
        this.frame(hand(kind, from.x + (to.x - from.x) * p, from.y + (to.y - from.y) * p, overrides), seconds / n);
      }
      return state;
    },
    reset() { state = sequence.reset(t); return state; },
  };
}

function atStage(h, expected) { assert.equal(h.state.stage, expected, `expected ${expected} at t=${h.t.toFixed(2)}; got ${h.state.stage}`); }
function samePoint(actual, expected, message) {
  assert.ok(actual && expected, `${message}: missing point`);
  assert.ok(Math.abs(actual.x - expected.x) < EPSILON && Math.abs(actual.y - expected.y) < EPSILON,
    `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}
function summon(h) {
  h.hold(hand('open'), .24);
  h.hold(hand('fist'), .24);
  atStage(h, 'star');
  return h;
}
function moon(h = harness()) {
  summon(h);
  h.hold(hand('open', .25), .40);
  h.move('open', { x: .25, y: .6 }, { x: .70, y: .6 }, .36);
  atStage(h, 'sun');
  h.hold(hand('open', .70), .70);
  h.move('open', { x: .70, y: .6 }, { x: .25, y: .6 }, .4);
  h.hold(hand('open', .25), .70);
  h.move('open', { x: .25, y: .6 }, { x: .70, y: .6 }, .36);
  atStage(h, 'moon');
  return h;
}
function releaseMoon(h = moon()) {
  const target = { ...h.state.target };
  h.hold(hand('c', target.x, target.y), .24);
  atStage(h, 'moonHeld');
  h.move('pinch', target, { x: .79, y: .67 }, .64);
  h.hold(hand('open', .79, .67), .24);
  atStage(h, 'moonReleased');
  return h;
}
function phases(h = releaseMoon()) {
  const anchor = { ...h.state.target };
  h.hold(hand('open', anchor.x, anchor.y), .24);
  h.move('open', anchor, { x: .1, y: anchor.y }, .80);
  atStage(h, 'phases');
  return h;
}
function pan(h = phases()) {
  const anchor = { ...(h.state.phaseAnchor || h.state.target) };
  h.hold(hand('pinch', anchor.x, anchor.y), .24);
  atStage(h, 'phaseHeld');
  h.move('pinch', anchor, { x: .25, y: .25 }, .80);
  h.hold(hand('pinch', .25, .25), .3);
  atStage(h, 'phaseHeld');
  h.hold(hand('open', .25, .25), .24);
  atStage(h, 'pan');
  return h;
}

async function check(id, name, fn) {
  try { await fn(); checks.push({ id, name, passed: true }); console.log(`PASS ${id}: ${name}`); }
  catch (error) { checks.push({ id, name, passed: false, error: error.message }); console.error(`FAIL ${id}: ${name}\n${error.stack}`); }
}

await check('empty-start', '无手/张掌/V/抬指保持空场，稳定握拳才召星', () => {
  const h = harness();
  h.hold(null, 2); atStage(h, 'idle'); assert.equal(h.state.visible, false);
  h.hold(hand('open'), 2); atStage(h, 'idle');
  h.hold(hand('victory'), .4); atStage(h, 'idle');
  h.hold(hand('point'), .4); atStage(h, 'idle');
  h.hold(hand('open'), .24);
  h.frame(hand('fist'), .025); h.hold(hand('open'), .24); atStage(h, 'idle');
  h.hold(hand('fist'), .24); atStage(h, 'star'); assert.equal(h.state.visible, true);
  h.hold(hand('fist'), 2); atStage(h, 'star');
});

await check('directional-swipes', '向右横挥每次仅切换一级；继续伸手不连续跳过太阳', () => {
  const h = summon(harness());
  h.hold(hand('open', .20), .4);
  h.move('open', { x: .20, y: .6 }, { x: .88, y: .6 }, .32);
  atStage(h, 'sun');
  h.move('open', { x: .88, y: .6 }, { x: .98, y: .6 }, .32);
  h.hold(hand('open', .98), 1); atStage(h, 'sun');
  h.move('open', { x: .98, y: .6 }, { x: .20, y: .6 }, .5); atStage(h, 'sun');
  h.hold(hand('open', .20), .7);
  h.move('open', { x: .20, y: .6 }, { x: .75, y: .6 }, .36); atStage(h, 'moon');
});

await check('unrelated-gestures', '静态V、反向横挥、竖直抬指不能切换天体', () => {
  const h = summon(harness());
  h.hold(hand('victory', .35), 2); atStage(h, 'star');
  h.hold(hand('open', .8), .7);
  h.move('open', { x: .8, y: .6 }, { x: .2, y: .6 }, .36); atStage(h, 'star');
  h.hold(hand('point', .3, .7), .7);
  h.move('point', { x: .3, y: .7 }, { x: .3, y: .2 }, .36); atStage(h, 'star');
});

await check('victory-classifier-tolerance', '明确向右横挥时模型短暂误判V不抹除空间动作证据', () => {
  const h = summon(harness()); h.hold(hand('victory', .20), .5);
  atStage(h, 'star');
  h.move('victory', { x: .20, y: .6 }, { x: .80, y: .6 }, .4); atStage(h, 'sun');
  h.hold(hand('victory', .80), 1); atStage(h, 'sun');
});

await check('brief-tracking-dropout', '短丢手可保留真实右挥样本，长丢手或不可能瞬移不能补造横挥', () => {
  const short = summon(harness()); short.hold(hand('open', .20), .5);
  for (let i = 1; i <= 5; i++) {
    short.frame(null, .04);
    short.frame(hand('open', .20 + .06 * i), .04);
  }
  atStage(short, 'sun');

  const long = summon(harness()); long.hold(hand('open', .20), .5);
  long.hold(null, .24); long.frame(hand('open', .80), .04); long.hold(hand('open', .80), .2); atStage(long, 'star');

  const jump = summon(harness()); jump.hold(hand('open', .20), .5);
  jump.frame(null, .02); jump.frame(hand('open', .95), .02); jump.hold(hand('open', .95), .2); atStage(jump, 'star');
});

await check('spatial-grab', '远处捏合不抓取，月球附近C形可抓并随手拖动', () => {
  const h = moon(); const target = { ...h.state.target };
  h.hold(hand('pinch', .02, .02), .5); atStage(h, 'moon'); samePoint(h.state.target, target, 'far pinch moves moon');
  h.hold(hand('c', target.x, target.y), .24); atStage(h, 'moonHeld'); assert.equal(h.state.held, true);
  h.move('pinch', target, { x: .78, y: .68 }, .6);
  assert.ok(h.state.target.x > target.x + .1, 'held moon should follow hand across screen');
});

await check('fist-grab-boundary', '近球握拳不能首次抓取；已抓住的C形偶发fist误判仍能跟随', () => {
  const h = moon(); const target = { ...h.state.target };
  h.hold(hand('fist', target.x, target.y), .3); atStage(h, 'moon');
  h.hold(hand('fist', target.x, target.y, { pinch: true, pinchStrength: .94 }), .3); atStage(h, 'moon');
  h.hold(hand('c', target.x, target.y), .24); atStage(h, 'moonHeld');
  h.move('c', target, { x: .65, y: .50 }, .6, { fist: true });
  atStage(h, 'moonHeld'); samePoint(h.state.target, { x: .65, y: .50 }, 'occluded held C gesture must keep following instead of being treated as a new fist');
});

await check('pinch-scale', '捏合越紧月球越小', () => {
  const h = moon(); const target = { ...h.state.target };
  h.hold(hand('pinch', target.x, target.y, { pinchStrength: .40 }), .24); atStage(h, 'moonHeld');
  h.hold(hand('pinch', target.x, target.y, { pinchStrength: .45 }), .3); const loose = h.state.scale;
  h.hold(hand('pinch', target.x, target.y, { pinchStrength: .97 }), .3); const tight = h.state.scale;
  assert.ok(tight < loose, `tight scale ${tight} must be smaller than loose ${loose}`);
});

await check('anchored-release', '松开后月球留在释放处，张掌和竖向离开不展开月相', () => {
  const h = releaseMoon(); const release = { ...h.state.target };
  h.hold(hand('open', .79, .67), 1); atStage(h, 'moonReleased');
  h.move('open', { x: .79, y: .67 }, { x: .79, y: .12 }, .6); atStage(h, 'moonReleased');
  h.hold(null, 1); atStage(h, 'moonReleased'); samePoint(h.state.target, release, 'released moon must stay anchored');
});

await check('left-pull-phases', '驻留月球向右不展开，向左拉才展开并保留右端锚点', () => {
  const h = releaseMoon(); const release = { ...h.state.target };
  h.move('open', release, { x: .96, y: release.y }, .4); atStage(h, 'moonReleased');
  h.hold(hand('open', release.x, release.y), .4);
  h.move('open', release, { x: .10, y: release.y }, .8); atStage(h, 'phases');
  assert.ok(h.state.phaseProgress > .5, `left pull should visibly unfold phases: ${h.state.phaseProgress}`);
  samePoint(h.state.phaseAnchor, release, 'rightmost full moon is the release anchor');
});

await check('collect-lift-release', '只在月相右端捏合收拢；保持抓取上举不会套锅，松开才套锅', () => {
  const h = phases(); const anchor = { ...h.state.phaseAnchor };
  h.hold(hand('pinch', .02, .02), .4); atStage(h, 'phases');
  h.hold(hand('pinch', anchor.x, anchor.y), .24); atStage(h, 'phaseHeld');
  h.move('pinch', anchor, { x: .25, y: .25 }, .8);
  h.hold(hand('pinch', .25, .25), 2); atStage(h, 'phaseHeld');
  const release = { ...h.state.target };
  h.hold(hand('open', .25, .25), .24); atStage(h, 'pan');
  samePoint(h.state.panOrigin, release, 'pan drop must start at held release location');
  samePoint(h.state.releaseTarget, release, 'pan release point must preserve last gripped position');
  assert.ok(h.state.target.x < release.x && h.state.target.y > release.y, 'moon must settle below-left of raised release point');
  const settled = { ...h.state.target };
  h.move('open', { x: .25, y: .25 }, { x: .85, y: .8 }, .5);
  h.hold(null, 2); atStage(h, 'pan'); samePoint(h.state.target, settled, 'pan must stay at derived settling point');
});

await check('c-grip-lift', 'C形抓取保持上举不能被误认为L形释放', () => {
  const h = phases(); const anchor = { ...h.state.phaseAnchor };
  h.hold(hand('c', anchor.x, anchor.y), .24); atStage(h, 'phaseHeld');
  h.move('c', anchor, { x: .25, y: .25 }, .8);
  h.hold(hand('c', .25, .25), 1); atStage(h, 'phaseHeld');
  const release = { ...h.state.target };
  h.hold(hand('l', .25, .25), .24); atStage(h, 'pan');
  samePoint(h.state.panOrigin, release, 'L-shaped release must keep last gripped point as drop origin');
  assert.ok(h.state.target.x < release.x && h.state.target.y > release.y, 'L-shaped release must settle moon below-left before enclosing it');
});

await check('l-release-aperture-growth', 'L开口1.47倍手长且较夹持明显增大可释放，维持C或微增不能释放', () => {
  for (const gripRatio of [1.20, 1.44]) {
    const h = phases(); const anchor = { ...h.state.phaseAnchor };
    const aperture = (p, ratio, strength = .3) => hand('c', p.x, p.y, {
      index: { x: p.x - .08 * ratio / 2, y: p.y },
      thumb: { x: p.x + .08 * ratio / 2, y: p.y }, pinchStrength: strength,
    });
    h.hold(aperture(anchor, gripRatio), .24); atStage(h, 'phaseHeld');
    const n = 20;
    for (let i = 1; i <= n; i++) {
      const p = i / n;
      h.frame(aperture({ x: anchor.x + (.25 - anchor.x) * p, y: anchor.y + (.25 - anchor.y) * p }, gripRatio));
    }
    h.hold(aperture({ x: .25, y: .25 }, gripRatio), .3); atStage(h, 'phaseHeld');
    h.hold(aperture({ x: .25, y: .25 }, 1.47, 0), .24);
    if (gripRatio === 1.20) atStage(h, 'pan');
    else {
      atStage(h, 'phaseHeld');
      h.hold(aperture({ x: .25, y: .25 }, 1.90, 0), .24); atStage(h, 'pan');
    }
  }
});

await check('pan-placement', '锅的位置由释放点决定：换一个释放点后锅同向同距离移动', () => {
  const positions = [];
  for (const releasedAt of [{ x: .25, y: .25 }, { x: .35, y: .32 }]) {
    const h = phases(); const anchor = { ...h.state.phaseAnchor };
    h.hold(hand('pinch', anchor.x, anchor.y), .24); atStage(h, 'phaseHeld');
    h.move('pinch', anchor, releasedAt, .8);
    h.hold(hand('l', releasedAt.x, releasedAt.y), .24); atStage(h, 'pan');
    samePoint(h.state.panOrigin, releasedAt, 'raised release point must determine pan origin');
    positions.push({ ...h.state.target });
  }
  assert.ok(Math.abs((positions[1].x - positions[0].x) - .10) < EPSILON, 'horizontal release delta must translate pan by same delta');
  assert.ok(Math.abs((positions[1].y - positions[0].y) - .07) < EPSILON, 'vertical release delta must translate pan by same delta');
});

await check('frozen-pan', '套锅后再次捏合和拖动不能抓起或移动锅', () => {
  const h = pan(); const settled = { ...h.state.target };
  h.hold(hand('pinch', settled.x, settled.y), .4);
  h.move('pinch', settled, { x: .85, y: .75 }, .8);
  h.hold(hand('open', .85, .75), .4);
  atStage(h, 'pan'); assert.equal(h.state.held, false);
  samePoint(h.state.target, settled, 'pinching cannot move a settled pan');
});

await check('phase-height', '拉开月相时手略向上移动，整排月相仍固定在释放高度', () => {
  const h = releaseMoon(); const anchor = { ...h.state.target };
  h.move('open', anchor, { x: .10, y: anchor.y - .12 }, .8); atStage(h, 'phases');
  assert.equal(h.state.phaseAnchor.y, anchor.y, 'moon-phase anchor height must remain fixed');
  assert.equal(h.state.target.y, anchor.y, 'full moon height must remain fixed while pulling');
});

await check('unarmed-pan', '锅悬浮期间仅张掌或V不爆散', () => {
  const h = pan();
  h.hold(hand('open', .25, .25), 2); atStage(h, 'pan');
  h.hold(hand('victory', .25, .25), .5); atStage(h, 'pan');
  assert.equal(h.state.burst, false);
});

await check('armed-burst', '锅旁拳→张掌只爆散一次，之后空场直至reset', () => {
  const h = pan(); let pulses = 0;
  h.hold(hand('fist', .25, .25), .24); atStage(h, 'pan');
  for (let i = 0; i < 20; i++) { h.frame(hand('open', .25, .25)); if (h.state.burst) pulses++; }
  atStage(h, 'burst'); assert.equal(pulses, 1, 'burst must be a one-frame pulse'); assert.equal(h.state.visible, false);
  h.hold(null, 3); atStage(h, 'burst');
  h.hold(hand('open'), .4); h.hold(hand('fist'), .4); atStage(h, 'burst'); assert.equal(h.state.visible, false);
  h.reset(); atStage(h, 'idle'); assert.equal(h.state.visible, false); assert.equal(h.state.held, false);
  summon(h); atStage(h, 'star');
});

await check('tracking-loss', '丢手不会合成释放、套锅或长距离挥手', () => {
  const h = moon(); const target = { ...h.state.target };
  h.hold(hand('pinch', target.x, target.y), .24); atStage(h, 'moonHeld');
  const frozen = { ...h.state.target }; h.hold(null, .5); atStage(h, 'moonHeld'); samePoint(h.state.target, frozen, 'loss freezes held moon');
  h.hold(hand('pinch', .02, .02), .4); atStage(h, 'moonHeld'); samePoint(h.state.target, frozen, 'far hand cannot teleport held moon after loss');
  h.hold(hand('pinch', frozen.x, frozen.y), .24);
  h.move('pinch', frozen, { x: .79, y: .67 }, .6); h.hold(hand('open', .79, .67), .24); atStage(h, 'moonReleased');
  const p = phases(h); const anchor = { ...p.state.phaseAnchor };
  p.hold(hand('pinch', anchor.x, anchor.y), .24); p.move('pinch', anchor, { x: .25, y: .25 }, .8); atStage(p, 'phaseHeld');
  p.hold(null, 1); atStage(p, 'phaseHeld');

  const star = summon(harness());
  star.hold(hand('open', .1), .4); star.hold(null, 1); star.hold(hand('open', .85), .4); atStage(star, 'star');

  const pot = pan();
  pot.hold(hand('fist', .25, .25), .24); pot.hold(null, .6); pot.hold(hand('open', .25, .25), .4); atStage(pot, 'pan');
});

await check('threshold-noise', '单帧拳/捏合噪声和微小横向抖动不能触发动作', () => {
  const h = harness(); h.hold(hand('open'), .4);
  for (let i = 0; i < 10; i++) { h.frame(hand('fist'), .02); h.frame(hand('open'), .06); }
  atStage(h, 'idle'); summon(h);
  for (let i = 0; i < 40; i++) h.frame(hand('open', .35 + (i % 2 ? .012 : -.012), .6));
  atStage(h, 'star');
  const m = moon(); const target = { ...m.state.target };
  for (let i = 0; i < 10; i++) { m.frame(hand('pinch', target.x, target.y), .02); m.frame(hand('open', target.x, target.y), .06); }
  atStage(m, 'moon');

  const released = releaseMoon(); const anchor = { ...released.state.target };
  for (let i = 0; i < 80; i++) released.frame(hand('open', anchor.x + (i % 2 ? .008 : -.008), anchor.y));
  atStage(released, 'moonReleased');
  assert.equal(released.state.phaseProgress, 0, 'tiny repeated jitter must not accumulate into a moon-phase pull');
  for (let i = 0; i < 40; i++) {
    released.frame(hand('point', anchor.x, anchor.y));
    released.frame(hand('open', anchor.x + .008, anchor.y));
    released.frame(hand('open', anchor.x - .008, anchor.y));
  }
  atStage(released, 'moonReleased');
  assert.equal(released.state.phaseProgress, 0, 'intermittent open-palm recognition must not ratchet tiny movements into phases');
});

await check('tick-without-observation', '渲染tick不能把单帧或过期手势补成稳定握拳/横挥', () => {
  const idle = harness(); idle.frame(hand('open'));
  for (let i = 0; i < 60; i++) idle.tick();
  idle.frame(hand('fist'));
  for (let i = 0; i < 60; i++) idle.tick();
  atStage(idle, 'idle'); assert.equal(idle.state.tracked, false);

  const star = summon(harness()); star.hold(hand('open', .15), .4);
  for (let i = 0; i < 60; i++) star.tick();
  star.frame(hand('open', .85));
  for (let i = 0; i < 60; i++) star.tick();
  atStage(star, 'star');

  const held = moon(); const target = { ...held.state.target };
  held.hold(hand('pinch', target.x, target.y), .24); atStage(held, 'moonHeld');
  held.tick(.3); assert.equal(held.state.tracked, false); assert.equal(held.state.interaction, 'reacquire');
  held.frame(hand('open', .85, .2)); atStage(held, 'moonHeld'); samePoint(held.state.target, target, 'expired held observation must freeze moon');
});

await check('tick-animation', 'tick独立推进锅落位/长大动画，爆散脉冲不重复', () => {
  const h = pan(); const settled = { ...h.state.target }; const before = h.state.panProgress;
  h.tick(.12); assert.ok(h.state.panProgress > before, 'pan growth should animate without a new hand observation');
  h.tick(.6); assert.equal(h.state.panProgress, 1); samePoint(h.state.target, settled, 'animation cannot move settled pan center');
  h.hold(hand('fist', settled.x, settled.y - .08), .24);
  h.frame(hand('open', settled.x, settled.y - .08)); atStage(h, 'burst'); assert.equal(h.state.burst, true);
  const bursts = h.events.filter(event => event.type === 'burst').length;
  for (let i = 0; i < 90; i++) { h.tick(); assert.equal(h.state.burst, false); }
  assert.equal(h.events.filter(event => event.type === 'burst').length, bursts, 'tick must not emit another burst');
  assert.equal(bursts, 1); atStage(h, 'burst'); assert.equal(h.state.visible, false);
});

await check('reset', '各抓取/展示阶段重置后无旧锚点、旧抓取或爆散', () => {
  for (const build of [moon, releaseMoon, phases, pan]) {
    const h = build(); h.reset(); atStage(h, 'idle');
    assert.equal(h.state.visible, false); assert.equal(h.state.held, false); assert.equal(h.state.phaseProgress, 0); assert.equal(h.state.burst, false);
    h.hold(hand('open'), .3); atStage(h, 'idle'); summon(h); atStage(h, 'star');
  }
});

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
report.status = checks.every(check => check.passed) ? 'passed-synthetic-sequence-validation' : 'failed-synthetic-sequence-validation';
report.test_command = 'node tests/gesture-sequence.test.mjs';
report.test_results = checks;
report.summary = { total: checks.length, passed: checks.filter(check => check.passed).length, failed: checks.filter(check => !check.passed).length };
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`${report.summary.passed}/${report.summary.total} interaction checks passed.`);
if (report.summary.failed) process.exitCode = 1;
