import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { GestureSequence } from '../public/gesture-sequence.js';

// Behavioral fixtures informed by source frames 513–517 and 548–552: the
// wrist moves little while the finger direction turns roughly 80–90 degrees.
// These exercise the public controller API, not real webcam recognition.
const checks = [];
const radians = degrees => degrees * Math.PI / 180;

function harness({ aspectRatio = 16 / 9, handSize = .075, switchDirection = 1,
  target = { x: .5, y: .5 } } = {}) {
  const events = [];
  const sequence = new GestureSequence({ onEvent: event => events.push(event) });
  let t = 0;
  let state = sequence.reset(t);
  const h = {
    sequence, events, aspectRatio, handSize, switchDirection,
    get t() { return t; },
    get state() { return state; },
    frame(input, dt = 1 / 30) { t += dt; state = sequence.update(input, t); return state; },
    hold(input, duration = .6) {
      const frames = Math.ceil(duration * 30);
      for (let i = 0; i < frames; i++) this.frame(input, duration / frames);
      return state;
    },
    pose(angle = -130, { progress = 0, kind = 'open', xOffset = 0, yOffset = 0 } = {}) {
      const size = handSize;
      const a = radians(angle);
      const wrist = {
        x: state.target.x + switchDirection * progress * size * .10 + xOffset,
        y: state.target.y + size * 1.4 * aspectRatio + yOffset,
      };
      const offset = (length, rotation = 0) => ({
        x: wrist.x + switchDirection * Math.cos(a + rotation) * size * length,
        y: wrist.y + Math.sin(a + rotation) * size * length * aspectRatio,
      });
      const index = offset(2.2);
      const thumb = offset(1.4, .50);
      const palm = offset(.45);
      const fingers = kind === 'open'
        ? { thumb: true, index: true, middle: true, ring: true, pinky: true }
        : kind === 'victory'
          ? { thumb: false, index: true, middle: true, ring: false, pinky: false }
          : { thumb: true, index: true, middle: false, ring: false, pinky: false };
      return {
        source: 'camera', wrist, index, thumb, palm,
        pinchCenter: { x: (index.x + thumb.x) / 2, y: (index.y + thumb.y) / 2 },
        handSize: size, aspectRatio, switchDirection, orbRadius: size * .8,
        pinch: false, fist: false, pinchStrength: 0,
        openPalm: kind === 'open', pointing: kind === 'index-thumb',
        victory: kind === 'victory', fingerStates: fingers,
        extendedFingers: Object.values(fingers).filter(Boolean).length,
        spread: kind === 'open' ? 1 : 0,
      };
    },
    flick({ from = -130, to = -45, duration = .18, frames = 6,
      kind = 'open', xOffset = 0, yOffset = 0, missing = [] } = {}) {
      for (let i = 1; i <= frames; i++) {
        const p = i / frames;
        this.frame(missing.includes(i) ? null : this.pose(from + (to - from) * p,
          { progress: p, kind, xOffset, yOffset }), duration / frames);
      }
      return state;
    },
    prepare(angle = -130, options = {}) { this.hold(this.pose(angle, options), .6); return this; },
  };
  const fistPoint = { x: target.x - .018, y: target.y - .035 };
  h.hold({ source: 'camera', palm: fistPoint, wrist: fistPoint,
    index: fistPoint, thumb: fistPoint, pinchCenter: fistPoint,
    fist: true, pinch: false, openPalm: false, handSize, aspectRatio,
    switchDirection, orbRadius: handSize * .8,
    fingerStates: { thumb: false, index: false, middle: false, ring: false, pinky: false },
  }, .34);
  assert.equal(h.state.stage, 'star', 'the fixture must summon through the public API');
  return h;
}

const stage = (h, expected, detail = '') => assert.equal(h.state.stage, expected,
  `${detail || 'stage'} at ${h.t.toFixed(3)} s`);

function check(id, description, fn) {
  try { fn(); checks.push({ id, description, passed: true }); console.log(`PASS ${id}: ${description}`); }
  catch (error) { checks.push({ id, description, passed: false, error: error.message }); console.error(`FAIL ${id}: ${description}\n${error.stack}`); }
}

check('local-wrist-flick', '小幅腕/掌位移，局部指尖快速转约85°即可由星切日', () => {
  const h = harness().prepare();
  const start = h.pose(-130);
  const end = h.pose(-45, { progress: 1 });
  assert.ok(Math.abs(end.wrist.x - start.wrist.x) < .01);
  assert.ok(Math.abs(end.palm.x - start.palm.x) < .06);
  h.flick(); stage(h, 'sun');
});

check('one-flick-one-stage', '同向继续甩或保持结束姿态不会连续跳过太阳', () => {
  const h = harness().prepare(); h.flick(); stage(h, 'sun');
  h.flick({ from: -45, to: 20, duration: .3 });
  h.hold(h.pose(20, { progress: 1 }), 1); stage(h, 'sun');
  assert.equal(h.events.filter(event => event.type === 'mode' && event.mode === 'sun').length, 1);
  assert.equal(h.events.filter(event => event.type === 'mode' && event.mode === 'moon').length, 0);
});

check('local-return-rearms', '仅回摆局部腕向即可准备第二次，不必把掌心移回固定左侧', () => {
  const h = harness().prepare(); h.flick(); stage(h, 'sun');
  h.hold(h.pose(-45, { progress: 1 }), .5);
  h.flick({ from: -45, to: -130, duration: .20 }); stage(h, 'sun');
  h.hold(h.pose(-130), .12); h.flick({ kind: 'index-thumb' }); stage(h, 'moon');
});

check('index-thumb-flick', '拇食指伸出、其他指弯曲时同样接受源片甩腕动作', () => {
  const h = harness().prepare(-130, { kind: 'index-thumb' });
  h.flick({ kind: 'index-thumb' }); stage(h, 'sun');
});

check('no-translation-only', '摄像头下大幅横移但局部指向不变不冒充翻腕', () => {
  const h = harness({ handSize: .055 }).prepare(-90, { xOffset: -.3 });
  for (let i = 1; i <= 12; i++) h.frame(h.pose(-90, { xOffset: -.3 + .6 * i / 12 }), .03);
  stage(h, 'star');
});

check('no-static-pose', '静态开掌、V或拇食指姿态都不会触发切换', () => {
  for (const kind of ['open', 'victory', 'index-thumb']) {
    const h = harness().prepare(-90, { kind });
    h.hold(h.pose(-90, { kind }), 2); stage(h, 'star', kind);
  }
});

check('no-reverse-flick', '与契约相反的翻腕只属于回手，不切换', () => {
  for (const switchDirection of [1, -1]) {
    const h = harness({ switchDirection }).prepare(-45);
    h.flick({ from: -45, to: -130 }); stage(h, 'star');
  }
});

check('no-far-flick', '离天体很远的局部翻腕不误触', () => {
  const h = harness({ handSize: .055 }).prepare(-130, { xOffset: .38 });
  h.flick({ xOffset: .38 }); stage(h, 'star');
});

check('no-slow-turn', '缓慢转腕不是短促甩动', () => {
  const h = harness().prepare();
  h.flick({ duration: 1.8, frames: 54 }); stage(h, 'star');
});

check('no-single-frame-jump', '单帧方向突变后静止，不以时间补足伪造甩腕', () => {
  const h = harness().prepare();
  h.frame(h.pose(-45, { progress: 1 }), 1 / 30);
  h.hold(h.pose(-45, { progress: 1 }), .45); stage(h, 'star');
});

check('short-dropout', '一次短漏检仍可连接真实观测到的快速翻腕', () => {
  const h = harness().prepare();
  h.flick({ duration: .20, frames: 6, missing: [3] }); stage(h, 'sun');
});

check('long-dropout', '长时间失联后在结束姿态重新出现不会补造动作', () => {
  const h = harness().prepare();
  h.hold(null, .30);
  h.hold(h.pose(-45, { progress: 1 }), .45); stage(h, 'star');
});

check('size-aspect-mirror-invariance', '相同物理翻腕在不同掌大小、画幅和镜像设置下结果一致', () => {
  for (const aspectRatio of [16 / 9, 4 / 3, 9 / 16]) {
    for (const handSize of [.035, .075, .11]) {
      for (const switchDirection of [1, -1]) {
        const h = harness({ aspectRatio, handSize, switchDirection }).prepare();
        h.flick(); stage(h, 'sun', JSON.stringify({ aspectRatio, handSize, switchDirection }));
      }
    }
  }
});

check('mouse-translation-compatible', '鼠标仍可用平移轨迹模拟甩动', () => {
  const h = harness({ handSize: .055 });
  const input = x => {
    const p = h.pose(-90);
    const dx = x - p.palm.x;
    for (const key of ['palm', 'index', 'thumb', 'pinchCenter', 'wrist']) p[key].x += dx;
    p.source = 'mouse';
    return p;
  };
  h.hold(input(.18), .6);
  for (let i = 1; i <= 12; i++) h.frame(input(.18 + .60 * i / 12), .03);
  stage(h, 'sun');
});

check('source-observation-window', '原片可用观测的短翻腕窗口能触发；烘焙画面漏检不等于真人验证', () => {
  const replay = JSON.parse(fs.readFileSync(new URL('../analysis/source-gesture-replay.json', import.meta.url), 'utf8'));
  // Both windows begin before and end just after the visible source transition.
  // Keep original observation gaps and coordinates; never interpolate missing hands.
  for (const [first, last] of [[509, 521], [545, 557]]) {
    const samples = replay.samples.filter(sample => sample.frameNumber >= first && sample.frameNumber <= last);
    assert.ok(samples.length >= 5, `missing source observation fixture ${first}–${last}`);
    const h = harness({ target: { x: .505, y: .76 } });
    const observed = sample => {
      const landmarks = sample.hands?.[0]?.landmarks;
      if (!landmarks || !sample.input) return null;
      const wrist = landmarks[0], middle = landmarks[9];
      return { ...sample.input, source: 'camera', wrist,
        aspectRatio: 16 / 9, switchDirection: 1, orbRadius: 67 / 1280,
        handSize: Math.hypot(middle.x - wrist.x, (middle.y - wrist.y) / (16 / 9)),
      };
    };
    h.hold(observed(samples[0]), .6);
    for (let i = 1; i < samples.length; i++) {
      h.frame(observed(samples[i]), (samples[i].frameNumber - samples[i - 1].frameNumber) / 30);
    }
    stage(h, 'sun', `source frames ${first}–${last}`);
  }
});

const failed = checks.filter(check => !check.passed).length;
const report = {
  tested_at: new Date().toISOString(),
  purpose: 'Public-API synthetic behavioral acceptance plus two local source-observation replays; no real camera accuracy claim.',
  source_sha256: Object.fromEntries(['public/gesture-sequence.js', 'analysis/source-gesture-replay.json'].map(file =>
    [file, createHash('sha256').update(fs.readFileSync(new URL(`../${file}`, import.meta.url))).digest('hex')])),
  source_windows: [[509, 521], [545, 557]],
  summary: { total: checks.length, passed: checks.length - failed, failed }, checks,
};
fs.writeFileSync(new URL('../analysis/flick-gesture-validation.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
console.log(`${checks.length - failed}/${checks.length} wrist-flick checks passed.`);
if (failed) process.exitCode = 1;
