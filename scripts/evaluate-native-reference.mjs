#!/usr/bin/env node
// Offline only: independent observations, never new inference or model enrollment.
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const flags = new Map([['--bank', 'bank'], ['--samples', 'samples'], ['--model', 'model'], ['--output', 'output']]);
const options = {};
const args = process.argv.slice(2);
while (args.length) {
  const flag = args.shift(), key = flags.get(flag), value = args.shift();
  if (!key || !value || value.startsWith('--') || Object.hasOwn(options, key)) throw new Error('Expected --bank FILE --samples HELDOUT_JSONL --model EXACT_MODEL');
  options[key] = value;
}
if (!options.bank || !options.samples || !options.model) throw new Error('Expected --bank FILE --samples HELDOUT_JSONL --model EXACT_MODEL');
const repo = path.dirname(path.dirname(await realpath(process.argv[1])));
const { analyzeGlobalOutputs } = await import(pathToFileURL(path.join(repo, 'static', 'fingerprint-core.js')));
const { classifySample } = await import(pathToFileURL(path.join(repo, 'codex-plugin', 'modeltrace-guard', 'scripts', 'state.mjs')));
const bankBytes = await readFile(path.resolve(options.bank));
const bank = JSON.parse(bankBytes);
if (!bank.models.some(model => model.id === options.model)) throw new Error('Expected model is absent from the bank');
const training = (await readFile(path.join(repo, 'data', 'gpt_reference.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
const trainingIds = new Set(training.map(row => row.challenge_id));
const trainingHashes = new Set(training.map(row => createHash('sha256').update(row.text).digest('hex')));
const rows = (await readFile(path.resolve(options.samples), 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
if (!rows.length) throw new Error('No heldout samples');
const hashes = new Set(), ids = new Set();
const results = rows.map(row => {
  const digest = createHash('sha256').update(row.text).digest('hex');
  if (row.split !== 'heldout' || row.training_approved !== false || !row.strict_valid || !row.route_verified
    || row.model_id !== options.model || row.route_evidence?.transport !== 'official'
    || !row.route_evidence?.completed || !row.route_evidence?.success
    || row.route_evidence?.responseEvent !== 'response.completed'
    || trainingIds.has(row.challenge_id) || trainingHashes.has(digest) || hashes.has(digest) || ids.has(row.row_id)) {
    throw new Error('Heldout provenance, split or independence check failed');
  }
  hashes.add(digest); ids.add(row.row_id);
  const analysis = analyzeGlobalOutputs([{ text: row.text, expected_count: row.requested_count }], bank);
  const classification = classifySample(analysis, options.model);
  return { challengeId: row.challenge_id, language: /query-heldout-zh/.test(row.challenge_id) ? 'zh' : 'en',
    ...classification, expectedRank: analysis.results.findIndex(item => item.model === options.model) + 1 };
});
const grouped = ['zh', 'en'].map(language => {
  const selected = rows.filter(row => row.challenge_id.includes(`-${language}-`));
  if (!selected.length) return { language, samples: 0 };
  const analysis = analyzeGlobalOutputs(selected.map(row => ({ text: row.text, expected_count: row.requested_count })), bank);
  return { language, samples: selected.length, ...classifySample(analysis, options.model) };
});
const report = {
  model: options.model, bankSha256: createHash('sha256').update(bankBytes).digest('hex'),
  independentSamples: rows.length, correctPredictions: results.filter(row => row.prediction === options.model).length,
  compatibleSamples: results.filter(row => row.outcome === 'compatible').length, results, grouped,
  calibrated: false,
  note: 'Independent Official observations using monitoring prompts in isolated native threads. Small-sample evaluation only; not a frozen-context fork, calibrated false-positive rate, or proof of backend identity.',
};
if (options.output) await writeFile(path.resolve(options.output), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
process.stdout.write(JSON.stringify(report) + '\n');
