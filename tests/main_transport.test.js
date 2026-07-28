'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('Best analysis preserves original upload channels and invalidates mono cache', () => {
  const source = fs.readFileSync(path.join(__dirname, '../js/main.js'), 'utf8');

  assert.match(source, /state\.fileBytes = ab\.slice\(0\)/);
  assert.match(source, /const audio = state\.fileBytes \|\| encodeWav/);
  assert.match(source, /const hash = 'v6:' \+ await fileHash/);
});
