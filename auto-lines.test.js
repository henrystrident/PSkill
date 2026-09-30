import test from 'node:test';
import assert from 'node:assert/strict';
import {extractLines} from './auto-lines.js';
import {validShapes,svgLines} from './composition.js';
function image(w,h,pixel){
  const data=new Uint8ClampedArray(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)data.set(pixel(x,y),(y*w+x)*4);
  return data;
}
test('flat and transparent images produce no false outlines',()=>{
  for(const color of [[0,0,0,255],[128,128,128,255],[255,255,255,255]])assert.equal(extractLines(image(64,64,()=>color),64,64).shapes.length,0);
  assert.equal(extractLines(image(64,64,x=>[x<32?0:255,0,0,0]),64,64).shapes.length,0);
});
test('a vertical boundary becomes a continuous normalized exportable line',()=>{
  const {shapes}=extractLines(image(64,64,x=>x<32?[0,0,0,255]:[255,255,255,255]),64,64);
  assert.equal(shapes.length,1);assert.ok(validShapes(shapes));
  assert.ok(shapes[0].points.every(([x])=>Math.abs(x-.5)<.03));
  assert.ok(shapes[0].points.at(-1)[1]-shapes[0].points[0][1]>.9);
  assert.match(svgLines(shapes,640,640),/<polyline/);
});
test('closed outlines survive and short details can be filtered',()=>{
  const data=image(64,64,(x,y)=>x>16&&x<48&&y>16&&y<48?[0,0,0,255]:[255,255,255,255]);
  const result=extractLines(data,64,64,{minLength:8});
  assert.ok(result.shapes.length>0);assert.ok(validShapes(result.shapes));
  assert.equal(extractLines(data,64,64,{minLength:300}).shapes.length,0);
});
test('detail increases sensitivity to faint boundaries',()=>{
  const data=image(64,64,x=>x<32?[120,120,120,255]:[145,145,145,255]);
  assert.equal(extractLines(data,64,64,{detail:0}).shapes.length,0);
  assert.ok(extractLines(data,64,64,{detail:100}).shapes.length>0);
});
