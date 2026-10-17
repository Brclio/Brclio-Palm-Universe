/**
 * Single-shot sounds for the gesture sequence. These share the record's audio
 * context, but use their own gain and sources: pausing music never pauses SFX.
 * unlock/prepare only load audio. A stage change (or visibleRecord) plays it.
 */
const STAGE_CUES = Object.freeze({
  star: 'summon', sun: 'sweepSun', moon: 'sweepMoon', moonHeld: 'grab',
  moonReleased: 'release', phases: 'phases', phaseHeld: 'collect', burst: 'burst',
});
const MAX_VOICES = 3;
const MAX_LATE_MS = 250;
const HISTORY_LIMIT = 48;
const FADE_SECONDS = .015;
const nowMs = () => globalThis.performance?.now?.() ?? Date.now();

export class InteractionAudio {
  constructor({ getContext, onState = () => {}, onError = () => {},
    manifestUrl = new URL('./audio/sfx/manifest.json', import.meta.url).href } = {}) {
    this.getContext = getContext || (() => null);
    this.onState = onState;
    this.onError = onError;
    this._manifestUrl = manifestUrl;
    this._context = null;
    this._gain = null;
    this._enabled = true;
    this._suspended = false;
    this._destroyed = false;
    this._stage = 'idle';
    this._version = 0;
    this._recordVisible = false;
    this._manifest = null;
    this._manifestPromise = null;
    this._prefetchPromise = null;
    this._preparePromise = null;
    this._bytes = new Map();
    this._byteLoads = new Map();
    this._buffers = new Map();
    this._loads = new Map();
    this._voices = new Set();
    this._history = [];
    this._lastCue = null;
    this._errorSent = false;
    this._abort = new AbortController();
  }

  get state() {
    return {
      enabled: this._enabled,
      suspended: this._suspended,
      ready: Boolean(this._manifest?.size && this._buffers.size === this._manifest.size),
      lastCue: this._lastCue,
      activeVoices: this._voices.size,
      history: this._history.map(entry => ({ ...entry })),
    };
  }

  /** Call after recordAudio.unlock(), within the same trusted input handler. */
  unlock() {
    if (this._destroyed) return Promise.resolve(false);
    let context, resumed;
    try {
      context = this._connect();
      if (!context) return Promise.resolve(false);
      resumed = context.state === 'running' ? Promise.resolve() : context.resume();
    } catch (error) {
      this._error(error);
      return Promise.resolve(false);
    }
    void this.prepare();
    // Never replay a missed cue after a context is resumed.
    return Promise.resolve(resumed).then(() => context.state === 'running').catch(error => {
      this._error(error);
      return false;
    });
  }

  /** Safe to call repeatedly; downloading and decoding are entirely silent. */
  async prepare() {
    if (this._destroyed) return false;
    if (this._preparePromise) return this._preparePromise;
    try {
      if (!this._connect()) return false;
    } catch (error) {
      this._error(error);
      return false;
    }
    this._preparePromise = this._loadManifest().then(async manifest => {
      if (!manifest || this._destroyed) return false;
      await Promise.all([...manifest.keys()].map(id => this._loadCue(id)));
      this._emit();
      return this.state.ready;
    });
    return this._preparePromise;
  }

  /** Fetch on page load without creating/resuming an audio context or decoding. */
  prefetch() {
    if (this._destroyed) return Promise.resolve(false);
    if (this._prefetchPromise) return this._prefetchPromise;
    this._prefetchPromise = this._loadManifest().then(async manifest => {
      if (!manifest || this._destroyed) return false;
      const bytes = await Promise.all([...manifest.keys()].map(id => this._readCue(id)));
      return !this._destroyed && bytes.every(Boolean);
    });
    return this._prefetchPromise;
  }

  /** Frame, tracking and hint updates within a stage do not retrigger a sound. */
  observe(snapshot) {
    if (this._destroyed || !snapshot?.stage || snapshot.stage === this._stage) return;
    if (snapshot.stage === 'idle') {
      this.reset();
      return;
    }
    this._stage = snapshot.stage;
    this._version++;
    this._recordVisible = false;
    if (this._stage === 'burst') this._stopAll();
    const cue = STAGE_CUES[this._stage];
    if (cue) void this._trigger(cue);
  }

  /** The pan stage begins before the record is drawn; wait for that first draw. */
  visibleRecord() {
    if (this._destroyed || this._stage !== 'pan' || this._recordVisible) return;
    this._recordVisible = true;
    void this._trigger('record');
  }

  setEnabled(enabled) {
    const next = Boolean(enabled);
    if (this._destroyed || next === this._enabled) return;
    this._enabled = next;
    this._version++;
    if (!next) this._stopAll();
    // Re-enabling permits future gestures; it does not replay the current one.
    this._emit();
  }

  /** Temporarily silence gestures while watching the original video. */
  suspend() {
    if (this._destroyed || this._suspended) return;
    this._suspended = true;
    this._version++;
    this._stopAll();
    this._emit();
  }

  /** Keep the user's enabled preference and never replay a missed gesture. */
  resume() {
    if (this._destroyed || !this._suspended) return;
    this._suspended = false;
    this._emit();
  }

  reset() {
    this._version++;
    this._stage = 'idle';
    this._recordVisible = false;
    this._lastCue = null;
    this._stopAll();
    this._emit();
  }

  destroy() {
    if (this._destroyed) return;
    this.reset();
    this._destroyed = true;
    this._abort.abort();
    this._gain?.disconnect();
    this._gain = null;
    this._bytes.clear();
    this._byteLoads.clear();
    this._buffers.clear();
    this._loads.clear();
    // The record player owns this context and must be the only one to close it.
  }

  _connect() {
    if (this._context) return this._context;
    const context = this.getContext();
    if (!context || context.state === 'closed') return null;
    this._context = context;
    this._gain = context.createGain();
    this._gain.gain.value = .7;
    this._gain.connect(context.destination);
    return context;
  }

  _loadManifest() {
    if (this._manifestPromise) return this._manifestPromise;
    this._manifestPromise = fetch(this._manifestUrl, { signal: this._abort.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`操作音效清单读取失败（${response.status}）。`);
        const data = await response.json();
        const values = data.cues || data;
        const entries = Array.isArray(values) ? values : Object.entries(values).map(([id, value]) => ({ ...value, id }));
        const manifest = new Map(entries.filter(item => item?.id && item.file).map(item => [item.id, item]));
        if (!manifest.size) throw new Error('操作音效清单为空。');
        if (this._destroyed) return null;
        this._manifest = manifest;
        return manifest;
      }).catch(error => { this._error(error); return null; });
    return this._manifestPromise;
  }

  _readCue(id) {
    if (this._bytes.has(id)) return Promise.resolve(this._bytes.get(id));
    if (this._byteLoads.has(id)) return this._byteLoads.get(id);
    const promise = this._loadManifest().then(async manifest => {
      if (!manifest || this._destroyed) return null;
      const cue = manifest.get(id);
      if (!cue) throw new Error(`缺少操作音效：${id}。`);
      const response = await fetch(new URL(cue.file, this._manifestUrl), { signal: this._abort.signal });
      if (!response.ok) throw new Error(`操作音效 ${id} 读取失败（${response.status}）。`);
      const bytes = await response.arrayBuffer();
      if (this._destroyed) return null;
      this._bytes.set(id, bytes);
      return bytes;
    }).catch(error => { this._error(error); return null; });
    this._byteLoads.set(id, promise);
    return promise;
  }

  _loadCue(id) {
    if (this._buffers.has(id)) return Promise.resolve(this._buffers.get(id));
    if (this._loads.has(id)) return this._loads.get(id);
    const promise = this._readCue(id).then(async bytes => {
      if (!bytes || this._destroyed) return null;
      // decodeAudioData may detach its input; retain the prefetched bytes.
      const buffer = await this._context.decodeAudioData(bytes.slice(0));
      if (this._destroyed) return null;
      this._buffers.set(id, buffer);
      this._emit();
      return buffer;
    }).catch(error => { this._error(error); return null; });
    this._loads.set(id, promise);
    return promise;
  }

  async _trigger(id) {
    if (!this._enabled || this._suspended || this._destroyed) return false;
    const version = this._version;
    const stage = this._stage;
    const requestedAt = nowMs();
    try {
      const context = this._connect();
      // A camera gesture must not silently create a second audio context.
      if (!context || context.state !== 'running') return false;
      const buffer = await this._loadCue(id);
      if (!buffer || this._destroyed || !this._enabled || this._suspended || version !== this._version ||
          context.state !== 'running' || nowMs() - requestedAt > MAX_LATE_MS) return false;
      const cue = this._manifest.get(id);
      const duration = Math.min(buffer.duration, Number(cue.duration) || buffer.duration, 6);
      if (!(duration > 0)) return false;
      let startAt = context.currentTime;
      if (this._voices.size >= MAX_VOICES) {
        this._stopVoice(this._voices.values().next().value);
        startAt += FADE_SECONDS;
      }
      if (id === 'burst') startAt += FADE_SECONDS;
      const gain = context.createGain();
      const source = context.createBufferSource();
      const level = Math.max(0, Math.min(.8, Number.isFinite(Number(cue.gain)) ? Number(cue.gain) : .8));
      const fade = Math.min(FADE_SECONDS, duration / 3);
      gain.gain.setValueAtTime(0, startAt);
      gain.gain.linearRampToValueAtTime(level, startAt + fade);
      gain.gain.setValueAtTime(level, startAt + duration - fade);
      gain.gain.linearRampToValueAtTime(0, startAt + duration);
      source.buffer = buffer;
      source.loop = false;
      source.connect(gain);
      gain.connect(this._gain);
      const voice = { source, gain, level, timer: null };
      source.onended = () => this._finishVoice(voice);
      this._voices.add(voice);
      source.start(startAt, 0, duration);
      this._lastCue = id;
      this._history.push({ id, stage, at: startAt, duration, gain: level });
      if (this._history.length > HISTORY_LIMIT) this._history.shift();
      this._emit();
      return true;
    } catch (error) {
      this._error(error);
      return false;
    }
  }

  _stopAll() {
    for (const voice of [...this._voices]) this._stopVoice(voice);
  }

  _stopVoice(voice) {
    if (!voice || !this._voices.delete(voice)) return;
    const now = this._context.currentTime;
    if (typeof voice.gain.gain.cancelAndHoldAtTime === 'function') voice.gain.gain.cancelAndHoldAtTime(now);
    else {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(Math.min(voice.level, Math.max(0, voice.gain.gain.value)), now);
    }
    voice.gain.gain.linearRampToValueAtTime(0, now + FADE_SECONDS);
    try { voice.source.stop(now + FADE_SECONDS); } catch { /* Already ended. */ }
    // Also disconnect while a shared context is suspended and onended cannot run.
    voice.timer = setTimeout(() => this._finishVoice(voice), FADE_SECONDS * 1000 + 10);
  }

  _finishVoice(voice) {
    clearTimeout(voice.timer);
    voice.source.onended = null;
    voice.source.disconnect();
    voice.gain.disconnect();
    this._voices.delete(voice);
    this._emit();
  }

  _emit() { if (!this._destroyed) this.onState(this.state); }
  _error(error) {
    if (this._destroyed || error?.name === 'AbortError' || this._errorSent) return;
    this._errorSent = true;
    this.onError(error);
    this._emit();
  }
}
