import assert from 'node:assert/strict';

process.env.TZ = 'Asia/Tokyo';
const { weekOf } = await import('../src/week.mjs');
// Sunday 2026-03-15, late evening UTC, belongs to the week of Monday 2026-03-09.
assert.equal(weekOf('2026-03-15T23:30:00Z'), '2026-03-09');
console.log('ok');
