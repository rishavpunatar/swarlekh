'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const DSP=require('../js/dsp');
function returningGesture({sa=210,anchor=0,direction=1,held=false,heldCenter=false,oneWay=false,confidence=.96}={}) {
  const hop=.01,f0=new Float32Array(250),clarity=new Float32Array(250).fill(.96),rms=new Float32Array(250).fill(.2);
  const hz=k=>sa*2**(k/12);
  f0.fill(hz(anchor),20,60);f0.fill(hz(anchor+direction*4),60,100);
  for(let i=100;i<140;i++){
    const phase=(i-100)/40;
    const cents=held?200:heldCenter?(phase>=.25&&phase<.75?210:-180):oneWay?(-180+380*phase):210*Math.sin(4*Math.PI*phase);
    f0[i]=hz(anchor)*2**(direction*cents/1200);clarity[i]=confidence;
  }
  f0.fill(hz(anchor+direction*4),140,220);
  const regions=[{onset:.2,offset:.6,frequency:hz(anchor)},
    {onset:.6,offset:1,frequency:hz(anchor+direction*4)},
    {onset:1,offset:1.4,frequency:hz(anchor+direction*2)},
    {onset:1.4,offset:2.2,frequency:hz(anchor+direction*4)}];
  const tokens=DSP.notateRegions(regions,f0,clarity,hop,sa,{clean:true,ornaments:true,rms,minNoteMs:130,ornMinMs:45});
  return {tokens:tokens.tokens,f0,clarity,rms,hop,regions,sa};
}
test('ornamented return uses its established anchor rather than the transient neighbour',()=>{
  for(const anchor of [-5,0,7])for(const direction of [-1,1]){
    const {tokens}=returningGesture({anchor,direction});
    const returned=tokens.find(n=>n.returningAnchor);
    assert.ok(returned,JSON.stringify(tokens));assert.equal(returned.k,anchor);
    assert.equal(returned.t0,1);assert.equal(returned.t1,1.4);
  }
});
test('real held intermediate notes, one-way slides and weak pitch do not gain an anchor label',()=>{
  for(const variant of [{held:true},{heldCenter:true},{oneWay:true},{confidence:.6}]){
    const {tokens}=returningGesture(variant);
    assert.ok(tokens.every(n=>!n.returningAnchor),JSON.stringify(tokens));
    if(variant.held)assert.equal(tokens.find(n=>n.t0===1).k,2);
  }
});

function delayedEntry({early=false,short=false,quiet=false}={}) {
  const hop=.01,f0=new Float32Array(7000),clarity=new Float32Array(7000),rms=new Float32Array(7000),sa=210;
  const start=early?1:35;
  const fill=(a,b,k,level=.2)=>{for(let i=Math.round(a/hop);i<Math.round(b/hop);i++){
    f0[i]=sa*2**(k/12);clarity[i]=.95;rms[i]=level;
  }};
  fill(start,start+(short?.06:.32),0,quiet?.01:.2);
  fill(start+.45,start+2,4);fill(start+2.1,start+3.2,0);
  return {f0,clarity,rms,hop,sa};
}
test('delayed vocal Sa cue keeps a short opening hold ahead of a later long Ga',()=>{
  const d=delayedEntry(),entry=DSP.findDelayedVocalEntry(d.f0,d.clarity,d.hop,d.rms);
  assert.ok(entry);assert.ok(Math.abs(entry.hz-d.sa)<.01);assert.equal(entry.start,35);
});
test('delayed entry cue stays inactive for ordinary starts and quiet leakage',()=>{
  const d=delayedEntry({early:true});assert.equal(DSP.findDelayedVocalEntry(d.f0,d.clarity,d.hop,d.rms),null);
  const q=delayedEntry({quiet:true});const e=DSP.findDelayedVocalEntry(q.f0,q.clarity,q.hop,q.rms);
  assert.ok(!e||e.start>=35.4,'quiet residual must not establish the tonic');
  const short=delayedEntry({short:true});const s=DSP.findDelayedVocalEntry(short.f0,short.clarity,short.hop,short.rms);
  assert.ok(!s||s.start>=35.4,'a brief blip is not a deliberate opening hold');
});
test('a supported separated-vocal entry can disambiguate a mix dominated by the later Ga',()=>{
  const v=delayedEntry(),entry=DSP.findDelayedVocalEntry(v.f0,v.clarity,v.hop,v.rms);
  const mix=Float32Array.from({length:7000},(_,i)=>v.sa*2**((i<3500?-8:4)/12));
  const clarity=new Float32Array(7000).fill(.95),rms=new Float32Array(7000).fill(.2);
  const result=DSP.detectTonic(mix,clarity,.01,rms,{vocalEntry:entry});
  assert.ok(Math.abs(1200*Math.log2(result[0].hz/v.sa))<10,JSON.stringify(result));
  assert.equal(result[0].vocalEntry,true);assert.equal(result[0].uncertain,true);
});
