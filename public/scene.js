import { GestureSequence } from './gesture-sequence.js';
import { Objects3D } from './objects-3d.js';

const TAU = Math.PI * 2;
const EDGES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[0,17],[17,18],[18,19],[19,20]];
const clamp = (v,a=0,b=1) => Math.min(b,Math.max(a,v));
let seed = 9182;
const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
export class UniverseScene {
  constructor(canvas){
    this.canvas=canvas;this.ctx=canvas.getContext('2d');this.mode='moon';this.hands=[];this.camera=false;this.immersed=false;this.pointerActive=false;this.down=false;
    this.target={x:.66,y:.43};this.position={...this.target};this.pointer={...this.target};this.particles=[];this.ambient=[];this.last=0;this.time=0;this.burstAt=-100;this.auto=false;this.autoStart=0;this.openSince=0;this.victorySince=0;this.lastSwitch=0;this.grabbed=false;this.orbScale=1;this.dissolved=false;
    this.rehearsal=false;this.sequence=new GestureSequence();this.sequenceSnapshot=null;this.sequenceSignature='';
    this.pointerGrip=.25;this.pressAt=0;
    this.mirror=true;
    this.recordPlaying=false;this.recordActivated=false;
    this.objects3d=new Objects3D();this.assetsReady=this.objects3d.assetsReady;
    fetch(new URL('./reference/hand-poses.json',import.meta.url)).then(r=>r.json()).then(poses=>this.handPoses=poses).catch(()=>{});
    this.reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.phases=[1,.75,.5,.25,0];
    this.resize=()=>{this.w=canvas.clientWidth;this.h=canvas.clientHeight;const dpr=Math.min(devicePixelRatio||1,2);canvas.width=this.w*dpr;canvas.height=this.h*dpr;this.ctx.setTransform(dpr,0,0,dpr,0,0);this.objects3d.resize(this.w,this.h);};
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
    this.objects3d.resetClocks();
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
    const sunVisible=this.mode==='sun'||this.transition?.mode==='sun'&&t-this.transition.start<.50;
    this.objects3d.update(dt,{mode:this.mode,dissolved:this.dissolved,recordPlaying:this.recordPlaying,sunVisible});
    this.position.x=clamp(this.position.x,.02,.98);this.position.y=clamp(this.position.y,.02,.94);
    for(const p of this.particles){p.age+=dt;p.x+=p.vx*dt;p.y+=p.vy*dt;p.vx*=Math.exp(-dt*.9);p.vy+=9*dt;}
    this.particles=this.particles.filter(p=>p.age<p.life);
  }
  glow(x,y,r,color,opacity=.45){const c=this.ctx;c.save();c.globalAlpha*=opacity;const g=c.createRadialGradient(x,y,r*.1,x,y,r);g.addColorStop(0,color);g.addColorStop(.32,color);g.addColorStop(1,'transparent');c.fillStyle=g;c.fillRect(x-r,y-r,r*2,r*2);c.restore();}
  drawMoon(x,y,r,phase=0,alpha=1){
    this.objects3d.draw('moon',x,y,r,this.ctx.globalAlpha*alpha,{phase});
  }
  drawStar(x,y,r){
    this.glow(x,y,r*1.5,'#e1ca76',.10);
    this.objects3d.draw('star',x,y,r,this.ctx.globalAlpha);
  }
  drawSun(x,y,r){
    this.glow(x,y,r*1.65,'#ffa61c',.18);
    this.objects3d.draw('sun',x,y,r,this.ctx.globalAlpha);
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
      this.drawMoon(px,py,phaseRadius,this.phases[i]);c.restore();
    }c.restore();
  }
  drawPan(x,y,r,progress=1){
    // Legacy controller stage name; this is a solid vinyl player with a pickup.
    this.objects3d.draw('record',x,y,r*2.25,this.ctx.globalAlpha*clamp(progress*2));
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
    const c=this.ctx,w=this.w,h=this.h,t=this.time;c.clearRect(0,0,w,h);this.objects3d.beginFrame();
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
    this.objects3d.render(c);
    if(this.objects3d.ready&&this.sequenceSnapshot?.stage==='pan'&&this.sequenceSnapshot.panProgress>=.28&&!this.recordActivated){this.recordActivated=true;this.onRecordVisible?.();}
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
  destroy(){cancelAnimationFrame(this.raf);window.removeEventListener('resize',this.resize);this.observer.disconnect();this.objects3d.dispose();}
}
