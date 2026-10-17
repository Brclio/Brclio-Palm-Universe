/* Runs MediaPipe on an isolated thread. This is a classic worker intentionally:
 * MediaPipe's WASM loader uses importScripts, including on browsers without SIMD. */
let task = null;
let initialized = false;

const serializeError = (error) => ({
  name: error?.name || 'Error',
  message: error?.message || String(error),
});

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    if (initialized) return;
    initialized = true;
    try {
      const { FilesetResolver, HandLandmarker } = await import(data.moduleURL);
      const fileset = await FilesetResolver.forVisionTasks(data.wasmURL);
      const options = {
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.55,
        minHandPresenceConfidence: 0.55,
        minTrackingConfidence: 0.5,
      };
      let delegate = data.delegate || 'GPU';
      try {
        task = await HandLandmarker.createFromOptions(fileset, {
          ...options,
          baseOptions: { modelAssetPath: data.modelURL, delegate },
        });
      } catch {
        delegate = 'CPU';
        task = await HandLandmarker.createFromOptions(fileset, {
          ...options,
          baseOptions: { modelAssetPath: data.modelURL, delegate },
        });
      }
      self.postMessage({ type: 'ready', delegate });
    } catch (error) {
      self.postMessage({ type: 'error', phase: 'init', error: serializeError(error) });
    }
    return;
  }

  if (data.type === 'frame') {
    const bitmap = data.bitmap;
    try {
      if (!task) throw new Error('The hand model is not initialized.');
      const result = task.detectForVideo(bitmap, data.timestamp);
      self.postMessage({
        type: 'results',
        timestamp: data.timestamp,
        landmarks: result.landmarks,
        worldLandmarks: result.worldLandmarks,
        handedness: result.handedness,
      });
    } catch (error) {
      self.postMessage({ type: 'error', phase: 'frame', error: serializeError(error) });
    } finally {
      bitmap?.close();
    }
  }
};
