// Analysis-only comparison. Reference crops never enter the production models.
const { chromium } = require('/Users/bornforthis/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({ headless:true, executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport:{width:1000,height:1450}, deviceScaleFactor:1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type()==='error') errors.push(message.text()); });
  try {
    await page.goto('http://localhost:5173/', { waitUntil:'networkidle' });
    await page.evaluate(async () => {
      const app = window.palmUniverse.scene;
      await app.assetsReady; cancelAnimationFrame(app.raf);
      const objects = app.objects3d;
      const image = async name => { const item = new Image(); item.src='/public/reference/'+name; await item.decode(); return item; };
      const frames = await Promise.all(['star-0500.png','sun-0543.png','moon-0577.png','record-0824.png'].map(image));
      document.body.replaceChildren(); document.body.style.cssText='margin:0;background:#171a17';
      const canvas=document.createElement('canvas'); canvas.width=1000;canvas.height=1450;document.body.append(canvas);
      const c=canvas.getContext('2d');c.fillStyle='#171a17';c.fillRect(0,0,1000,1450);
      c.fillStyle='#ece5d2';c.font='500 28px "PingFang SC",sans-serif';c.fillText('按原片校准 · 独立三维重建',40,52);
      c.fillStyle='#a5aa9c';c.font='16px "PingFang SC",sans-serif';c.fillText('原片参考区域',190,97);c.fillText('代码模型实际渲染',635,97);
      const rows=[
        {kind:'star',name:'星星',y:120,height:260,crop:[570,455,180,180],x:90,cy:90,r:67*1.08},
        {kind:'sun',name:'太阳',y:390,height:260,crop:[551,456,180,180],x:90,cy:90,r:66},
        {kind:'moon',name:'月球',y:660,height:260,crop:[555,458,180,180],x:90,cy:90,r:67},
        {kind:'record',name:'唱片',y:930,height:450,crop:[78,15,310,410],x:154,cy:250,r:67*2.25},
      ];
      objects.clock=2;objects.sunClock=2;objects.recordClock=2;objects.recordPlaying=true;
      for (let i=0;i<rows.length;i++) {
        const row=rows[i], left=90,right=540,panelWidth=415,scale=row.kind==='record'?1:1.26;
        c.fillStyle='#10130f';c.fillRect(left,row.y,panelWidth,row.height-10);c.fillRect(right,row.y,panelWidth,row.height-10);
        c.font='15px "PingFang SC",sans-serif';c.fillStyle='#c7c3b4';c.fillText(row.name,30,row.y+24);
        const [sx,sy,sw,sh]=row.crop;
        const offsetX=panelWidth/2-sw*scale/2,offsetY=(row.height-10)/2-sh*scale/2;
        c.drawImage(frames[i],sx,sy,sw,sh,left+offsetX,row.y+offsetY,sw*scale,sh*scale);
        const surface=document.createElement('canvas');surface.width=sw;surface.height=sh;app.ctx=surface.getContext('2d');
        objects.resize(sw,sh);objects.beginFrame();
        if(row.kind==='record')app.drawPan(row.x,row.cy,67);
        else app['draw'+row.kind[0].toUpperCase()+row.kind.slice(1)](row.x,row.cy,row.r);
        objects.render(app.ctx);
        c.drawImage(surface,right+offsetX,row.y+offsetY,sw*scale,sh*scale);
      }
      c.fillStyle='#858d7e';c.font='13px "PingFang SC",sans-serif';
      c.fillText('左列仅用于样式对照；互动场景不加载视频帧、图片或视频纹理。背景与光照环境有所不同。',40,1420);
    });
    await page.screenshot({ path:path.join(__dirname,'procedural-style-comparison.png') });
    if(errors.length) throw new Error(errors.join('\n'));
    console.log('Source-style comparison rendered without browser errors.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
