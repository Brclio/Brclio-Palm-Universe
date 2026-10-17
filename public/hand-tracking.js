/**
 * Local, camera-only hand tracking. Importing this file never opens the camera.
 * Call start(videoElement) from a user click; stop() releases every camera track.
 * Coordinates are the original, UNMIRRORED MediaPipe normalized coordinates.
 * A mirrored preview should draw at x = 1 - landmark.x.
 */
const VENDOR = new URL('./vendor/mediapipe/', import.meta.url);
const MODEL_URL = new URL('hand_landmarker.task', VENDOR).href;
const MODULE_URL = new URL('vision_bundle.mjs', VENDOR).href;
const WASM_URL = new URL('wasm', VENDOR).href;
const MAX_FPS = 30;
const MAIN_THREAD_FPS = 24;
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
const abortError = () => new DOMException('Hand tracking was stopped.', 'AbortError');

function angle(a, b, c) {
  const ab = { x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) };
  const cb = { x: c.x - b.x, y: c.y - b.y, z: (c.z || 0) - (b.z || 0) };
  const length = Math.hypot(ab.x, ab.y, ab.z) * Math.hypot(cb.x, cb.y, cb.z);
  return length ? Math.acos(clamp((ab.x * cb.x + ab.y * cb.y + ab.z * cb.z) / length, -1, 1)) * 180 / Math.PI : 0;
}

function gestureMetrics(landmarks, worldLandmarks, aspect, previous) {
  // Meter-space geometry avoids orientation and video aspect ratio assumptions.
  const imagePoints = landmarks.map(({ x, y }) => ({ x: x * aspect, y }));
  const p = worldLandmarks?.length === 21
    ? worldLandmarks
    : landmarks.map(({ x, y, z }) => ({ x: x * aspect, y, z: z * aspect }));
  const palmWidth = Math.max(distance(p[5], p[17]), 0.00001);
  const palmSize = Math.max((distance(p[0], p[9]) + palmWidth) / 2, 0.00001);
  const fingers = [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
  const extended = fingers.map(([mcp, pip, dip, tip]) => (
    angle(p[mcp], p[pip], p[dip]) > 149
    && angle(p[pip], p[dip], p[tip]) > 145
    && distance(p[tip], p[0]) > distance(p[pip], p[0]) * 1.1
  ));
  const thumb = angle(p[2], p[3], p[4]) > 150
    && distance(p[4], p[17]) > distance(p[3], p[17]) * 1.07
    && distance(p[4], p[5]) > palmSize * 0.32;
  const count = extended.reduce((sum, value) => sum + Number(value), 0);
  // Screen-space contact matches the rendered cursor; inferred depth is less
  // stable precisely when the thumb and index fingertip occlude one another.
  const imagePalmSize = Math.max((distance(imagePoints[0], imagePoints[9]) + distance(imagePoints[5], imagePoints[17])) / 2, 0.00001);
  const pinchRatio = distance(imagePoints[4], imagePoints[8]) / imagePalmSize;
  // Separate enter/leave thresholds prevent flicker at the pinch boundary.
  const pinch = pinchRatio < (previous?.pinch ? 0.43 : 0.30);
  const strength = clamp((0.82 - pinchRatio) / 0.64);
  const pinchStrength = previous ? strength * 0.7 + previous.pinchStrength * 0.3 : strength;
  const spread = count >= 3
    ? clamp((distance(p[8], p[12]) + distance(p[12], p[16]) + distance(p[16], p[20])) / (palmWidth * 1.3))
    : 0;
  const palmCenter = [0, 5, 9, 13, 17].reduce((center, index) => ({
    x: center.x + landmarks[index].x / 5,
    y: center.y + landmarks[index].y / 5,
  }), { x: 0, y: 0 });

  return {
    pinch,
    pinchStrength,
    openPalm: count === 4 && !pinch,
    fist: count === 0 && fingers.every(([, pip, , tip]) => distance(p[tip], p[0]) < distance(p[pip], p[0]) * 1.14),
    pointing: extended[0] && !extended[1] && !extended[2] && !extended[3],
    victory: extended[0] && extended[1] && !extended[2] && !extended[3],
    spread,
    extendedFingers: count + Number(thumb),
    fingerStates: { thumb, index: extended[0], middle: extended[1], ring: extended[2], pinky: extended[3] },
    palmCenter,
    fingertip: { x: landmarks[8].x, y: landmarks[8].y },
    pinchCenter: midpoint(landmarks[4], landmarks[8]),
  };
}

function classifyError(error, phase) {
  const names = {
    NotAllowedError: ['permission-denied', '摄像头权限未开启，请在浏览器地址栏允许摄像头后重试。'],
    PermissionDeniedError: ['permission-denied', '摄像头权限未开启，请在浏览器地址栏允许摄像头后重试。'],
    NotFoundError: ['camera-not-found', '没有找到摄像头，请连接摄像头后重试。'],
    DevicesNotFoundError: ['camera-not-found', '没有找到摄像头，请连接摄像头后重试。'],
    NotReadableError: ['camera-busy', '摄像头暂时无法使用，请关闭占用摄像头的其他应用后重试。'],
    TrackStartError: ['camera-busy', '摄像头暂时无法使用，请关闭占用摄像头的其他应用后重试。'],
    OverconstrainedError: ['camera-settings', '摄像头不支持当前设置，请更换摄像头后重试。'],
    SecurityError: ['insecure-context', '请通过 localhost 或 HTTPS 打开网页以启用摄像头。'],
  };
  const [code, message] = names[error?.name] || (
    phase === 'model' ? ['model-failed', '手势模型加载失败，请刷新页面或点击重试。']
      : phase === 'video' ? ['video-failed', '摄像头画面尚未准备好，请重试。']
        : phase === 'tracking' ? ['tracking-failed', '手势跟踪暂时中断，请点击重试。']
          : ['camera-failed', '摄像头启动失败，请检查摄像头权限后重试。']
  );
  return { code, message, name: error?.name || 'Error', detail: error?.message || String(error) };
}

export class HandTracker {
  constructor({ onResults = () => {}, onStatus = () => {} } = {}) {
    this.onResults = onResults;
    this.onStatus = onStatus;
    this._generation = 0;
    this._stream = null;
    this._video = null;
    this._worker = null;
    this._task = null;
    this._raf = 0;
    this._running = false;
    this._inFlight = false;
    this._startPromise = null;
    this._cancelWait = null;
    this._lastFrameAt = 0;
    this._lastVideoTime = -1;
    this._previousHands = [];
    this._frameErrors = 0;
    this._bitmapResizeSupported = true;
    this._frameTimer = 0;
    this._workerDelegate = null;
    this._usedCPURecovery = false;
  }

  _emitStatus(state, message, error) {
    try { this.onStatus({ state, message, ...(error ? { error, code: error.code } : {}) }); }
    catch (callbackError) { console.error('HandTracker onStatus callback failed:', callbackError); }
  }

  _emitResults(result) {
    try { this.onResults(result); }
    catch (callbackError) { console.error('HandTracker onResults callback failed:', callbackError); }
  }

  start(videoElement) {
    if (this._running && this._video === videoElement) return Promise.resolve(this);
    if (this._startPromise) return this._startPromise;
    this._teardown();
    const generation = ++this._generation;
    this._video = videoElement;
    this._usedCPURecovery = false;
    this._startPromise = (async () => {
      let phase = 'camera';
      try {
        if (!videoElement || videoElement.tagName !== 'VIDEO') {
          throw new TypeError('HandTracker.start requires a video element.');
        }
        if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
          throw new DOMException('Camera access requires localhost or HTTPS.', 'SecurityError');
        }
        this._emitStatus('camera', '正在请求摄像头权限…');
        // Only this explicit method ever requests camera access.
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
        });
        if (generation !== this._generation) {
          stream.getTracks().forEach((track) => track.stop());
          throw abortError();
        }
        this._stream = stream;
        stream.getVideoTracks().forEach((track) => track.addEventListener('ended', () => {
          if (generation !== this._generation || this._stream !== stream) return;
          const error = { code: 'camera-ended', name: 'NotReadableError', message: '摄像头连接已断开，请重新连接后重试。' };
          this.stop();
          this._emitStatus('error', error.message, error);
        }, { once: true }));
        videoElement.muted = true;
        videoElement.playsInline = true;
        videoElement.srcObject = stream;
        phase = 'video';
        await this._prepareVideo(videoElement, generation);
        if (generation !== this._generation) throw abortError();
        phase = 'model';
        this._emitStatus('loading', '正在加载本地手势模型…');
        await this._createEngine(generation);
        if (generation !== this._generation) throw abortError();
        this._running = true;
        this._lastFrameAt = 0;
        this._lastVideoTime = -1;
        this._frameErrors = 0;
        this._emitStatus('running', '手势跟踪已就绪');
        this._loop(generation);
        return this;
      } catch (error) {
        if (generation === this._generation) {
          this._teardown();
          if (error?.name !== 'AbortError') {
            const details = classifyError(error, phase);
            this._emitStatus('error', details.message, details);
          }
        }
        throw error;
      } finally {
        if (generation === this._generation) this._startPromise = null;
      }
    })();
    return this._startPromise;
  }

  async _prepareVideo(video, generation) {
    await video.play();
    if (video.readyState >= 2 && video.videoWidth) return;
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        video.removeEventListener('loadeddata', ready);
        video.removeEventListener('error', failed);
        if (this._cancelWait === cancel) this._cancelWait = null;
        error ? reject(error) : resolve();
      };
      const ready = () => generation === this._generation ? finish() : finish(abortError());
      const failed = () => finish(new Error('Camera video could not be decoded.'));
      const cancel = () => finish(abortError());
      const timer = setTimeout(() => finish(new Error('Camera video timed out.')), 12000);
      this._cancelWait = cancel;
      video.addEventListener('loadeddata', ready, { once: true });
      video.addEventListener('error', failed, { once: true });
      if (video.readyState >= 2 && video.videoWidth) ready();
    });
  }

  async _createEngine(generation) {
    if (typeof Worker !== 'undefined' && typeof createImageBitmap === 'function') {
      try {
        await this._createWorker(generation);
        return;
      } catch (error) {
        if (generation !== this._generation) throw abortError();
        this._worker?.terminate();
        this._worker = null;
        console.info('HandTracker: worker unavailable; using the local main-thread model.', error?.message);
      }
    }
    const { FilesetResolver, HandLandmarker } = await import(MODULE_URL);
    if (generation !== this._generation) throw abortError();
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    const options = { runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.55, minHandPresenceConfidence: 0.55, minTrackingConfidence: 0.5 };
    let task;
    try {
      task = await HandLandmarker.createFromOptions(fileset, { ...options, baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' } });
    } catch {
      if (generation !== this._generation) throw abortError();
      task = await HandLandmarker.createFromOptions(fileset, { ...options, baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' } });
    }
    if (generation !== this._generation) { task.close(); throw abortError(); }
    this._task = task;
  }

  _createWorker(generation, delegate = 'GPU') {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./hand-tracking-worker.js', import.meta.url));
      this._worker = worker;
      let ready = false;
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this._cancelWait === cancel) this._cancelWait = null;
        error ? reject(error) : resolve();
      };
      const cancel = () => finish(abortError());
      const timer = setTimeout(() => finish(new Error('Local model initialization timed out.')), 45000);
      this._cancelWait = cancel;
      worker.onerror = (event) => {
        const error = new Error(event.message || 'Hand tracking worker failed.');
        if (!ready) finish(error);
        else this._trackingError(error, generation);
      };
      worker.onmessage = ({ data }) => {
        if (generation !== this._generation || this._worker !== worker) return;
        if (data.type === 'ready') { ready = true; this._workerDelegate = data.delegate; finish(); }
        else if (data.type === 'results') {
          clearTimeout(this._frameTimer);
          this._frameTimer = 0;
          this._inFlight = false;
          this._frameErrors = 0;
          this._processResults(data, data.timestamp);
        } else if (data.type === 'error') {
          const error = Object.assign(new Error(data.error.message), { name: data.error.name });
          if (!ready) finish(error);
          else this._trackingError(error, generation);
        }
      };
      worker.postMessage({ type: 'init', moduleURL: MODULE_URL, wasmURL: WASM_URL, modelURL: MODEL_URL, delegate });
    });
  }

  _loop(generation) {
    if (!this._running || generation !== this._generation) return;
    this._raf = requestAnimationFrame((timestamp) => {
      this._loop(generation);
      const video = this._video;
      const interval = 1000 / (this._worker ? MAX_FPS : MAIN_THREAD_FPS);
      if (document.hidden || this._inFlight || !video || video.readyState < 2
        || timestamp - this._lastFrameAt < interval || video.currentTime === this._lastVideoTime) return;
      this._lastFrameAt = timestamp;
      this._lastVideoTime = video.currentTime;
      this._inFlight = true;
      if (this._worker) {
        this._frameTimer = setTimeout(() => this._recoverWorker(generation), 3000);
        this._sendFrame(video, timestamp, generation);
      }
      else {
        try {
          const result = this._task.detectForVideo(video, timestamp);
          this._inFlight = false;
          this._frameErrors = 0;
          this._processResults(result, timestamp);
        } catch (error) { this._trackingError(error, generation); }
      }
    });
  }

  async _sendFrame(video, timestamp, generation) {
    let bitmap;
    const worker = this._worker;
    try {
      if (this._bitmapResizeSupported) {
        const width = Math.min(640, video.videoWidth);
        const height = Math.max(1, Math.round(video.videoHeight * width / video.videoWidth));
        try { bitmap = await createImageBitmap(video, { resizeWidth: width, resizeHeight: height, resizeQuality: 'low' }); }
        catch { this._bitmapResizeSupported = false; }
      }
      if (!bitmap) bitmap = await createImageBitmap(video);
      if (generation !== this._generation || !this._running || this._worker !== worker) { bitmap.close(); return; }
      worker.postMessage({ type: 'frame', bitmap, timestamp }, [bitmap]);
    } catch (error) {
      bitmap?.close();
      if (this._worker !== worker) return;
      this._trackingError(error, generation);
    }
  }

  async _recoverWorker(generation) {
    if (generation !== this._generation || !this._running) return;
    this._frameTimer = 0;
    this._worker?.terminate();
    this._worker = null;
    this._inFlight = true;
    if (this._usedCPURecovery || this._workerDelegate === 'CPU') {
      const details = classifyError(new Error('The hand model did not return a camera frame within 3 seconds.'), 'tracking');
      this.stop();
      this._emitStatus('error', details.message, details);
      return;
    }
    this._usedCPURecovery = true;
    this._emitStatus('loading', '正在切换兼容手势模式…');
    try {
      await this._createWorker(generation, 'CPU');
      if (generation !== this._generation || !this._running) return;
      this._inFlight = false;
      this._lastVideoTime = -1;
      this._emitStatus('running', '手势跟踪已就绪');
    } catch (error) {
      if (generation !== this._generation) return;
      const details = classifyError(error, 'tracking');
      this.stop();
      this._emitStatus('error', details.message, details);
    }
  }

  _processResults(result, timestamp) {
    const previous = this._previousHands.filter((hand) => timestamp - hand.timestamp < 400);
    const used = new Set();
    const aspect = (this._video?.videoWidth || 1) / (this._video?.videoHeight || 1);
    const hands = (result.landmarks || []).map((source, index) => {
      const landmarks = source.map(({ x, y, z }) => ({ x, y, z }));
      const handedness = result.handedness?.[index]?.[0]?.categoryName || 'Unknown';
      let nearest = -1;
      let nearestDistance = 0.35;
      previous.forEach((hand, oldIndex) => {
        if (used.has(oldIndex)) return;
        const delta = Math.hypot(hand.gestures.palmCenter.x - landmarks[9].x, hand.gestures.palmCenter.y - landmarks[9].y)
          + (hand.handedness === handedness ? 0 : 0.025);
        if (delta < nearestDistance) { nearest = oldIndex; nearestDistance = delta; }
      });
      if (nearest >= 0) used.add(nearest);
      const gestures = gestureMetrics(landmarks, result.worldLandmarks?.[index], aspect, previous[nearest]?.gestures);
      return { landmarks, handedness, gestures };
    });
    this._previousHands = hands.map((hand) => ({ ...hand, timestamp }));
    this._emitResults({ hands, timestamp });
  }

  _trackingError(error, generation) {
    if (generation !== this._generation || !this._running) return;
    clearTimeout(this._frameTimer);
    this._frameTimer = 0;
    this._inFlight = false;
    // An isolated camera frame can fail while a tab resumes; allow recovery.
    if (++this._frameErrors < 3) return;
    const details = classifyError(error, 'tracking');
    this.stop();
    this._emitStatus('error', details.message, details);
  }

  _teardown() {
    this._running = false;
    clearTimeout(this._frameTimer);
    this._frameTimer = 0;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._cancelWait?.();
    this._cancelWait = null;
    this._worker?.terminate();
    this._worker = null;
    this._workerDelegate = null;
    try { this._task?.close(); } catch { /* Already disposed by MediaPipe. */ }
    this._task = null;
    const stream = this._stream;
    stream?.getTracks().forEach((track) => track.stop());
    if (this._video?.srcObject === stream) {
      this._video.pause();
      this._video.srcObject = null;
    }
    this._stream = null;
    this._video = null;
    this._inFlight = false;
    this._previousHands = [];
  }

  stop() {
    ++this._generation;
    this._teardown();
    this._startPromise = null;
    this._emitResults({ hands: [], timestamp: performance.now() });
    this._emitStatus('stopped', '摄像头已关闭');
  }
}

export default HandTracker;
