import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT, choiceSelection, isControlCommand } from '../scripts/guard.mjs';
import { listCandidates, providerHistory } from '../scripts/switch-candidates.mjs';
import { switchControlContext } from '../scripts/switch-consent.mjs';
import { digest } from '../scripts/state.mjs';

const row = (id, name, extra = {}) => ({ id, name, category: null, fingerprint: digest(id), nativeOfficial: 0, followsNativeLogin: 0, managedCodexAccount: 0, ...extra });
const layout = (extra = {}) => ({
  providers: [
    row('company', 'API2 copy'), row('a-api2', 'API2'), row('doro', 'Doro'),
    row('official', 'OpenAI Official', { category: 'official', nativeOfficial: 1, followsNativeLogin: 1 }),
    row('managed', 'Work ChatGPT', { category: 'official', managedCodexAccount: 1 }),
    row('bound', 'Bound Official', { category: 'official' }),
    row('copilot', 'Copilot', { delegatedAuth: 1 }), row('xai', 'xAI', { delegatedAuth: 1 }),
    row('evil', 'bad\nname'),
  ],
  stack: { enabled: true, members: ['company', 'a-api2', 'xai'], keys: { 'api2-copy': 'company', api2: 'a-api2', xai: 'xai' } },
  defaultProvider: 'company', listener: { listen_address: '127.0.0.1', listen_port: 15721, auto_failover_enabled: 0 },
  mode: 'proxy', attached: true, pending: false, ...extra,
});
const descriptor = (id, name, transport, key) => ({ id, name, fingerprint: digest(id), transport, key });
const primary = descriptor('company', 'API2 copy', 'ccswitch', 'api2-copy');
const official = descriptor('official', 'OpenAI Official', 'official', null);
const config = { id: '11111111-1111-4111-8111-111111111111', primary, backup: official };
const summary = entries => entries.map(e => [e.number, e.name, e.reason, e.recommended, e.monitoringAfterSwitch]);

test('every CCSwitch card is listed: selectable ones numbered with the recommendation first, the rest with a reason', () => {
  const entries = listCandidates(layout(), config, primary, new Map(), new Map([['doro', 'needs_ccswitch_conversion']]));
  assert.deepEqual(summary(entries), [
    [1, 'OpenAI Official', null, true, 'stops'],
    [2, 'API2', null, false, 'continues'],
    [3, 'xAI', null, false, 'continues'],
    [null, 'API2 copy', 'current_route', false, 'continues'],
    [null, 'Doro', 'needs_ccswitch_conversion', false, 'continues'],
    [null, 'Work ChatGPT', 'managed_official_account', false, 'stops'],
    [null, 'Bound Official', 'official_card_not_native', false, 'stops'],
    [null, 'Copilot', 'needs_ccswitch_aggregation', false, 'continues'],
    [null, null, 'invalid_card', false, 'continues'],
  ]);
  assert.deepEqual(entries[0].descriptor, official, 'a selectable entry binds the exact card identity');
  // Ordinary cards connect directly, even as Stack members; only CCSwitch-managed logins use Stack.
  assert.equal(entries[1].descriptor.transport, 'direct'); assert.equal(entries[1].descriptor.key, null);
  assert.equal(entries[2].descriptor.transport, 'ccswitch'); assert.equal(entries[2].descriptor.key, 'xai');
  assert.equal(entries[4].descriptor, null);
});

test('without any problem a key-based card is selectable without CCSwitch Aggregation', () => {
  const plain = layout({ stack: { enabled: false, members: [], keys: {} } });
  const entries = listCandidates(plain, config, primary);
  assert.deepEqual(entries.filter(e => e.selectable).map(e => [e.number, e.name]), [[1, 'OpenAI Official'], [2, 'API2'], [3, 'Doro']]);
  assert.equal(entries.find(e => e.name === 'xAI').reason, 'needs_ccswitch_aggregation');
});

test('without a configured backup nothing is recommended and the primary comes first when it is not current', () => {
  const entries = listCandidates(layout(), { ...config, backup: null }, official);
  assert.deepEqual(summary(entries).slice(0, 4), [[1, 'API2 copy', null, false, 'continues'], [2, 'API2', null, false, 'continues'],
    [3, 'Doro', null, false, 'continues'], [4, 'xAI', null, false, 'continues']]);
  assert.equal(entries.find(e => e.name === 'OpenAI Official').reason, 'current_route');
});

test('returning to the primary needs it as the CCSwitch default and failover off', () => {
  assert.equal(listCandidates(layout({ defaultProvider: 'a-api2' }), config, official).find(e => e.primary).reason, 'primary_default_changed');
  assert.equal(listCandidates(layout({ listener: { auto_failover_enabled: 1 } }), config, official).find(e => e.primary).reason, 'ccswitch_failover_enabled');
});

test('the latest scored sample per card is shown, ignoring coverage gaps and foreign files', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'switch-candidates-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sample = (at, providerId, outcome, prediction) => ({ at, outcome, expected: 'gpt-6.1-sol', prediction, fork: { routing: { providerId } } });
  await writeFile(path.join(directory, `${digest('one')}.json`), JSON.stringify({ samples: [
    sample(1, 'company', 'compatible', 'gpt-6.1-sol'), sample(5, 'company', 'difference_signal', 'gpt-5.6-luna'),
    sample(9, 'company', 'missing_expected_model', 'gpt-6-astra'), sample(3, 'official', 'compatible', 'gpt-6.1-sol'),
  ] }));
  await writeFile(path.join(directory, `${digest('two')}.json`), JSON.stringify({ samples: [sample(4, 'official', 'repeated_difference', 'gpt-6-luna')] }));
  await writeFile(path.join(directory, `${digest('three')}.json`), '{not json');
  await writeFile(path.join(directory, 'gateway-config.json'), JSON.stringify({ samples: [sample(99, 'company', 'compatible', 'x')] }));
  const history = await providerHistory(directory);
  assert.deepEqual(history.get('company'), { at: 5, expected: 'gpt-6.1-sol', prediction: 'gpt-5.6-luna', outcome: 'difference_signal' });
  assert.deepEqual(history.get('official'), { at: 4, expected: 'gpt-6.1-sol', prediction: 'gpt-6-luna', outcome: 'repeated_difference' });
  assert.equal(listCandidates(layout(), config, official, history).find(e => e.id === 'company').lastCheck.prediction, 'gpt-5.6-luna');
});

test('an answer names exactly one target, and 0 stays a decline', () => {
  assert.deepEqual(choiceSelection({ pick: '2' }), { pick: 2 });
  assert.deepEqual(choiceSelection({ 'target-name': 'Doro' }), { name: 'Doro', id: undefined });
  for (const options of [{}, { pick: '1', 'target-name': 'Doro' }, { pick: '0' }, { pick: '-1' }, { pick: '1.5' }, { pick: 'one' }, { pick: '01' }]) {
    assert.throws(() => choiceSelection(options));
  }
});

test('listing and choosing are allowed while paused; anything chained to them is not', () => {
  const entry = path.join(ROOT, 'scripts', 'guard.mjs');
  const allowed = cmd => isControlCommand({ tool_name: 'Bash', tool_input: { command: cmd } });
  assert.equal(allowed(`node '${entry}' candidates --session s --request r`), true);
  assert.equal(allowed(`node '${entry}' choose --session s --request r --pick 2`), true);
  assert.equal(allowed(`node '${entry}' choose --session s --request r --target-name 'API2 copy'`), true);
  for (const suffix of [' choose --pick 2; echo bypass', ' candidates --unknown x', ' choose --request r --halt h']) assert.equal(allowed(`node '${entry}'${suffix}`), false);
});

test('an open incident asks the user to choose from the list, with the recommendation and keep-current option', () => {
  const state = { session: 's', taskHalt: { id: 'h' }, autoSwitch: { phase: 'awaiting_approval' },
    switchRequest: { id: 'r', haltId: 'h', status: 'pending', source: primary, target: official } };
  const text = switchControlContext(state, '/data', ROOT);
  assert.match(text, /candidates --session 's' --data-dir '\/data' --request 'r'/);
  assert.match(text, /choose --session 's' --data-dir '\/data' --request 'r' --pick <N>/);
  assert.match(text, /0 = keep "API2 copy"/);
  assert.match(text, /Mark "OpenAI Official" as recommended/);
  assert.match(text, /decline-switch/);
  const none = switchControlContext({ ...state, switchRequest: { ...state.switchRequest, target: null } }, '/data', ROOT);
  assert.match(none, /Nothing is recommended/);
});

test('cards that need CCSwitch are unavailable while its proxy is off; direct cards are not affected', () => {
  const entries = listCandidates(layout({ mode: 'direct', attached: false }), config, official);
  const by = name => entries.find(entry => entry.name === name);
  assert.equal(by('API2 copy').reason, 'ccswitch_proxy_off', 'this configured primary uses the CCSwitch default route');
  assert.equal(by('xAI').reason, 'ccswitch_proxy_off');
  assert.equal(by('API2').selectable, true); assert.equal(by('Doro').selectable, true);
});

test('switching back to a directly connected primary keeps its configured route and needs no CCSwitch default', () => {
  const direct = { ...config, primary: { ...primary, transport: 'direct', key: null } };
  const entries = listCandidates(layout({ defaultProvider: 'a-api2', listener: { auto_failover_enabled: 1 } }), direct, official);
  const back = entries.find(entry => entry.id === 'company');
  assert.equal(back.selectable, true); assert.deepEqual(back.descriptor, direct.primary);
  const edited = listCandidates(layout({ providers: layout().providers.map(p => (p.id === 'company' ? { ...p, fingerprint: 'e'.repeat(64) } : p)) }), direct, official);
  assert.equal(edited.find(entry => entry.id === 'company').reason, 'primary_changed');
});
