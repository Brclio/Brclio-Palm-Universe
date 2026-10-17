// The supplied clip is the visual source. Keep its actual material, crater
// pattern and record grooves; mask the objects at runtime, not the room/person.
const TAU = Math.PI * 2;
const image = name => new Promise((resolve, reject) => {
  const i = new Image(); i.onload = () => resolve(i); i.onerror = reject;
  i.src = new URL(`./reference/${name}`, import.meta.url).href;
});
function canvas(w, h=w) { const c=document.createElement('canvas'); c.width=w; c.height=h; return c; }
function motion(name){const v=document.createElement('video');v.muted=true;v.loop=true;v.playsInline=true;v.preload='auto';v.src=new URL(`./reference/${name}`,import.meta.url).href;v.load();return v;}
function disk(source,x,y,rx,ry=rx) {
  const out=canvas(Math.ceil(rx*2+4),Math.ceil(ry*2+4)),c=out.getContext('2d');
  c.save();c.beginPath();c.ellipse(out.width/2,out.height/2,rx,ry,0,0,TAU);c.clip();
  c.drawImage(source,x-rx-2,y-ry-2,out.width,out.height,0,0,out.width,out.height);c.restore();
  return out;
}
function star(source) {
  const out=canvas(180),c=out.getContext('2d');
  // Frame 500: the hand has cleared the entire star. Follow its actual rounded
  // silhouette; frame 491 overlapped skin and lost part of the left upper face.
  c.beginPath();c.moveTo(87,22);
  c.bezierCurveTo(90,16,96,30,107,65);
  c.bezierCurveTo(119,69,149,70,161,76);
  c.bezierCurveTo(170,79,145,100,131,113);
  c.bezierCurveTo(130,128,139,160,133,165);
  c.bezierCurveTo(125,168,98,146,85,146);
  c.bezierCurveTo(73,146,47,169,42,164);
  c.bezierCurveTo(38,158,45,131,48,113);
  c.bezierCurveTo(37,102,15,84,16,77);
  c.bezierCurveTo(18,70,49,73,65,66);
  c.bezierCurveTo(73,49,79,29,87,22);c.closePath();c.clip();
  c.drawImage(source,570,455,180,180,0,0,180,180);
  return out;
}
export async function loadReferenceEffects() {
  const [s,u,m,p,v]=await Promise.all([
    image('star-0500.png'),image('sun-0543.png'),image('moon-0577.png'),
    image('phases-0738.png'),image('record-0824.png'),
  ]);
  return {
    star:star(s),sun:disk(u,641,546,66),moon:disk(m,645,548,67),
    phases:[185,421,643,878,1102].map(x=>disk(p,x,519,49)),
    record:disk(v,232,265,149,156),
    sunVideo:motion('sun-motion.mp4'),recordVideo:motion('record-motion.mp4'),
  };
}
