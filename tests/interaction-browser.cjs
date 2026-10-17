// HISTORICAL SNAPSHOT: superseded by revision-browser.cjs. UI selectors and pan interpretation belong to the earlier revision.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('/Users/bornforthis/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const baseURL = process.env.INTERACTION_TEST_URL || 'http://localhost:5173/';
const checks = [], pageErrors = [], httpErrors = [], externalFailures = [];
const states = [], screenshots = [];
let browser;

async function check(id, name, fn) {
  try { await fn(); checks.push({ id, name, passed: true }); console.log(`PASS ${id}: ${name}`); }
  catch (error) { checks.push({ id, name, passed: false, error: error.message }); console.error(`FAIL ${id}: ${name}\n${error.stack}`); }
}
function observe(page, label) {
  page.on('pageerror', error => pageErrors.push({ page: label, error: error.message }));
  page.on('response', response => { if (response.status() >= 400) httpErrors.push({ page: label, status: response.status(), url: response.url() }); });
  page.on('requestfailed', request => {
    if (!request.url().startsWith(baseURL) && !request.failure()?.errorText.includes('ABORTED'))
      externalFailures.push({ page: label, url: request.url(), error: request.failure()?.errorText });
  });
}
async function openPage(context, label) {
  const page = await context.newPage(); observe(page, label);
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.palmUniverse?.scene));
  return page;
}
async function state(page, label) {
  const value = await page.evaluate(() => {
    const scene = window.palmUniverse.scene;
    return {
      snapshot: scene.sequenceSnapshot,
      mode: scene.mode, target: scene.target, position: scene.position,
      down: scene.down, sequenceEnabled: scene.sequenceEnabled, camera: scene.camera,
      rehearsal: scene.rehearsal, particles: scene.particles.length,
      dissolved: scene.dissolved, handSerial: scene.handSerial || 0,
      lastSequenceSerial: scene.lastSequenceSerial,
      hint: document.querySelector('#gesture-hint').textContent,
      status: document.querySelector('#status-text').textContent,
      disabledModes: Array.from(document.querySelectorAll('.mode')).filter(button => button.disabled).length,
      restartHidden: document.querySelector('#restart').hidden,
    };
  });
  if (label) states.push({ label, ...value });
  return value;
}
async function stage(page, expected, label = expected) {
  await page.waitForFunction(expected => window.palmUniverse.scene.sequenceSnapshot?.stage === expected, expected, { timeout: 2500 });
  const result = await state(page, label);
  assert.equal(result.snapshot.stage, expected);
  return result;
}
function samePoint(actual, expected, message) {
  assert.ok(actual && expected, `${message}: missing point`);
  assert.ok(Math.abs(actual.x - expected.x) < .004 && Math.abs(actual.y - expected.y) < .004,
    `${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}
async function pointer(page, x, y) {
  const rect = await page.locator('#universe').boundingBox();
  await page.mouse.move(rect.x + x * rect.width, rect.y + y * rect.height);
}
async function move(page, from, to, seconds = .4) {
  const n = Math.max(2, Math.ceil(seconds / .035));
  for (let i = 1; i <= n; i++) {
    const p = i / n;
    await pointer(page, from.x + (to.x - from.x) * p, from.y + (to.y - from.y) * p);
    await page.waitForTimeout(seconds * 1000 / n);
  }
}
async function verifyPhasesDrawing(page) {
  const drawing = await page.evaluate(() => {
    const scene = window.palmUniverse.scene, calls = [], original = scene.drawMoon;
    scene.drawMoon = function(x, y, r, texture, alpha) {
      calls.push({ x: x / scene.w, y: y / scene.h, r, texture: scene.textures.indexOf(texture), alpha });
      return original.call(this, x, y, r, texture, alpha);
    };
    try { scene.draw(); } finally { scene.drawMoon = original; }
    return { calls, anchor: scene.sequenceSnapshot.phaseAnchor, progress: scene.sequenceSnapshot.phaseProgress };
  });
  assert.equal(drawing.calls.length, 5, 'fully unfolded drawing must have exactly five moons');
  assert.ok(drawing.calls.every(call => Math.abs(call.y - drawing.anchor.y) < .001), 'all five phases must stay at release height');
  assert.deepEqual(drawing.calls.map(call => call.texture), [8, 7, 6, 5, 4], 'phases must progress from dark/right crescent to full moon');
  samePoint(drawing.calls[4], drawing.anchor, 'rightmost full moon must remain at release anchor');
  for (let i = 1; i < 5; i++) assert.ok(drawing.calls[i].x > drawing.calls[i - 1].x, 'phase order must run left to right');
  return drawing;
}
async function saveScreenshot(page, name) {
  const output = path.join(root, 'analysis', name);
  await page.screenshot({ path: output, fullPage: true }); screenshots.push(output);
}

const trackerMock = `
export class HandTracker {
  constructor(options = {}) { Object.assign(this, options); window.__mockHandTracker = this; this.starts = 0; this.stops = 0; }
  async start(video) {
    this.starts++; Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1280 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 720 });
    this.onStatus?.({ state: 'running', message: 'Synthetic test tracker' }); return this;
  }
  stop() { this.stops++; }
}`;

async function emitHand(page, kind, x = .35, y = .60, overrides = {}) {
  await page.evaluate(({ kind, x, y, overrides }) => {
    const scene = window.palmUniverse.scene;
    const width = 1280, height = 720, scale = Math.max(scene.w / width, scene.h / height);
    const vw = width * scale, vh = height * scale;
    const inverse = (sx, sy) => ({ x: 1 - (sx * scene.w - (scene.w - vw) / 2) / vw, y: (sy * scene.h - (scene.h - vh) / 2) / vh, z: 0 });
    const fingers = kind === 'open'
      ? { thumb: true, index: true, middle: true, ring: true, pinky: true }
      : kind === 'fist'
        ? { thumb: false, index: false, middle: false, ring: false, pinky: false }
        : { thumb: true, index: true, middle: false, ring: false, pinky: false };
    const gap = kind === 'open' ? .17 : kind === 'l' ? .18 : kind === 'pinch' ? .012 : kind === 'fist' ? .035 : .07;
    const points = Array.from({ length: 21 }, () => inverse(x, y + .03));
    points[0] = inverse(x, y + .10); points[9] = inverse(x, y + .015);
    points[4] = inverse(x + gap / 2, y); points[8] = inverse(x - gap / 2, y);
    const gestures = {
      pinch: kind === 'pinch', pinchStrength: kind === 'pinch' ? .94 : kind === 'c' ? .3 : 0,
      openPalm: kind === 'open', fist: kind === 'fist', pointing: kind === 'l', victory: false,
      spread: kind === 'open' ? .9 : 0,
      fingerStates: fingers, palmCenter: inverse(x, y + .08), pinchCenter: inverse(x, y),
      fingertip: points[8], extendedFingers: Object.values(fingers).filter(Boolean).length,
      ...overrides,
    };
    window.__mockHandTracker.onResults({ hands: [{ landmarks: points, gestures, handedness: 'Right', score: .99 }], timestamp: performance.now() });
  }, { kind, x, y, overrides });
}
async function holdHand(page, kind, x, y, seconds = .28, overrides = {}) {
  const n = Math.ceil(seconds / .04);
  for (let i = 0; i < n; i++) { await emitHand(page, kind, x, y, overrides); await page.waitForTimeout(seconds * 1000 / n); }
}
async function moveHand(page, kind, from, to, seconds = .5) {
  const n = Math.ceil(seconds / .04);
  for (let i = 1; i <= n; i++) {
    const p = i / n;
    await emitHand(page, kind, from.x + (to.x - from.x) * p, from.y + (to.y - from.y) * p);
    await page.waitForTimeout(seconds * 1000 / n);
  }
}

(async () => {
  browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const page = await openPage(desktop, 'desktop-pointer');

  await check('pointer-full-sequence', '桌面真实鼠标事件按原片动作完成空场→星→日→月→五相→锅→爆散', async () => {
    await page.locator('#demo-toggle').click();
    let result = await stage(page, 'idle', 'pointer-start-empty');
    assert.equal(result.mode, null); assert.equal(result.disabledModes, 5); assert.equal(result.restartHidden, false);
    await page.keyboard.press('5'); await page.keyboard.press('b'); await page.mouse.dblclick(500, 500); await page.waitForTimeout(100);
    result = await state(page); assert.equal(result.snapshot.stage, 'idle'); assert.equal(result.mode, null);
    await pointer(page, .35, .6); await page.waitForTimeout(250);
    await page.mouse.down(); await page.waitForTimeout(220); await stage(page, 'star', 'pointer-star'); await page.mouse.up();
    await pointer(page, .20, .6); await page.waitForTimeout(500);
    await move(page, { x: .20, y: .6 }, { x: .75, y: .6 }, .4); await stage(page, 'sun', 'pointer-sun');
    await move(page, { x: .75, y: .6 }, { x: .20, y: .6 }, .45); await page.waitForTimeout(180);
    await move(page, { x: .20, y: .6 }, { x: .75, y: .6 }, .4); result = await stage(page, 'moon', 'pointer-moon');
    const moon = result.snapshot.target;
    await pointer(page, moon.x, moon.y); await page.mouse.down(); await page.waitForTimeout(220); await stage(page, 'moonHeld', 'pointer-moon-held');
    await move(page, moon, { x: .79, y: .67 }, .7); await page.mouse.up(); await page.waitForTimeout(180);
    result = await stage(page, 'moonReleased', 'pointer-moon-released'); const anchor = { ...result.snapshot.target };
    samePoint(anchor, { x: .79, y: .67 }, 'moon must release at actual pointer position');
    await move(page, anchor, { x: anchor.x, y: anchor.y - .15 }, .35); await page.waitForTimeout(100);
    result = await state(page); assert.equal(result.snapshot.stage, 'moonReleased'); samePoint(result.snapshot.target, anchor, 'released moon cannot follow departing pointer');
    await pointer(page, anchor.x, anchor.y); await page.waitForTimeout(80);
    await move(page, anchor, { x: .10, y: anchor.y }, .8); await stage(page, 'phases', 'pointer-five-phases');
    await verifyPhasesDrawing(page); await saveScreenshot(page, 'preview-interaction-sequence.png');
    await move(page, { x: .10, y: anchor.y }, anchor, .5); await page.mouse.down(); await page.waitForTimeout(220); await stage(page, 'phaseHeld', 'pointer-phases-collected');
    await move(page, anchor, { x: .25, y: .25 }, .8); await page.waitForTimeout(260); await stage(page, 'phaseHeld', 'pointer-raised-still-held');
    await page.mouse.up(); await page.waitForTimeout(200); result = await stage(page, 'pan', 'pointer-pan-drop');
    samePoint(result.snapshot.panOrigin, { x: .25, y: .25 }, 'pan drop must start at raised pointer release');
    assert.ok(result.target.x < .25 && result.target.y > .25, 'pan must settle below-left of raised pointer');
    const settled = { ...result.target }; await page.waitForTimeout(550);
    await pointer(page, settled.x, settled.y); await page.mouse.down(); await page.waitForTimeout(180); await page.mouse.up();
    result = await stage(page, 'burst', 'pointer-burst'); assert.equal(result.mode, null); assert.ok(result.particles > 0, 'burst must produce visible particles');
    await page.waitForTimeout(4300); result = await state(page, 'pointer-finale-empty');
    assert.equal(result.snapshot.stage, 'burst'); assert.equal(result.mode, null); assert.equal(result.particles, 0);
    await page.locator('#restart').click(); result = await stage(page, 'idle', 'pointer-reset');
    assert.equal(result.mode, null); assert.equal(result.snapshot.held, false); assert.equal(result.disabledModes, 5);
  });

  const permission = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await permission.addInitScript(() => {
    window.__cameraRequests = 0;
    navigator.mediaDevices.getUserMedia = async () => { window.__cameraRequests++; throw new DOMException('Permission denied by browser test', 'NotAllowedError'); };
  });
  const denied = await openPage(permission, 'camera-permission-denied');
  await check('camera-denied-retry', '摄像头拒绝权限与重试均恢复可操作状态，未请求真实摄像头', async () => {
    for (let i = 1; i <= 2; i++) {
      await denied.locator('#camera-toggle').click();
      await denied.waitForFunction(count => window.__cameraRequests === count && !document.querySelector('#camera-toggle').disabled, i);
      assert.equal(await denied.locator('#camera-label').textContent(), '开启摄像头');
      assert.match(await denied.locator('#toast').textContent(), /权限未开启/);
      const result = await state(denied); assert.equal(result.camera, false); assert.equal(result.sequenceEnabled, false);
    }
  });

  const cameraContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await cameraContext.addInitScript(() => {
    window.__realCameraRequests = 0;
    navigator.mediaDevices.getUserMedia = async () => { window.__realCameraRequests++; throw new Error('Real camera access forbidden in test'); };
  });
  await cameraContext.route('**/public/hand-tracking.js', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: trackerMock }));
  const camera = await openPage(cameraContext, 'camera-synthetic-results');
  await camera.locator('#camera-toggle').click(); await stage(camera, 'idle', 'camera-start-empty');

  await check('camera-observation-serial', '摄像头单帧握拳不会因渲染循环重复计时而召星，过期观察不触发动作', async () => {
    await holdHand(camera, 'open', .35, .6, .28);
    await emitHand(camera, 'fist', .35, .6); await camera.waitForTimeout(400);
    let result = await stage(camera, 'idle', 'camera-stale-one-frame-fist'); assert.equal(result.snapshot.tracked, false);
    await holdHand(camera, 'open', .35, .6, .28); await holdHand(camera, 'fist', .35, .6, .28);
    result = await stage(camera, 'star', 'camera-fresh-fist-star'); assert.ok(result.handSerial > 5);
    await holdHand(camera, 'open', .15, .6, .5); await camera.waitForTimeout(400);
    await emitHand(camera, 'open', .85, .6); await camera.waitForTimeout(100);
    result = await state(camera); assert.equal(result.snapshot.stage, 'star', 'far observation after a stall cannot form a swipe');
    assert.equal(await camera.evaluate(() => window.__realCameraRequests), 0);
  });

  await check('camera-synthetic-sequence', '合成模型结果经过app回调、映射与serial机制完成原片全流程', async () => {
    await camera.locator('#restart').click(); await stage(camera, 'idle');
    await camera.keyboard.press('5'); await camera.keyboard.press('b'); await camera.mouse.dblclick(500, 500);
    let result = await state(camera); assert.equal(result.snapshot.stage, 'idle'); assert.equal(result.disabledModes, 5);
    await holdHand(camera, 'open', .35, .6, .28); await holdHand(camera, 'fist', .35, .6, .28); await stage(camera, 'star');
    await holdHand(camera, 'open', .20, .6, .5); await moveHand(camera, 'open', { x: .20, y: .6 }, { x: .75, y: .6 }, .4); await stage(camera, 'sun');
    await moveHand(camera, 'open', { x: .75, y: .6 }, { x: .20, y: .6 }, .5); await holdHand(camera, 'open', .20, .6, .16);
    await moveHand(camera, 'open', { x: .20, y: .6 }, { x: .75, y: .6 }, .4); result = await stage(camera, 'moon');
    const moon = result.snapshot.target;
    await holdHand(camera, 'pinch', .02, .02, .24); await stage(camera, 'moon');
    await holdHand(camera, 'c', moon.x, moon.y, .24); await stage(camera, 'moonHeld');
    await holdHand(camera, 'pinch', moon.x, moon.y, .2, { pinchStrength: .45 }); const loose = (await state(camera)).snapshot.scale;
    await holdHand(camera, 'pinch', moon.x, moon.y, .2, { pinchStrength: .97 }); const tight = (await state(camera)).snapshot.scale;
    assert.ok(tight < loose, 'camera pinch strength must scale moon down');
    await moveHand(camera, 'pinch', moon, { x: .79, y: .67 }, .8); await holdHand(camera, 'open', .79, .67, .24);
    result = await stage(camera, 'moonReleased', 'camera-release-anchor'); const anchor = { ...result.target };
    samePoint(anchor, { x: .79, y: .67 }, 'mirrored camera mapping must release at expected screen coordinates');
    await holdHand(camera, 'open', anchor.x, anchor.y, .25); await stage(camera, 'moonReleased');
    await moveHand(camera, 'open', anchor, { x: .10, y: anchor.y }, .9); await stage(camera, 'phases'); await verifyPhasesDrawing(camera);
    await holdHand(camera, 'pinch', anchor.x, anchor.y, .24); await stage(camera, 'phaseHeld');
    await moveHand(camera, 'pinch', anchor, { x: .25, y: .25 }, .8); await holdHand(camera, 'pinch', .25, .25, .3); await stage(camera, 'phaseHeld');
    await holdHand(camera, 'l', .25, .25, .24); result = await stage(camera, 'pan', 'camera-pan');
    samePoint(result.snapshot.panOrigin, { x: .25, y: .25 }, 'camera L release must originate at last gripping point'); const settled = { ...result.target };
    await holdHand(camera, 'pinch', settled.x, settled.y, .25); await moveHand(camera, 'pinch', settled, { x: .85, y: .75 }, .8);
    result = await stage(camera, 'pan'); samePoint(result.target, settled, 'camera pinch cannot regrab or drag settled pan');
    await holdHand(camera, 'fist', settled.x, settled.y - .08, .25); await holdHand(camera, 'open', settled.x, settled.y - .08, .20);
    result = await stage(camera, 'burst', 'camera-burst'); assert.equal(result.mode, null); assert.ok(result.particles > 0);
    await holdHand(camera, 'open', .35, .6, .25); await holdHand(camera, 'fist', .35, .6, .25); await stage(camera, 'burst');
    assert.equal(await camera.evaluate(() => window.__realCameraRequests), 0);
    await camera.locator('#camera-toggle').click(); result = await state(camera); assert.equal(result.camera, false); assert.equal(result.sequenceEnabled, false);
  });

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const mobile = await openPage(mobileContext, 'mobile-layout');
  await check('mobile-layout', '390×844手机布局无水平溢出，排练与重来入口可见', async () => {
    await mobile.locator('#demo-toggle').click(); await stage(mobile, 'idle');
    const metrics = await mobile.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(metrics.scrollWidth <= metrics.width, 'mobile page must not overflow horizontally');
    for (const selector of ['#camera-toggle', '#restart', '#demo-toggle', '#music-toggle', '#replace-music']) {
      const box = await mobile.locator(selector).boundingBox();
      assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= metrics.width + 1 && box.y + box.height <= metrics.height + 1, `${selector} must be visible within mobile viewport`);
    }
    await saveScreenshot(mobile, 'preview-interaction-mobile.png');
  });

  await check('browser-errors', '浏览器运行无JavaScript未捕获异常与HTTP 404/其他失败响应', async () => {
    assert.deepEqual(pageErrors, [], 'uncaught browser errors');
    assert.deepEqual(httpErrors, [], 'HTTP errors');
  });

  await browser.close(); browser = null;
})().catch(error => {
  checks.push({ id: 'browser-runner', name: 'Browser runner completed', passed: false, error: error.stack || error.message });
  console.error(error);
}).finally(async () => {
  if (browser) await browser.close();
  const report = {
    purpose: '浏览器开发验收：真实pointer事件和显式模型测试替身；无真实摄像头访问。',
    test_command: 'node tests/interaction-browser.cjs', base_url: baseURL,
    status: checks.every(check => check.passed) ? 'passed-browser-development-validation' : 'failed-browser-development-validation',
    summary: { total: checks.length, passed: checks.filter(check => check.passed).length, failed: checks.filter(check => !check.passed).length },
    test_results: checks, page_errors: pageErrors, http_errors: httpErrors, external_request_failures: externalFailures,
    screenshots, recorded_states: states,
    limitations: [
      '摄像头成功流程用显式HandTracker测试替身输入合成模型结果，未验证真实模型识别准确率或真实摄像头画质。',
      '摄像头权限拒绝使用getUserMedia测试替身；成功mock路径禁止调用真实getUserMedia。',
      '手机此次仅验收布局与入口，不代表所有触屏手势或浏览器均已实测。',
    ],
  };
  fs.writeFileSync(path.join(root, 'analysis', 'interaction-browser-validation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.summary.passed}/${report.summary.total} browser checks passed.`);
  if (report.summary.failed) process.exitCode = 1;
});
