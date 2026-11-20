import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(new URL("..", import.meta.url).pathname);
const rendererPath = resolve(root, "src/avatar-renderer.js");
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<canvas id="stage" width="1080" height="1920"></canvas>
<script type="module">
  import { AvatarRenderer } from "/src/avatar-renderer.js";
  const makeAsset = (hue, accent) => {
    const c = document.createElement("canvas"); c.width = 256; c.height = 256;
    const x = c.getContext("2d"); const g = x.createLinearGradient(0,0,256,256);
    g.addColorStop(0,hue); g.addColorStop(1,accent); x.fillStyle=g;
    x.beginPath(); x.ellipse(128,128,100,116,0,0,Math.PI*2); x.fill();
    x.fillStyle="#fff"; x.beginPath(); x.arc(92,105,12,0,Math.PI*2); x.arc(164,105,12,0,Math.PI*2); x.fill();
    return c.toDataURL("image/png");
  };
  const canvas=document.getElementById("stage");
  const renderer=new AvatarRenderer(canvas);
  const avatar=makeAsset("#b58cff","#f58ebc");
  renderer.setAssets({idle:avatar,talking:avatar});
  const accessories=[
    {src:makeAsset("#ffd166","#ef476f"),x:.18,y:.2,w:.2,h:.2,follow:true,effectsEnabled:true},
    {src:makeAsset("#06d6a0","#118ab2"),x:.82,y:.2,w:.2,h:.2,follow:true,effectsEnabled:true},
    {src:makeAsset("#f78c6b","#9d4edd"),x:.2,y:.8,w:.2,h:.2,follow:true,effectsEnabled:true},
    {src:makeAsset("#90e0ef","#4361ee"),x:.8,y:.8,w:.2,h:.2,follow:true,effectsEnabled:true}
  ];
  renderer.setAccessories(accessories);
  renderer.setPreferences({
    outputWidth:1080,outputHeight:1920,scale:.9,mirror:true,bounce:.02,squash:.07,bounceMs:240,idleBob:.006,
    background:{mode:"gradient",color1:"#182848",color2:"#4b6cb7",angle:135},
    effects:{
      enabled:true,stickerEffectsEnabled:true,
      filter:{enabled:true,intensity:35,states:["all"],targets:["all"]},
      stroke:{enabled:true,intensity:30,thickness:5,states:["all"],targets:["all"]},
      shadow:{enabled:true,intensity:25,states:["all"],targets:["all"]},
      bloom:{enabled:true,intensity:30,states:["all"],targets:["all"]},
      distort:{enabled:true,intensity:12,states:["all"],targets:["all"]},
      eagle:{enabled:true,intensity:20,states:["all"],targets:["all"]},
      shake:{enabled:true,intensity:5,states:["all"],targets:["all"]}
    }
  });
  await Promise.all([...renderer.images.values()].filter(Boolean).map(img=>img.decode()));
  renderer.setState("talking");
  const samples=[];
  for(let i=0;i<3;i++){
    const start=performance.now();
    renderer.render(1800+i*33);
    // Flush command submission without reading back the entire 8.3 MB canvas.
    canvas.getContext("2d").getImageData(540,960,1,1);
    samples.push(performance.now()-start);
  }
  window.__vioBenchmark={
    width:canvas.width,height:canvas.height,frames:samples.length,
    frameMs:samples,averageMs:samples.reduce((a,b)=>a+b,0)/samples.length,
    imageCacheSize:renderer.images.size,accessories:accessories.length,
    effectCount:7,visibleSampleAlpha:canvas.getContext("2d").getImageData(540,960,1,1).data[3]
  };
</script></body></html>`;

const server=createServer(async(req,res)=>{
  if(req.url==="/test.html"){res.writeHead(200,{"content-type":"text/html"});res.end(html);return;}
  if(req.url==="/src/avatar-renderer.js"){res.writeHead(200,{"content-type":"text/javascript"});res.end(await readFile(rendererPath));return;}
  res.writeHead(404);res.end();
});
await new Promise(resolveListen=>server.listen(0,"127.0.0.1",resolveListen));
const address=server.address();let browser;
try{
  browser=await chromium.launch({headless:true,args:["--no-sandbox"]});
  const page=await browser.newPage();const errors=[];
  page.on("pageerror",e=>errors.push(e.message));
  page.on("console",m=>{if(m.type()==="error")errors.push(m.text());});
  await page.goto(`http://127.0.0.1:${address.port}/test.html`,{waitUntil:"domcontentloaded",timeout:15000});
  try{await page.waitForFunction(()=>Boolean(window.__vioBenchmark),{timeout:60000});}
  catch(error){
    const stage=await page.evaluate(()=>({benchmark:!!window.__vioBenchmark,ready:document.readyState}));
    throw new Error(`High-resolution benchmark stalled: ${JSON.stringify(stage)}; browser errors: ${errors.join("; ")}; ${error.message}`);
  }
  const result=await page.evaluate(()=>window.__vioBenchmark);
  assert.deepEqual(errors,[],errors.join("; "));
  assert.equal(result.width,1080);assert.equal(result.height,1920);
  assert.equal(result.frames,3);assert.equal(result.accessories,4);assert.equal(result.effectCount,7);
  assert.ok(result.imageCacheSize>=5,"Avatar and four accessory sources should be cached.");
  assert.ok(result.frameMs.every(Number.isFinite),"All frame timings must be finite.");
  assert.ok(result.visibleSampleAlpha>0,"Canvas center sample should contain rendered pixels.");
  console.log("BENCHMARK browser renderer 1080x1920:",JSON.stringify(result));
}finally{
  await browser?.close();
  await new Promise(resolveClose=>server.close(resolveClose));
}
