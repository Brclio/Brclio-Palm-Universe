import { GestureSequence } from './gesture-sequence.js';
import { loadReferenceEffects } from './reference-effects.js';

const TAU = Math.PI * 2;
const EDGES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[0,17],[17,18],[18,19],[19,20]];
const clamp = (v,a,b) => Math.min(b,Math.max(a,v));
let seed = 9182;
const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
function noiseGrid(size) { return Float32Array.from({length:size*size},random); }
const noise = [noiseGrid(8),noiseGrid(16),noiseGrid(32),noiseGrid(64),noiseGrid(128)];
function sampleNoise(x,y,octave) {
  const grid=noise[octave], n=8<<octave;
  const gx=x*(n-1), gy=y*(n-1), ix=Math.floor(gx), iy=Math.floor(gy), fx=gx-ix, fy=gy-iy;
  const a=grid[iy*n+ix],b=grid[iy*n+Math.min(n-1,ix+1)],c=grid[Math.min(n-1,iy+1)*n+ix],d=grid[Math.min(n-1,iy+1)*n+Math.min(n-1,ix+1)];
  return (a+(b-a)*fx)*(1-fy)+(c+(d-c)*fx)*fy;
}
function moonTexture(phase=0) {
  const size=256, canvas=document.createElement('canvas'); canvas.width=canvas.height=size;
  const c=canvas.getContext('2d'),img=c.createImageData(size,size);
  const craters=Array.from({length:42},()=>({x:random()*1.7-.85,y:random()*1.7-.85,r:.015+random()*.12,depth:.1+random()*.2}));
  for(let y=0;y<size;y++)for(let x=0;x<size;x++) {
    const nx=(x-size/2)/(size/2-2),ny=(y-size/2)/(size/2-2),rr=nx*nx+ny*ny;
    if(rr>=1)continue;
    const z=Math.sqrt(1-rr), u=x/size,v=y/size;
    let tex=0;
    for(let o=0;o<5;o++)tex+=sampleNoise(u,v,o)*[.42,.28,.17,.09,.04][o];
    const mare = Math.sin(nx*8+Math.sin(ny*4)*2)*Math.cos(ny*7-nx*2);
    tex=tex*.7+.25+(mare>.22?-.14:0);
    for(const cr of craters){const d=Math.hypot(nx-cr.x,ny-cr.y)/cr.r;if(d<1.15){tex-=Math.exp(-d*d*5)*cr.depth;tex+=Math.exp(-Math.pow(d-.85,2)*100)*.12;}}
    const lighting=clamp(nx*Math.sin(phase)+z*Math.cos(phase),0,1);
    const shade=(.11+.89*Math.pow(lighting,.45))*(.7+.3*z);
    const lum=clamp((135+tex*145)*shade,0,255), i=(y*size+x)*4;
    img.data[i]=lum;img.data[i+1]=lum*.99;img.data[i+2]=lum*.89;img.data[i+3]=clamp((1-rr)*120,0,1)*255;
  }
  c.putImageData(img,0,0);return canvas;
}
function sunTexture(){
  const cv=document.createElement('canvas');cv.width=cv.height=256;const c=cv.getContext('2d');
  const img=c.createImageData(256,256);
  for(let y=0;y<256;y++)for(let x=0;x<256;x++){
    const nx=(x-128)/125,ny=(y-128)/125,r=nx*nx+ny*ny;if(r>=1)continue;
    const t=sampleNoise(x/256,y/256,4)*.65+sampleNoise(x/256,y/256,2)*.35;
    const z=Math.sqrt(1-r),i=(y*256+x)*4;
    img.data[i]=255;img.data[i+1]=clamp(120+t*130+z*20,0,255);img.data[i+2]=20+t*t*160;img.data[i+3]=clamp((1-r)*100,0,1)*255;
  }c.putImageData(img,0,0);return cv;
}
export class UniverseScene {
  constructor(canvas){
    this.canvas=canvas;this.ctx=canvas.getContext('2d');this.mode='moon';this.hands=[];this.camera=false;this.immersed=false;this.pointerActive=false;this.down=false;
    this.target={x:.66,y:.43};this.position={...this.target};this.pointer={...this.target};this.particles=[];this.ambient=[];this.last=0;this.time=0;this.burstAt=-100;this.auto=false;this.autoStart=0;this.openSince=0;this.victorySince=0;this.lastSwitch=0;this.grabbed=false;this.orbScale=1;this.dissolved=false;
    this.rehearsal=false;this.sequence=new GestureSequence();this.sequenceSnapshot=null;this.sequenceSignature='';
    this.pointerGrip=.25;this.pressAt=0;this.reference=null;
    this.mirror=true;
    this.recordPlaying=false;this.recordActivated=false;
    this.assetsReady=loadReferenceEffects().then(effects=>{this.reference=effects;this.moon=effects.moon;effects.phases.forEach((tex,i)=>this.textures[8-i]=tex);return effects;}).catch(error=>{console.error('原片图形素材加载失败',error);});
    fetch(new URL('./reference/hand-poses.json',import.meta.url)).then(r=>r.json()).then(poses=>this.handPoses=poses).catch(()=>{});
    this.reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.textures=Array.from({length:9},(_,i)=>moonTexture(-Math.PI+i*Math.PI/4));this.moon=this.textures[4];this.sun=sunTexture();
    this.resize=()=>{this.w=canvas.clientWidth;this.h=canvas.clientHeight;const dpr=Math.min(devicePixelRatio||1,2);canvas.width=this.w*dpr;canvas.height=this.h*dpr;this.ctx.setTransform(dpr,0,0,dpr,0,0);};
    this.resize();window.addEventListener('resize',this.resize);
    this.observer=new ResizeObserver(this.resize);this.observer.observe(canvas);
    for(let i=0;i<65;i++)this.ambient.push({x:random(),y:random(),r:random()*1.1+.2,a:random()*.25,speed:random()*.005+.001});
    this.frame=this.frame.bind(this);this.raf=requestAnimationFrame(this.frame);
  }
  setMode(mode){if(mode!==this.mode)this.transition=this.mode&&!this.dissolved?{mode:this.mode,start:this.time}:null;this.mode=mode;this.burstAt=-100;this.particles=[];this.openSince=0;this.pointSince=0;this.grabbed=false;this.dissolved=false;this.orbScale=1;}
  get sequenceEnabled(){return this.camera||this.rehearsal;}
  setPointer(x,y,down=this.down){this.pointer={x:clamp(x/this.w,0,1),y:clamp(y/this.h,0,1)};this.pointerActive=true;if(down&&!this.down){this.pressAt=this.time;this.pointerGrip=.25;}this.down=down;}
  adjustGrip(delta){if(this.down)this.pointerGrip=clamp(this.pointerGrip+delta,.08,1);}
  setHands(results,video){this.hands=results.hands||[];this.handTime=performance.now();this.handSerial=(this.handSerial||0)+1;this.video=video;}
  map(p){
    const px=this.mirror?1-p.x:p.x;
    if(!this.video?.videoWidth)return{x:px*this.w,y:p.y*this.h};
    const s=Math.max(this.w/this.video.videoWidth,this.h/this.video.videoHeight),vw=this.video.videoWidth*s,vh=this.video.videoHeight*s;
    return{x:px*vw+(this.w-vw)/2,y:p.y*vh+(this.h-vh)/2};
  }
  burst(){
    if(this.time-this.burstAt<2.8||this.dissolved)return;
    this.burstAt=this.time;this.dissolved=true;const x=this.position.x*this.w,y=this.position.y*this.h;
    const radius=Math.min(this.w*.115,this.h*.215);
    for(let i=0;i<(this.reduced?180:4200);i++){
      const a=random()*TAU,s=15+random()*100,r=Math.sqrt(random())*radius;
      this.particles.push({x:x+Math.cos(a)*r,y:y+Math.sin(a)*r,vx:Math.cos(a)*s-20,vy:Math.sin(a)*s-15,age:0,life:.7+random()*1.5,r:(.35+random()*.8)*Math.max(.5,this.w/1280)});
    }
  }
  resetSequence(){
    this.sequenceSnapshot=this.sequence.reset(this.time);this.recordPlaying=false;this.recordActivated=false;
    for(const video of [this.reference?.sunVideo,this.reference?.recordVideo])if(video){video.pause();video.currentTime=0;}
    this.sequenceSignature='';this.lastSequenceSerial=null;this.mode=null;this.transition=null;this.appearAt=undefined;this.particles=[];this.dissolved=false;this.orbScale=1;this.grabbing=false;this.target={...this.sequenceSnapshot.target};this.position={...this.target};this.onSequence?.(this.sequenceSnapshot);
  }
  setCamera(enabled){this.camera=enabled;this.rehearsal=!enabled;this.hands=[];this.pointerActive=false;this.down=false;this.resetSequence();}
  startRehearsal(){this.camera=false;this.rehearsal=true;this.pointerActive=false;this.down=false;this.resetSequence();}
  stopRehearsal(){this.rehearsal=false;this.sequenceSnapshot=null;this.pointerActive=false;this.setMode('moon');}
  setAuto(enabled){this.auto=false;if(enabled)this.startRehearsal();}
  handInput(hand){
    const normalize=p=>{const q=this.map(p);return{x:q.x/this.w,y:q.y/this.h};};
    const g=hand.gestures,p=hand.landmarks;
    const wrist=normalize(p[0]),knuckle=normalize(p[9]);
    return{...g,palm:normalize(g.palmCenter),index:normalize(p[8]),thumb:normalize(p[4]),pinchCenter:normalize(g.pinchCenter),aspectRatio:this.w/this.h,handSize:Math.hypot(wrist.x-knuckle.x,(wrist.y-knuckle.y)*this.h/this.w)};
  }
  mouseInput(){
    const stage=this.sequence.stage,p={...this.pointer},closed=this.down;
    const fist=closed&&(stage==='idle'||stage==='pan');
    const grip=closed&&['moon','moonHeld','phases','phaseHeld'].includes(stage);
    const lRelease=(stage==='phaseHeld'||stage==='moonHeld')&&!closed;
    const strength=grip?clamp(this.pointerGrip+(this.time-this.pressAt)*.7,.1,1):0;
    const opening=grip?.08*(1-strength)+.009:fist?.009:lRelease?.15:.13;
    return{palm:p,index:{x:p.x-opening/2,y:p.y},thumb:{x:p.x+opening/2,y:p.y},pinchCenter:p,handSize:.085,aspectRatio:this.w/this.h,
      pinch:grip,pinchStrength:strength,openPalm:!fist&&!grip&&!lRelease,fist,pointing:lRelease,victory:false,spread:closed?0:1,
      fingerStates:{thumb:!fist,index:!fist,middle:!fist&&!grip&&!lRelease,ring:!fist&&!grip&&!lRelease,pinky:!fist&&!grip&&!lRelease}};
  }
  update(dt){
    this.time+=dt;
    const t=this.time;
    if(this.sequenceEnabled){
      const fresh=this.camera&&this.hands.length&&performance.now()-this.handTime<180;
      const input=this.camera?(fresh?this.handInput(this.hands[0]):null):(this.pointerActive?this.mouseInput():null);
      const previous=this.sequenceSnapshot;
      let snapshot;
      if(this.camera&&input&&this.handSerial===this.lastSequenceSerial)snapshot=this.sequence.tick(t);
      else{snapshot=this.sequence.update(input,t);if(this.camera)this.lastSequenceSerial=this.handSerial;}
      this.sequenceSnapshot=snapshot;
      if(snapshot.mode!==this.mode){
        const cross=this.mode==='star'&&snapshot.mode==='sun'||this.mode==='sun'&&snapshot.mode==='moon';
        this.transition=cross?{mode:this.mode,start:t}:null;
        if(!this.mode&&snapshot.mode)this.appearAt=t;
        this.mode=snapshot.mode;
      }
      this.target={...snapshot.target};this.tracking=snapshot.tracked;this.grabbing=snapshot.held;
      if(snapshot.stage==='pan'&&snapshot.panOrigin){const p=1-Math.pow(1-snapshot.panProgress,3);this.position={x:snapshot.panOrigin.x+(snapshot.target.x-snapshot.panOrigin.x)*p,y:snapshot.panOrigin.y+(snapshot.target.y-snapshot.panOrigin.y)*p};}
      if(snapshot.stage==='moonReleased'&&snapshot.releaseOrigin){const p=snapshot.releaseProgress<.5?2*snapshot.releaseProgress**2:1-(-2*snapshot.releaseProgress+2)**2/2;this.position={x:snapshot.releaseOrigin.x+(snapshot.target.x-snapshot.releaseOrigin.x)*p,y:snapshot.releaseOrigin.y};}
      if(snapshot.burst){this.position={...(snapshot.burstTarget||snapshot.target)};this.dissolved=false;this.burst();}
      this.orbScale+=(snapshot.scale-this.orbScale)*(1-Math.exp(-dt*10));
      const signature=[snapshot.stage,snapshot.hint,snapshot.tracked,snapshot.held].join('|');
      if(signature!==this.sequenceSignature){this.sequenceSignature=signature;this.onSequence?.(snapshot);}
    }else{
      this.tracking=false;this.grabbing=this.down;
      if(!this.pointerActive){this.target={x:this.w<700?.64:.67,y:this.w<700?.51:.43};if(!this.reduced){this.target.x+=Math.sin(t*.35)*.012;this.target.y+=Math.cos(t*.42)*.012;}}
      const desiredScale=this.mode==='moon'&&this.grabbing?.18:1;this.orbScale+=(desiredScale-this.orbScale)*(1-Math.exp(-dt*8));
    }
    const ease=1-Math.exp(-dt*(this.grabbing?18:7));
    if(!['moonReleased','pan'].includes(this.sequenceSnapshot?.stage)){this.position.x+=(this.target.x-this.position.x)*ease;this.position.y+=(this.target.y-this.position.y)*ease;}
    if(this.reference)for(const [mode,video] of [['sun',this.reference.sunVideo],['pan',this.reference.recordVideo]]){if(mode===this.mode&&!this.dissolved&&(mode!=='pan'||this.recordPlaying)){if(video.paused&&!video._starting){video._starting=true;video.play().catch(()=>{}).finally(()=>video._starting=false);}}else if(!video.paused)video.pause();}
    this.position.x=clamp(this.position.x,.02,.98);this.position.y=clamp(this.position.y,.02,.94);
    for(const p of this.particles){p.age+=dt;p.x+=p.vx*dt;p.y+=p.vy*dt;p.vx*=Math.exp(-dt*.9);p.vy+=9*dt;}
    this.particles=this.particles.filter(p=>p.age<p.life);
  }
  glow(x,y,r,color,opacity=.45){const c=this.ctx;c.save();c.globalAlpha*=opacity;const g=c.createRadialGradient(x,y,r*.1,x,y,r);g.addColorStop(0,color);g.addColorStop(.32,color);g.addColorStop(1,'transparent');c.fillStyle=g;c.fillRect(x-r,y-r,r*2,r*2);c.restore();}
  drawMoon(x,y,r,texture=this.moon,alpha=1){const c=this.ctx;c.save();c.globalAlpha*=alpha;this.glow(x,y,r*1.55,'#e8e3b6',.16);c.shadowColor='#f5f1c1';c.shadowBlur=r*.09;const R=this.reference?r*texture.width/(texture.width-4):r;c.drawImage(texture,x-R,y-R,R*2,R*2);c.restore();}
  drawStar(x,y,r){
    const c=this.ctx;
    this.glow(x,y,r*1.5,'#e1ca76',.13);
    c.save();c.translate(x,y);
    // A very small yaw keeps the source's inflated 3D face, not a flat outline.
    c.scale(1+Math.sin(this.time*.6)*.025,1);
    if(this.reference?.star){
      c.shadowColor='#e6d18e';c.shadowBlur=r*.10;
      c.drawImage(this.reference.star,-r*1.23,-r*1.23,r*2.46,r*2.46);
    }else{
      c.beginPath();for(let i=0;i<10;i++){const a=-Math.PI/2+i*Math.PI/5,rr=i%2?r*.48:r;c.lineTo(Math.cos(a)*rr,Math.sin(a)*rr);}c.closePath();
      c.fillStyle='#b3a67b';c.fill();
    }c.restore();
  }
  drawSun(x,y,r){
    const c=this.ctx,t=this.time;
    this.glow(x,y,r*1.65,'#ffa61c',.35);this.glow(x,y,r*1.14,'#ffd357',.5);
    c.save();c.translate(x,y);c.rotate(Math.sin(t*.18)*.025);
    const video=this.reference?.sunVideo,texture=this.reference?.sun||this.sun;
    c.shadowColor='#ffcc3d';c.shadowBlur=r*.09;
    if(video?.readyState>=2){c.beginPath();c.arc(0,0,r,0,TAU);c.clip();c.drawImage(video,-r*70/66,-r*70/66,r*140/66,r*140/66);}
    else{const R=this.reference?r*texture.width/(texture.width-4):r;c.drawImage(texture,-R,-R,2*R,2*R);}c.restore();
    // Irregular low flame filaments, instead of the old evenly spaced loops.
    c.save();c.globalCompositeOperation='screen';
    for(let i=0;i<36;i++){
      const a=i*2.39996+t*.07,len=r*(.05+.045*Math.sin(t*3+i*8));
      c.beginPath();c.moveTo(x+Math.cos(a)*r*.96,y+Math.sin(a)*r*.96);
      c.quadraticCurveTo(x+Math.cos(a+.06)*(r+len),y+Math.sin(a+.06)*(r+len),x+Math.cos(a+.12)*(r+len*.4),y+Math.sin(a+.12)*(r+len*.4));
      c.strokeStyle=`rgba(255,194,62,${.18+.12*Math.sin(i+t*2)})`;c.lineWidth=r*.018;c.stroke();
    }c.restore();
  }
  drawPhases(x,y,r,progress=1,anchor=null,span=.72,opacity=1,omitFull=false){
    const c=this.ctx,right=anchor?anchor.x*this.w:this.w*.86;
    const phaseRadius=this.h*(49/720);
    c.save();c.globalAlpha*=opacity;
    for(let i=0;i<5;i++){
      if(omitFull&&i===4)continue;
      const elapsed=progress*1.10;
      const p=i===4?1:clamp((elapsed-i*.105)/(1.10-i*.105),0,1);
      if(p<=0)continue;
      const keys=[[0,0],[.061,.136],[.212,.333],[.303,.516],[.394,.733],[.545,.902],[.666,.963],[.848,.994],[1,1]];
      let ease=1;for(let k=1;k<keys.length;k++)if(p<=keys[k][0]){const [a,av]=keys[k-1],[b,bv]=keys[k];ease=av+(bv-av)*(p-a)/(b-a);break;}
      const px=right-(4-i)*span*this.w/4*ease,py=anchor?anchor.y*this.h:y;
      c.save();c.globalAlpha*=clamp(p*6,0,1);
      this.drawMoon(px,py,phaseRadius,this.textures[8-i]);c.restore();
    }c.restore();
  }
  drawPan(x,y,r,progress=1){
    // Legacy stage name; visually this is the source's vinyl record + tonearm.
    const c=this.ctx,R=r*2.25,k=R/149,video=this.reference?.recordVideo;
    c.save();c.translate(x,y);c.globalAlpha*=clamp(progress*2,0,1);
    if(video?.readyState>=2){
      // The original dynamic grooves, moon lighting and wisps are retained.
      // A union mask keeps the disk and the narrow external tonearm only.
      c.save();c.scale(k,k);c.beginPath();c.ellipse(0,0,149,156,0,0,TAU);
      c.moveTo(-4,-245);c.bezierCurveTo(4,-249,14,-246,15,-238);
      c.quadraticCurveTo(14,-229,8,-225);c.bezierCurveTo(9,-195,12,-170,22,-145);
      c.lineTo(15,-145);c.bezierCurveTo(8,-170,4,-196,3,-225);
      c.quadraticCurveTo(-8,-228,-6,-239);c.closePath();c.clip();
      c.drawImage(video,-154,-250,310,410);c.restore();
    }else if(this.reference?.record){
      c.drawImage(this.reference.record,-R*151/149,-R*158/149,R*302/149,R*316/149);
      // The source texture already contains the part inside the disk.
      c.save();c.lineCap='round';c.beginPath();c.moveTo(R*.035,-R*1.56);
      c.bezierCurveTo(R*.04,-R*1.38,R*.065,-R*1.20,R*.105,-R*1.04);
      c.strokeStyle='#090c0b';c.lineWidth=R*.035;c.stroke();
      c.strokeStyle='#777f7e';c.lineWidth=R*.008;c.stroke();
      c.beginPath();c.ellipse(.035*R,-1.58*R,R*.052,R*.047,0,0,TAU);c.fillStyle='#090c0d';c.fill();c.strokeStyle='#737c7e';c.lineWidth=R*.008;c.stroke();c.restore();
    }else{c.fillStyle='#171919';c.beginPath();c.arc(0,0,R,0,TAU);c.fill();this.drawMoon(0,0,R*.58);}
    c.restore();
  }
  simulatedHand(){
    if(this.handPoses){
      const stage=this.sequence.stage;
      let pose=this.down?(stage==='pan'?'burstFist':stage==='idle'?'fist':'grip'):stage==='phaseHeld'?'release':stage==='star'||stage==='sun'?'sweep':stage==='pan'?'burstOpen':'open';
      const p=this.handPoses[pose].points,focus=this.pointerActive?this.pointer:{x:.48,y:.64};
      let strength=this.down&&pose==='grip'?clamp((this.time-this.pressAt)*.7,0,1):0;
      const tight=this.handPoses.tight.points;
      return p.map(([x,y],i)=>({x:focus.x*this.w+(x*(1-strength)+tight[i][0]*strength)*this.h/720,y:focus.y*this.h+(y*(1-strength)+tight[i][1]*strength)*this.h/720}));
    }
    const focus=this.rehearsal&&this.pointerActive?this.pointer:this.position;
    const px=focus.x*this.w,py=focus.y*this.h;
    const size=Math.min(this.w*.16,160)*(this.w<700?.68:1);
    const baseY=py+size*1.55;
    // A 21-point hand in the same topology as MediaPipe; the index fingertip guides the orb.
    const coords=[[.04,1.3],[-.33,1.07],[-.55,.77],[-.69,.48],[-.72,.22],[-.25,.65],[-.3,.21],[-.28,-.17],[-.24,-.4],[.02,.57],[.03,.06],[.04,-.35],[.04,-.62],[.27,.65],[.34,.17],[.37,-.18],[.39,-.41],[.49,.8],[.63,.43],[.7,.15],[.74,-.03]];
    const angle=this.grabbing?.15:-.2;
    return coords.map(([x,y],i)=>{if(this.grabbing&&i>4){y+=.35*Math.sin(i);x*=.8;}return{x:px+(x*Math.cos(angle)-y*Math.sin(angle))*size,y:baseY+(x*Math.sin(angle)+y*Math.cos(angle))*size-size*.75};});
  }
  drawHand(points,alpha=1,synthetic=false){
    const c=this.ctx;c.save();c.globalAlpha=alpha;c.lineCap='round';c.lineJoin='round';
    const scale=this.h/720;c.shadowColor='#efe1b0';c.shadowBlur=2*scale;
    for(const [a,b] of EDGES){c.beginPath();c.moveTo(points[a].x,points[a].y);c.lineTo(points[b].x,points[b].y);c.strokeStyle='#fff0d6';c.lineWidth=1.7*scale;c.stroke();}
    for(let i=0;i<points.length;i++){const p=points[i],tip=[4,8,12,16,20].includes(i);c.beginPath();c.arc(p.x,p.y,(tip?3.7:1.25)*scale,0,TAU);c.fillStyle='#fff1d9';c.fill();}
    c.restore();
  }
  draw(){
    const c=this.ctx,w=this.w,h=this.h,t=this.time;c.clearRect(0,0,w,h);
    if(!this.camera){
      for(const s of this.ambient){const y=(s.y-t*s.speed+100)%1*h;c.beginPath();c.arc(s.x*w,y,s.r,0,TAU);c.fillStyle=`rgba(205,199,157,${s.a*(.6+.4*Math.sin(t*.3+s.x*15))})`;c.fill();}
    }
    if(this.camera){if(this.tracking)for(const hand of this.hands)this.drawHand(hand.landmarks.map(p=>this.map(p)),.9);}
    else if(this.pointerActive)this.drawHand(this.simulatedHand(),.85,true);
    let x=this.position.x*w,y=this.position.y*h;
    const base=h*(67/720),released=this.sequenceSnapshot?.stage==='moonReleased';
    const release=this.sequenceSnapshot;
    const rp=release?.releaseProgress||0,re=rp*rp*(3-2*rp);
    const r=base*(this.mode==='moon'?(released?release.releaseScale+(49/67-release.releaseScale)*re:this.orbScale):1);
    const burstAge=t-this.burstAt;
    const transitionAge=this.transition?t-this.transition.start:1;
    if(transitionAge<.50){const p=clamp(transitionAge/.50,0,1),ease=1-Math.pow(1-p,3);c.save();c.globalAlpha=1-p;this.drawEffect(this.transition.mode,x+ease*w*.28,y,r);c.restore();x-=(1-ease)*w*.28;}
    c.save();if(transitionAge<.55)c.globalAlpha=transitionAge/.55;if(this.dissolved)c.globalAlpha*=clamp(1-burstAge*7,0,1);
    if(this.sequenceEnabled&&this.appearAt!==undefined)c.globalAlpha*=clamp((t-this.appearAt)/.22);
    if(this.sequenceSnapshot?.stage==='phaseHeld'&&this.sequenceSnapshot.phaseProgress>0)this.drawPhases(x,y,r,1,this.sequenceSnapshot.phaseAnchor,this.sequenceSnapshot.phaseSpan,this.sequenceSnapshot.phaseProgress,true);
    if(this.mode)this.drawEffect(this.mode,x,y,r);
    c.restore();
    if(this.sequenceSnapshot?.stage==='pan'&&this.sequenceSnapshot.panProgress>=.28&&!this.recordActivated){this.recordActivated=true;this.onRecordVisible?.();}
    if(this.grabbing&&burstAge>3&&!this.sequenceEnabled){c.save();c.strokeStyle='#e4d7ad55';c.lineWidth=.7;c.setLineDash([2,5]);c.beginPath();c.arc(x,y,r*1.4,0,TAU);c.stroke();c.restore();}
    c.save();c.globalCompositeOperation='screen';
    for(const p of this.particles){c.globalAlpha=Math.pow(1-p.age/p.life,1.7);c.fillStyle='#e9e2bd';c.beginPath();c.arc(p.x,p.y,p.r,0,TAU);c.fill();}c.restore();
  }
  drawEffect(mode,x,y,r){
    if(mode==='star')this.drawStar(x,y,r*1.08);
    else if(mode==='sun')this.drawSun(x,y,r*.99);
    else if(mode==='phases'){const s=this.sequenceSnapshot;this.drawPhases(x,y,r,s?.phaseProgress??1,s?.phaseAnchor,s?.phaseSpan??.72);}
    else if(mode==='pan'){const p=this.sequenceSnapshot?.panProgress??1;this.drawPan(x,y,r*(.065+.935*p),p);}
    else this.drawMoon(x,y,r);
  }
  frame(now){const dt=this.last?Math.min((now-this.last)/1000,.05):.016;this.last=now;if(!document.hidden){this.update(dt);this.draw();}this.raf=requestAnimationFrame(this.frame);}
  destroy(){cancelAnimationFrame(this.raf);window.removeEventListener('resize',this.resize);this.observer.disconnect();this.reference?.sunVideo?.pause();this.reference?.recordVideo?.pause();}
}
