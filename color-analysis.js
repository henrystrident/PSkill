// Browser/Node shared, deterministic statistics for sRGB display pixels.
export function rgbToLab(r, g, b) {
  const linear = v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
  r = linear(r); g = linear(g); b = linear(b);
  const f = t => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
  const x = f((.4124564*r + .3575761*g + .1804375*b) / .95047);
  const y = f(.2126729*r + .7151522*g + .072175*b);
  const z = f((.0193339*r + .119192*g + .9503041*b) / 1.08883);
  return [116*y-16, 500*(x-y), 200*(y-z)];
}
export function analyzeRGBA(data, width, height, maxSamples = 120000) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || data.length !== width*height*4 || !Number.isFinite(maxSamples) || maxSamples < 1) throw new Error('图片像素数据无效。');
  const step = Math.max(1, Math.ceil(Math.sqrt(width*height/maxSamples)));
  const hist = { luma: Array(256).fill(0), r: Array(256).fill(0), g: Array(256).fill(0), b: Array(256).fill(0) };
  const bands = ['阴影','中间调','高光'].map(name => ({ name, weight:0, rgb:[0,0,0], lab:[0,0,0], saturation:0 }));
  const hues = Array(12).fill(0), buckets = new Map();
  let count=0, weight=0, sum=0, sq=0, saturation=0, neutral=0, nearBlack=0, nearWhite=0;
  for (let y=Math.min(height-1,Math.floor(step/2)); y<height; y+=step) for (let x=Math.min(width-1,Math.floor(step/2)); x<width; x+=step) {
    const p=(y*width+x)*4, a=data[p+3]/255;
    if (!a) continue;
    const rgb=[data[p],data[p+1],data[p+2]], [r,g,b]=rgb;
    const l=.2126*r+.7152*g+.0722*b, max=Math.max(...rgb), min=Math.min(...rgb), delta=max-min, s=max?delta/max:0;
    count++; weight+=a; sum+=l*a; sq+=l*l*a; saturation+=s*a;
    hist.luma[Math.round(l)]+=a; hist.r[r]+=a; hist.g[g]+=a; hist.b[b]+=a;
    if(l<=5) nearBlack+=a; if(l>=250) nearWhite+=a;
    if(s<.1 || max<16) neutral+=a;
    else {
      let h = max===r ? ((g-b)/delta)%6 : max===g ? (b-r)/delta+2 : (r-g)/delta+4;
      h=(h*60+360)%360; hues[Math.floor((h+15)%360/30)]+=a;
    }
    const band=bands[l<85?0:l<170?1:2], lab=rgbToLab(r,g,b);
    band.weight+=a; band.saturation+=s*a;
    rgb.forEach((v,i)=>{band.rgb[i]+=v*a;band.lab[i]+=lab[i]*a;});
    const key=rgb.map(v=>Math.floor(v/32)).join(',');
    if(!buckets.has(key)) buckets.set(key,{weight:0,rgb:[0,0,0]});
    const bucket=buckets.get(key); bucket.weight+=a; rgb.forEach((v,i)=>bucket.rgb[i]+=v*a);
  }
  if(!weight) throw new Error('图片没有可分析的不透明像素。');
  const percentile = q => {let n=0;for(let i=0;i<256;i++){n+=hist.luma[i];if(n>=weight*q)return i;}return 255;};
  const mean=sum/weight, p05=percentile(.05), p50=percentile(.5), p95=percentile(.95);
  const palette=[...buckets.values()].sort((a,b)=>b.weight-a.weight).slice(0,6).map(v=>{
    const rgb=v.rgb.map(x=>Math.round(x/v.weight));
    return { rgb, hex:'#'+rgb.map(x=>x.toString(16).padStart(2,'0')).join(''), share:v.weight/weight };
  });
  return {
    version:1, space:'sRGB / D65', width, height, sampleCount:count, sampleStep:step,
    methods:{brightness:'Y′ = 0.2126 R′ + 0.7152 G′ + 0.0722 B′，0–255 显示像素值，非线性光能亮度',contrast:'Y′ 标准差；P95−P5 表示中央 90% 像素的明暗跨度',saturation:'HSV S 的像素平均值',bands:'按 Y′ 分区：阴影 <85，中间调 85–<170，高光 ≥170',color:'分区像素的 CIELAB 均值，sRGB 转换，D65 参考白；不是白平衡偏差',palette:'RGB 每通道 32 级宽度分桶，取面积最大的 6 桶，显示桶内实际平均色',sampling:'二维等距采样，透明像素排除，半透明像素按 alpha 加权'},
    brightness:mean, contrast:Math.sqrt(Math.max(0,sq/weight-mean*mean)), saturation:saturation/weight,
    percentiles:{p05,p50,p95}, tonalRange:p95-p05, nearBlack:nearBlack/weight, nearWhite:nearWhite/weight,
    histogram:Object.fromEntries(Object.entries(hist).map(([key,values])=>[key,values.map(v=>v/weight)])),
    bands:bands.map(v=>({name:v.name,share:v.weight/weight,rgb:v.weight?v.rgb.map(x=>x/v.weight):null,lab:v.weight?v.lab.map(x=>x/v.weight):null,saturation:v.weight?v.saturation/v.weight:null})),
    hues:hues.map((v,i)=>({name:['红','橙','黄','黄绿','绿','青绿','青','蓝青','蓝','紫','洋红','红紫'][i],degrees:i*30,share:v/weight})),
    neutralShare:neutral/weight, palette
  };
}
