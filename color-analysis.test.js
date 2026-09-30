import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRGBA, rgbToLab } from './color-analysis.js';
const near=(actual,expected,tolerance=1e-5)=>assert.ok(Math.abs(actual-expected)<tolerance,`${actual} ≈ ${expected}`);
const image=pixels=>analyzeRGBA(Uint8ClampedArray.from(pixels.flat()),pixels.length,1);
test('neutral display levels and exact black/white statistics',()=>{
  const s=image([[0,0,0,255],[255,255,255,255]]);
  near(s.brightness,127.5);near(s.contrast,127.5);near(s.saturation,0);
  near(s.nearBlack,.5);near(s.nearWhite,.5);assert.equal(s.tonalRange,255);
  near(s.bands[0].share,.5);assert.equal(s.bands[1].rgb,null);near(s.bands[2].share,.5);
  near(s.neutralShare,1);assert.ok(s.palette.some(c=>c.hex==='#000000'));
});
test('CIELAB D65 neutral and primary reference values',()=>{
  const white=rgbToLab(255,255,255);near(white[0],100,.001);near(white[1],0,.001);near(white[2],0,.001);
  const gray=rgbToLab(128,128,128);near(gray[1],0,.001);near(gray[2],0,.001);
  const red=rgbToLab(255,0,0);near(red[0],53.24,.02);near(red[1],80.09,.02);near(red[2],67.20,.02);
});
test('alpha weighted statistics exclude hidden colors',()=>{
  const s=image([[255,0,0,0],[0,0,0,255],[255,255,255,85]]);
  assert.equal(s.sampleCount,2);near(s.brightness,63.75);near(s.nearBlack,.75);near(s.nearWhite,.25);
  assert.throws(()=>image([[255,0,0,0]]),/没有可分析/);
});
test('hue, bands and histogram fractions conserve total area',()=>{
  const s=image([[255,0,0,255],[0,255,0,255],[0,0,255,255],[128,128,128,255]]);
  near(s.hues[0].share,.25);near(s.hues[4].share,.25);near(s.hues[8].share,.25);near(s.neutralShare,.25);
  near(s.bands.reduce((n,b)=>n+b.share,0),1);
  for(const h of Object.values(s.histogram))near(h.reduce((a,b)=>a+b,0),1);
  near(s.hues.reduce((a,b)=>a+b.share,0)+s.neutralShare,1);
});
test('palette uses observed bucket means rather than bucket centers',()=>{
  const s=image([[1,2,3,255],[3,4,5,255]]);
  assert.equal(s.palette[0].hex,'#020304');near(s.palette[0].share,1);
});
test('sampling handles narrow images and validates dimensions',()=>{
  const pixels=new Uint8ClampedArray(1*960*4).fill(255);
  const s=analyzeRGBA(pixels,1,960,100);assert.ok(s.sampleCount>0);near(s.brightness,255);
  assert.throws(()=>analyzeRGBA(pixels,2,960),/无效/);
});
