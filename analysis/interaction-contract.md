# 当前交互顺序与控制器接口

依据：原片关键帧与 `source-reaudit-v2.md`。可确认的是手型、动作顺序、物体位置与画面变化；原始源代码和识别参数未知。首页默认鼠标完整流程，摄像头共用同一控制器，16:9舞台提供当前步骤的原片示范。

## 顺序与响应

| 原片时间附近 | 手势 | 响应与状态 |
|---|---|---|
| 16.1秒 | 收拢四根长指握拳，拇指可外伸 | 召出原片材质的立体金星，随后固定：`idle → star` |
| 17.2秒 | 松手，从左向右扫过星星附近 | 星向右退出、太阳由左补入：`star → sun` |
| 18.4秒 | 手回左侧，拇食指伸出，再向右扫过太阳 | 太阳换月球：`sun → moon` |
| 19.5–21.4秒 | 月球附近C形夹取，夹小后向右移动 | 抓取后才跟手，按开口连续缩放：`moon → moonHeld` |
| 21.4秒 | 伸直食指并张开拇指释放 | 从最后持球点向右微移约.03画宽，约.6秒放大后固定：`moonHeld → moonReleased` |
| 23.03秒 | 五指张掌向左扫 | 触发后五个月相自主依次展开，右端满月及横排高度固定：`moonReleased → phases` |
| 25秒附近 | 回到最右端满月，C形夹取 | 小月球跟手，其他月相消退：`phases → phaseHeld` |
| 26.7秒 | 夹持向左上举起，再张开拇食指成L形 | 月球向手左下放大为黑胶唱片，唱臂与唱头保持独立形状：`phaseHeld → pan` |
| 33秒附近 | 唱片旁先握拳，再快速张开五指 | 只触发一次爆散，保持空场直到重来：`pan → burst` |

`pan` 是兼容已有数据的内部标识，用户看到的是黑胶唱片。底部流程进度不可跳步。静止V手势、反向横挥、远处横挥、未抓球就抬指、唱片旁仅张掌都不能替代上述动作。月相仅由左扫触发，其后按动画进度展开，不要求手持续拖完整排。

音乐绑定唱片显现事件：初次输入只静默解锁 AudioContext，所有前置阶段不创建播放节点、歌曲时间为0。`pan` 绘制出唱片后，`onRecordVisible` 才调用 `RecordAudio.activate()` 从头播放《茶花开了》。暂停/恢复同时控制盘面动态纹理；爆散用350毫秒淡出，重置与切换输入停止并归零。前置阶段替换曲目不会绕过此门控。

鼠标按住对应收拢或夹持、松开对应张手、横移对应挥手；摄像头使用真实手型和位置。鼠标是交互排练，不是用鼠标证明真人手势已全部验证。

## 公共API

`public/gesture-sequence.js` 无DOM、摄像头或渲染依赖，导出 `GestureSequence`、默认同名类和 `SEQUENCE_DEFAULTS`。

```js
import { GestureSequence } from './gesture-sequence.js';
const sequence = new GestureSequence({ onEvent(event) {}, thresholds: {} });
const observed = sequence.update(handOrNull, timeSeconds);
const animated = sequence.tick(timeSeconds);
const restarted = sequence.reset(timeSeconds);
```

时间单位为秒且单调。`update` 只提交新观察；`null` 表示没有可靠手部输入。模型两次结果之间使用 `tick` 推进动画，不能逐渲染帧反复提交同一缓存手势，否则会伪造连续手势证据。

输入示意：

```js
{
  palm: { x, y }, index: { x, y }, thumb: { x, y },
  pinchCenter: { x, y },
  aspectRatio, // 画布宽/高
  handSize,    // hypot(dx, dy/aspectRatio)，腕到中指掌指关节
  pinch, pinchStrength, openPalm, fist, pointing, victory, spread,
  fingerStates: { thumb, index, middle, ring, pinky }
}
```

坐标为最终显示画布中的0–1归一化坐标：右为x增加，上为y减小。摄像头未镜像的模型坐标必须先经过画面镜像/裁切映射。距离用宽度为单位的物理尺度，不能直接把不同宽高比例下的 `hypot(dx,dy)` 当掌长。

| 快照字段 | 含义 |
|---|---|
| `stage` / `mode` / `visible` | 当前顺序状态、绘制模式、是否显示主体。`phaseHeld` 使用 `moon` 模式并保留消退月相。 |
| `target` / `scale` | 当前或动画结束后的主体坐标、缩放；握持时才随指间点移动。 |
| `held` / `tracked` | 是否握持、是否有有效近期手部观察。 |
| `releaseOrigin` / `releaseTarget` / `releaseProgress` / `releaseScale` | 初次放球起点、最终目标、0–1恢复进度及释放前尺寸，供渲染器执行右移放大。 |
| `phaseAnchor` / `phaseSpan` / `phaseProgress` | 右端满月坐标、最大展开跨度、0–1动画进度；抓取后进度随消退动画下降。 |
| `panOrigin` / `panProgress` | 高举松开时的指间点、唱片形成进度；最终位置由释放点与掌长推导。 |
| `burst` / `burstTarget` | 当次更新的爆散脉冲与起点，下一次更新清除脉冲。 |
| `interaction` / `hint` / `time` | 操作状态、步骤提示、当前时间。 |

事件类型为 `stage`、`mode`、`burst`，携带当前状态、模式、时间和位置；切换事件另含先前状态。`reset` 返回空场快照，调用方同时清空粒子和画面过渡。

## 跟踪中断与验收范围

短暂漏检不合成手势，任意漏检清除稳定手势计时。约150毫秒内可保留已观测的横挥点；更长中断清除横挥历史，握持物体停住，必须在原位置附近重新夹取。已启动的释放恢复、月相、唱片形成等视觉动画可以继续，`tick` 不触发新抓取、释放或爆散。

现行规则报告为 `revision-gesture-validation.json`，浏览器报告为 `revision-browser-validation.json`。后者包含真实鼠标事件和明确标注的摄像头模型测试替身，没有操作真实摄像头。

`source-gesture-replay.json`、`source-replay-controller-validation.json` 是**上一版历史模型回放**：其坐标/掌长约定和控制器版本与当前不同，且全程未通过。不得据此声称本轮原片模型回放全部通过。原片烘焙特效遮挡手指，局部探针也不能替代全程回放。真人摄像头完整流程和实际识别手感尚未实测。
