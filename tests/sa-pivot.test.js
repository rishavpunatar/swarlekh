'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const DSP = require('../js/dsp');
const Corrections = require('../js/corrections');

// Run the actual editor handlers with a minimal DOM. Rendering has zero layout
// size here; pitch detection, edits, score/export updates and controls are real.
function editor() {
  const elements = new Map();
  function element() {
    return { value:'', textContent:'', hidden:false, style:{}, dataset:{}, children:[], clientWidth:0, clientHeight:0,
      classList:{add(){},remove(){},toggle(){}}, listeners:{},
      addEventListener(type,fn){this.listeners[type]=fn;},
      setAttribute(){}, getContext(){return {};}, querySelectorAll(){return [];},
      appendChild(child){this.children.push(child);}, append(...children){this.children.push(...children);},
    };
  }
  const document={
    getElementById(id){if(!elements.has(id)) elements.set(id,element());return elements.get(id);},
    querySelector(){return element();},createElement:element,addEventListener(){},
    documentElement:element(),body:element(),
  };
  document.getElementById('sourceSel').value='original';
  document.getElementById('detailSel').value='clean';
  document.getElementById('speedSel').value='1';
  const window={addEventListener(){}};
  const context=vm.createContext({window,document,DSP,Corrections,Audio:element,
    Float32Array,Float64Array,Uint8Array,Map,Set,URL,Blob,console,
    localStorage:{getItem(){return null;},setItem(){}},
    getComputedStyle(){return {getPropertyValue(){return '';}};},
    setTimeout(){return 0;},clearTimeout(){},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/main.js'),'utf8'),context);
  const app=window.SwarLekh;
  const f0=Float32Array.from({length:400},(_,i)=>i%100<80?220*2**([0,2,4,7][Math.floor(i/100)]/12):0);
  Object.assign(app.state,{saHz:220,notationSaHz:220,duration:4,f0,f0raw:f0,f0auto:f0,
    clarity:Float32Array.from(f0,hz=>hz?1:0),hopSec:.01});
  app.state.opts.rms=Float32Array.from(f0,hz=>hz?.2:0);
  app.renotate();
  return {app,elements};
}
const plain=value=>JSON.parse(JSON.stringify(value));

test('fine-tuning Sa repeatedly pivots automatic and edited notes by the same cumulative interval',()=>{
  const {app}=editor();
  app._editNote(1,5);
  const before=plain(app.state.tokens);
  app._changeSa(220*2**(.4/12));
  app._changeSa(220*2**(.8/12));
  assert.deepEqual(plain(app.state.tokens.map(n=>n.k)),before.map(n=>n.k-1));
  assert.deepEqual(plain(app.state.tokens.map(n=>[n.t0,n.t1])),before.map(n=>[n.t0,n.t1]));
  app.renotate();
  assert.deepEqual(plain(app.state.tokens.map(n=>n.k)),before.map(n=>n.k-1),'subsequent edits/regeneration retain the pivot');
  app._changeSa(220);
  assert.deepEqual(plain(app.state.tokens.map(n=>n.k)),before.map(n=>n.k));
});

test('Ga and Ni pivots preserve every interval, added/deleted note, and edit undo',()=>{
  const {app,elements}=editor();
  app._addNote(.85,.95,9);
  app._selectNote(0);app._deleteNote();
  const before=plain(app.state.tokens);
  // A pure relabel must not call detection at all, even if settings would
  // produce a different draft. Subsequent regeneration uses the stable tonic.
  const detect=DSP.notate;
  try {
    DSP.notate=()=>{throw new Error('Relabel called detection');};
    app._changeSa(220/2**(4/12));
    assert.deepEqual(plain(app.state.tokens.map(n=>n.k)),before.map(n=>n.k+4));
    assert.equal(app.state.tokens.length,before.length);
    app._changeSa(220*2**(1/12));
    assert.deepEqual(plain(app.state.tokens.map(n=>n.k)),before.map(n=>n.k-1));
  } finally {DSP.notate=detect;}
  app.renotate();
  assert.deepEqual(plain(app.state.tokens.map(n=>[n.t0,n.t1,n.k])),before.map(n=>[n.t0,n.t1,n.k-1]));
  app._undoNoteEdit();
  assert.ok(app.state.tokens.some(n=>n.t0===0&&n.k===-1),'undo deletion restores a note in the new Sa');
  assert.equal(app._exportJson().notationSaHz,220);
  elements.get('undoSaBtn').listeners.click();
  assert.ok(Math.abs(app.state.saHz-220/2**(4/12))<1e-9);
});

test('all ornament pitches and octave crossings shift along with their parent note',()=>{
  const source=[{t0:1,t1:2,k:11,learnedK:11,cents:1112,sungCents:1117,
    via:[7,9,11],kan:[9],murki:[9,11,9],graceAfter:[12],andolanLo:10,andolanHi:12,
    manualFreeTargetK:14,orn:[{k:9,t0:.9,t1:1,type:'meend'}]}];
  const shifted=Corrections.transposeTokens(source,4);
  assert.equal(shifted[0].k,15);assert.equal(DSP.tokenText(shifted[0].k,false),"g'");
  assert.deepEqual(shifted[0].via,[11,13,15]);
  assert.deepEqual(shifted[0].orn,[{k:13,t0:.9,t1:1,type:'meend'}]);
  assert.equal(shifted[0].manualFreeTargetK,18);
  assert.deepEqual(Corrections.transposeTokens(shifted,-4),source);
});

test('Best-engine notes retain their pivot after regeneration and saved-state restoration',()=>{
  const {app}=editor();
  app.state.noteRegions=[0,2,4,7].map((k,i)=>({onset:i,offset:i+.8,frequency:220*2**(k/12)}));
  app.renotate();
  app._editNote(1,5);
  const before=plain(app.state.tokens.map(n=>[n.t0,n.t1,n.k]));
  app._changeSa(220/2**(4/12));
  app.renotate();
  assert.deepEqual(plain(app.state.tokens.map(n=>[n.t0,n.t1,n.k])),before.map(([a,b,k])=>[a,b,k+4]));
  const saved={saHz:app.state.saHz,notationSaHz:app.state.notationSaHz,manualEdits:plain(app.state.manualEdits)};
  const restored=editor().app;
  restored.state.noteRegions=plain(app.state.noteRegions);
  Object.assign(restored.state,saved);
  restored.renotate();
  assert.deepEqual(plain(restored.state.tokens.map(n=>[n.t0,n.t1,n.k])),before.map(([a,b,k])=>[a,b,k+4]));
});
