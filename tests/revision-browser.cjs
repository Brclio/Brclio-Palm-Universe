// Current revision browser checks. Runs against headless development Chrome; never accesses the actual webcam.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require('/Users/bornforthis/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const sourceSha256 = Object.fromEntries(['app.js','public/scene.js','public/gesture-sequence.js','public/objects-3d.js','public/models/celestial.js','public/models/sculpted.js','public/models/lunar-surface.js','public/vendor/three/three.module.js','public/vendor/three/three.core.js','public/record-audio.js','public/interaction-audio.js','public/audio/sfx/manifest.json'].map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]));
const baseURL = process.env.INTERACTION_TEST_URL || 'http://localhost:5173/';
const checks = [], pageErrors = [], httpErrors = [], externalFailures = [], webglErrors = [], requests = [], geometryEvidence = [];
const states = [], screenshots = [], animationEvidence = [], phaseFadeEvidence = [], audioEvidence = [], sfxEvidence = [];
let browser;

function installAudioObservation(){
  const NativeContext=window.AudioContext||window.webkitAudioContext;
  window.__audioProbe={contexts:[],edges:[],sources:[],starts:0,stops:0};
  if(!NativeContext)return;
  const connect=AudioNode.prototype.connect;
  AudioNode.prototype.connect=function(target,...rest){window.__audioProbe.edges.push({from:this,to:target});return connect.call(this,target,...rest);};
  const start=AudioBufferSourceNode.prototype.start,stop=AudioBufferSourceNode.prototype.stop;
  AudioBufferSourceNode.prototype.start=function(...args){
    const p=window.__audioProbe,a=window.palmUniverse?.audio,sfx=window.palmUniverse?.sfx,ctx=this.context;
    p.starts++;const first=p.edges.find(e=>e.from===this)?.to;
    const channel=first===a?._gain?'record':p.edges.some(e=>e.from===first&&e.to===sfx?._gain)?'sfx':'unknown';
    const entry={node:this,stopped:false,ended:false,channel,stage:window.palmUniverse?.scene.sequenceSnapshot?.stage,panProgress:window.palmUniverse?.scene.sequenceSnapshot?.panProgress,peakRms:0,sampleCount:0};p.sources.push(entry);
    let analyser,sink,timer;
    if(channel==='sfx'){
      entry.connectedToDestination=p.edges.some(e=>e.from===sfx._gain&&e.to===ctx.destination);
      analyser=ctx.createAnalyser();analyser.fftSize=1024;sink=ctx.createGain();sink.gain.value=0;first.connect(analyser);analyser.connect(sink);sink.connect(ctx.destination);
      timer=setInterval(()=>{const samples=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(samples);const rms=Math.sqrt(samples.reduce((sum,x)=>sum+x*x,0)/samples.length);entry.peakRms=Math.max(entry.peakRms,rms);entry.sampleCount++;},15);
    }
    this.addEventListener('ended',()=>{entry.ended=true;clearInterval(timer);analyser?.disconnect();sink?.disconnect();},{once:true});return start.apply(this,args);
  };
  AudioBufferSourceNode.prototype.stop=function(...args){window.__audioProbe.stops++;for(const entry of window.__audioProbe.sources)if(entry.node===this)entry.stopped=true;return stop.apply(this,args);};
  window.AudioContext=class extends NativeContext{constructor(...args){super(...args);window.__audioProbe.contexts.push(this);}};
}
async function sampleAudio(page,label){
  const result=await page.evaluate(()=>{
    const a=window.palmUniverse.audio,p=window.__audioProbe,ctx=p.contexts.at(-1),edge=ctx&&p.edges.find(e=>e.to===ctx.destination&&e.from===a._gain);
    if(edge&&!p.analyser){p.analyser=ctx.createAnalyser();p.analyser.fftSize=2048;edge.from.connect(p.analyser);const sink=ctx.createGain();sink.gain.value=0;p.analyser.connect(sink);sink.connect(ctx.destination);}
    let rms=0;if(p.analyser){const samples=new Float32Array(p.analyser.fftSize);p.analyser.getFloatTimeDomainData(samples);rms=Math.sqrt(samples.reduce((sum,x)=>sum+x*x,0)/samples.length);}
    const channelSources=p.sources.filter(x=>p.edges.some(e=>e.from===x.node&&e.to===a._gain));
    const live=channelSources.filter(x=>!x.stopped&&!x.ended),connected=live.some(x=>p.edges.some(e=>e.from===x.node&&p.edges.some(f=>f.from===e.to&&f.to===ctx?.destination)));
    return {state:a.state,contextState:ctx?.state||'not-created',starts:channelSources.length,stops:channelSources.filter(x=>x.stopped||x.ended).length,liveSources:live.length,allChannelsLiveSources:p.sources.filter(x=>!x.stopped&&!x.ended).length,connectedToDestination:connected,rms,recordPlaying:window.palmUniverse.scene.recordPlaying,recordAnimationPlaying:window.palmUniverse.scene.objects3d.recordPlaying,recordClock:window.palmUniverse.scene.objects3d.recordClock,mediaElementPaused:document.querySelector('#music').paused};
  });if(label)audioEvidence.push({event:label,...result});return result;
}
const SFX_IDS=['summon','sweepSun','sweepMoon','grab','release','phases','collect','record','burst'];
async function sampleSfx(page,label){
  const result=await page.evaluate(()=>{
    const s=window.palmUniverse.sfx,p=window.__audioProbe;
    return {state:s.state,contextCount:p.contexts.length,sharedContext:s._context===window.palmUniverse.audio.context,separateGain:s._gain!==window.palmUniverse.audio._gain,voices:p.sources.filter(e=>e.channel==='sfx').map(({node,...entry})=>entry)};
  });if(label)sfxEvidence.push({event:label,...result});return result;
}
async function assertSfxSequence(page,baseline,label){
  await page.waitForTimeout(100);
  const result=await sampleSfx(page,label),history=result.state.history.slice(baseline.history),voices=result.voices.slice(baseline.voices);
  assert.deepEqual(history.map(e=>e.id),SFX_IDS,'one cue for each stage, record visibility, and burst');
  assert.equal(voices.length,9,'exactly nine actual SFX BufferSource starts');
  for(let i=0;i<voices.length;i++){assert.ok(voices[i].connectedToDestination,'SFX source routes to actual destination');assert.ok(voices[i].peakRms>1e-5,history[i].id+' actual per-voice output contains audio energy');}
  assert.ok(voices[7].panProgress>=.28,'record SFX begins only when record becomes visible');
  assert.equal(result.contextCount,1);assert.equal(result.sharedContext,true);assert.equal(result.separateGain,true);
}
async function sfxBaseline(page){const result=await sampleSfx(page);return {history:result.state.history.length,voices:result.voices.length};}
async function verifyIndependentSfxMute(page){
  const initial=await sampleAudio(page),before=await sampleSfx(page);
  await page.locator('#sfx-toggle').click();await page.waitForTimeout(100);
  const muted=await sampleSfx(page,'sfx-mute-during-record'),song=await sampleAudio(page,'song-continues-with-sfx-muted');
  assert.equal(muted.state.enabled,false);assert.equal(muted.state.activeVoices,0);assert.equal(song.state.playing,true);assert.ok(song.state.currentTime>initial.state.currentTime);assert.ok(song.rms>1e-5);assert.equal(song.recordAnimationPlaying,true);
  await page.locator('#sfx-toggle').click();await page.waitForTimeout(100);const unmuted=await sampleSfx(page,'sfx-reenable-does-not-replay');
  assert.equal(unmuted.state.enabled,true);assert.equal(unmuted.state.history.length,before.state.history.length);assert.equal(unmuted.voices.length,before.voices.length);
}

async function assertAudioSilent(page,label){
  let result=await sampleAudio(page);if(result.rms>1e-5){await page.waitForTimeout(100);result=await sampleAudio(page);}
  audioEvidence.push({event:label,...result});assert.equal(result.state.active,false,label+' must keep record gate closed');assert.equal(result.state.playing,false,label+' cannot be playing');assert.equal(result.state.currentTime,0,label+' cannot advance audio clock');assert.equal(result.liveSources,0,label+' cannot have a live record-music source');assert.ok(result.rms<1e-5,label+' record-music channel must be silent');assert.equal(result.mediaElementPaused,true,'HTML audio never plays in parallel');return result;
}
async function verifyRecordAudio(page,label){
  await page.waitForFunction(()=>window.palmUniverse.audio.state.playing);
  let result;for(let i=0;i<18;i++){await page.waitForTimeout(100);result=await sampleAudio(page);if(result.rms>1e-5&&result.state.currentTime>.15)break;}
  audioEvidence.push({event:label,...result});assert.equal(result.state.active,true);assert.equal(result.contextState,'running');assert.equal(result.connectedToDestination,true,'BufferSource must connect through gain to actual destination');assert.ok(result.rms>1e-5,'actual output analyser must see song energy');assert.ok(result.state.currentTime>.15);assert.equal(result.recordPlaying,true);assert.equal(result.mediaElementPaused,true);return result;
}
async function verifyRecordPauseResume(page){
  await page.locator('#music-toggle').click();await page.waitForTimeout(100);const before=await sampleAudio(page),before3d=await sample3d(page);
  await pointer(page,.8,.2);await page.mouse.down();await page.waitForTimeout(30);await page.mouse.up();await page.waitForTimeout(300);const after=await sampleAudio(page,'record-user-pause-stays-paused');
  assert.equal(after.state.active,true);assert.equal(after.state.playing,false);assert.ok(Math.abs(after.state.currentTime-before.state.currentTime)<.025);assert.equal(after.liveSources,0);assert.ok(after.rms<1e-5);assert.equal(after.recordAnimationPlaying,false);assert.ok(Math.abs(after.recordClock-before.recordClock)<.025,'record 3D animation stops with music');const after3d=await sample3d(page);assert.deepEqual(after3d.recordUniformTimes,before3d.recordUniformTimes,'paused record light shaders freeze');assert.equal(after3d.recordRotation,before3d.recordRotation,'paused solid platter freezes');
  await page.locator('#music-toggle').click();await verifyRecordAudio(page,'record-user-resume');await verify3dAnimation(page,'pan');
}

async function check(id, name, fn) {
  try { await fn(); checks.push({ id, name, passed: true }); console.log(`PASS ${id}: ${name}`); }
  catch (error) { checks.push({ id, name, passed: false, error: error.message }); console.error(`FAIL ${id}: ${name}\n${error.stack}`); }
}
function observe(page, label) {
  page.on('request', request=>requests.push({page:label,url:request.url(),type:request.resourceType()}));
  page.on('console', message=>{if(/WebGL.*(?:error|invalid)|Shader Error|VALIDATE_STATUS|compile.*shader|shader.*compil/i.test(message.text()))webglErrors.push({page:label,type:message.type(),message:message.text()});});
  page.on('pageerror', error => pageErrors.push({ page: label, error: error.message }));
  page.on('response', response => { if (response.status() >= 400) httpErrors.push({ page: label, status: response.status(), url: response.url() }); });
  page.on('requestfailed', request => {
    if (!request.url().startsWith(baseURL) && !request.failure()?.errorText.includes('ABORTED'))
      externalFailures.push({ page: label, url: request.url(), error: request.failure()?.errorText });
  });
}
async function openPage(context, label, waitUntil = 'networkidle') {
  const page = await context.newPage(); observe(page, label);
  await page.addInitScript(installAudioObservation);
  await page.goto(baseURL, { waitUntil });
  await page.waitForFunction(() => Boolean(window.palmUniverse?.scene));
  await page.evaluate(() => window.palmUniverse.scene.assetsReady);
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
      modeButtons: document.querySelectorAll('button.mode').length,
      sceneSize: {w:scene.w,h:scene.h},
      objects3d: scene.objects3d.state,
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
  if(!['pan','burst'].includes(expected))await assertAudioSilent(page,label);
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
    const scene=window.palmUniverse.scene;scene.draw();
    return {calls:scene.objects3d.state.activeObjects.filter(c=>c.kind==='moon').map(c=>({...c,x:c.x/scene.w,y:c.y/scene.h})),anchor:scene.sequenceSnapshot.phaseAnchor,progress:scene.sequenceSnapshot.phaseProgress};
  });
  assert.equal(drawing.calls.length,5,'fully unfolded 3D drawing must have exactly five moons');
  assert.ok(drawing.calls.every(call=>Math.abs(call.y-drawing.anchor.y)<.001),'all five phases must stay at release height');
  assert.deepEqual(drawing.calls.map(call=>call.phase),[.78,.64,.48,.30,0],'five spherical light phases progress from a thin right-lit crescent to full');
  samePoint(drawing.calls[4],drawing.anchor,'rightmost full moon remains at release anchor');
  for(let i=1;i<5;i++)assert.ok(drawing.calls[i].x>drawing.calls[i-1].x,'phase order runs left to right');
  return drawing;
}

async function saveScreenshot(page, name) {
  const output = path.join(root, 'analysis', name);
  await page.screenshot({ path: output, fullPage: true }); screenshots.push(output);
}


async function sample3d(page) {
  return page.evaluate(()=>{
    const o=window.palmUniverse.scene.objects3d;
    const times=kind=>{const values=[];o.pools[kind][0].object.traverse(n=>{for(const m of n.material?(Array.isArray(n.material)?n.material:[n.material]):[])if(m.uniforms?.uTime)values.push(m.uniforms.uTime.value);});return values;};
    return {...o.state,sunUniformTimes:times('sun'),recordUniformTimes:times('record'),recordRotation:o.pools.record[0].object.getObjectByName('Grooved solid vinyl platter').rotation.z};
  });
}
async function verify3dAnimation(page, expectedMode) {
  if(expectedMode!=='sun')await page.waitForFunction(()=>{const s=window.palmUniverse.scene;return s.transition?.mode!=='sun'||s.time-s.transition.start>=.50;});
  await page.waitForTimeout(80);const before=await sample3d(page);await page.waitForTimeout(310);const after=await sample3d(page);
  assert.ok(after.ready);assert.ok(after.clock>before.clock,'3D animation clock advances');
  if(expectedMode==='sun'){
    assert.ok(after.sunClock>before.sunClock+.04,'solar clock advances on stage');
    assert.ok(after.sunUniformTimes.length>0);assert.ok(after.sunUniformTimes.every((t,i)=>t>before.sunUniformTimes[i]+.04),'actual solar shader uniforms advance');
  }else assert.ok(Math.abs(after.sunClock-before.sunClock)<.025,'solar clock pauses offstage');
  if(expectedMode==='pan'){
    assert.equal(after.recordPlaying,true);assert.ok(after.recordClock>before.recordClock+.04);
    assert.ok(after.recordUniformTimes.length>0);assert.ok(after.recordUniformTimes.every((t,i)=>t>before.recordUniformTimes[i]+.04),'actual record light shaders animate');
    assert.ok(Math.abs(after.recordRotation-before.recordRotation)>.004,'actual solid vinyl platter rotates');
  }else{assert.equal(after.recordPlaying,false);assert.ok(Math.abs(after.recordClock-before.recordClock)<.025,'record clock pauses offstage');}
  animationEvidence.push({expectedMode,before,after});
}
async function verifyPhaseFade(page) {
  const sample=()=>page.evaluate(()=>{const s=window.palmUniverse.scene;s.draw();return s.objects3d.state.activeObjects.filter(c=>c.kind==='moon'&&c.phase>0).map(c=>({...c,x:c.x/s.w,y:c.y/s.h}));});
  const before=await sample();await page.waitForTimeout(140);const after=await sample();
  assert.equal(before.length,4,'held full moon leaves four stationary 3D phase ghosts');assert.equal(after.length,4);
  for(let i=0;i<4;i++){samePoint(after[i],before[i],'remaining phase position stays fixed during fade');assert.ok(after[i].opacity<before[i].opacity,'remaining 3D phases fade without spatial collapse');}
  phaseFadeEvidence.push({before,after});
}
async function inspectGeometry(page,label) {
  const result=await page.evaluate(()=>{
    const o=window.palmUniverse.scene.objects3d,models={};
    for(const [kind,pool] of Object.entries(o.pools)){
      const meshes=[];pool[0].object.traverse(n=>{if(!n.isMesh||!n.geometry)return;const p=n.geometry.getAttribute('position');let min=Infinity,max=-Infinity;for(let i=0;i<p.count;i++){min=Math.min(min,p.getZ(i));max=Math.max(max,p.getZ(i));}meshes.push({name:n.name,type:n.geometry.type,vertices:p.count,zMin:min,zMax:max,hasNormals:Boolean(n.geometry.getAttribute('normal'))});});models[kind]=meshes;
    }
    const externalTextures=[];o.scene.traverse(n=>{for(const m of n.material?(Array.isArray(n.material)?n.material:[n.material]):[]){const values=[...Object.values(m),...Object.values(m.uniforms||{}).map(v=>v.value)];for(const texture of values)if(texture?.isTexture&&(texture.image instanceof HTMLImageElement||texture.image instanceof HTMLVideoElement))externalTextures.push(texture.image.src);}});
    return {models,externalTextures,webgl2:o.renderer.getContext() instanceof WebGL2RenderingContext,glError:o.renderer.getContext().getError(),programs:o.renderer.info.programs.map(p=>({name:p.name,runnable:p.diagnostics?.runnable??true}))};
  });
  for(const kind of ['star','sun','moon','record']){assert.ok(result.models[kind].some(m=>m.vertices>100&&m.zMax-m.zMin>.01&&m.hasNormals),kind+' must contain real volume geometry with normals');}
  assert.deepEqual(result.externalTextures,[],'all texture pixels are code generated');assert.equal(result.webgl2,true);assert.equal(result.glError,0);assert.ok(result.programs.length>0);assert.ok(result.programs.every(p=>p.runnable),'all GPU programs compile');geometryEvidence.push({label,...result});return result;
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
    const inverse = (sx, sy) => ({ x: scene.mirror ? 1 - (sx * scene.w - (scene.w - vw) / 2) / vw : (sx * scene.w - (scene.w - vw) / 2) / vw, y: (sy * scene.h - (scene.h - vh) / 2) / vh, z: 0 });
    const fingers = kind === 'open'
      ? { thumb: true, index: true, middle: true, ring: true, pinky: true }
      : kind === 'fist'
        ? { thumb: false, index: false, middle: false, ring: false, pinky: false }
        : { thumb: true, index: true, middle: false, ring: false, pinky: false };
    const gap = kind === 'open' ? .17 : kind === 'l' ? .18 : kind === 'pinch' ? .012 : kind === 'fist' ? .035 : .055;
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
  browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const page = await openPage(desktop, 'desktop-pointer');

  await check('record-audio-initial-gate', '进入和首次操作只静默解锁，唱片出现前音乐不可播放', async () => {
    const entry=await assertAudioSilent(page,'entry-before-any-input');assert.equal(entry.allChannelsLiveSources,0);const sfx=await sampleSfx(page,'initial-page-silent');assert.equal(sfx.state.enabled,true);assert.equal(sfx.state.history.length,0);assert.equal(sfx.contextCount,0,'silent WAV prefetch must not create an AudioContext');
    const element=await page.locator('#music').evaluate(a=>({src:a.currentSrc||a.src,autoplay:a.autoplay,paused:a.paused}));
    assert.equal(await page.locator('#track-name').textContent(),'茶花开了');assert.equal(element.autoplay,false);assert.equal(element.paused,true);
    assert.equal(decodeURIComponent(new URL(element.src).pathname),'/茶花开了.m4a');assert.equal(await page.locator('#music-toggle').isDisabled(),true);
    const response=await page.evaluate(async()=>{const r=await fetch(document.querySelector('#music').src,{headers:{Range:'bytes=0-99'}});await r.arrayBuffer();return {status:r.status,type:r.headers.get('content-type')};});assert.equal(response.status,206);assert.match(response.type,/^audio\/mp4/);
    await pointer(page,.15,.45);await page.mouse.down();await page.waitForTimeout(30);await page.mouse.up();
    await page.waitForFunction(()=>window.palmUniverse.audio.state.ready);await page.waitForTimeout(250);
    await page.waitForFunction(()=>window.palmUniverse.sfx.state.ready);
    const ready=await assertAudioSilent(page,'first-pointer-silently-unlocked');assert.equal(ready.contextState,'running');assert.equal(ready.state.duration,270);assert.equal(ready.starts,0);
    await page.keyboard.press('Space');await assertAudioSilent(page,'space-cannot-skip-record-gate');
    await page.locator('#restart').click();await stage(page,'idle');
  });

  await check('pointer-full-sequence', '桌面真实鼠标事件按原片动作完成空场→星→日→月→五相→唱片→爆散', async () => {
    const sfxStart=await sfxBaseline(page);
    // Default page is already in the real mouse sequence.
    let result = await stage(page, 'idle', 'pointer-start-empty');
    assert.equal(result.mode, null); assert.equal(result.modeButtons, 0); assert.equal(result.restartHidden, false);
    await page.keyboard.press('5'); await page.keyboard.press('b'); await page.mouse.dblclick(500, 500); await page.waitForTimeout(100);
    result = await state(page); assert.equal(result.snapshot.stage, 'idle'); assert.equal(result.mode, null);
    await pointer(page, .35, .6); await page.waitForTimeout(250);
    await page.mouse.down(); await page.waitForTimeout(360); await stage(page, 'star', 'pointer-star'); await page.mouse.up();
    await page.waitForTimeout(650); await saveScreenshot(page, 'revision-star.png');
    await pointer(page, .20, .6); await page.waitForTimeout(500);
    await move(page, { x: .20, y: .6 }, { x: .75, y: .6 }, .4); await stage(page, 'sun', 'pointer-sun'); await page.waitForTimeout(650); await verify3dAnimation(page,'sun'); await saveScreenshot(page, 'revision-sun.png');
    await move(page, { x: .75, y: .6 }, { x: .20, y: .6 }, .45); await page.waitForTimeout(180);
    await move(page, { x: .20, y: .6 }, { x: .75, y: .6 }, .4); result = await stage(page, 'moon', 'pointer-moon');
    const moon = result.snapshot.target;
    await verify3dAnimation(page,null);
    await saveScreenshot(page, 'revision-moon.png');
    await pointer(page, moon.x, moon.y); await page.mouse.down(); await page.waitForTimeout(220); await stage(page, 'moonHeld', 'pointer-moon-held');
    const loose = (await state(page)).snapshot.scale; await page.waitForTimeout(500);
    assert.ok((await state(page)).snapshot.scale < loose, 'holding closes the simulated thumb/index opening continuously');
    await move(page, moon, { x: .79, y: .67 }, .7); await page.mouse.up(); await page.waitForTimeout(180);
    result = await stage(page, 'moonReleased', 'pointer-moon-released'); const anchor = { ...result.snapshot.target };
    samePoint(result.snapshot.releaseOrigin, {x:.79,y:.67}, 'moon release retains the last held point');
    samePoint(anchor, { x: .82, y: .67 }, 'moon drifts right by .03 frame widths before settling');
    assert.ok(result.position.x>.79 && result.position.x<anchor.x, 'released moon is still between origin and settled point during source drift');
    await page.waitForTimeout(600);samePoint((await state(page)).position,anchor,'moon reaches and stays at drift destination');
    await move(page, anchor, { x: anchor.x, y: anchor.y - .15 }, .35); await page.waitForTimeout(100);
    result = await state(page); assert.equal(result.snapshot.stage, 'moonReleased'); samePoint(result.snapshot.target, anchor, 'released moon cannot follow departing pointer');
    await pointer(page, anchor.x, anchor.y); await page.waitForTimeout(80);
    await move(page, anchor, { x: anchor.x - .30, y: anchor.y }, .40); await stage(page, 'phases', 'pointer-phase-trigger');
    const progressAtStop = (await state(page)).snapshot.phaseProgress;
    assert.ok(progressAtStop < 1, 'left swipe must first start staggered unfold');
    await page.waitForTimeout(1350); const unfolded = await state(page, 'pointer-five-phases');
    assert.equal(unfolded.snapshot.phaseProgress, 1, 'five phases must finish revealing while the pointer stays still');
    assert.ok(unfolded.snapshot.phaseProgress > progressAtStop);
    await pointer(page, .10, anchor.y);
    await verifyPhasesDrawing(page); await saveScreenshot(page, 'revision-phases.png');
    await move(page, { x: .10, y: anchor.y }, anchor, .5); await page.mouse.down(); await page.waitForTimeout(220); await stage(page, 'phaseHeld', 'pointer-phases-collected'); await verifyPhaseFade(page);
    await move(page, anchor, { x: .25, y: .25 }, .8); await page.waitForTimeout(260); await stage(page, 'phaseHeld', 'pointer-raised-still-held');
    await page.mouse.up(); await page.waitForTimeout(200); result = await stage(page, 'pan', 'pointer-pan-drop');
    samePoint(result.snapshot.panOrigin, { x: .25, y: .25 }, 'pan drop must start at raised pointer release');
    assert.ok(result.target.x < .25 && result.target.y > .25, 'pan must settle below-left of raised pointer');
    const settled = { ...result.target }; await verifyRecordAudio(page,'mouse-record-auto-start'); await verifyIndependentSfxMute(page); await verifyRecordPauseResume(page); await page.waitForTimeout(550); await verify3dAnimation(page,'pan'); await saveScreenshot(page, 'revision-record.png');
    await pointer(page, settled.x, settled.y); await page.mouse.down(); await page.waitForTimeout(180); await page.mouse.up();
    result = await stage(page, 'burst', 'pointer-burst'); assert.equal(result.mode, null); assert.ok(result.particles > 0, 'burst must produce visible particles');
    await saveScreenshot(page, 'revision-burst.png'); await page.waitForTimeout(450); await assertAudioSilent(page,'mouse-burst-faded-and-stopped'); await verify3dAnimation(page,null); await page.waitForTimeout(4300); result = await state(page, 'pointer-finale-empty');
    assert.equal(result.snapshot.stage, 'burst'); assert.equal(result.mode, null); assert.equal(result.particles, 0);
    await assertSfxSequence(page,sfxStart,'mouse-nine-cues-once');
    await page.locator('#restart').click(); result = await stage(page, 'idle', 'pointer-reset');
    assert.equal(result.mode, null); assert.equal(result.snapshot.held, false); assert.equal(result.modeButtons, 0);
  });

  await check('motion-and-phase-rendering', '太阳和黑胶真实3D材质随独立时钟动画，四个月相固定位置淡出', async () => {
    assert.ok(animationEvidence.length>=4);assert.equal(phaseFadeEvidence.length,1);
  });

  await check('independent-3d-models-and-stage', '全部图形为有体积的真实WebGL模型，着色器可编译，主舞台无视频/截图纹理', async () => {
    const result=await state(page);assert.equal(result.objects3d.ready,true);
    assert.ok(Math.abs(result.sceneSize.w/result.sceneSize.h-16/9)<.005);assert.equal(result.modeButtons,0);
    await inspectGeometry(page,'desktop-real-3d-models');
    await page.locator('#guide-toggle').click(); await page.waitForTimeout(300);
    assert.equal(await page.locator('#gesture-guide').isVisible(), true);
    const time = await page.locator('#guide-video').evaluate(v=>v.currentTime); assert.ok(time>=14.5 && time<=16.7);
    await page.locator('#guide-close').click();
    const transforms=await page.evaluate(()=>['#guide-video','#reference-video'].map(selector=>getComputedStyle(document.querySelector(selector)).transform));assert.deepEqual(transforms,['none','none'],'source footage must never be mirrored');
  });

  await check('mouse-mirror-independence', '镜像切换只影响摄像头，鼠标坐标和当前鼠标流程不受影响', async()=>{
    await page.locator('#mirror-toggle').click();
    await pointer(page,.35,.6);await page.mouse.down();await page.waitForTimeout(360);await page.mouse.up();
    const before=await stage(page,'star');samePoint(before.snapshot.target,{x:.368,y:.635},'mirror off does not alter mouse screen coordinates');
    await page.locator('#mirror-toggle').click();const after=await state(page);assert.equal(after.snapshot.stage,'star');samePoint(after.snapshot.target,before.snapshot.target,'mouse stage remains unchanged when mirror toggles');
    await page.locator('#restart').click();
  });


  await check('sfx-reset-and-reference-pause', '原片对照暂停操作音效，关闭不补播；重来立即停止在播音效', async()=>{
    await page.locator('#restart').click();await pointer(page,.35,.6);await page.mouse.down();await page.waitForTimeout(280);await page.mouse.up();await stage(page,'star');
    let playing=await sampleSfx(page);assert.ok(playing.state.activeVoices>0,'summon cue is still playing before dialog opens');
    await page.locator('#reference-open').click();await page.waitForTimeout(60);
    const suspended=await sampleSfx(page,'reference-dialog-suspends-sfx');assert.equal(suspended.state.suspended,true);assert.equal(suspended.state.enabled,true);assert.equal(suspended.state.activeVoices,0);
    await page.locator('#reference-close').click();
    // The dialog close event is queued; GPU-heavy runs can delay it beyond a
    // fixed 80 ms. Wait for the observable lifecycle transition, with a bound.
    await page.waitForFunction(()=>!window.palmUniverse.sfx.state.suspended,null,{timeout:2500});
    const resumed=await sampleSfx(page,'reference-close-no-replay');assert.equal(resumed.state.suspended,false);assert.equal(resumed.state.history.length,playing.state.history.length);assert.equal(resumed.voices.length,playing.voices.length);
    await page.locator('#restart').click();await pointer(page,.35,.6);await page.mouse.down();await page.waitForTimeout(280);await page.mouse.up();await stage(page,'star');
    playing=await sampleSfx(page);assert.ok(playing.state.activeVoices>0);
    await page.locator('#restart').click();await page.waitForTimeout(80);
    const cleared=await sampleSfx(page,'reset-stops-live-sfx');assert.equal(cleared.state.activeVoices,0);assert.equal(cleared.state.lastCue,null);assert.equal(cleared.voices.filter(v=>!v.stopped&&!v.ended).length,0);assert.equal(cleared.state.history.length,playing.state.history.length);
  });

  await desktop.close();

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
      const result = await state(denied); assert.equal(result.camera, false); assert.equal(result.sequenceEnabled, true);
    }
  });

  await permission.close();

  const cameraContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await cameraContext.addInitScript(() => {
    window.__realCameraRequests = 0;
    navigator.mediaDevices.getUserMedia = async () => { window.__realCameraRequests++; throw new Error('Real camera access forbidden in test'); };
  });
  await cameraContext.route('**/public/hand-tracking.js', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: trackerMock }));
  const camera = await openPage(cameraContext, 'camera-synthetic-results');
  await camera.locator('#camera-toggle').click();
  await camera.waitForFunction(() => window.palmUniverse.scene.camera && window.__mockHandTracker);
  await stage(camera, 'idle', 'camera-start-empty');

  await check('camera-observation-serial', '摄像头单帧握拳不会因渲染循环重复计时而召星，过期观察不触发动作', async () => {
    await holdHand(camera, 'open', .35, .6, .28);
    await emitHand(camera, 'fist', .35, .6); await camera.waitForTimeout(400);
    let result = await stage(camera, 'idle', 'camera-stale-one-frame-fist'); assert.equal(result.snapshot.tracked, false);
    await holdHand(camera, 'open', .35, .6, .28); await holdHand(camera, 'fist', .35, .6, .36);
    result = await stage(camera, 'star', 'camera-fresh-fist-star'); assert.ok(result.handSerial > 5);
    const cueCount=(await sampleSfx(camera)).state.history.length;
    await camera.evaluate(()=>window.__mockHandTracker.onResults({hands:[],timestamp:performance.now()}));
    await holdHand(camera, 'open', .15, .6, .5); await camera.waitForTimeout(400);
    await emitHand(camera, 'open', .85, .6); await camera.waitForTimeout(100);
    result = await state(camera); assert.equal(result.snapshot.stage, 'star', 'far observation after a stall cannot form a swipe');
    assert.equal(await camera.evaluate(() => window.__realCameraRequests), 0);assert.equal((await sampleSfx(camera,'tracking-hint-no-retrigger')).state.history.length,cueCount);
  });

  await check('camera-mirror-alignment', '镜像开关同步翻转画面和关键点，重置动作流程，非镜像下仍能识别屏幕位置', async () => {
    const mapping=()=>camera.evaluate(()=>{const s=window.palmUniverse.scene,p=s.map({x:.2,y:.4});return {mirror:s.mirror,x:p.x/s.w,y:p.y/s.h,css:document.querySelector('#camera').style.transform};});
    const before=await mapping();assert.equal(before.mirror,true);samePoint(before,{x:.8,y:.4},'mirrored map');assert.equal(before.css,'scaleX(-1)');
    await holdHand(camera,'open',.20,.6,.5);await moveHand(camera,'open',{x:.20,y:.6},{x:.75,y:.6},.4);await stage(camera,'sun','mirrored-screen-right-swipe');
    await camera.locator('#mirror-toggle').click();await stage(camera,'idle');await camera.waitForTimeout(70);assert.equal((await sampleSfx(camera,'camera-mirror-stops-sfx')).state.activeVoices,0);
    const after=await mapping();assert.equal(after.mirror,false);samePoint(after,{x:.2,y:.4},'unmirrored map');assert.equal(after.css,'none');
    await holdHand(camera,'fist',.35,.6,.36);const star=await stage(camera,'star');samePoint(star.snapshot.target,{x:.368,y:.635},'unmirrored real input must summon in the correct screen location');
    await holdHand(camera,'open',.20,.6,.5);await moveHand(camera,'open',{x:.20,y:.6},{x:.75,y:.6},.4);await stage(camera,'sun','unmirrored-screen-right-swipe');
    await camera.locator('#mirror-toggle').click();await stage(camera,'idle');assert.equal((await mapping()).mirror,true);
  });

  await check('camera-synthetic-sequence', '合成模型结果经过app回调、映射与serial机制完成当前观察动作全流程', async () => {
    await camera.locator('#restart').click(); await stage(camera, 'idle');
    const sfxStart=await sfxBaseline(camera);
    await camera.locator('#music-file').setInputFiles(path.join(root,'public/audio/lunar-reverie.mp3'));
    await camera.waitForFunction(()=>window.palmUniverse.audio.state.ready&&window.palmUniverse.audio.state.trackName==='lunar-reverie');
    const replacement=await assertAudioSilent(camera,'replacement-before-record-stays-silent');assert.equal(replacement.state.duration,48);
    await camera.keyboard.press('5'); await camera.keyboard.press('b'); await camera.mouse.dblclick(500, 500);
    let result = await state(camera); assert.equal(result.snapshot.stage, 'idle'); assert.equal(result.modeButtons, 0);
    await holdHand(camera, 'open', .35, .6, .28); await holdHand(camera, 'fist', .35, .6, .36); await stage(camera, 'star');
    await holdHand(camera, 'open', .20, .6, .5); await moveHand(camera, 'open', { x: .20, y: .6 }, { x: .75, y: .6 }, .4); await stage(camera, 'sun');
    await moveHand(camera, 'open', { x: .75, y: .6 }, { x: .20, y: .6 }, .5); await holdHand(camera, 'open', .20, .6, .16);
    await moveHand(camera, 'open', { x: .20, y: .6 }, { x: .75, y: .6 }, .4); result = await stage(camera, 'moon');
    const moon = result.snapshot.target;
    await holdHand(camera, 'pinch', .02, .02, .24); await stage(camera, 'moon');
    await holdHand(camera, 'c', moon.x, moon.y, .24); await stage(camera, 'moonHeld');
    await holdHand(camera, 'c', moon.x, moon.y, .2, { pinchStrength: .45 }); const loose = (await state(camera)).snapshot.scale;
    await holdHand(camera, 'c', moon.x, moon.y, .2, { pinchStrength: .97 }); const tight = (await state(camera)).snapshot.scale;
    assert.ok(tight < loose, 'camera pinch strength must scale moon down');
    await moveHand(camera, 'pinch', moon, { x: .79, y: .67 }, .8); await holdHand(camera, 'l', .79, .67, .24);
    result = await stage(camera, 'moonReleased', 'camera-release-anchor'); const anchor = { ...result.target };
    samePoint(result.snapshot.releaseOrigin, {x:.79,y:.67}, 'mirrored camera mapping must preserve actual held point');
    samePoint(anchor, { x: .82, y: .67 }, 'camera release uses the same right drift as pointer');
    await holdHand(camera, 'open', anchor.x, anchor.y, .25); await stage(camera, 'moonReleased');
    await moveHand(camera, 'open', anchor, { x: .40, y: anchor.y }, .45); await stage(camera, 'phases');
    await camera.waitForTimeout(1300); await verifyPhasesDrawing(camera);
    await holdHand(camera, 'pinch', anchor.x, anchor.y, .24); await stage(camera, 'phaseHeld');
    await moveHand(camera, 'pinch', anchor, { x: .25, y: .25 }, .8); await holdHand(camera, 'pinch', .25, .25, .3); await stage(camera, 'phaseHeld');
    await holdHand(camera, 'l', .25, .25, .24); result = await stage(camera, 'pan', 'camera-pan');
    samePoint(result.snapshot.panOrigin, { x: .25, y: .25 }, 'camera L release must originate at last gripping point'); const settled = { ...result.target };
    const playing=await verifyRecordAudio(camera,'camera-model-callback-auto-start-without-new-click');assert.equal(playing.state.trackName,'lunar-reverie');assert.equal(playing.state.duration,48);
    await holdHand(camera, 'pinch', settled.x, settled.y, .25); await moveHand(camera, 'pinch', settled, { x: .85, y: .75 }, .8);
    result = await stage(camera, 'pan'); samePoint(result.target, settled, 'camera pinch cannot regrab or drag settled pan');
    await holdHand(camera, 'fist', settled.x, settled.y - .08, .25); await holdHand(camera, 'open', settled.x, settled.y - .08, .20);
    result = await stage(camera, 'burst', 'camera-burst'); assert.equal(result.mode, null); assert.ok(result.particles > 0);
    await holdHand(camera, 'open', .35, .6, .25); await holdHand(camera, 'fist', .35, .6, .25); await stage(camera, 'burst');
    await assertAudioSilent(camera,'camera-burst-faded-and-stopped');
    await assertSfxSequence(camera,sfxStart,'camera-async-nine-cues-once');
    assert.equal(await camera.evaluate(() => window.__realCameraRequests), 0);
    await camera.locator('#camera-toggle').click(); result = await state(camera); assert.equal(result.camera, false); assert.equal(result.sequenceEnabled, true);await camera.waitForTimeout(70);assert.equal((await sampleSfx(camera,'camera-switch-stops-sfx')).state.activeVoices,0);
  });

  await check('record-audio-reset-boundaries', '重来、切换摄像头、摄像头镜像重置会停止并归零唱片音频', async()=>{
    // Isolated cleanup fixture: explicitly activate the audio class after its
    // trusted context unlock. Normal activation is already proven above through
    // complete pointer and model callback sequences. This is not gesture evidence.
    for(const action of ['restart','camera-switch','camera-mirror']){
      if(action==='camera-mirror'&&!await camera.evaluate(()=>window.palmUniverse.scene.camera))await camera.locator('#camera-toggle').click();
      await camera.waitForTimeout(120);await camera.evaluate(()=>window.palmUniverse.audio.activate());
      await camera.waitForFunction(()=>window.palmUniverse.audio.state.playing);
      await camera.locator(action==='restart'?'#restart':action==='camera-switch'?'#camera-toggle':'#mirror-toggle').click();
      await camera.waitForTimeout(150);await assertAudioSilent(camera,'cleanup-'+action);
    }
  });

  await cameraContext.close();


  await check('sfx-delayed-decode-reset', '真实延迟WAV响应：正常在期限内播一次，重来使相同待解码动作失效', async()=>{
    for(const cancel of [false,true]){
      const delayedContext=await browser.newContext({viewport:{width:1440,height:1000}}),pending=[];
      await delayedContext.route('**/public/audio/sfx/*.wav',route=>{pending.push(route);});
      const delayed=await openPage(delayedContext,cancel?'sfx-delay-cancel':'sfx-delay-control','domcontentloaded');
      await pointer(delayed,.35,.6);await delayed.mouse.down();
      await delayed.waitForFunction(()=>window.palmUniverse.scene.sequenceSnapshot?.stage==='star',null,{polling:10});
      const atStage=Date.now();
      assert.equal((await sampleSfx(delayed)).state.history.length,0,'cue awaits actual network response');
      if(cancel){await delayed.mouse.up();await delayed.locator('#restart').click({force:true});assert.equal((await state(delayed)).snapshot.stage,'idle','reset must actually occur before releasing the pending response');}
      const releaseDelayMs=Date.now()-atStage;
      assert.ok(releaseDelayMs<200,'response cancellation tested before late-cue expiry');
      assert.equal(pending.length,9,'all nine real WAV requests are pending');
      await Promise.all(pending.splice(0).map(route=>route.continue()));
      await delayed.mouse.up();await delayed.waitForFunction(()=>window.palmUniverse.sfx.state.ready);
      await delayed.waitForTimeout(100);
      const result=await sampleSfx(delayed,cancel?'delayed-reset-cancels-cue':'delayed-control-plays-cue');sfxEvidence.push({event:'delayed-response-timing',cancel,releaseDelayMs});
      assert.equal(result.state.history.length,cancel?0:1);assert.equal(result.voices.length,cancel?0:1);
      if(cancel){assert.equal(result.state.activeVoices,0);await stage(delayed,'idle');}
      else{assert.equal(result.state.history[0].id,'summon');assert.ok(result.voices[0].peakRms>1e-5);}
      await delayedContext.close();
    }
  });

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const mobile = await openPage(mobileContext, 'mobile-layout');
  await check('mobile-layout', '390×844手机布局无水平溢出，排练与重来入口可见', async () => {
    // Default mobile page also starts in the sequence. await stage(mobile, 'idle');
    const metrics = await mobile.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(metrics.scrollWidth <= metrics.width, 'mobile page must not overflow horizontally');
    const result=await state(mobile); assert.ok(Math.abs(result.sceneSize.w/result.sceneSize.h-16/9)<.005, 'mobile keeps the original composition ratio');
    for (const selector of ['#camera-toggle', '#mirror-toggle', '#restart', '#demo-toggle', '#music-toggle', '#replace-music', '#sfx-toggle']) {
      const box = await mobile.locator(selector).boundingBox();
      assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= metrics.width + 1 && box.y + box.height <= metrics.height + 1, `${selector} must be visible within mobile viewport`);
    }
    await inspectGeometry(mobile,'mobile-real-3d-models');await saveScreenshot(mobile, 'revision-mobile.png');
  });

  await check('browser-errors', '浏览器运行无JavaScript未捕获异常与HTTP 404/其他失败响应', async () => {
    assert.deepEqual(pageErrors, [], 'uncaught browser errors');
    assert.deepEqual(httpErrors, [], 'HTTP errors');assert.deepEqual(webglErrors,[],'WebGL and GLSL compile errors');
    const forbidden=requests.filter(r=>{const pathname=new URL(r.url).pathname;return /\/public\/.*\.(?:png|jpe?g|webp|gif|mp4|webm)$/i.test(pathname)||pathname.endsWith('/reference-effects.js');});assert.deepEqual(forbidden,[],'main runtime must never request image or movie effect assets');
  });

  await browser.close(); browser = null;
})().catch(error => {
  checks.push({ id: 'browser-runner', name: 'Browser runner completed', passed: false, error: error.stack || error.message });
  console.error(error);
}).finally(async () => {
  if (browser) await browser.close();
  const report = {
    tested_at: new Date().toISOString(), source_sha256: sourceSha256,
    purpose: '浏览器开发验收：真实pointer事件和显式模型测试替身；无真实摄像头访问。',
    test_command: 'node tests/revision-browser.cjs', base_url: baseURL,
    status: checks.every(check => check.passed) ? 'passed-browser-development-validation' : 'failed-browser-development-validation',
    summary: { total: checks.length, passed: checks.filter(check => check.passed).length, failed: checks.filter(check => !check.passed).length },
    test_results: checks, page_errors: pageErrors, http_errors: httpErrors, external_request_failures: externalFailures,
    screenshots, recorded_states: states, real_3d_animation_observations: animationEvidence, geometry_observations: geometryEvidence, webgl_errors: webglErrors, runtime_requests: requests, phase_fade_observations: phaseFadeEvidence, audio_observations: audioEvidence, sfx_observations: sfxEvidence, browser_autoplay_policy: 'Chrome default; no autoplay-policy override',
    limitations: [
      '摄像头成功流程用显式HandTracker测试替身输入合成模型结果，未验证真实模型识别准确率或真实摄像头画质。',
      '摄像头权限拒绝使用getUserMedia测试替身；成功mock路径禁止调用真实getUserMedia。',
      '手机此次仅验收布局与入口，不代表所有触屏手势或浏览器均已实测。',
      '唱片前段静默断言仅观测RecordAudio独立GainNode通道；手势SFX可在同一个AudioContext的独立通道正常发声。',
      '音频重置边界用显式 audio.activate() 建立隔离清理fixture；正常自动起播另由完整鼠标和相机模型回调流程验证。',
      'AudioContext/BufferSource 观测与旁接 Analyser 仅用于测量，不替换播放器或使用自动播放策略豁免。',
    ],
  };
  fs.writeFileSync(path.join(root, 'analysis', 'revision-browser-validation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.summary.passed}/${report.summary.total} browser checks passed.`);
  if (report.summary.failed) process.exitCode = 1;
});
