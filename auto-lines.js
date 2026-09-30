// Smoothed luminance → Sobel → non-maximum suppression → hysteresis → polylines.
// Coordinates share the manual editor's normalized format.
export function extractLines(data, width, height, {detail=50, minLength=12, category='subject'}={}) {
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||data.length!==width*height*4)throw new Error('图片像素无效。');
  if(!Number.isFinite(detail)||detail<0||detail>100||!Number.isFinite(minLength)||minLength<2)throw new Error('线稿参数无效。');
  const size=width*height, gray=new Float32Array(size), temp=new Float32Array(size), blur=new Float32Array(size);
  for(let i=0;i<size;i++){
    const p=i*4,a=data[p+3]/255;
    gray[i]=(data[p]*.2126+data[p+1]*.7152+data[p+2]*.0722)*a+255*(1-a);
  }
  const kernel=[1,4,6,4,1];
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    let sum=0;for(let k=-2;k<=2;k++)sum+=gray[y*width+Math.max(0,Math.min(width-1,x+k))]*kernel[k+2];temp[y*width+x]=sum/16;
  }
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    let sum=0;for(let k=-2;k<=2;k++)sum+=temp[Math.max(0,Math.min(height-1,y+k))*width+x]*kernel[k+2];blur[y*width+x]=sum/16;
  }
  const magnitude=new Float32Array(size),direction=new Uint8Array(size),thin=new Float32Array(size);
  for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
    const i=y*width+x;
    const gx=-blur[i-width-1]+blur[i-width+1]-2*blur[i-1]+2*blur[i+1]-blur[i+width-1]+blur[i+width+1];
    const gy=-blur[i-width-1]-2*blur[i-width]-blur[i-width+1]+blur[i+width-1]+2*blur[i+width]+blur[i+width+1];
    magnitude[i]=Math.hypot(gx,gy);
    direction[i]=(Math.round(Math.atan2(gy,gx)*4/Math.PI)+4)%4;
  }
  const offsets=[1,width+1,width,width-1];
  for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
    const i=y*width+x,d=offsets[direction[i]],m=magnitude[i];
    if(m>magnitude[i-d]&&m>=magnitude[i+d])thin[i]=m;
  }
  const high=140-detail*1.2,low=high*.4,mask=new Uint8Array(size),queue=[];
  for(let i=0;i<size;i++)if(thin[i]>=high){mask[i]=1;queue.push(i);}
  const neighbors=i=>{
    const x=i%width,y=Math.floor(i/width),result=[];
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      if((dx||dy)&&x+dx>=0&&x+dx<width&&y+dy>=0&&y+dy<height)result.push(i+dy*width+dx);
    }
    return result;
  };
  for(let head=0;head<queue.length;head++)for(const j of neighbors(queue[head]))if(!mask[j]&&thin[j]>=low){mask[j]=1;queue.push(j);}
  // Avoid diagonal shortcuts where two edge pixels already have an orthogonal connection.
  const adjacent=i=>neighbors(i).filter(j=>mask[j]&&(Math.abs(i%width-j%width)!==1||Math.abs(Math.floor(i/width)-Math.floor(j/width))!==1||(!mask[Math.floor(i/width)*width+j%width]&&!mask[Math.floor(j/width)*width+i%width])));
  const visited=new Set(),paths=[];
  const edgeKey=(a,b)=>Math.min(a,b)*size+Math.max(a,b);
  const walk=(start,next)=>{
    const path=[start];let prev=start,current=next,length=0;
    while(true){
      visited.add(edgeKey(prev,current));path.push(current);
      length+=Math.hypot(current%width-prev%width,Math.floor(current/width)-Math.floor(prev/width));
      const links=adjacent(current);
      if(links.length!==2||current===start)break;
      const following=links.find(j=>j!==prev);
      if(visited.has(edgeKey(current,following)))break;
      prev=current;current=following;
    }
    if(length>=minLength)paths.push({path,length});
  };
  for(const i of queue)if(adjacent(i).length!==2)for(const j of adjacent(i))if(!visited.has(edgeKey(i,j)))walk(i,j);
  for(const i of queue)for(const j of adjacent(i))if(!visited.has(edgeKey(i,j)))walk(i,j);
  paths.sort((a,b)=>b.length-a.length);
  const shapes=paths.slice(0,500).map(({path})=>{
    // Keep direction changes and every fourth pixel; retain the final endpoint.
    let kept=path.filter((p,i)=>i===0||i===path.length-1||i%4===0||(p-path[i-1]!==path[i+1]-p));
    if(kept.length>10000){const stride=Math.ceil(kept.length/9999);kept=kept.filter((p,i)=>i%stride===0||i===kept.length-1);}
    return {type:'polyline',category,points:kept.map(i=>[(i%width)/(width-1||1),Math.floor(i/width)/(height-1||1)])};
  });
  return {shapes,total:paths.length,truncated:paths.length>500};
}
