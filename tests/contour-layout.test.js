'use strict';

// Drawing rules for note names on the contour: every note is named in the
// normal view, names never leave the plot, and when zoomed far out names that
// cannot fit are skipped instead of piling up as overlapping 7px text.
const test = require('node:test');
const assert = require('node:assert');
const { placeLabels, overlaps } = require('../js/contour-layout.js');

const measure = (text, size) => text.length * size * 0.62;
const bounds = { x0: 46, y0: 18, x1: 800, y1: 550 };

function denseItems(n, spacingPx) {
  const items = [];
  for (let i = 0; i < n; i++) {
    items.push({ text: ['S', 'R', 'G', 'm', 'P', "S'", '.N'][i % 7], cx: 60 + i * spacingPx, cy: 300 + 40 * Math.sin(i), big: i % 3 === 0 });
  }
  return items;
}

test('contour labels: a normal view names every note at a readable size without overlaps', () => {
  const out = placeLabels(denseItems(20, 36), { measure, bounds, force: true });
  assert.strictEqual(out.filter((p) => p.skipped).length, 0);
  assert.ok(out.every((p) => p.size >= 9.5), 'sparse notes keep their full size');
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
    assert.ok(!overlaps(out[i].box, out[j].box), `labels ${i} and ${j} overlap`);
  }
});

test('contour labels: names stay inside the plot, even for notes at its edges', () => {
  const items = [
    { text: "S'", cx: 47, cy: 19, big: true }, { text: '.N', cx: 799, cy: 549, big: true },
    { text: 'G', cx: 400, cy: 18.5, big: false }, { text: 'P', cx: 802, cy: 300, big: false },
  ];
  for (const p of placeLabels(items, { measure, bounds, force: true })) {
    assert.ok(p.box[0] >= bounds.x0 - 0.01 && p.box[2] <= bounds.x1 + 0.01, `x out of plot: ${p.box}`);
    assert.ok(p.box[1] >= bounds.y0 - 0.01 && p.box[3] <= bounds.y1 + 0.01, `y out of plot: ${p.box}`);
  }
});

test('contour labels: zoomed far out, names that cannot fit are skipped, never overlapped', () => {
  const out = placeLabels(denseItems(200, 3), { measure, bounds, force: false });
  const shown = out.filter((p) => !p.skipped);
  assert.ok(shown.length > 0 && shown.length < out.length, 'some names fit, the rest are skipped');
  for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) {
    assert.ok(!overlaps(shown[i].box, shown[j].box), 'no overlapping names when not forced');
  }
});

test('contour labels: important notes are placed first and win their lane', () => {
  const items = [
    { text: 'G', cx: 300, cy: 300, big: true },       // active/held note — first in priority
    { text: 'R', cx: 302, cy: 300, big: false },
  ];
  const out = placeLabels(items, { measure, bounds, force: true });
  assert.strictEqual(out[0].size, 13, 'the first (most important) name keeps its full size');
});
