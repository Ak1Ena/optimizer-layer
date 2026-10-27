#!/usr/bin/env node
// Summarizes benchmark-run.mjs results: per arm and per task class, plus AC1/AC2 from the adaptive-execution spec.
// Only recorded values are used; a statistic with no measured input is n/a, never estimated.
//   node scripts/benchmark-report.mjs RESULTS.jsonl [--json]
import { readFileSync } from 'node:fs';

const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const measured = values => values.filter(value => typeof value === 'number' && Number.isFinite(value));
const stat = values => {
  const known = measured(values);
  return { median: median(known), mean: mean(known), measured: known.length, of: values.length };
};

export function summarizeGroup(rows) {
  const verified = rows.filter(row => row.hiddenPassed).length;
  const costs = rows.map(row => row.totalCostUsd);
  // Cost per verified success needs every run's cost: an unknown cost cannot be summed.
  const costKnown = costs.every(cost => typeof cost === 'number');
  return {
    runs: rows.length, verified, verifiedRate: rows.length ? verified / rows.length : null,
    falseDone: rows.filter(row => row.falseDone).length,
    tokens: Object.fromEntries(['total', 'input', 'cacheRead', 'cacheWrite', 'output'].map(key => [key, stat(rows.map(row => row.tokens?.[key]))])),
    wallMs: stat(rows.map(row => row.wallMs)),
    turns: stat(rows.map(row => row.turns)),
    costUsd: costKnown && rows.length ? costs.reduce((sum, cost) => sum + cost, 0) : null,
    costPerVerified: costKnown && verified ? costs.reduce((sum, cost) => sum + cost, 0) / verified : null,
    overheadShare: stat(rows.filter(row => row.arm !== 'A').map(row => row.optimizer?.overheadShare)),
  };
}

const complex = new Set(['ambiguous', 'multi-file', 'misleading']);

/** Zero verified successes means an infinite cost per success; an unknown cost leaves the comparison null. */
function costNoWorse(c, b) {
  if (c.verified === 0) return false;
  if (b.verified === 0) return true;
  return c.costPerVerified === null || b.costPerVerified === null ? null : c.costPerVerified <= b.costPerVerified;
}

export function summarize(rows) {
  const arms = [...new Set(rows.map(row => row.arm))].sort();
  const classes = [...new Set(rows.map(row => row.class))].sort();
  const pick = (arm, keep = () => true) => rows.filter(row => row.arm === arm && keep(row));
  const byArm = Object.fromEntries(arms.map(arm => [arm, summarizeGroup(pick(arm))]));
  const byClass = Object.fromEntries(classes.map(kind => [kind, Object.fromEntries(arms.map(arm => [arm, summarizeGroup(pick(arm, row => row.class === kind))]))]));
  const ratio = (a, b) => a !== null && b !== null && b > 0 ? a / b : null;
  // A definite failure is FAIL even when another input is missing.
  const all = (...checks) => checks.includes(false) ? false : checks.includes(null) ? null : true;

  const sA = summarizeGroup(pick('A', row => row.class === 'straightforward'));
  const sC = summarizeGroup(pick('C', row => row.class === 'straightforward'));
  const tokenRatio = ratio(sC.tokens.total.median, sA.tokens.total.median);
  const wallRatio = ratio(sC.wallMs.median, sA.wallMs.median);
  const ac1 = {
    rule: 'straightforward: C median tokens and wall clock <= 1.25x A, and C verified rate >= A',
    tokenRatio, wallRatio, verifiedRateA: sA.verifiedRate, verifiedRateC: sC.verifiedRate, runsA: sA.runs, runsC: sC.runs,
    // Medians cover measured runs only; unmeasured (crashed, timed-out) runs are counted here, not estimated.
    tokensMeasuredA: sA.tokens.total.measured, tokensMeasuredC: sC.tokens.total.measured,
    pass: sA.runs && sC.runs ? all(tokenRatio === null ? null : tokenRatio <= 1.25, wallRatio === null ? null : wallRatio <= 1.25, sC.verifiedRate >= sA.verifiedRate) : null,
  };
  const cA = summarizeGroup(pick('A', row => complex.has(row.class)));
  const cB = summarizeGroup(pick('B', row => complex.has(row.class)));
  const cC = summarizeGroup(pick('C', row => complex.has(row.class)));
  const ac2 = {
    rule: 'ambiguous/multi-file/misleading: C verified rate >= A, and C cost per verified success <= B',
    verifiedRateA: cA.verifiedRate, verifiedRateC: cC.verifiedRate, costPerVerifiedB: cB.costPerVerified, costPerVerifiedC: cC.costPerVerified, runsA: cA.runs, runsB: cB.runs, runsC: cC.runs,
    pass: cA.runs && cB.runs && cC.runs ? all(cC.verifiedRate >= cA.verifiedRate, costNoWorse(cC, cB)) : null,
  };
  return { runs: rows.length, byArm, byClass, ac1, ac2 };
}

const na = value => value === null || value === undefined ? 'n/a' : value;
const int = value => value === null ? 'n/a' : Math.round(value).toLocaleString('en-US');
const pct = value => value === null ? 'n/a' : `${(value * 100).toFixed(0)}%`;
const usd = value => value === null ? 'n/a' : `$${value.toFixed(4)}`;
const sec = value => value === null ? 'n/a' : `${(value / 1000).toFixed(1)} s`;
const x = value => value === null ? 'n/a' : `${value.toFixed(2)}x`;
const verdict = value => value === null ? 'n/a (missing data)' : value ? 'PASS' : 'FAIL';
const partial = s => s.measured < s.of ? ` (${s.measured}/${s.of})` : '';

function table(title, groups) {
  const lines = [`## ${title}`, '', '| arm | runs | verified | false done | tokens median / mean | input / cache read / cache write / output (median) | wall median / mean | turns median | cost per verified | overhead share median |', '|---|---|---|---|---|---|---|---|---|---|'];
  for (const [arm, s] of Object.entries(groups)) {
    const t = s.tokens;
    lines.push(`| ${arm} | ${s.runs} | ${s.verified} (${pct(s.verifiedRate)}) | ${s.falseDone} | ${int(t.total.median)} / ${int(t.total.mean)}${partial(t.total)} | ${int(t.input.median)} / ${int(t.cacheRead.median)} / ${int(t.cacheWrite.median)} / ${int(t.output.median)} | ${sec(s.wallMs.median)} / ${sec(s.wallMs.mean)} | ${na(s.turns.median)} | ${usd(s.costPerVerified)} | ${arm === 'A' ? '-' : pct(s.overheadShare.median)}${arm === 'A' ? '' : partial(s.overheadShare)} |`);
  }
  return lines.join('\n');
}

export function markdown(summary) {
  const { ac1, ac2 } = summary;
  return [
    `# Benchmark report (${summary.runs} runs)`, '',
    'Verified = hidden acceptance test passed. False done = A ended without error, or B/C reported VERIFIED, while the hidden test failed. Tokens = input + cache read + cache write + output from Claude Code usage. Overhead share = optimizer start + verify + hook wall clock over the `optimizer run` wall clock. (k/n) = only k of n runs measured it.', '',
    table('By arm', summary.byArm), '',
    ...Object.entries(summary.byClass).flatMap(([kind, groups]) => [table(`Class: ${kind}`, groups), '']),
    '## Acceptance criteria', '',
    `- AC1 ${verdict(ac1.pass)}: ${ac1.rule}. C/A median tokens ${x(ac1.tokenRatio)} (measured A ${ac1.tokensMeasuredA}/${ac1.runsA}, C ${ac1.tokensMeasuredC}/${ac1.runsC}), C/A median wall clock ${x(ac1.wallRatio)}, verified rate A ${pct(ac1.verifiedRateA)} vs C ${pct(ac1.verifiedRateC)} (runs A ${ac1.runsA}, C ${ac1.runsC}).`,
    `- AC2 ${verdict(ac2.pass)}: ${ac2.rule}. Verified rate A ${pct(ac2.verifiedRateA)} vs C ${pct(ac2.verifiedRateC)}; cost per verified success B ${usd(ac2.costPerVerifiedB)} vs C ${usd(ac2.costPerVerifiedC)} (runs A ${ac2.runsA}, B ${ac2.runsB}, C ${ac2.runsC}).`,
    '',
  ].join('\n');
}

if (import.meta.main) {
  const path = process.argv.slice(2).find(item => !item.startsWith('--'));
  if (!path) throw new Error('usage: node scripts/benchmark-report.mjs RESULTS.jsonl [--json]');
  // A retried run appends a new row with the same id; the last one counts. Unparseable (cut) lines are skipped.
  const rows = [...new Map(readFileSync(path, 'utf8').split('\n').flatMap(line => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  }).map(row => [row.id, row])).values()];
  const summary = summarize(rows);
  process.stdout.write(process.argv.includes('--json') ? JSON.stringify(summary, null, 2) + '\n' : markdown(summary));
}
