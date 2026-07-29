'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('Best analysis preserves original upload channels and invalidates mono cache', () => {
  const source = fs.readFileSync(path.join(__dirname, '../js/main.js'), 'utf8');

  assert.match(source, /state\.fileBytes = ab\.slice\(0\)/);
  assert.match(source, /const audio = state\.fileBytes \|\| encodeWav/);
  assert.match(source, /const hash = 'v8:' \+ await fileHash/);
  assert.match(source, /REQUIRED_SERVER_ANALYSIS_VERSION = 5/);
  assert.match(source, /matras \\u2248 <b>/);
  assert.match(source, /_renderRhythm: renderRhythm/);
});

test('canvas notes support persistent drag correction and undo', () => {
  const source = fs.readFileSync(path.join(__dirname, '../js/main.js'), 'utf8');

  assert.match(source, /applyManualNoteEdits\(res\.tokens\)/);
  assert.match(source, /mode: 'note'/);
  assert.match(source, /applyManualTarget\(token, targetK\)/);
  assert.match(source, /commitManualNoteEdit\(dragInfo\.tokenIndex, targetK\)/);
  assert.match(source, /undoNoteBtn\.addEventListener\('click', undoManualNoteEdit\)/);
});

test('canvas supports persistent missing-note insertion with regenerated lines', () => {
  const source = fs.readFileSync(path.join(__dirname, '../js/main.js'), 'utf8');

  assert.match(source, /mode: 'add-note'/);
  assert.match(source, /commitManualNoteInsertion\(preview\.t0, preview\.t1, preview\.k\)/);
  assert.match(source, /type: 'insert'/);
  assert.match(source, /manualAddition: true/);
  assert.match(source, /DSP\.buildPracticeContour\(state\.tokens, out, hopSec\)/);
});
