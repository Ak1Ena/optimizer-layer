#!/usr/bin/env node
// Offline calibration only: scores are not probabilities and never cause interventions.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { retrieveContext } from '../packages/runtime/src/context.ts';

const benchmark = resolve(import.meta.dirname, '../examples/benchmark');
const tasks = JSON.parse(readFileSync(join(benchmark, 'tasks.json'), 'utf8'));
const maxFileBytes = 256 * 1024;
// The runtime tokenizer is private; keep its stop words, adding generic request filler.
const stopWords = new Set(('the and for with that this from into must should shall when then each every support returns return '
  + 'have has are not can will acceptance some one make only than more before after how what which its any all fix').split(' '));
const tokens = text => new Set((text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
  .filter(word => word.length > 2 && !stopWords.has(word)));
const comparePath = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const authorityWords = /\b(?:decisions?|polic(?:y|ies)|rules?|contracts?|requirements?|specifications?)\b/i;
const constraintWords = /\b(?:must|shall|never|defined|identified|keep|required|cannot)\b/gi;

function parseFile(path, buffer) {
  assert(buffer.length <= maxFileBytes, `File size limit: ${path}`);
  assert(!buffer.includes(0), `Binary file unsupported: ${path}`);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  const links = [];
  for (const line of text.split(/\r?\n/)) {
    // shortcut: simple Markdown links and single backticks only; use a parser for complex markup.
    const references = [...line.matchAll(/`([^`\n]+)`|\[[^\]]*\]\(([^)\s]+)\)/g)];
    const prose = line.replace(/`([^`\n]+)`|\[[^\]]*\]\(([^)\s]+)\)/g, reference => ' '.repeat(reference.length));
    for (const match of references) {
      let target;
      try { target = decodeURIComponent((match[1] ?? match[2]).split(/[?#]/)[0]); }
      catch { continue; }
      if (!target || target.startsWith('/') || target.includes('\\') || /^[\w+.-]+:/.test(target)) continue;
      target = posix.normalize(posix.join(posix.dirname(path), target));
      if (target === '..' || target.startsWith('../')) continue;
      const before = prose.slice(0, match.index).split(/[.!?](?:\s|$)/).at(-1);
      const after = prose.slice(match.index + match[0].length).split(/[.!?](?:\s|$)/)[0];
      links.push({ target, authority: authorityWords.test(`${before} ${after}`) });
    }
  }
  return {
    path, text, tokens: tokens(`${path} ${text}`), links,
    constraints: new Set((text.match(constraintWords) ?? []).map(word => word.toLowerCase())).size,
    digest: createHash('sha256').update(buffer).digest('hex'),
  };
}

function refresh(root, index, overlay = new Map()) {
  const seen = new Set();
  let parsed = 0;
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const absolute = join(directory, entry.name);
      assert(!entry.isSymbolicLink(), `Symlink unsupported: ${absolute}`);
      if (entry.isDirectory()) { visit(absolute); continue; }
      assert(entry.isFile(), `Non-regular file unsupported: ${absolute}`);
      const path = relative(root, absolute).split('\\').join('/');
      seen.add(path);
      const stat = lstatSync(absolute, { bigint: true });
      assert(stat.size <= BigInt(maxFileBytes), `File size limit: ${path}`);
      const stamp = `${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
      const previous = index.get(path);
      if (!overlay.has(path) && previous?.stamp === stamp) continue;
      const buffer = overlay.get(path) ?? readFileSync(absolute);
      const digest = createHash('sha256').update(buffer).digest('hex');
      if (previous?.digest === digest) { previous.stamp = stamp; continue; }
      const file = parseFile(path, buffer);
      // Synthetic edits must not masquerade as a filesystem snapshot on the next refresh.
      index.set(path, { ...file, stamp: overlay.has(path) ? null : stamp });
      parsed++;
    }
  }
  visit(root);
  for (const path of index.keys()) if (!seen.has(path)) index.delete(path);
  return parsed;
}

function rank(index, query) {
  const queryTokens = tokens(query);
  const incoming = new Set();
  const authoritative = new Set();
  for (const source of index.values()) {
    if (![...queryTokens].some(token => source.tokens.has(token))) continue;
    for (const link of source.links) {
      if (link.target === source.path || !index.has(link.target)) continue;
      incoming.add(link.target);
      if (link.authority) authoritative.add(link.target);
    }
  }
  return [...index.values()].map(file => {
    const relevance = [...queryTokens].filter(token => file.tokens.has(token)).length / Math.max(1, queryTokens.size);
    const link = incoming.has(file.path) ? 0.25 : 0;
    const authority = authoritative.has(file.path) ? 1 : 0;
    const constraints = relevance > 0 ? Math.min(1, file.constraints / 4) : 0;
    return { path: file.path, score: relevance + link + authority + constraints, relevance, link, authority, constraints };
  }).sort((a, b) => b.score - a.score || comparePath(a.path, b.path));
}

function selfCheck() {
  const source = parseFile('entry.txt', Buffer.from('Requirements for widgets are in [reference](reference.rst).'));
  const target = parseFile('reference.rst', Buffer.from('Widgets must be unique. Never discard provenance.'));
  const index = new Map([[source.path, source], [target.path, target]]);
  const ranked = rank(index, 'Fix widgets');
  assert.equal(ranked[0].path, target.path);
  assert.equal(ranked[0].authority, 1);
  const sentences = parseFile('entry.txt', Buffer.from('Use `widget.mjs`. Requirements for widgets are in `reference.rst`.'));
  assert.deepEqual(sentences.links.map(link => link.authority), [false, true]);
  assert.equal(parseFile('entry.txt', Buffer.from('[external](https://example.invalid/a) [escape](../a) [absolute](/a)')).links.length, 0);
  const moved = parseFile('renamed.txt', Buffer.from(target.text));
  const newSource = parseFile(source.path, Buffer.from(source.text.replace('reference.rst', moved.path)));
  const renamed = rank(new Map([[newSource.path, newSource], [moved.path, moved]]), 'Fix widgets');
  assert.equal(renamed[0].path, moved.path);
  assert.equal(renamed[0].score, ranked[0].score);
  const tied = rank(new Map(['b.txt', 'a.txt'].map(path => [path, parseFile(path, Buffer.from('same'))])), 'unrelated');
  assert.deepEqual(tied.map(file => file.path), ['a.txt', 'b.txt']);
  const irrelevant = parseFile('unrelated.txt', Buffer.from('Must never keep required material.'));
  assert.equal(rank(new Map([[irrelevant.path, irrelevant]]), 'widgets')[0].constraints, 0);
  assert.throws(() => parseFile('binary', Buffer.from([0])), /Binary/);
  assert.throws(() => parseFile('large', Buffer.alloc(maxFileBytes + 1)), /size limit/);
}
selfCheck();

// Evaluate the unchanged public runtime API before the new index. It has no native rank/score.
// No conversations are supplied: these repository fixtures have no imported event-store decisions.
const baseline = tasks.map(task => {
  // tasks.json contains names/classes; the benchmark itself loads the goal from task.txt.
  const root = join(benchmark, 'tasks', task.name, 'repo');
  const text = readFileSync(join(benchmark, 'tasks', task.name, 'task.txt'), 'utf8');
  const goal = { version: 1, request: text, requirements: [{ id: 'R1', statement: text, acceptance: '', sourceLine: 1 }], uncertainties: [] };
  const start = performance.now();
  const context = retrieveContext(root, goal, []);
  const milliseconds = performance.now() - start;
  assert(context.complete, context.diagnostics.join('; '));
  const counts = new Map();
  for (const item of context.items) {
    const path = relative(root, item.path);
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return { ...task, root, text, milliseconds, counts };
});
console.log('VERIFIED baseline public retrieveContext(): lexical excerpt selection, no native file ranking/alert threshold; timings are single-shot and include first-call/JIT effects, not a speed comparison');
for (const task of baseline) console.log(`${task.name}: ${[...task.counts].map(([path, count]) => `${path}=${count}`).join(', ')} (${task.milliseconds.toFixed(3)} ms)`);

const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const results = baseline.map(task => {
  const buildTimes = [];
  const updateTimes = [];
  const unchangedTimes = [];
  let ranked;
  let fileCount;
  // Includes directory traversal, stat, read, hash, tokenization, link graph and query scoring.
  for (let repetition = 0; repetition < 25; repetition++) {
    const index = new Map();
    let start = performance.now();
    const count = refresh(task.root, index);
    ranked = rank(index, task.text);
    buildTimes.push(performance.now() - start);
    assert.equal(count, index.size);
    fileCount = count;
    start = performance.now();
    assert.equal(refresh(task.root, index), 0);
    rank(index, task.text);
    unchangedTimes.push(performance.now() - start);
    const changed = index.get(ranked[0].path);
    const overlay = new Map([[changed.path, Buffer.from(`${changed.text}\n`)]]);
    start = performance.now();
    assert.equal(refresh(task.root, index, overlay), 1);
    const updated = rank(index, task.text);
    updateTimes.push(performance.now() - start);
    assert.notEqual(index.get(changed.path).digest, changed.digest);
    assert.deepEqual(updated, ranked); // A trailing newline changes the hash, not evidence.
    assert.equal(refresh(task.root, index), 1); // Restore cached content, never touch the fixture.
  }
  const ablatedIndex = new Map();
  refresh(task.root, ablatedIndex);
  for (const file of ablatedIndex.values()) for (const link of file.links) link.authority = false;
  return { ...task, ranked, withoutAuthority: rank(ablatedIndex, task.text), fileCount, buildTimes, updateTimes, unchangedTimes };
});

// Pilot labels influence calibration only, never candidate scores. A control is any non-ambiguous task.
const positives = results.filter(task => task.class === 'ambiguous');
const controls = results.filter(task => task.class !== 'ambiguous');
assert(positives.length && controls.length);
const scores = [...new Set(results.map(task => task.ranked[0].score))].sort((a, b) => a - b);
const thresholds = [0, ...scores.slice(1).map((score, index) => (scores[index] + score) / 2), scores.at(-1) + 0.001];
const choices = thresholds.map(threshold => {
  const tp = positives.filter(task => task.ranked[0].score >= threshold).length;
  const fp = controls.filter(task => task.ranked[0].score >= threshold).length;
  return { threshold, tp, fp, objective: tp / positives.length - fp / controls.length };
}).sort((a, b) => b.objective - a.objective || a.fp - b.fp || b.threshold - a.threshold);
const calibrated = choices[0];
console.log(`\nPILOT-ONLY alert threshold >= ${calibrated.threshold.toFixed(6)} (full-precision ${calibrated.threshold}); chosen on these same ${results.length} tasks, NOT held-out evidence`);
console.log(`Detection proxy: ${calibrated.tp}/${positives.length} ambiguous tasks; false-positive tasks: ${calibrated.fp}/${controls.length} controls. This does not test trace gaps or AC6.`);
console.log('Score = query-token coverage + 0.25 referenced + 1 authority-labelled reference + constraint bonus (min(1, distinct constraint cues / 4), zero without query overlap).');
console.log(`Calibration gap: weakest ambiguous top score ${Math.min(...positives.map(task => task.ranked[0].score)).toFixed(6)} minus strongest control ${Math.max(...controls.map(task => task.ranked[0].score)).toFixed(6)} = ${(Math.min(...positives.map(task => task.ranked[0].score)) - Math.max(...controls.map(task => task.ranked[0].score))).toFixed(6)}.`);
console.log(`Authority-word ablation at the same threshold: ${positives.filter(task => task.withoutAuthority[0].score >= calibrated.threshold).length}/${positives.length} ambiguous tasks alert; success here depends on English authority wording in referring prose, not demonstrated ambiguity detection.`);
console.log('Critical-context ground truth is supplied by the research question, not inferred or read from restricted files; compare the ranked paths with those labels separately.');
console.log('\n| Task | Class | Top 3 candidates (score) | Alert candidates | Build p50 ms | Update p50 ms |');
console.log('|---|---|---|---|---:|---:|');
for (const task of results) {
  const format = file => `${file.path} (${file.score.toFixed(3)})`;
  const alerts = task.ranked.filter(file => file.score >= calibrated.threshold).map(file => file.path);
  console.log(`| ${task.name} | ${task.class} | ${task.ranked.slice(0, 3).map(format).join('; ')} | ${alerts.join(', ') || 'none'} | ${percentile(task.buildTimes, 0.5).toFixed(3)} | ${percentile(task.updateTimes, 0.5).toFixed(3)} |`);
}
for (const [label, key] of [['Build', 'buildTimes'], ['One-file synthetic update', 'updateTimes'], ['Unchanged refresh', 'unchangedTimes']]) {
  const times = results.flatMap(task => task[key]);
  console.log(`${label}: p50=${percentile(times, 0.5).toFixed(3)} ms p95=${percentile(times, 0.95).toFixed(3)} ms max=${Math.max(...times).toFixed(3)} ms (${times.length} samples, warm filesystem cache; process startup excluded).`);
}
console.log(`Indexed ${results.reduce((sum, task) => sum + task.fileCount, 0)} files across ${results.length} repositories. Self-checks passed.`);
console.log('Incremental: mtimeNs/ctimeNs/size detect changes; hash skips unchanged bytes; changed files alone are re-tokenized; deleted files removed; links/scores rebuilt.');
console.log('Update measurement uses a changed-content memory overlay plus real traversal/stat/hash/reindex; no fixture is edited, so changed-file disk-read and watcher latency are NOT measured.');
console.log('Limits: simple links only, no semantic entailment or decision authority verification; keyword-heavy decoys and ties can mislead; unlinked/non-text decisions can be missed.');
