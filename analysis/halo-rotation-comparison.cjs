// Actual WebGL model renders, not illustrated mockups. The first column loads
// the previous committed model solely inside an isolated analysis browser.
const {chromium}=require('/Users/bornforthis/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const {execFileSync}=require('node:child_process');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const baseline=execFileSync('git',['show','f85a15b:public/models/celestial.js'],{cwd:root,encoding:'utf8'});
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const errors=[],renders=[];
 try {
  for(const previous of [true,false]){
   const page=await browser.newPage({viewport:{width:1200,height:900}});
   page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
   if(previous)await page.route('**/public/models/celestial.js',route=>route.fulfill({contentType:'text/javascript',body:baseline}));
   await page.goto('http://localhost:5173/',{waitUntil:'networkidle'});
   renders.push(await page.evaluate(async previous=>{
    const s=window.palmUniverse.scene;await s.assetsReady;cancelAnimationFrame(s.raf);
    const o=s.objects3d,out=[];
    for(const time of previous?[0]:[0,8]){
     const canvas=document.createElement('canvas');canvas.width=380;canvas.height=480;
     const c=canvas.getContext('2d');s.ctx=c;o.resize(380,480);o.clock=time;o.sunClock=time;
     o.beginFrame();if(previous)s.glow(190,120,69*1.65,'#ffa61c',.18);
     s.drawSun(190,120,69);s.drawMoon(190,360,69);o.render(c);
     out.push({time,image:canvas.toDataURL()});
    }
    if(!previous){
     const canvas=document.createElement('canvas');canvas.width=1140;canvas.height=190;
     const c=canvas.getContext('2d');o.resize(1140,190);o.beginFrame();o.clock=0;
     s.phases.forEach((phase,i)=>o.draw('moon',110+230*i,85,48,1,{phase}));o.render(c);
     out.push({phases:true,image:canvas.toDataURL()});
    }
    return out;
   },previous));
   await page.close();
  }
  const page=await browser.newPage({viewport:{width:1200,height:900},deviceScaleFactor:1});
  await page.goto('http://localhost:5173/');
  await page.evaluate(async renders=>{
   const s=window.palmUniverse.scene;await s.assetsReady;cancelAnimationFrame(s.raf);
   document.body.replaceChildren();document.body.style.cssText='margin:0;background:#171a17';
   const canvas=document.createElement('canvas');canvas.width=1200;canvas.height=900;document.body.append(canvas);
   const c=canvas.getContext('2d');c.fillStyle='#171a17';c.fillRect(0,0,1200,900);
   c.fillStyle='#ece5d2';c.font='500 28px "PingFang SC",sans-serif';c.fillText('光晕与自转 · 实际模型渲染',30,48);
   const columns=[renders[0][0],renders[1][0],renders[1][1]],labels=['修改前 · 0 秒','现在 · 0 秒','现在 · 8 秒'];
   for(let i=0;i<columns.length;i++){
    const x=20+i*390;c.fillStyle='#10130f';c.fillRect(x,110,380,480);
    c.fillStyle='#bec3b5';c.font='17px "PingFang SC",sans-serif';c.fillText(labels[i],x+125,90);
    const image=new Image();image.src=columns[i].image;await image.decode();c.drawImage(image,x,110);
   }
   c.fillStyle='#bec3b5';c.font='17px "PingFang SC",sans-serif';c.fillText('月相亮侧柔光 · 地形自转时，月相的明暗方向保持稳定',30,632);
   c.fillStyle='#10130f';c.fillRect(30,655,1140,190);
   const phases=new Image();phases.src=renders[1][2].image;await phases.decode();c.drawImage(phases,30,655);
   c.fillStyle='#858d7e';c.font='13px "PingFang SC",sans-serif';c.fillText('各列使用相同尺寸与背景；画面来自运行中的 WebGL 模型，未使用原片图片作为纹理。',30,878);
  },renders);
  await page.screenshot({path:path.join(__dirname,'halo-rotation-comparison.png')});
  // A light, warm surround checks the same source-over compositing used over
  // a camera feed, without requesting or recording a real webcam.
  await page.evaluate(()=>{
   const s=window.palmUniverse.scene,o=s.objects3d,c=document.querySelector('canvas').getContext('2d');
   c.clearRect(0,0,1200,900);c.fillStyle='#171a17';c.fillRect(0,0,1200,450);
   c.fillStyle='#b3a18a';c.fillRect(0,450,1200,450);
   s.ctx=c;o.resize(1200,900);o.clock=0;o.sunClock=0;o.beginFrame();
   for(const y of [235,685]){s.drawSun(220,y,83);s.drawMoon(600,y,83);s.drawMoon(980,y,83,.5);}
   o.render(c);c.font='20px "PingFang SC",sans-serif';c.fillStyle='#e8e0cb';
   c.fillText('深色背景 · 太阳 / 满月 / 半月',30,45);c.fillStyle='#302e28';
   c.fillText('浅暖色背景 · 同一透明模型叠合（非真实摄像头测试）',30,495);
  });
  await page.screenshot({path:path.join(__dirname,'halo-background-check.png')});
  if(errors.length)throw new Error(errors.join('\n'));
  console.log('Before/after halo and rotation comparison rendered.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
