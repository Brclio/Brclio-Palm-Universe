import assert from 'node:assert/strict';
import test from 'node:test';
import { HandTracker } from '../public/hand-tracking.js';

// Synthetic detector output only: these checks exercise observation geometry,
// identity and timing. They never request a camera or run a recognition model.
const SHAPE = [
  [0, .08], [-.03, .055], [-.05, .035], [-.065, .01], [-.075, -.015],
  [-.04, 0], [-.045, -.04], [-.045, -.07], [-.045, -.095],
  [-.012, -.008], [-.012, -.055], [-.012, -.09], [-.012, -.12],
  [.017, 0], [.02, -.04], [.02, -.075], [.02, -.10],
  [.045, .014], [.05, -.015], [.05, -.045], [.05, -.07],
];

function syntheticHand(x, y = .5, { aspect = 16 / 9, scale = 1, label = 'Right' } = {}) {
  return {
    landmarks: SHAPE.map(([dx, dy]) => ({ x: x + dx * scale, y: y + dy * scale * aspect, z: 0 })),
    label,
  };
}

function harness(aspect = 16 / 9) {
  const results = [];
  const tracker = new HandTracker({ onResults: (result) => results.push(result) });
  tracker._video = { videoWidth: aspect * 720, videoHeight: 720 };
  return {
    tracker,
    send(hands, timestamp) {
      tracker._processResults({
        landmarks: hands.map((hand) => hand.landmarks),
        handedness: hands.map((hand) => [{ categoryName: hand.label }]),
      }, timestamp);
      return results.at(-1);
    },
  };
}

test('synthetic hands retain identity when detector output order changes', () => {
  const h = harness();
  const first = h.send([syntheticHand(.25), syntheticHand(.75, .5, { label: 'Left' })], 1000);
  const second = h.send([syntheticHand(.74, .5, { label: 'Left' }), syntheticHand(.26)], 1033);
  assert.notEqual(first.hands[0].id, first.hands[1].id);
  assert.equal(second.hands[0].id, first.hands[1].id);
  assert.equal(second.hands[1].id, first.hands[0].id);
});

test('handedness label changes during a palm turn do not replace identity', () => {
  const h = harness();
  const first = h.send([syntheticHand(.5)], 1000);
  const second = h.send([syntheticHand(.505, .5, { label: 'Left' })], 1033);
  assert.equal(second.hands[0].id, first.hands[0].id);
  assert.equal(second.hands[0].handedness, 'Left');
});

test('short detector gaps preserve identity without emitting invented hands', () => {
  const h = harness();
  const first = h.send([syntheticHand(.5)], 1000);
  assert.deepEqual(h.send([], 1100).hands, []);
  const returned = h.send([syntheticHand(.51)], 1167);
  assert.equal(returned.hands[0].id, first.hands[0].id);
});

test('a hand absent for 400 ms receives a new identity and unfiltered fresh size', () => {
  const h = harness();
  const first = h.send([syntheticHand(.5)], 1000);
  h.send([], 1200);
  const returned = h.send([syntheticHand(.5, .5, { scale: .65 })], 1400);
  assert.notEqual(returned.hands[0].id, first.hands[0].id);
  assert.equal(returned.hands[0].gestures.stableScreenHandSize, returned.hands[0].gestures.imagePalmSize);
});

test('capture timestamps are preserved separately from receipt time', () => {
  const h = harness();
  const before = performance.now();
  const result = h.send([syntheticHand(.5)], 1_234_567);
  const after = performance.now();
  assert.equal(result.timestamp, 1_234_567);
  assert.ok(result.receivedAt >= before && result.receivedAt <= after);
});

test('screen palm sizes use camera-width units for landscape and portrait sources', () => {
  const sizes = [16 / 9, 4 / 3, 9 / 16].map((aspect) => {
    const h = harness(aspect);
    return h.send([syntheticHand(.5, .5, { aspect })], 1000).hands[0].gestures;
  });
  for (const size of sizes) {
    for (const key of ['imagePalmSize', 'screenPalmLength', 'stableScreenHandSize']) {
      assert.ok(Number.isFinite(size[key]) && size[key] > .025 && size[key] < .2, `${key} is a plausible width-normalized palm size`);
      assert.ok(Math.abs(size[key] - sizes[0][key]) < 1e-12, `${key} preserves physical image geometry across aspect ratios`);
    }
  }
});

test('palm size filtering advances only with new capture time and converges', () => {
  const h = harness();
  const first = h.send([syntheticHand(.5)], 1000).hands[0];
  const turned = h.send([syntheticHand(.5, .5, { scale: .6 })], 1033).hands[0];
  assert.equal(turned.id, first.id);
  assert.ok(turned.gestures.imagePalmSize < turned.gestures.stableScreenHandSize);
  assert.ok(turned.gestures.stableScreenHandSize < first.gestures.stableScreenHandSize);
  const sameCaptureTime = h.send([syntheticHand(.5, .5, { scale: .6 })], 1033).hands[0];
  assert.equal(sameCaptureTime.gestures.stableScreenHandSize, turned.gestures.stableScreenHandSize);
  const settled = h.send([syntheticHand(.5, .5, { scale: .6 })], 1233).hands[0];
  assert.ok(Math.abs(settled.gestures.stableScreenHandSize - settled.gestures.imagePalmSize)
    < Math.abs(turned.gestures.stableScreenHandSize - turned.gestures.imagePalmSize) * .05);
});

test('degenerate synthetic geometry remains finite without a camera or world landmarks', () => {
  const h = harness();
  const result = h.send([{ landmarks: Array.from({ length: 21 }, () => ({ x: .5, y: .5, z: 0 })), label: 'Unknown' }], 1000);
  const g = result.hands[0].gestures;
  for (const key of ['imagePalmSize', 'screenPalmLength', 'stableScreenHandSize', 'pinchStrength']) assert.ok(Number.isFinite(g[key]), key);
  assert.ok(g.imagePalmSize > 0);
});
