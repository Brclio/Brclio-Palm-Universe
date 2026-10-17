# 本地手势跟踪模块

入口是 `public/hand-tracking.js`。`public/hand-tracking-worker.js` 是实现所需的独立 Worker，页面无需另行导入。仅调用 `start(videoElement)` 才会请求摄像头，模块导入与页面加载均不请求权限。

```js
import { HandTracker } from '/hand-tracking.js';

const tracker = new HandTracker({
  onStatus: ({ state, message, error }) => { /* 更新 UI */ },
  onResults: ({ hands, timestamp }) => { /* 绘制效果 */ },
});

// 在用户的点击处理器内调用；失败同时触发 error 状态并 reject。
await tracker.start(document.querySelector('video'));
// 关闭摄像头、停止 RAF、终止 Worker、释放模型。
tracker.stop();
```

## 输出约定

- `timestamp` 为浏览器 `performance.now()` 同时基的毫秒时间戳。
- `hands` 最多 2 只手。未检测到手时返回空数组。
- 每只手：`{ landmarks, handedness, gestures }`。
- `landmarks` 为原始 21 个 `{ x, y, z }`；不做镜像、不做位置平滑，供场景自行平滑。x/y 对应原始视频归一化坐标；镜像预览绘制时使用 `1 - x`，y 保持原值。若视频使用 `object-fit: cover`，绘制层还应应用相同裁剪与缩放。
- `handedness` 是模型原样返回的 `Left`、`Right` 或 `Unknown` 字符串，不因页面 CSS 镜像而交换。手部关联优先按掌心距离匹配，以免双手顺序变化使捏合状态跳转。

`gestures` 定义如下。这些是本项目根据 landmark 几何计算的交互规则，不是额外下载的手势分类模型。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `pinch` | boolean | 拇指尖与食指尖靠近；使用经宽高比校正的屏幕距离/掌心尺度，进入阈值 0.30，退出阈值 0.43，防止边缘抖动 |
| `pinchStrength` | 0–1 | 捏合强度，1 为更紧；进行轻量时间平滑 |
| `openPalm` | boolean | 四根长手指伸直，且未捏合；不强制拇指伸直 |
| `fist` | boolean | 四根长手指收起，且指尖向手腕弯回 |
| `pointing` | boolean | 食指伸直，中指、无名指、小指收起 |
| `victory` | boolean | 食指、中指伸直，无名指、小指收起 |
| `spread` | 0–1 | 伸直至少三根长手指时的指尖间距/掌宽张开度；越接近 1 越张开 |
| `extendedFingers` | integer | 伸直手指数 0–5，含拇指 |
| `fingerStates` | object | 额外字段，包含 `thumb/index/middle/ring/pinky` 五个 boolean |
| `palmCenter` | `{x,y}` | 手腕与四个掌指关节的平均位置 |
| `fingertip` | `{x,y}` | 食指尖位置，landmark 8 |
| `pinchCenter` | `{x,y}` | 拇指尖、食指尖中点，landmark 4/8 |

伸指判断优先采用模型输出的米制 3D 关节角度和指尖到手腕距离，因此不依赖手指在画面中向上还是向下。捏合用屏幕空间距离，避免拇指与食指相互遮挡时估算深度跳动。

## 状态与恢复

`onStatus` 接收 `{ state, message, error?, code? }`，状态为 `camera`、`loading`、`running`、`stopped`、`error`。error 为可序列化对象 `{ code, name, message, detail? }`。message 是可直接展示的中文说明；detail 保存底层异常信息。

摄像头权限拒绝、设备缺失/占用、不安全来源、模型加载失败、连续推理错误均可重试。相同视频重复 `start` 会复用当前流；启动期间重复调用共用同一 Promise。`stop` 会使尚未完成的启动作废；即使权限请求晚于 stop 才返回，也立即关闭其流。

Worker 模式最多推理 30 FPS、每次最多一个在途 ImageBitmap，推理图像最长宽度 640；不可使用 Worker 时回退到主线程，最多 24 FPS。页面隐藏时暂停推理。优先 GPU，初始化失败改 CPU；GPU 首帧或后续帧 3 秒未返回时终止该 Worker，并重建 CPU Worker。CPU 模式仍超时则回报 error，避免无结果永久等待。

## 模型与来源

于 2026-10-17 实时核验 npm `latest` 为 `@mediapipe/tasks-vision` **1.1.1**。下载后的 JS、SIMD/非 SIMD WASM、模型均位于 `public/vendor/mediapipe`；运行时只访问当前网页同源静态资源，不需要 CDN、API key 或后端。资产清单与 SHA-256 位于 `public/vendor/mediapipe/asset-manifest.json`，软件许可位于同目录 `LICENSE`。

- [Google 官方 Hand Landmarker Web 文档](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/web_js)：VIDEO 模式、21 点坐标、置信度选项及同步推理说明。
- [Google 官方模型与任务概览](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker)：手掌检测与手部 landmark 模型组合。
- [Google 官方 hand_landmarker.task / float16 / version 1](https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task)。
- [npm 官方发布元数据](https://registry.npmjs.org/@mediapipe/tasks-vision/latest)。
- [上游 Apache 2.0 许可](https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE)。

## 实测证据与边界

在本机 Chrome Headless 中，使用本地 HTTP 服务验证，未调用用户的真实摄像头。

1. 原视频抽帧直接送入 CPU Worker 模型；测试将 `getUserMedia` 替换为抛错函数，实际调用计数为 **0**。15 帧结果记录在 `analysis/hand-tracking-frame-validation.json`。例如 frame-0050/0100 各检出一只手、21 点、pointing=true；frame-0138 检出双手；frame-0180 检出一只手、21 点、openPalm=true、extendedFingers=5、spread=1。每帧均记录 pinch/openPalm 等状态，也如实记录没有检测到手的帧。
2. 浏览器虚拟摄像头测试记录在 `analysis/hand-tracking-lifecycle-validation.json`：GPU 软件渲染首帧超时后成功切换 CPU，收到 92 次结果回调；重复 start 复用同一个流；stop 后 track 为 ended、RAF 为 0、video.srcObject 为 null；同一实例能够再次启动。
3. 权限拒绝与启动取消的测试记录在 `analysis/hand-tracking-errors-validation.json`：拒绝权限后产生 permission-denied 中文状态、无遗留流/Worker/RAF；恢复权限后同一实例重新启动成功；并发 start 共用 Promise；请求尚未返回时 stop，迟到流的 track 立即 ended，启动以 AbortError 结束；测试捕获的外部域名请求为 **0**。
4. 叠加特效后的专项验证在 `analysis/hand-tracking-effects-validation.json`：指定的 15 帧中 13 帧检出手，frame-0490 命中 pinch（指尖距离/掌心尺度 0.2322），frame-0460 命中 openPalm。额外逐帧分析 frame-0585–0645，共 61 帧、19.4667–21.4667 秒，55 帧检出手；pinch 在 0609、0610、0614、0619 命中。0585、0607、0608、0611、0612、0613 没有检出手。frame-0600 能检出 21 点，但连续段指尖比例 0.9074，未进入 pinch；画面中该手是拇指与食指分开夹住月球的 C 形，不能将它与指尖接触的捏合视为同一几何条件。发光月球、白色骨架和较小的手部画面会使检测不连续，不能声称原视频特效段的 pinch 持续稳定。专项测试摄像头请求计数为 0，未据此修改模块阈值。

这些结果证明本地资源加载、真实模型推理、坐标/状态输出及基本生命周期运行通畅。未在真人摄像头、Safari、手机或不同光照/遮挡条件下完成实测；也不能据视频中的有限抽帧保证每种手势在所有人手上同样灵敏。
