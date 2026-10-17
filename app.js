import { UniverseScene } from './public/scene.js';
import { RecordAudio } from './public/record-audio.js';
import { InteractionAudio } from './public/interaction-audio.js';

const $=s=>document.querySelector(s);
const stage=$('#stage'),shell=$('.stage-shell'),canvas=$('#universe'),music=$('#music');
function fitStage(){const w=Math.min(shell.clientWidth,shell.clientHeight*16/9);stage.style.width=`${w}px`;stage.style.height=`${w*9/16}px`;}
fitStage();new ResizeObserver(fitStage).observe(shell);
const scene=new UniverseScene(canvas);
const modes=['star','sun','moon','phases','pan'];
const mouseHints={idle:'在画面里按住鼠标片刻，对应原片的收拢握拳。',star:'松开鼠标，从星星左侧向右横扫。',sun:'先移回左边，再向右横扫一次，换成月球。',moon:'移到月球上按住，拇指与食指会夹住它。',moonHeld:'保持按住，月球逐渐缩小；拖到右侧后松开。',moonReleased:'松开鼠标向左横扫，月相会依次展开。',phases:'回到最右侧满月上按住，把它夹起来。',phaseHeld:'保持按住向左上方拖动，再松开手指，月球化为黑胶唱片。',pan:'移到唱片旁，按住片刻再松开，对应握拳后张开五指。',burst:'月光散开了。点击「重来」重新开始。'};
const stageLabels={idle:'等待收拢手指',star:'星星',sun:'太阳',moon:'月球',moonHeld:'夹取月球',moonReleased:'月球已释放',phases:'月相展开',phaseHeld:'夹取后上举',pan:'黑胶唱片',burst:'月光散开'};
const guideRanges={idle:[14.5,16.6],star:[16.65,17.75],sun:[17.8,18.95],moon:[19.15,20.4],moonHeld:[19.5,21.9],moonReleased:[22.15,24.3],phases:[24.45,25.85],phaseHeld:[25.5,27.35],pan:[31.65,33.65],burst:[32.7,34.7]};
let tracker=null,cameraBusy=false,cameraRequest=0,toastTimer,lastStage='',guideRange=guideRanges.idle;
const recordAudio=new RecordAudio({audio:music,onState:musicUi,onError:error=>toast(error.message)});
const interactionAudio=new InteractionAudio({getContext:()=>recordAudio.context,onState:sfxUi,onError:error=>toast(error.message)});
void interactionAudio.prefetch();
function toast(message){$('#toast').textContent=message;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),4500);}
function status(state,message){$('#status-text').textContent=message;$('#status-dot').classList.toggle('loading',state==='loading');}
function refreshGuide(){guideRange=guideRanges[scene.sequence.stage]||guideRanges.idle;$('#guide-caption').textContent=scene.sequenceSnapshot?.hint||'';const video=$('#guide-video');if(!$('#gesture-guide').hidden){video.currentTime=guideRange[0];video.play().catch(()=>{});}}
function updateModeUi(){
  $('#camera').style.transform=scene.mirror?'scaleX(-1)':'none';
  $('#demo-toggle').classList.toggle('selected',!scene.camera);$('#demo-toggle').setAttribute('aria-pressed',String(!scene.camera));
  $('#camera-toggle').classList.toggle('selected',scene.camera);$('#camera-toggle').setAttribute('aria-pressed',String(scene.camera));
  $('#camera-label').textContent=scene.camera?'关闭摄像头':'开启摄像头';
  $('#idle-instruction').textContent=scene.camera?'像原片一样四指收拢握拳，拇指可伸出。':'在画面里按住鼠标片刻，召出星星。';
  $('#input-description').textContent=scene.camera?'左右以画面为准：向右扫过星球切换 · 张掌向左扫展开月相':'按住＝收拢 · 松开＝张手 · 横移＝挥手 · 按住拖动＝夹取移动';
}
scene.onSequence=s=>{
  if(s.stage==='idle'){recordAudio.reset();interactionAudio.reset();}
  else if(s.stage==='burst'&&lastStage!=='burst')recordAudio.dissolve();
  interactionAudio.observe(s);
  $('#gesture-hint').textContent=scene.camera?(s.stage==='idle'&&!s.tracked?'把手放进镜头，四指收拢握拳，拇指可伸出。':s.hint):mouseHints[s.stage];
  document.body.classList.toggle('has-input',s.stage!=='idle'||scene.pointerActive||scene.camera&&s.tracked);
  const mode=s.stage==='phaseHeld'?'phases':s.stage==='burst'?'pan':s.mode;
  document.querySelectorAll('.mode').forEach(e=>{e.classList.toggle('active',e.dataset.mode===mode);e.classList.toggle('done',modes.indexOf(e.dataset.mode)<modes.indexOf(mode));});
  if(lastStage!==s.stage){lastStage=s.stage;refreshGuide();}
};
scene.onRecordVisible=()=>{recordAudio.activate();interactionAudio.visibleRecord();};
function pointer(e,down){const r=canvas.getBoundingClientRect();scene.setPointer(e.clientX-r.left,e.clientY-r.top,down);document.body.classList.add('has-input');}
canvas.addEventListener('pointermove',e=>{if(!scene.camera)pointer(e,scene.down);});
canvas.addEventListener('pointerdown',e=>{if(scene.camera)return;canvas.setPointerCapture(e.pointerId);pointer(e,true);});
canvas.addEventListener('pointerup',e=>{if(!scene.camera)pointer(e,false);if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);});
canvas.addEventListener('pointercancel',()=>scene.down=false);
canvas.addEventListener('wheel',e=>{if(!scene.camera&&scene.down){e.preventDefault();scene.adjustGrip(e.deltaY*.003);}}, {passive:false});

function musicUi(state){
  const {playing,active,blocked,ready}=state;
  scene.recordPlaying=playing;
  const label=active?(playing?'暂停唱片音乐':'播放唱片音乐'):'唱片出现后自动播放';
  $('#music-toggle').disabled=!active;$('#play-icon').textContent=playing?'Ⅱ':'▶';
  $('#music-toggle').setAttribute('aria-label',label);$('#music-toggle').title=label;
  $('#equalizer').classList.toggle('playing',playing);
  $('#track-name').textContent=state.trackName;
  $('#track-subtitle').textContent=!active?'唱片出现时播放':playing?'唱片播放中 · 可替换音乐':blocked?'点击播放，启动唱片':!ready?'正在读取唱片音乐…':'唱片已暂停';
}
// The initial trusted input unlocks a silent context. Only the visible record
// opens the audio gate; camera/model callbacks need no additional play click.
function unlockMusic(e){if(e.target.closest?.('#music-toggle')||e.code==='Space')return;recordAudio.unlock();interactionAudio.unlock();}
document.addEventListener('pointerdown',unlockMusic,{capture:true});
document.addEventListener('keydown',unlockMusic,{capture:true});
$('#music-toggle').addEventListener('click',()=>{
  if(recordAudio.state.playing)recordAudio.pause();
  else{recordAudio.unlock();recordAudio.resume();}
});
function sfxUi(state){const button=$('#sfx-toggle');button.textContent=`音效：${state.enabled?'开':'关'}`;button.setAttribute('aria-pressed',String(state.enabled));}
$('#sfx-toggle').addEventListener('click',()=>interactionAudio.setEnabled(!interactionAudio.state.enabled));
$('#replace-music').addEventListener('click',()=>$('#music-file').click());
$('#music-file').addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;if(!file.type.startsWith('audio/')&&!/\.(mp3|wav|m4a|ogg|flac|aac|opus)$/i.test(file.name)){toast('请选择音频文件。');return;}await recordAudio.setFile(file);e.target.value='';});

async function startCamera(){
  if(cameraBusy)return;if(scene.camera){stopCamera();return;}
  if(!window.isSecureContext){toast('请通过 localhost 或 HTTPS 打开网页以使用摄像头。');return;}
  cameraBusy=true;const request=++cameraRequest;$('#camera-toggle').disabled=true;$('#camera-label').textContent='正在连接';status('loading','准备本地手势识别…');
  try{
    if(!tracker){const {HandTracker}=await import('./public/hand-tracking.js');tracker=new HandTracker({onResults:results=>{if(scene.camera)scene.setHands(results,$('#camera'));},onStatus:event=>{if(event.state==='error'&&scene.camera){stopCamera();status('error',event.message);toast(event.message);}else if(event.state==='camera'||event.state==='loading')status('loading',event.message);}});}
    await tracker.start($('#camera'));if(request!==cameraRequest){tracker.stop();return;}
    scene.setCamera(true);document.body.classList.add('camera-active');document.body.classList.remove('has-input');updateModeUi();status('ready','摄像头手势 · 收拢手指召星');
  }catch(error){
    if(request!==cameraRequest||error.name==='AbortError')return;
    tracker?.stop();scene.setCamera(false);document.body.classList.remove('camera-active');updateModeUi();
    const messages={NotAllowedError:'摄像头权限未开启。允许访问后可重试。',NotFoundError:'未找到摄像头，请检查连接。',NotReadableError:'摄像头被占用，请关闭其他使用它的应用后重试。'};
    toast(messages[error.name]||error.message||'手势模型加载失败，请重试。');status('error','鼠标操作 · 摄像头可重试');
  }finally{cameraBusy=false;$('#camera-toggle').disabled=false;updateModeUi();}
}
function stopCamera(){++cameraRequest;tracker?.stop();scene.setCamera(false);document.body.classList.remove('camera-active','has-input');updateModeUi();status('ready','鼠标操作 · 按住收拢，松开张手');}
$('#camera-toggle').addEventListener('click',startCamera);
$('#mirror-toggle').addEventListener('click',()=>{scene.mirror=!scene.mirror;$('#mirror-toggle').textContent=`镜像：${scene.mirror?'开':'关'}`;$('#mirror-toggle').setAttribute('aria-pressed',String(scene.mirror));updateModeUi();if(scene.camera){scene.resetSequence();toast('画面与关键点已同步翻转，从收拢手指重新开始。');}});
$('#demo-toggle').addEventListener('click',()=>{if(scene.camera||cameraBusy)stopCamera();else{scene.startRehearsal();document.body.classList.remove('has-input');}updateModeUi();status('ready','鼠标操作 · 按住收拢，松开张手');});
$('#restart').addEventListener('click',()=>{scene.resetSequence();scene.down=false;document.body.classList.remove('has-input');refreshGuide();});
$('#fullscreen').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await $('#experience').requestFullscreen();}catch{toast('当前浏览器不支持全屏。');}});
const guide=$('#gesture-guide'),guideVideo=$('#guide-video');
function setGuide(open){guide.hidden=!open;$('#guide-toggle').setAttribute('aria-pressed',String(open));if(open)refreshGuide();else guideVideo.pause();}
$('#guide-toggle').addEventListener('click',()=>setGuide(guide.hidden));$('#guide-close').addEventListener('click',()=>setGuide(false));
guideVideo.addEventListener('timeupdate',()=>{if(!guide.hidden&&guideVideo.currentTime>=guideRange[1]){guideVideo.currentTime=guideRange[0];guideVideo.play().catch(()=>{});}});
const dialog=$('#reference-dialog'),reference=$('#reference-video');
$('#reference-open').addEventListener('click',()=>{recordAudio.pause();interactionAudio.suspend();dialog.showModal();if(reference.currentTime<14)reference.currentTime=14;});
$('#reference-close').addEventListener('click',()=>dialog.close());dialog.addEventListener('close',()=>{reference.pause();interactionAudio.resume();});
dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
window.addEventListener('keydown',e=>{if(dialog.open||e.target.matches('input,textarea'))return;if(e.code==='Space'&&!e.target.matches('button,a')){e.preventDefault();$('#music-toggle').click();}else if(e.key.toLowerCase()==='h'){document.body.classList.toggle('clean');}else if(e.key==='Escape'&&document.body.classList.contains('clean'))document.body.classList.remove('clean');});
window.addEventListener('pagehide',e=>{stopCamera();recordAudio.reset();interactionAudio.reset();guideVideo.pause();if(!e.persisted){scene.destroy();interactionAudio.destroy();recordAudio.destroy();}});
setInterval(()=>{if(scene.camera)status('ready',scene.tracking?`已识别手掌 · ${stageLabels[scene.sequence.stage]}`:'手掌未进入识别范围');},600);
window.palmUniverse={scene,stopCamera,audio:recordAudio,sfx:interactionAudio};
scene.startRehearsal();updateModeUi();
musicUi(recordAudio.state);
sfxUi(interactionAudio.state);
