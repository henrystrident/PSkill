import { extractLines } from './auto-lines.js';
export const categories = {
  edge:{name:'自动边缘',color:'#a6e3bb',width:2},
  mountain:{name:'远处山脊',color:'#ffb035',width:6},
  near:{name:'前景轮廓',color:'#cf7cff',width:4},
  lake:{name:'湖岸 / 水线',color:'#48e8fa',width:3},
  bridge:{name:'桥梁 / 引导线',color:'#fff661',width:6},
  subject:{name:'主体轮廓',color:'#ff9eac',width:5}
};
const clone = shapes => JSON.parse(JSON.stringify(shapes));
export function validShapes(shapes) {
  const unit=n=>Number.isFinite(n)&&n>=0&&n<=1;
  return Array.isArray(shapes)&&shapes.length<=500&&shapes.every(s=>
    s && Object.hasOwn(categories,s.category) && (s.type==='polyline' ? Array.isArray(s.points)&&s.points.length>=2&&s.points.length<=10000&&s.points.every(p=>Array.isArray(p)&&p.length===2&&p.every(unit)) : s.type==='ellipse'&&[s.cx,s.cy,s.rx,s.ry].every(unit))
  );
}
export function svgLines(shapes, width, height) {
  if(!validShapes(shapes)||!Number.isInteger(width)||width<1||!Number.isInteger(height)||height<1)throw new Error('线图数据无效。');
  const n=v=>Number(v.toFixed(2));
  const lines=shapes.map(s=>{
    const attrs=`fill="none" stroke="black" stroke-width="${categories[s.category].width*width/1440}" stroke-linecap="round" stroke-linejoin="round"`;
    return s.type==='ellipse'?`<ellipse cx="${n(s.cx*width)}" cy="${n(s.cy*height)}" rx="${n(s.rx*width)}" ry="${n(s.ry*height)}" ${attrs}/>`:`<polyline points="${s.points.map(([x,y])=>`${n(x*width)},${n(y*height)}`).join(' ')}" ${attrs}/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n<rect width="100%" height="100%" fill="white"/>\n${lines.join('\n')}\n</svg>`;
}
function draw(ctx, shapes, width, height, pure) {
  ctx.lineCap='round';ctx.lineJoin='round';
  for(const s of shapes) {
    ctx.beginPath();ctx.lineWidth=categories[s.category].width*width/1440;ctx.strokeStyle=pure?'black':categories[s.category].color;
    if(s.type==='ellipse')ctx.ellipse(s.cx*width,s.cy*height,s.rx*width,s.ry*height,0,0,Math.PI*2);
    else s.points.forEach(([x,y],i)=>{if(i)ctx.lineTo(x*width,y*height);else ctx.moveTo(x*width,y*height);});
    if(!pure){ctx.save();ctx.strokeStyle='#000b';ctx.lineWidth+=3*width/960;ctx.stroke();ctx.restore();}
    ctx.stroke();
  }
}
export class CompositionEditor {
  constructor({onChange}) {
    this.$=id=>document.getElementById(id);this.overlay=this.$('composition-overlay');this.onChange=onChange;this.draft=[];this.shapes=[];this.history=[];this.exports=[];
    this.$('composition-view').onchange=()=>this.render();
    this.$('draw-toggle').onclick=()=>{this.drawing=!this.drawing;this.$('draw-toggle').textContent=this.drawing?'结束勾线模式':'开始勾线';this.$('draw-toggle').setAttribute('aria-pressed',String(this.drawing));this.render();};
    this.$('finish-line').onclick=()=>this.finish();
    this.$('undo-line').onclick=()=>{if(this.draft.length)this.draft.pop();else if(this.history.length)this.shapes=this.history.pop();else if(this.shapes.length)this.shapes.pop();this.save();this.render();};
    this.$('clear-lines').onclick=()=>{if(this.shapes.length)this.history.push(clone(this.shapes));this.draft=[];this.shapes=[];this.save();this.render();};
    this.$('line-category').onchange=()=>{if(this.draft.length>=2)this.finish();else this.draft=[];this.render();};
    this.$('export-lines').onclick=()=>this.export();
    this.$('auto-lines').onclick=()=>this.autoTrace();
    for(const id of ['auto-detail','auto-length'])this.$(id).oninput=()=>{this.$(id+'-value').textContent=this.$(id).value;};
    this.overlay.addEventListener('pointerdown',e=>{
      if(!this.drawing||e.button!==0)return;e.preventDefault();
      const r=this.overlay.getBoundingClientRect();
      this.draft.push([Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))]);this.render();
    });
    this.overlay.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();this.finish();}if(e.key==='Escape'){this.draft=[];this.render();}});
    this.observer=new ResizeObserver(()=>this.position());this.observer.observe(this.$('preview'));
  }
  setFrame(frame) {
    this.frame=frame;this.history=[];this.draft=[];this.drawing=false;
    this.$('draw-toggle').textContent='开始勾线';this.$('draw-toggle').setAttribute('aria-pressed','false');
    this.shapes=clone(frame.referenceShapes||[]);
    try {const saved=JSON.parse(localStorage.getItem('frame-study-lines:'+frame.lineKey));if(validShapes(saved))this.shapes=saved;}catch{}
    this.$('composition-origin').textContent=frame.referenceShapes?'已载入之前人工勾画的南疆范本线条，可继续编辑。':'可一键自动转线稿，也可沿主要轮廓逐点手工勾线。';
    this.$('auto-status').textContent='';
    this.$('composition-save').textContent='';
    this.hideExports();this.render();
  }
  finish() {
    if(this.draft.length<2)return;
    this.history.push(clone(this.shapes));this.history=this.history.slice(-50);
    this.shapes.push({type:'polyline',category:this.$('line-category').value,points:this.draft});this.draft=[];this.save();this.render();
  }
  async autoTrace() {
    if(!this.frame||this.autoBusy)return;
    const frame=this.frame,button=this.$('auto-lines');this.autoBusy=true;button.disabled=true;
    this.$('auto-status').textContent='正在提取照片边缘…';
    try {
      await new Promise(resolve=>setTimeout(resolve,30));
      if(this.frame!==frame)return;
      const source=frame.canvas,canvas=document.createElement('canvas'),scale=Math.min(1,720/Math.max(source.width,source.height));
      canvas.width=Math.max(1,Math.round(source.width*scale));canvas.height=Math.max(1,Math.round(source.height*scale));
      const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(source,0,0,canvas.width,canvas.height);
      const result=extractLines(ctx.getImageData(0,0,canvas.width,canvas.height).data,canvas.width,canvas.height,{detail:Number(this.$('auto-detail').value),minLength:Number(this.$('auto-length').value),category:'edge'});
      const retained=this.shapes.filter(s=>s.source!=='automatic'),room=Math.max(0,500-retained.length);
      if(!result.shapes.length){this.$('auto-status').textContent='未找到符合条件的线条。试着增加细节或降低最短线长。';return;}
      if(!room){this.$('auto-status').textContent='已有线条达到 500 条上限，请先清理部分线条。';return;}
      this.history.push(clone(this.shapes));this.history=this.history.slice(-50);
      this.shapes=[...retained,...result.shapes.slice(0,room).map(s=>({...s,source:'automatic'}))];
      this.$('composition-view').value='pure';this.save();this.render();
      this.$('auto-status').textContent=`已生成 ${Math.min(room,result.shapes.length)} 条自动线条，可撤销。${result.truncated||result.shapes.length>room?'达到线条上限，已优先保留较长轮廓。':''}`;
    }catch(error){this.$('auto-status').textContent='自动勾线失败：'+error.message;}
    finally{this.autoBusy=false;button.disabled=false;}
  }
  save() {
    let error='';
    try{localStorage.setItem('frame-study-lines:'+this.frame.lineKey,JSON.stringify(this.shapes));}catch{error='浏览器无法保存线条，请导出线图或 JSON 报告保留。';}
    this.$('composition-save').textContent=error||'完成的线条已保存在此浏览器，重新选择同一文件可恢复。';
    this.hideExports();this.onChange?.();
  }
  hideExports(){this.$('line-exports').hidden=true;for(const url of this.exports)URL.revokeObjectURL(url);this.exports=[];}
  position() {
    const box=this.$('preview').getBoundingClientRect(),parent=this.$('canvas-wrap').getBoundingClientRect();
    Object.assign(this.overlay.style,{left:`${box.left-parent.left}px`,top:`${box.top-parent.top}px`,width:`${box.width}px`,height:`${box.height}px`});
  }
  render() {
    if(!this.frame)return;
    const pure=this.$('composition-view').value==='pure',canvas=this.overlay,source=this.frame.canvas;
    if(canvas.width!==source.width||canvas.height!==source.height){canvas.width=source.width;canvas.height=source.height;}
    const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);
    if(pure){ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);}
    this.$('preview').style.visibility=pure?'hidden':'visible';
    this.$('gridlines').style.visibility=pure?'hidden':'visible';
    this.overlay.style.pointerEvents=this.drawing?'auto':'none';this.overlay.style.cursor=this.drawing?'crosshair':'default';
    draw(ctx,this.shapes,canvas.width,canvas.height,pure);
    if(this.draft.length){
      const shape={type:'polyline',category:this.$('line-category').value,points:this.draft};
      ctx.save();ctx.setLineDash([6,5]);draw(ctx,[shape],canvas.width,canvas.height,pure);ctx.restore();
      ctx.fillStyle=pure?'#000':categories[shape.category].color;
      for(const [x,y] of this.draft){ctx.beginPath();ctx.arc(x*canvas.width,y*canvas.height,3,0,Math.PI*2);ctx.fill();}
    }
    this.$('finish-line').disabled=this.draft.length<2;
    this.$('undo-line').disabled=!this.draft.length&&!this.shapes.length&&!this.history.length;
    this.$('clear-lines').disabled=!this.shapes.length&&!this.draft.length;
    this.$('export-lines').disabled=!this.shapes.length;
    this.$('composition-count').textContent=`${this.shapes.length} 条已完成轮廓${this.draft.length?` · 当前线 ${this.draft.length} 个点，点击“完成这条线”保存`:''}`;
    this.$('composition-summary').textContent=Object.entries(categories).map(([key,v])=>`${v.name} ${this.shapes.filter(s=>s.category===key).length} 条`).join(' · ');
    this.position();
  }
  snapshot(){return {method:'人工勾线 / 本地边缘提取；source 为 automatic 表示自动线条，坐标按画幅宽高归一化到 0–1',shapes:clone(this.shapes)};}
  export() {
    if(!this.shapes.length)return;
    this.hideExports();const canvas=document.createElement('canvas');canvas.width=this.frame.canvas.width;canvas.height=this.frame.canvas.height;
    const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);draw(ctx,this.shapes,canvas.width,canvas.height,true);
    const svg=svgLines(this.shapes,canvas.width,canvas.height),svgUrl=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));this.exports.push(svgUrl);
    this.$('line-svg-download').href=svgUrl;this.$('line-png-download').href=canvas.toDataURL('image/png');this.$('line-svg-source').value=svg;
    this.$('line-exports').hidden=false;
  }
}
