import assert from 'node:assert/strict';
import test from 'node:test';
import { UniverseScene } from '../public/scene.js';
import { GestureSequence } from '../public/gesture-sequence.js';

// Exercise the real scene observation/update methods without constructing its
// DOM canvas or WebGL renderer. All camera observations and clock values are
// synthetic; this suite neither opens a browser nor requests a real camera.
function hand(id, { x = .5, kind = 'open', size = .08 } = {}) {
  const points = Array.from({length:21}, () => ({x,y:.55,z:0}));
  points[0]={x,y:.66,z:0};points[9]={x,y:.54,z:0};
  points[5]={x:x-.04,y:.55,z:0};points[17]={x:x+.04,y:.55,z:0};
  const gap=kind==='pinch'?.012:kind==='fist'?.03:.15;
  points[4]={x:x+gap/2,y:.55,z:0};points[8]={x:x-gap/2,y:.55,z:0};
  const open=kind==='open';
  return {id,landmarks:points,gestures:{palmCenter:{x,y:.60},pinchCenter:{x,y:.55},
    openPalm:open,fist:kind==='fist',pinch:kind==='pinch',pinchStrength:kind==='pinch'?.95:0,
    fingerStates:{thumb:open,index:open,middle:open,ring:open,pinky:open},spread:open?1:0,
    imagePalmSize:size,screenPalmLength:size,stableScreenHandSize:size}};
}

function harness(t) {
  let now=1000;
  t.mock.method(performance,'now',()=>now);
  const video={videoWidth:1280,videoHeight:720};
  const scene=Object.create(UniverseScene.prototype);
  Object.assign(scene,{camera:true,rehearsal:false,mirror:true,startedAt:0,w:1280,h:720,stageWidth:1280,stageHeight:720,
    viewport:{x:0,y:0,width:1280,height:720},video,sourceWidth:1280,sourceHeight:720,
    sequence:new GestureSequence(),sequenceSnapshot:null,sequenceSignature:'',mode:null,time:0,
    target:{x:.43,y:.58},position:{x:.43,y:.58},orbRadius:null,orbScale:1,activeHandId:null,activeHand:null,
    hands:[],handSerial:0,lastSequenceSerial:null,particles:[],dissolved:false,recordPlaying:false,
    objects3d:{update(){},resetClocks(){}},resize(){throw new Error('This fixture must not invoke DOM resize');}});
  scene.sequenceSnapshot=scene.sequence.reset(1);
  return {scene,video,get now(){return now;},
    send(hands,receivedAt=now,capturedAt=receivedAt){now=receivedAt;scene.setHands({hands,timestamp:capturedAt,receivedAt},video);},
    frame(at=now){now=at;scene.update(1/60);return scene.sequenceSnapshot;}};
}

function flickPose(anchor, degrees, progress=0) {
  const aspect=16/9,angle=degrees*Math.PI/180,wrist={x:anchor.x+.015*progress,y:anchor.y+.095*aspect};
  const point=(r,offset=0)=>({x:wrist.x+r*Math.cos(angle+offset*Math.PI/180),y:wrist.y+r*Math.sin(angle+offset*Math.PI/180)*aspect,z:0});
  const points=[wrist,point(.025,-45),point(.05,-45),point(.08,-40),point(.11,-35),
    point(.058,-5),point(.085,-3),point(.11,-1),point(.135),
    point(.065,15),point(.095,12),point(.13,10),point(.155,8),
    point(.058,28),point(.087,26),point(.115,24),point(.137,22),
    point(.048,40),point(.068,38),point(.087,36),point(.107,34)];
  const raw=p=>({x:1-p.x,y:p.y,z:0});
  const palm=[0,5,9,13,17].reduce((p,i)=>({x:p.x+points[i].x/5,y:p.y+points[i].y/5}),{x:0,y:0});
  const size=(.065+Math.hypot(points[5].x-points[17].x,(points[5].y-points[17].y)/aspect))/2;
  return {id:1,landmarks:points.map(raw),gestures:{palmCenter:raw(palm),pinchCenter:raw({x:(points[4].x+points[8].x)/2,y:(points[4].y+points[8].y)/2}),
    openPalm:true,fist:false,pinch:false,pinchStrength:0,spread:1,
    fingerStates:{thumb:true,index:true,middle:true,ring:true,pinky:true},
    imagePalmSize:size,screenPalmLength:.065,stableScreenHandSize:size}};
}

function delayedFlickSetup(h) {
  let received=1000;
  for(let i=0;i<8;i++,received+=40){h.send([hand(1,{kind:'fist'})],received,received-160);h.frame();h.frame(received+16);}
  assert.equal(h.scene.sequenceSnapshot.stage,'star');
  const anchor=h.scene.sequenceSnapshot.target;
  for(let i=0;i<16;i++,received+=33){h.send([flickPose(anchor,-130)],received,received-160);h.frame();h.frame(received+16);}
  return {anchor,received};
}

test('scene rejects stale, future and out-of-order capture timestamps without replacing the primary hand', t=>{
  const h=harness(t);h.send([hand(1)]);const serial=h.scene.handSerial;
  h.send([hand(2)],1100,950);
  h.send([hand(2)],1300,1119);
  h.send([hand(2)],1300,1351);
  assert.equal(h.scene.handSerial,serial);assert.equal(h.scene.handTime,1000);
  assert.equal(h.scene.activeHandId,1);
});

test('same captured frame cannot count as a newly received primary-hand observation', t=>{
  const h=harness(t);h.send([hand(1)]);const serial=h.scene.handSerial,seenAt=h.scene.activeHandSeenAt;
  h.send([hand(1,{x:.8})],1100,1000);
  assert.equal(h.scene.handSerial,serial,'re-delivery of the same capture must not advance the observation serial');
  assert.equal(h.scene.activeHandSeenAt,seenAt,'duplicate capture must not prolong the hand identity lock');
});

test('scene keeps the selected ID when two detector hands change output order', t=>{
  const h=harness(t);h.send([hand(1,{x:.3}),hand(2,{x:.8})]);h.frame();
  h.send([hand(2,{x:.79}),hand(1,{x:.31})],1033);h.frame();
  assert.equal(h.scene.activeHandId,1);assert.equal(h.scene.sequence._activeHandId,1);
  assert.ok(Math.abs(h.scene.handInput(h.scene.activeHand).palm.x-.69)<1e-12);
});

test('short loss waits for the same hand; a different hand can be selected after the identity grace', t=>{
  const h=harness(t);h.send([hand(1)]);h.frame();
  h.send([],1100);assert.equal(h.frame().tracked,false);
  h.send([hand(2)],1200);assert.equal(h.scene.activeHand,null);assert.equal(h.frame().tracked,false);
  h.send([hand(1)],1300);assert.equal(h.scene.activeHandId,1);assert.equal(h.frame().tracked,true);
  h.send([],1400);h.frame();h.send([hand(2)],1710);h.frame();
  assert.equal(h.scene.activeHandId,2);assert.equal(h.scene.sequence._activeHandId,2);
});

test('a replacement hand must reacquire a held moon nearby instead of teleporting it', t=>{
  const h=harness(t);h.send([hand(1)]);h.frame();
  Object.assign(h.scene.sequence,{stage:'moonHeld',mode:'moon',held:true,target:{x:.5,y:.55},scale:.5});
  h.scene.mode='moon';h.scene.sequenceSnapshot=h.scene.sequence.snapshot();
  h.send([],1100);h.frame();
  h.send([hand(2,{x:.85,kind:'pinch'})],1450);const lost=h.frame();
  assert.equal(lost.interaction,'reacquire');assert.deepEqual(lost.target,{x:.5,y:.55});
  for(const at of [1483,1516,1549]){h.send([hand(2,{x:.5,kind:'pinch'})],at);h.frame();}
  assert.equal(h.scene.sequenceSnapshot.interaction,'holding');
  assert.deepEqual(h.scene.sequenceSnapshot.target,{x:.5,y:.55});
});

test('continuous delayed captures still satisfy a real 220 ms fist dwell', t=>{
  const h=harness(t);
  for(let i=0;i<24;i++){
    const received=1000+i*33;
    h.send([hand(1,{kind:'fist'})],received,received-160);h.frame();
    h.frame(received+16);
  }
  assert.equal(h.scene.sequenceSnapshot.stage,'star','160 ms inference latency is accepted by the scene and must not be mistaken for missing observations');
  h.frame(h.now+250);
  assert.equal(h.scene.sequenceSnapshot.tracked,false,'an actual arrival gap still expires tracking');
});

test('160 ms delayed local wrist rotation switches the star using capture speed',t=>{
  const h=harness(t),setup=delayedFlickSetup(h);
  for(let i=1;i<=6;i++){
    const received=setup.received+i*30;
    h.send([flickPose(setup.anchor,-130+85*i/6,i/6)],received,received-160);h.frame();h.frame(received+16);
  }
  assert.equal(h.scene.sequenceSnapshot.stage,'sun');
});

test('receipt grace cannot turn a single fist observation into a completed dwell',t=>{
  const h=harness(t);h.send([hand(1,{kind:'fist'})],1000,840);h.frame();
  for(let at=1016;at<=1336;at+=16)h.frame(at);
  assert.equal(h.scene.sequenceSnapshot.stage,'idle');assert.equal(h.scene.sequenceSnapshot.tracked,false);
});

test('render frames after one wrist jump cannot invent a continuous flick',t=>{
  const h=harness(t),setup=delayedFlickSetup(h),received=setup.received+30;
  h.send([flickPose(setup.anchor,-45,1)],received,received-160);h.frame();
  for(let at=received+16;at<=received+336;at+=16)h.frame(at);
  assert.equal(h.scene.sequenceSnapshot.stage,'star');assert.equal(h.scene.sequenceSnapshot.tracked,false);
});

test('recent receipt cannot hide a long gap between the actual capture samples',t=>{
  const h=harness(t);h.send([hand(1,{kind:'fist'})],1000,840);h.frame();
  h.send([hand(1,{kind:'fist'})],1100,1090);h.frame();
  assert.equal(h.scene.sequenceSnapshot.stage,'idle','250 ms capture gap must reset dwell even though receipts are only 100 ms apart');
});

test('calibrated orb radius remains stable while the hand moves and drives the collision input', t=>{
  const h=harness(t);
  for(let i=0;i<8;i++){h.send([hand(1,{kind:'fist',size:.08})],1000+i*40);h.frame();}
  assert.equal(h.scene.sequenceSnapshot.stage,'star');
  const radius=h.scene.baseRadius;
  assert.ok(Math.abs(radius-.08*1280*.75)<1e-9);
  h.send([hand(1,{size:.16})],1320);h.frame();
  assert.equal(h.scene.baseRadius,radius,'the stationary celestial object must not resize with a later palm turn');
  assert.equal(h.scene.handInput(h.scene.activeHand).orbRadius,radius/1280);
});

test('logical camera coordinates preserve native image points and palm units through mirroring', t=>{
  const h=harness(t),s=h.scene;
  s.w=1440;s.h=1080;s.viewport={x:240,y:0,width:1440,height:1080};
  assert.deepEqual(s.map({x:.2,y:.4}),{x:1152,y:432});
  const mirrored=s.handInput(hand(1,{x:.2,size:.07}));
  assert.equal(mirrored.palm.x,.8);assert.equal(mirrored.handSize,.07);assert.equal(mirrored.switchDirection,1);
  s.mirror=false;
  const unmirrored=s.handInput(hand(1,{x:.2,size:.07}));
  assert.equal(unmirrored.palm.x,.2);assert.equal(unmirrored.handSize,.07);assert.equal(unmirrored.switchDirection,-1);
});
