// Full-window layout and original-camera-coordinate regression checks.
// Camera metadata is an explicit synthetic fixture. This never opens a webcam
// and does not claim to measure landmark accuracy on a real person's hand.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require('/Users/bornforthis/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const baseURL = process.env.INTERACTION_TEST_URL || 'http://127.0.0.1:5173/';
const sourceFiles = ['styles.css', 'index.html', 'app.js', 'public/scene.js', 'public/gesture-sequence.js', 'public/objects-3d.js'];
const hashes = () => Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const sourceSha256 = hashes();
const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'narrow-phone', width: 320, height: 568 },
  { name: 'landscape-phone', width: 844, height: 390 },
];
const sources = [
  { name: '16x9', width: 1920, height: 1080 },
  { name: '4x3', width: 1280, height: 960 },
  { name: '9x16', width: 1080, height: 1920 },
];
const checks = [], observations = [], screenshots = [], browserErrors = [], httpErrors = [];
let browser;
const near = (actual, expected, label, tolerance = 1.1) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}`);
const overlap = (a, b) => a.x < b.x + b.width - .5 && a.x + a.width > b.x + .5 && a.y < b.y + b.height - .5 && a.y + a.height > b.y + .5;
async function check(id, fn) {
  try { await fn(); checks.push({ id, passed: true }); console.log('PASS ' + id); }
  catch (error) { checks.push({ id, passed: false, error: error.stack }); console.error('FAIL ' + id + ': ' + error.message); }
}
function expectedContain(viewport, source) {
  const scale = Math.min(viewport.width / source.width, viewport.height / source.height);
  const width = source.width * scale, height = source.height * scale;
  return { x: (viewport.width - width) / 2, y: (viewport.height - height) / 2, width, height };
}
async function settleResize(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function stageGeometry(page) {
  return page.evaluate(() => {
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const s = window.palmUniverse.scene;
    return {
      window: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      stage: rect('#stage'), canvas: rect('#universe'), shell: rect('.stage-shell'),
      experience: rect('#experience'),
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      scene: { width: s.w, height: s.h, viewport: s.viewport },
      cameraObjectFit: getComputedStyle(document.querySelector('#camera')).objectFit,
    };
  });
}
function assertFullWindow(geometry, viewport) {
  for (const name of ['stage', 'canvas', 'shell', 'experience']) {
    near(geometry[name].x, 0, name + ' left'); near(geometry[name].y, 0, name + ' top');
    near(geometry[name].width, viewport.width, name + ' width');
    near(geometry[name].height, viewport.height, name + ' height');
  }
  assert.ok(geometry.scrollWidth <= viewport.width + 1, 'document must not scroll horizontally');
  assert.ok(geometry.scrollHeight <= viewport.height + 1, 'document must not scroll vertically');
}
async function mockCamera(page, source) {
  await page.evaluate(source => {
    const s = window.palmUniverse.scene, video = document.querySelector('#camera');
    Object.defineProperties(video, {
      videoWidth: { configurable: true, value: source.width },
      videoHeight: { configurable: true, value: source.height },
    });
    s.setCamera(true); s.video = video; s.resize();
    document.body.classList.add('camera-active', 'has-input');
  }, source);
  await settleResize(page);
}
async function mappingObservation(page, mirror) {
  return page.evaluate(mirror => {
    const s = window.palmUniverse.scene;
    // Exercise the existing mirror control, including its CSS-video update.
    if (s.mirror !== mirror) document.querySelector('#mirror-toggle').click();
    const anchors = [{ x: 0, y: 0 }, { x: .5, y: .5 }, { x: 1, y: 1 }].map(source => {
      const local = s.map(source);
      return { source, local, screen: { x: s.viewport.x + local.x, y: s.viewport.y + local.y } };
    });
    const transform = new DOMMatrix(getComputedStyle(document.querySelector('#camera')).transform);
    return {
      mirror: s.mirror, anchors, width: s.w, height: s.h, viewport: { ...s.viewport },
      videoScaleX: transform.a,
      rendererSize: { width: s.objects3d.width, height: s.objects3d.height },
    };
  }, mirror);
}
async function drawModelObservation(page) {
  return page.evaluate(() => {
    const s = window.palmUniverse.scene, renderer = s.objects3d;
    // Render the actual production draw path with an explicit expanded-phase
    // fixture. The controller's gesture progression is tested separately.
    s.mode = 'phases'; s.sequenceSnapshot = null; s.transition = null;
    s.appearAt = undefined; s.dissolved = false; s.tracking = false;
    s.grabbing = false; s.particles = []; s.position = { x: .5, y: .65 };
    s.orbScale = 1;
    let compositeTransform;
    const original = renderer.render;
    renderer.render = function (context) {
      const m = context.getTransform();
      compositeTransform = { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f };
      return original.call(this, context);
    };
    try { s.draw(); } finally { renderer.render = original; }
    const dpr = Math.min(devicePixelRatio || 1, 2);
    return {
      viewport: { ...s.viewport }, width: s.w, height: s.h, dpr,
      compositeTransform,
      objects: renderer.state.activeObjects,
      // Global alpha pixels prove the real WebGL composite lands inside the
      // camera rectangle, rather than only passing a coordinate-math test.
      samplePixels: renderer.state.activeObjects.map(object => {
        const globalX = s.viewport.x + object.x, globalY = s.viewport.y + object.y;
        const px = Math.min(s.canvas.width - 1, Math.max(0, Math.round(globalX * dpr)));
        const py = Math.min(s.canvas.height - 1, Math.max(0, Math.round(globalY * dpr)));
        return { x: globalX, y: globalY, alpha: s.ctx.getImageData(px, py, 1, 1).data[3] };
      }),
      glError: renderer.renderer.getContext().getError(),
    };
  });
}
async function hudObservation(page) {
  return page.evaluate(() => {
    const box = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const visible = el => { const r = el.getBoundingClientRect(), style = getComputedStyle(el); return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; };
    const controls = [...document.querySelectorAll('.topbar button,.topbar a,.stage-actions button,.music-controls button')].filter(visible).map(el => {
      const rect = box(el), atPoint = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return { id: el.id || el.className, rect, disabled: !!el.disabled, receivesPointer: atPoint === el || el.contains(atPoint) };
    });
    const hint = box(document.querySelector('.hint'));
    const hintTarget = document.elementFromPoint(hint.x + hint.width / 2, hint.y + hint.height / 2);
    return {
      topbar: box(document.querySelector('.topbar')),
      stageTop: box(document.querySelector('.stage-top')),
      bottom: box(document.querySelector('.bottom')),
      controls,
      hintPointerTarget: hintTarget?.id || hintTarget?.className || hintTarget?.tagName,
    };
  });
}

(async () => {
  browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: viewports[0].width, height: viewports[0].height } });
  await page.addInitScript(() => {
    window.__webcamRequests = 0;
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => {
      window.__webcamRequests++;
      throw new Error('This regression fixture must never request a real camera.');
    };
  });
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('console', message => { if (/WebGL.*(?:error|invalid)|Shader Error|VALIDATE_STATUS|shader.*compil/i.test(message.text())) browserErrors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) httpErrors.push(response.status() + ' ' + response.url()); });
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await page.evaluate(() => window.palmUniverse.scene.assetsReady);
  await page.evaluate(() => cancelAnimationFrame(window.palmUniverse.scene.raf));

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await settleResize(page);
    await page.evaluate(() => {
      const s = window.palmUniverse.scene;
      s.setCamera(false); s.video = null; s.resize();
      document.body.classList.remove('camera-active', 'clean');
    });
    await check(viewport.name + '-full-window-mouse-stage', async () => {
      const geometry = await stageGeometry(page); observations.push({ label: viewport.name + '-layout', ...geometry });
      assertFullWindow(geometry, viewport);
      near(geometry.scene.width, viewport.width, 'mouse logical width');
      near(geometry.scene.height, viewport.height, 'mouse logical height');
      near(geometry.scene.viewport.x, 0, 'mouse viewport left');
      near(geometry.scene.viewport.y, 0, 'mouse viewport top');
    });
    await check(viewport.name + '-hud-visible-clickable-and-pass-through', async () => {
      const hud = await hudObservation(page); observations.push({ label: viewport.name + '-hud', ...hud });
      assert.ok(!overlap(hud.topbar, hud.stageTop), 'main navigation must not overlap status/actions');
      assert.ok(!overlap(hud.bottom, hud.stageTop), 'bottom controls must not overlap stage actions');
      for (const control of hud.controls) {
        assert.ok(control.rect.x >= -.5 && control.rect.y >= -.5, control.id + ' inside top/left');
        assert.ok(control.rect.x + control.rect.width <= viewport.width + .5, control.id + ' inside right');
        assert.ok(control.rect.y + control.rect.height <= viewport.height + .5, control.id + ' inside bottom');
        if (!control.disabled) assert.ok(control.receivesPointer, control.id + ' receives pointer events');
      }
      assert.equal(hud.hintPointerTarget, 'universe', 'noninteractive hint text must not block hand/mouse canvas');
      await page.locator('#guide-toggle').click();
      assert.equal(await page.locator('#gesture-guide').isVisible(), true, 'guide action opens');
      await page.locator('#guide-close').click();
      assert.equal(await page.locator('#gesture-guide').isVisible(), false, 'guide action closes');
      await page.keyboard.press('h');
      assert.equal(await page.locator('.topbar').isVisible(), false, 'H hides controls');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.topbar').isVisible(), true, 'Esc restores controls');
      assertFullWindow(await stageGeometry(page), viewport);
    });

    for (const source of sources) {
      await mockCamera(page, source);
      const expected = expectedContain(viewport, source);
      await check(`${viewport.name}-${source.name}-native-camera-contain-rectangle`, async () => {
        const geometry = await stageGeometry(page); observations.push({ label: `${viewport.name}-${source.name}-camera`, source, ...geometry });
        assertFullWindow(geometry, viewport);
        assert.equal(geometry.cameraObjectFit, 'contain', 'camera must preserve its complete original field of view');
        for (const field of ['x', 'y', 'width', 'height']) near(geometry.scene.viewport[field], expected[field], 'camera viewport ' + field);
        near(geometry.scene.width, expected.width, 'camera logical width');
        near(geometry.scene.height, expected.height, 'camera logical height');
        near(geometry.scene.width / geometry.scene.height, source.width / source.height, 'camera source aspect', .0001);
      });
      for (const mirror of [false, true]) {
        await check(`${viewport.name}-${source.name}-mirror-${mirror ? 'on' : 'off'}-three-camera-anchors`, async () => {
          const mapping = await mappingObservation(page, mirror);
          observations.push({ label: `${viewport.name}-${source.name}-mirror-${mirror}`, ...mapping });
          assert.equal(mapping.mirror, mirror);
          near(mapping.videoScaleX, mirror ? -1 : 1, 'CSS-video mirror', .0001);
          near(mapping.rendererSize.width, expected.width, 'WebGL logical width');
          near(mapping.rendererSize.height, expected.height, 'WebGL logical height');
          for (const anchor of mapping.anchors) {
            const x = mirror ? 1 - anchor.source.x : anchor.source.x;
            near(anchor.local.x, x * expected.width, 'landmark local X');
            near(anchor.local.y, anchor.source.y * expected.height, 'landmark local Y');
            near(anchor.screen.x, expected.x + x * expected.width, 'landmark displayed X');
            near(anchor.screen.y, expected.y + anchor.source.y * expected.height, 'landmark displayed Y');
          }
        });
      }
      await check(`${viewport.name}-${source.name}-five-phases-use-camera-rectangle`, async () => {
        const drawing = await drawModelObservation(page);
        observations.push({ label: `${viewport.name}-${source.name}-draw`, ...drawing });
        assert.equal(drawing.objects.length, 5, 'five expanded phase models');
        assert.equal(drawing.glError, 0, 'actual WebGL rendering succeeds');
        const m = drawing.compositeTransform;
        near(m.a, drawing.dpr, 'Canvas composite scale X', .0001);
        near(m.d, drawing.dpr, 'Canvas composite scale Y', .0001);
        near(m.e, expected.x * drawing.dpr, 'Canvas composite translate X');
        near(m.f, expected.y * drawing.dpr, 'Canvas composite translate Y');
        for (const object of drawing.objects) {
          assert.equal(object.kind, 'moon');
          assert.ok(object.radius > 0);
          assert.ok(object.x - object.radius >= -.5, 'phase solid remains inside camera left edge');
          assert.ok(object.x + object.radius <= expected.width + .5, 'phase solid remains inside camera right edge');
          assert.ok(object.y - object.radius >= -.5, 'phase solid remains inside camera top edge');
          assert.ok(object.y + object.radius <= expected.height + .5, 'phase solid remains inside camera bottom edge');
        }
        assert.ok(drawing.samplePixels.every(pixel => pixel.alpha > 0), 'actual composites appear at the mapped camera anchors');
      });
      if ((viewport.name === 'desktop' && source.name === '16x9') ||
          (viewport.name === 'phone' && source.name === '9x16') ||
          (viewport.name === 'narrow-phone' && source.name === '4x3') ||
          (viewport.name === 'landscape-phone' && source.name === '16x9')) {
        const output = path.join(root, 'analysis', `viewport-${viewport.name}-${source.name}-synthetic-camera.png`);
        await page.screenshot({ path: output }); screenshots.push(output);
      }
    }
  }
  await check('no-real-webcam-request-or-browser-errors', async () => {
    assert.equal(await page.evaluate(() => window.__webcamRequests), 0);
    assert.deepEqual(browserErrors, []); assert.deepEqual(httpErrors, []);
    assert.deepEqual(hashes(), sourceSha256, 'sources must remain unchanged during verification');
  });
})().catch(error => {
  checks.push({ id: 'runner', passed: false, error: error.stack }); console.error(error);
}).finally(async () => {
  if (browser) await browser.close();
  const report = {
    tested_at: new Date().toISOString(),
    setup: 'Actual application and GPU renderer in headless Chrome. Camera videoWidth/videoHeight are explicit synthetic metadata; no physical camera, tracking model, or real-hand accuracy claim. Expanded phases use an isolated scene fixture, while coordinate mapping and HUD exercise production code.',
    source_sha256: sourceSha256,
    summary: { total: checks.length, passed: checks.filter(check => check.passed).length, failed: checks.filter(check => !check.passed).length },
    test_results: checks, observations, screenshots, browser_errors: browserErrors, http_errors: httpErrors,
  };
  fs.mkdirSync(path.join(root, 'analysis'), { recursive: true });
  fs.writeFileSync(path.join(root, 'analysis/viewport-mapping-validation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.summary.passed}/${report.summary.total} viewport/camera-mapping checks passed.`);
  if (report.summary.failed) process.exitCode = 1;
});
