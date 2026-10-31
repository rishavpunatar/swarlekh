'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../js/main.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../style.css'), 'utf8');

test('server analysis reports live progress and has no fixed client timeout', () => {
  assert.match(source, /\/status\?job=\$\{jobId\}/);
  assert.match(source, /\/analyze\?job=\$\{jobId\}/);
  assert.match(source, /SERVER_SILENCE_LIMIT_MS/);
  assert.doesNotMatch(source, /30 \* 60 \* 1000/);
  assert.match(source, /'TimeoutError'/);
  assert.match(source, /resp\.status === 415/);            // WAV retry for unreadable formats
});

test('cancel stops the job on the server, not just the browser request', () => {
  assert.match(source, /\/cancel\?job=\$\{serverJobId\}/);
  assert.match(source, /cancelServerJob\(\);\s+\/\/ stop the work on the server too/);
});

test('note corrections persist per recording and restore on reload', () => {
  assert.match(source, /createObjectStore\('edits'\)/);
  assert.match(source, /idbPut\('edits:' \+ state\.fileSha/);
  assert.match(source, /const savedEdits = await loadNoteEdits\(state\.fileSha\)/);
  assert.match(source, /state\.manualEdits = savedEdits;/);
  assert.equal((source.match(/noteEditsChanged\(\);/g) || []).length, 5);
});

test('notation is readable as text and exportable', () => {
  assert.match(html, /id="notationCard"/);
  for (const id of ['copyBtn', 'dlTxtBtn', 'dlJsonBtn', 'printBtn', 'dlWavBtn']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(source, /DSP\.notationLines\(state\.phrases, state\.scale\)/);
  assert.match(source, /corrections: state\.manualEdits/);
  assert.match(css, /@media print/);
});

test('page markup satisfies the CSP and gives the canvas a text alternative', () => {
  assert.doesNotMatch(html, /\sstyle="/, 'inline style attributes are blocked by style-src');
  assert.match(html, /<canvas id="contour" role="img" aria-label=/);
  const versions = new Set([...html.matchAll(/\?v=(\d+)/g)].map((m) => m[1]));
  assert.equal(versions.size, 1, `mixed asset versions: ${[...versions]}`);
  assert.match(source, new RegExp(`WORKER_URL = 'js/worker\\.js\\?v=${[...versions][0]}'`));
});

test('practice layout: sticky transport, contour before analysis cards', () => {
  const order = ['playerCard', 'canvasCard', 'notationCard', 'tonicCard', 'ragaCard', 'settingsCard']
    .map((id) => html.indexOf(`id="${id}"`));
  assert.deepStrictEqual(order, [...order].sort((a, b) => a - b));
  assert.match(css, /#playerCard \{\s+position: sticky;/);
});

test('loops end on the animation frame and touch gestures are handled', () => {
  assert.match(source, /function tick\(\) \{\s+const t = origEl\.currentTime;[\s\S]{0,300}t >= state\.loopB\) \{\s+if \(state\.ramp\.on\) rampStep\(\);/);
  assert.match(source, /pinch = \{/);
  assert.match(source, /window\.scrollBy\(0, dragInfo\.lastY - e\.clientY\)/);
  assert.match(source, /NOTE_HOLD_MS/);
});

test('sing-along captures through an AudioWorklet with a fallback', () => {
  assert.match(source, /audioWorklet\.addModule\('js\/mic-worklet\.js\?v=/);
  assert.match(source, /createScriptProcessor\(4096, 1, 1\)/);
  assert.ok(fs.existsSync(path.join(__dirname, '../js/mic-worklet.js')));
});

test('verification aids: uncertain notes, notation playback and the sung-pitch trace', () => {
  assert.match(source, /DSP\.isUncertainNote\(tk\)/);
  assert.match(source, /DSP\.notationPitchTrack\(state\.tokens/);
  assert.match(html, /<option value="orignotation">Original \+ notation<\/option>/);
  assert.match(html, /<option value="notation">Notation only<\/option>/);
  assert.match(html, /id="sungBtn"[^>]*>Sung<\/button>/);
  assert.match(source, /state\.showSung && state\.centsSm/);
  assert.match(css, /\.unsure \{/);
});

test('contour names come from the tested layout module, and drift reaches drone and mic', () => {
  assert.match(source, /ContourLayout\.placeLabels\(labelItems/);
  assert.match(html, /<script src="js\/contour-layout\.js\?v=/);
  assert.match(source, /force: pxPerSec >= 60/);
  assert.match(source, /DSP\.driftAt\(state\.drift, origEl\.currentTime\)/);
  assert.match(source, /state\.opts\.droneStrength = result\.droneStrength/);
});
