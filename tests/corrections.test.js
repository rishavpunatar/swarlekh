'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {transposeEdits, removeIntervals, learnTiming} = require('../js/corrections');

test('Sa relabelling preserves expert pitches and free-bend targets, including history', () => {
  const sa = 220;
  const edits = [{type:'move',k:4,originalK:2,freeTargetK:7}, {type:'insert',k:0}];
  for (const steps of [-1, 4]) {
    const newSa=sa/2**(steps/12), moved=transposeEdits(edits,steps);
    for (let i=0;i<edits.length;i++) assert.ok(Math.abs(sa*2**(edits[i].k/12) - newSa*2**(moved[i].k/12))<1e-9);
    assert.deepEqual(transposeEdits(moved,-steps), edits);
  }
});
test('deleting a note cannot erase neighboring syllables after changed segmentation', () => {
  const tokens=[{t0:0,t1:1,k:0},{t0:1,t1:2,k:2},{t0:2,t1:3,k:4}];
  assert.deepEqual(removeIntervals(tokens,[{t0:1,t1:2}]),[tokens[0],tokens[2]]);
  const merged=[{t0:0,t1:3,k:0}];
  assert.deepEqual(removeIntervals(merged,[{t0:1,t1:2}]),[{t0:0,t1:1,k:0},{t0:2,t1:3,k:0}]);
  assert.equal(tokens.length,3);
});
test('reviewed syllables change timing floors without transferring tonic or pitch', () => {
  assert.equal(learnTiming([{notes:[{t0:0,t1:.1}]}]),null);
  const examples=[{notes:Array.from({length:12},(_,i)=>({t0:i*.2,t1:i*.2+.1,k:4})),saHz:220}];
  const learned=learnTiming(examples);
  assert.deepEqual(learned,{version:1,examples:1,minNoteMs:65,onsetMinMs:50});
  assert.ok(learned.minNoteMs<130);
  assert.equal(learnTiming([{notes:Array.from({length:8},()=>({t0:0,t1:1.5}))}]).minNoteMs,170);
});
test('adding over a deleted passage replaces only that part of the deletion', () => {
  const tombstones=[{type:'delete',t0:1,t1:2,time:1.5}];
  const remaining=removeIntervals(tombstones,[{t0:1.3,t1:1.7}]);
  assert.deepEqual(remaining.map(n=>[n.t0,n.t1]),[[1,1.3],[1.7,2]]);
  const final=removeIntervals([{t0:1.3,t1:1.7,k:4}],remaining);
  assert.equal(final.length,1);
});
