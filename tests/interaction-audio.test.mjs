import test from 'node:test';
import assert from 'node:assert/strict';
import { InteractionAudio } from '../public/interaction-audio.js';

const ids = ['summon', 'sweepSun', 'sweepMoon', 'grab', 'release', 'phases', 'collect', 'record', 'burst'];
const stages = ['star', 'sun', 'moon', 'moonHeld', 'moonReleased', 'phases', 'phaseHeld', 'pan', 'burst'];
const flush = () => new Promise(resolve => setImmediate(resolve));
const originalFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = originalFetch; });

class Parameter {
  value = 1;
  events = [];
  setValueAtTime(value, at) { this.value = value; this.events.push(['set', value, at]); }
  linearRampToValueAtTime(value, at) { this.events.push(['ramp', value, at]); }
  cancelScheduledValues(at) { this.events.push(['cancel', at]); }
  cancelAndHoldAtTime(at) { this.events.push(['hold', at]); }
}
class Context {
  state = 'suspended';
  currentTime = 10;
  destination = {};
  sources = [];
  gains = [];
  deferred = new Map();
  closed = false;
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { this.closed = true; }
  createGain() {
    const gain = { gain: new Parameter(), connect() {}, disconnect() { this.disconnected = true; } };
    this.gains.push(gain);
    return gain;
  }
  createBufferSource() {
    const source = {
      loop: true, started: false, stopped: false,
      connect() {}, disconnect() { this.disconnected = true; },
      start(at, offset, duration) { this.started = true; this.startArgs = { at, offset, duration }; },
      stop(at) { this.stopped = true; this.stopAt = at; },
      finish() { this.onended?.(); },
    };
    this.sources.push(source);
    return source;
  }
  decodeAudioData(bytes) {
    const id = ids[new Uint8Array(bytes)[0]];
    return this.deferred.get(id)?.promise || Promise.resolve({ duration: .8, id });
  }
  defer(id) {
    let resolve;
    const promise = new Promise(done => { resolve = () => done({ duration: .8, id }); });
    this.deferred.set(id, { promise, resolve });
    return resolve;
  }
}

function harness({ missing = false, context = new Context() } = {}) {
  const errors = [];
  const requests = [];
  let sharedContext = context;
  const manifest = ids.map((id, i) => ({ id, file: `${id}.wav`, stage: stages[i], duration: .7, gain: .8 }));
  globalThis.fetch = async url => {
    const path = String(url);
    requests.push(path);
    if (path.endsWith('manifest.json')) return { ok: true, json: async () => manifest };
    const id = path.split('/').pop().replace('.wav', '');
    return { ok: !missing, status: missing ? 404 : 200, arrayBuffer: async () => Uint8Array.of(ids.indexOf(id)).buffer };
  };
  const audio = new InteractionAudio({ getContext: () => sharedContext, onError: error => errors.push(error) });
  return { audio, context, errors, requests, provideContext: value => { sharedContext = value; } };
}

test('page-load prefetch needs no audio context and the first gesture uses cached bytes', async () => {
  const { audio, requests, provideContext } = harness({ context: null });
  assert.equal(await audio.prefetch(), true);
  assert.equal(requests.length, 10, 'one manifest and nine samples');
  assert.equal(audio.state.ready, false, 'no decoding happens during prefetch');
  assert.equal(audio.state.activeVoices, 0);
  assert.equal(audio._context, null);
  const context = new Context();
  provideContext(context);
  await audio.unlock(); await audio.prepare();
  assert.equal(requests.length, 10, 'unlock reuses every downloaded sample');
  assert.equal(context.sources.length, 0);
  audio.observe({ stage: 'star' }); await flush();
  assert.deepEqual(audio.state.history.map(item => item.id), ['summon']);
  audio.destroy();
});

test('prefetch and unlock in parallel share the same sample downloads', async () => {
  const { audio, requests } = harness();
  const preload = audio.prefetch();
  await audio.unlock();
  await preload; await audio.prepare();
  assert.equal(requests.length, 10);
  assert.equal(audio.state.activeVoices, 0);
  audio.destroy();
});

test('unlock and preparation are silent; cues follow transitions exactly once', async () => {
  const { audio, context } = harness();
  await audio.unlock();
  assert.equal(await audio.prepare(), true);
  assert.equal(context.sources.length, 0);
  assert.equal(context.gains[0].gain.value, .7, 'independent effects bus uses the chosen mix level');
  for (const stage of stages) {
    audio.observe({ stage, tracked: true });
    await flush();
    const before = context.sources.length;
    for (let i = 0; i < 100; i++) audio.observe({ stage, tracked: i % 2 === 0, hint: String(i) });
    await flush();
    assert.equal(context.sources.length, before);
    if (stage === 'pan') {
      assert.equal(audio.state.history.at(-1).id, 'collect');
      audio.visibleRecord();
      audio.visibleRecord();
      await flush();
    }
  }
  assert.deepEqual(audio.state.history.map(item => item.id), ids);
  assert.ok(audio.state.history.every(item => item.gain === .8));
  assert.equal(audio.state.activeVoices, 1, 'burst clears previous tails before its own source');
  assert.ok(context.sources.every(source => source.loop === false));
  assert.ok(context.sources.every(source => source.startArgs.offset === 0 && source.startArgs.duration === .7));
  audio.destroy();
  assert.equal(context.closed, false, 'SFX must not close the music context');
});

test('mute and reset stop SFX and never replay the current gesture', async () => {
  const { audio, context } = harness();
  await audio.unlock(); await audio.prepare();
  audio.observe({ stage: 'star' }); await flush();
  audio.setEnabled(false);
  assert.equal(audio.state.activeVoices, 0);
  assert.equal(context.sources[0].stopped, true);
  audio.observe({ stage: 'sun' }); await flush();
  audio.setEnabled(true);
  audio.observe({ stage: 'sun' }); await flush();
  assert.equal(context.sources.length, 1);
  audio.observe({ stage: 'moon' }); await flush();
  assert.equal(context.sources.length, 2);
  audio.reset();
  assert.equal(audio.state.activeVoices, 0);
  assert.equal(audio.state.lastCue, null);
  audio.observe({ stage: 'star' }); await flush();
  assert.equal(context.sources.length, 3);
  audio.destroy();
});

test('a delayed decode cannot sound during the next gesture', async () => {
  const context = new Context();
  const resolveSummon = context.defer('summon');
  const { audio } = harness({ context });
  await audio.unlock(); await flush();
  audio.observe({ stage: 'star' });
  audio.observe({ stage: 'sun' }); await flush();
  resolveSummon(); await audio.prepare(); await flush();
  assert.deepEqual(audio.state.history.map(item => item.id), ['sweepSun']);
  audio.destroy();
});

test('dialog suspension preserves preference and follows stages without playing missed cues', async () => {
  const { audio, context } = harness();
  await audio.unlock(); await audio.prepare();
  audio.observe({ stage: 'star' }); await flush();
  audio.suspend();
  assert.equal(audio.state.suspended, true);
  assert.equal(audio.state.enabled, true);
  assert.equal(audio.state.activeVoices, 0);
  audio.observe({ stage: 'sun' }); await flush();
  audio.resume();
  audio.observe({ stage: 'sun', hint: 'updated' }); await flush();
  assert.equal(audio.state.suspended, false);
  assert.equal(context.sources.length, 1, 'resume cannot replay the already observed sun stage');
  audio.observe({ stage: 'moon' }); await flush();
  assert.equal(context.sources.length, 2);
  audio.setEnabled(false);
  audio.suspend();
  audio.observe({ stage: 'moonHeld' });
  audio.resume();
  assert.equal(audio.state.enabled, false, 'dialog close preserves user mute');
  assert.equal(context.sources.length, 2);
  audio.destroy();
});

test('suspend invalidates queued decode and record appearances during the dialog', async () => {
  const context = new Context();
  const resolveSummon = context.defer('summon');
  const { audio } = harness({ context });
  await audio.unlock(); await flush();
  audio.observe({ stage: 'star' });
  audio.suspend();
  audio.resume();
  resolveSummon(); await audio.prepare(); await flush();
  assert.equal(context.sources.length, 0, 'a pending pre-dialog cue must not leak after close');
  audio.suspend();
  audio.observe({ stage: 'pan' });
  audio.visibleRecord();
  audio.resume();
  audio.visibleRecord(); await flush();
  assert.equal(context.sources.length, 0, 'a record already shown while suspended is not replayed');
  audio.observe({ stage: 'burst' }); await flush();
  assert.deepEqual(audio.state.history.map(item => item.id), ['burst']);
  audio.destroy();
});

test('reset and disable cancel queued decode callbacks', async () => {
  for (const action of ['reset', 'disable', 'destroy']) {
    const context = new Context();
    const resolveSummon = context.defer('summon');
    const { audio } = harness({ context });
    await audio.unlock(); await flush();
    audio.observe({ stage: 'star' });
    if (action === 'disable') audio.setEnabled(false);
    else audio[action]();
    resolveSummon(); await flush(); await flush();
    assert.equal(context.sources.length, 0, `${action} cancels pending source`);
    audio.destroy();
  }
});

test('a sample that decodes too late is dropped even within the same stage', async () => {
  const context = new Context();
  const resolveSummon = context.defer('summon');
  const { audio } = harness({ context });
  await audio.unlock(); await flush();
  audio.observe({ stage: 'star' });
  await new Promise(resolve => setTimeout(resolve, 275));
  resolveSummon(); await audio.prepare(); await flush();
  assert.equal(context.sources.length, 0);
  audio.destroy();
});

test('suspended contexts drop cues and unlock does not replay them', async () => {
  const { audio, context } = harness();
  await audio.unlock(); await audio.prepare();
  context.state = 'suspended';
  audio.observe({ stage: 'star' }); await flush();
  await audio.unlock(); await flush();
  assert.equal(context.sources.length, 0);
  audio.observe({ stage: 'sun' }); await flush();
  assert.equal(context.sources.length, 1);
  audio.destroy();
});

test('voice limits and bounded history hold over repeated sequences', async () => {
  const { audio, context } = harness();
  await audio.unlock(); await audio.prepare();
  for (let i = 0; i < 65; i++) {
    audio.observe({ stage: i % 2 ? 'sun' : 'star' }); await flush();
    assert.ok(audio.state.activeVoices <= 3);
  }
  assert.equal(audio.state.history.length, 48);
  assert.ok(context.sources[0].stopped);
  for (const source of context.sources.slice(-3)) source.finish();
  assert.equal(audio.state.activeVoices, 0);
  audio.destroy();
});

test('missing assets warn once, without throwing or stopping gesture updates', async () => {
  const { audio, errors } = harness({ missing: true });
  await audio.unlock();
  assert.equal(await audio.prepare(), false);
  for (const stage of stages) audio.observe({ stage });
  await flush();
  assert.equal(errors.length, 1);
  assert.equal(audio.state.activeVoices, 0);
  audio.destroy();
});
