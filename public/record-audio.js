/**
 * Audio belongs to the record stage, not to page entry or the first gesture.
 * Call unlock() synchronously from a real pointer/key event. It resumes an
 * otherwise silent AudioContext, so later model callbacks can call activate()
 * without a second click. The supplied <audio> is a source/configuration only;
 * it is never played in parallel with Web Audio.
 */
export class RecordAudio {
  constructor({ audio, onState = () => {}, onError = () => {} } = {}) {
    this.audio = audio || null;
    this.onState = onState;
    this.onError = onError;
    this._context = null;
    this._gain = null;
    this._source = null;
    this._buffer = null;
    this._bufferPromise = null;
    this._bytesPromise = null;
    this._abort = null;
    this._loadVersion = 0;
    this._playVersion = 0;
    this._active = false;
    this._wantPlaying = false;
    this._blocked = false;
    this._offset = 0;
    this._startedAt = 0;
    this._fadeTimer = null;
    this._progressTimer = null;
    this._destroyed = false;
    this._loop = audio ? audio.loop : true;
    this._volume = .65;
    const url = audio?.currentSrc || audio?.src || new URL('../茶花开了.m4a', import.meta.url).href;
    this._trackName = this._nameFromUrl(url);
    if (audio) {
      audio.autoplay = false;
      audio.pause();
      try { audio.currentTime = 0; } catch { /* Metadata may not be ready yet. */ }
    }
    // Fetching is silent. Decoding waits until a context exists after unlock.
    this._prepareBytes(signal => fetch(url, { signal }).then(response => {
      if (!response.ok) throw new Error(`音乐读取失败（${response.status}）。`);
      return response.arrayBuffer();
    }));
  }

  get state() {
    return {
      ready: Boolean(this._buffer),
      active: this._active,
      playing: Boolean(this._source && this._context?.state === 'running'),
      currentTime: this._position(),
      duration: this._buffer?.duration || 0,
      trackName: this._trackName,
      blocked: this._blocked,
    };
  }

  /** Must be invoked without an await before it in a trusted input handler. */
  unlock() {
    if (this._destroyed) return Promise.resolve(false);
    let context, resumed;
    try {
      context = this._getContext();
      // This call is deliberately synchronous with the trusted user event.
      resumed = context.state === 'running' ? Promise.resolve() : context.resume();
    } catch (error) {
      this._blocked = true;
      this._error(error);
      return Promise.resolve(false);
    }
    const load = this._ensureBuffer();
    return Promise.resolve(resumed).then(() => {
      this._blocked = context.state !== 'running';
      this._emit();
      if (this._active && this._wantPlaying) this._startWhenReady();
      // Unlock success does not wait for the entire song to decode.
      return !this._blocked;
    }).catch(error => {
      this._blocked = true;
      this._error(error);
      return false;
    }).finally(() => { void load; });
  }

  /** The only method that opens the record gate. Repeated calls are harmless. */
  activate() {
    if (this._destroyed || this._active) return Promise.resolve(false);
    this._cancelFade();
    this._stopSource();
    this._active = true;
    this._wantPlaying = true;
    this._offset = 0;
    this._playVersion++;
    this._emit();
    return this._startWhenReady();
  }

  pause() {
    this._cancelFade();
    this._offset = this._position();
    this._wantPlaying = false;
    this._playVersion++;
    this._stopSource();
    this._emit();
  }

  resume() {
    // A music button, key or file change cannot skip the interaction sequence.
    if (this._destroyed || !this._active) return Promise.resolve(false);
    this._wantPlaying = true;
    this._emit();
    return this._startWhenReady();
  }

  reset() {
    this._cancelFade();
    this._active = false;
    this._wantPlaying = false;
    this._playVersion++;
    this._stopSource();
    this._offset = 0;
    this._emit();
  }

  /** Close the gate immediately, then let the record's last sound fade out. */
  dissolve(seconds = .35) {
    this._cancelFade();
    this._active = false;
    this._wantPlaying = false;
    this._playVersion++;
    if (!this._source || this._context?.state !== 'running' || seconds <= 0) {
      this.reset();
      return;
    }
    const now = this._context.currentTime;
    this._gain.gain.cancelScheduledValues(now);
    this._gain.gain.setValueAtTime(this._volume, now);
    this._gain.gain.linearRampToValueAtTime(0, now + seconds);
    this._fadeTimer = setTimeout(() => {
      this._fadeTimer = null;
      this._stopSource();
      this._offset = 0;
      this._emit();
    }, seconds * 1000);
    this._emit();
  }

  async setFile(file) {
    if (this._destroyed || !file || typeof file.arrayBuffer !== 'function') return false;
    this._cancelFade();
    this._stopSource();
    this._offset = 0;
    this._playVersion++;
    this._wantPlaying = this._active;
    this._trackName = (file.name || '本地音乐').replace(/\.[^.]+$/, '');
    const loadVersion = this._prepareBytes(() => file.arrayBuffer());
    this._emit();
    await this._ensureBuffer();
    if (loadVersion !== this._loadVersion || this._destroyed) return false;
    if (this._active && this._wantPlaying) return this._startWhenReady();
    this._emit();
    return Boolean(this._buffer);
  }

  destroy() {
    if (this._destroyed) return;
    this.reset();
    this._destroyed = true;
    this._abort?.abort();
    this._loadVersion++;
    if (this._context) {
      this._context.onstatechange = null;
      this._context.close().catch(() => {});
    }
    this._buffer = null;
    this._bytesPromise = null;
  }

  _getContext() {
    if (this._context) return this._context;
    const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Context) throw new Error('当前浏览器不支持唱片音频播放。');
    const context = this._context = new Context({ latencyHint: 'interactive' });
    this._gain = context.createGain();
    this._gain.gain.value = this._volume;
    this._gain.connect(context.destination);
    context.onstatechange = () => {
      if (this._destroyed) return;
      if (context.state === 'running') {
        this._blocked = false;
        if (this._active && this._wantPlaying && !this._source) this._startWhenReady();
      } else if (this._active && this._wantPlaying) this._blocked = true;
      this._emit();
    };
    return context;
  }

  _prepareBytes(read) {
    this._abort?.abort();
    this._abort = new AbortController();
    const signal = this._abort.signal;
    const version = ++this._loadVersion;
    this._buffer = null;
    this._bufferPromise = null;
    this._bytesPromise = Promise.resolve().then(() => read(signal)).catch(error => {
      if (version === this._loadVersion && error.name !== 'AbortError') this._error(error);
      return null;
    });
    return version;
  }

  _ensureBuffer() {
    if (this._buffer) return Promise.resolve(this._buffer);
    if (this._bufferPromise) return this._bufferPromise;
    const version = this._loadVersion;
    this._bufferPromise = this._bytesPromise.then(async bytes => {
      if (!bytes || version !== this._loadVersion || this._destroyed) return null;
      const buffer = await this._getContext().decodeAudioData(bytes);
      if (version !== this._loadVersion || this._destroyed) return null;
      this._buffer = buffer;
      this._bytesPromise = null;
      this._emit();
      return buffer;
    }).catch(error => {
      if (version === this._loadVersion && !this._destroyed) this._error(new Error(`音乐解码失败，请替换为 MP3、WAV 或 M4A 文件。${error.message ? ` ${error.message}` : ''}`));
      return null;
    });
    return this._bufferPromise;
  }

  async _startWhenReady() {
    const version = this._playVersion;
    const buffer = await this._ensureBuffer();
    if (!buffer || version !== this._playVersion || !this._active || !this._wantPlaying || this._source || this._destroyed) return false;
    const context = this._getContext();
    if (context.state !== 'running') {
      this._blocked = true;
      this._emit();
      return false;
    }
    this._blocked = false;
    this._offset = this._offset >= buffer.duration ? 0 : this._offset;
    const source = this._source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = this._loop;
    source.connect(this._gain);
    this._gain.gain.cancelScheduledValues(context.currentTime);
    this._gain.gain.setValueAtTime(this._volume, context.currentTime);
    this._startedAt = context.currentTime;
    source.onended = () => {
      if (source !== this._source) return;
      this._offset = buffer.duration;
      this._wantPlaying = false;
      this._stopSource();
      this._emit();
    };
    source.start(0, this._offset);
    this._progressTimer = setInterval(() => this._emit(), 125);
    this._emit();
    return true;
  }

  _position() {
    const elapsed = this._source && this._context ? this._context.currentTime - this._startedAt : 0;
    const value = Math.max(0, this._offset + elapsed);
    const duration = this._buffer?.duration || 0;
    return duration ? (this._loop && this._source ? value % duration : Math.min(value, duration)) : 0;
  }

  _stopSource() {
    clearInterval(this._progressTimer);
    this._progressTimer = null;
    if (!this._source) return;
    const source = this._source;
    this._source = null;
    source.onended = null;
    try { source.stop(); } catch { /* A naturally completed node is already stopped. */ }
    source.disconnect();
  }

  _cancelFade() {
    clearTimeout(this._fadeTimer);
    this._fadeTimer = null;
    if (this._gain) {
      this._gain.gain.cancelScheduledValues(this._context.currentTime);
      this._gain.gain.setValueAtTime(this._volume, this._context.currentTime);
    }
  }

  _nameFromUrl(url) {
    try { return decodeURIComponent(new URL(url, globalThis.location?.href).pathname.split('/').pop()).replace(/\.[^.]+$/, '') || '茶花开了'; }
    catch { return '茶花开了'; }
  }

  _emit() { if (!this._destroyed) this.onState(this.state); }
  _error(error) { if (!this._destroyed) { this.onError(error); this._emit(); } }
}
