import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { confusableGroupsFor, loadArtifacts } from '../scripts/guard.mjs';
import { classifySample, isMismatch } from '../scripts/state.mjs';

const GROUP = [{ id: 'gpt-6.1-sol~gpt-6-astra', models: ['gpt-6.1-sol', 'gpt-6-astra'], minimumGroupWeight: 0.5 }];
const scored = (...rows) => ({ results: rows.map(([model, probability]) => ({ model, probability })) });
const sample = (evidence, expected = 'gpt-6.1-sol') => ({ expected, ...evidence });

test('the shipped group matches the bundled bank exactly and loads', async () => {
  const file = JSON.parse(await readFile(new URL('../assets/confusable-groups.json', import.meta.url), 'utf8'));
  const provenance = JSON.parse(await readFile(new URL('../assets/provenance.json', import.meta.url), 'utf8'));
  assert.equal(file.bankSha256, provenance.bankSha256, 'a rebuilt bank must re-validate its confusable groups');
  const { confusableGroups } = await loadArtifacts();
  assert.deepEqual(confusableGroups, GROUP);
});

test('a stale, malformed or unknown-model group file is ignored, keeping the strict rule', async () => {
  const { bank, metadata } = await loadArtifacts();
  const file = JSON.parse(await readFile(new URL('../assets/confusable-groups.json', import.meta.url), 'utf8'));
  assert.deepEqual(confusableGroupsFor({ ...file, bankSha256: '0'.repeat(64) }, metadata, bank), []);
  assert.deepEqual(confusableGroupsFor({ ...file, schema: 2 }, metadata, bank), []);
  assert.deepEqual(confusableGroupsFor(null, metadata, bank), []);
  assert.deepEqual(confusableGroupsFor({ ...file, groups: [{ ...file.groups[0], models: ['gpt-6.1-sol', 'not-in-bank'] }] }, metadata, bank), []);
  assert.deepEqual(confusableGroupsFor({ ...file, groups: [{ ...file.groups[0], minimumGroupWeight: 0.2 }] }, metadata, bank), []);
});

test('the real third verification sample is group-compatible instead of inconclusive', () => {
  // Official gpt-6.1-sol canary of 2026-10-21: astra 0.4998, expected sol only 0.0251.
  const result = scored(['gpt-6-astra', 0.4997552603951844], ['gpt-5.5', 0.20132483900603054], ['gpt-6-sol', 0.10672300739429631], ['gpt-6.1-sol', 0.02512977239663095]);
  assert.equal(classifySample(result, 'gpt-6.1-sol').outcome, 'inconclusive', 'strict rule without groups');
  const evidence = classifySample(result, 'gpt-6.1-sol', [], GROUP);
  assert.equal(evidence.outcome, 'compatible'); assert.equal(evidence.prediction, 'gpt-6-astra');
  assert.equal(evidence.confusableGroup.id, 'gpt-6.1-sol~gpt-6-astra');
  assert.ok(Math.abs(evidence.confusableGroup.groupWeight - 0.5248850327917554) < 1e-12);
  assert.equal(isMismatch(sample(evidence)), false, 'no pause and no switch request');
});

test('group-compatible requires the group to carry the weight and never hides other models', () => {
  // Held-out zh-3: astra strong, sol 0.026 → strict difference_signal (official false positive).
  const strong = classifySample(scored(['gpt-6-astra', 0.9], ['gpt-6.1-sol', 0.026]), 'gpt-6.1-sol', [], GROUP);
  assert.equal(strong.outcome, 'compatible'); assert.equal(isMismatch(sample(strong)), false);
  assert.equal(classifySample(scored(['gpt-6-astra', 0.9], ['gpt-6.1-sol', 0.026]), 'gpt-6.1-sol').outcome, 'difference_signal');
  // Symmetric for a thread expecting gpt-6-astra.
  assert.equal(classifySample(scored(['gpt-6.1-sol', 0.6], ['gpt-6-astra', 0.1]), 'gpt-6-astra', [], GROUP).outcome, 'compatible');
  // The expected model ranked first but below 0.5 is also rescued by its group.
  const shared = classifySample(scored(['gpt-6.1-sol', 0.45], ['gpt-6-astra', 0.3], ['gpt-5.5', 0.25]), 'gpt-6.1-sol', [], GROUP);
  assert.equal(shared.outcome, 'compatible'); assert.equal(shared.confusableGroup.id, 'gpt-6.1-sol~gpt-6-astra');
  // Too little group weight stays inconclusive and remains a reported ranking disagreement.
  const weak = classifySample(scored(['gpt-6-astra', 0.4], ['gpt-5.5', 0.35], ['gpt-6.1-sol', 0.05]), 'gpt-6.1-sol', [], GROUP);
  assert.equal(weak.outcome, 'inconclusive'); assert.equal(weak.confusableGroup, undefined); assert.equal(isMismatch(sample(weak)), true);
  // The original API2 incident (gpt-5.6-luna 0.986) is untouched by the group.
  const luna = classifySample(scored(['gpt-5.6-luna', 0.986], ['gpt-6-astra', 0.01], ['gpt-6.1-sol', 0.00004]), 'gpt-6.1-sol', [], GROUP);
  assert.equal(luna.outcome, 'difference_signal'); assert.equal(luna.confusableGroup, undefined); assert.equal(isMismatch(sample(luna)), true);
  // Models outside every group keep the strict rule.
  assert.equal(classifySample(scored(['gpt-6-sol', 0.9], ['gpt-5.5', 0.05]), 'gpt-5.5', [], GROUP).outcome, 'difference_signal');
});
