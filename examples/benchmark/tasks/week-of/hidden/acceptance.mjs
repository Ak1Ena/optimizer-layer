import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [project, zone] = process.argv.slice(2);
if (!zone) {
  // Each zone runs in its own process so TZ is fixed before any Date is created.
  for (const tz of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Asia/Bangkok']) {
    const child = spawnSync(process.execPath, [import.meta.filename, project, tz], { encoding: 'utf8', env: { ...process.env, TZ: tz } });
    assert.equal(child.status, 0, `${tz}: ${child.stderr}`);
  }
} else {
  const { weekOf } = await import(pathToFileURL(join(project, 'src/week.mjs')).href);
  const { ordersByWeek } = await import(pathToFileURL(join(project, 'src/report.mjs')).href);
  const cases = [
    ['2026-03-09T00:00:00Z', '2026-03-09'], ['2026-03-11T12:00:00Z', '2026-03-09'], ['2026-03-15T00:00:00Z', '2026-03-09'],
    ['2026-03-15T23:59:59Z', '2026-03-09'], ['2026-03-16T00:00:00Z', '2026-03-16'], ['2026-01-04T22:00:00Z', '2025-12-29'],
    ['2026-03-08T09:30:00Z', '2026-03-02'], ['2026-11-01T08:00:00Z', '2026-10-26'],
  ];
  for (const [input, monday] of cases) assert.equal(weekOf(input), monday, `${zone} ${input}`);
  assert.deepEqual(ordersByWeek([{ id: 1, at: '2026-03-15T23:30:00Z' }, { id: 2, at: '2026-03-16T00:30:00Z' }]), { '2026-03-09': [1], '2026-03-16': [2] });
}
