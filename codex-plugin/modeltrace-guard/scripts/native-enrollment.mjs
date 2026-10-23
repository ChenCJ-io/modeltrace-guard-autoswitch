// Opt-in reference collection. Importing this module never starts inference.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AppServerClient, CODEX_CLIENT_INFO, codexExecutable, disabledHooksOverride, openAppServer } from './app-server-client.mjs';
import { requireTrustedGuard, generateProbe } from './fork-runner.mjs';
import { parseNumbers } from './fingerprint-core.mjs';
import { assertProviderCurrent, gatewayURL, loadGatewayConfig, resolveProvider, verifyGatewayReady } from './provider-config.mjs';
import { readReceipt } from './switch-policy.mjs';
import { drainingRelay as referenceRelay } from './stream-relay.mjs';

export const ENROLLMENT_INSTRUCTIONS = 'This is an isolated reference-data collection expressly requested by the user. Answer the supplied numeric task once using the language model itself. Do not use tools, delegate, read files, or execute commands. Return only the requested complete sequence. Do not manage plugins or continue another task.';

export function referenceThreadParameters({ model, effort, cwd, challenge }) {
  return {
    model, modelProvider: 'openai', allowProviderModelFallback: false,
    cwd, runtimeWorkspaceRoots: [cwd], sandbox: 'read-only', approvalPolicy: 'never',
    ephemeral: true, environments: [], dynamicTools: [], serviceTier: 'default',
    developerInstructions: [ENROLLMENT_INSTRUCTIONS, challenge.system].filter(Boolean).join('\n\n'),
    config: { model_reasoning_effort: effort },
  };
}

export function referenceInput(challenge) {
  return [challenge.user_prefix, challenge.prompt].filter(Boolean).join('\n\n');
}

export function standardCreditEquivalent(usage) {
  if (!usage || !['inputTokens', 'cachedInputTokens', 'outputTokens'].every(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0)
    || usage.cachedInputTokens > usage.inputTokens) return null;
  return ((usage.inputTokens - usage.cachedInputTokens) * 50 + usage.cachedInputTokens * 2.5 + usage.outputTokens * 250) / 1e6;
}

export function referenceQuality(text, expectedCount) {
  const numbers = parseNumbers(text);
  const ratio = numbers.length / expectedCount;
  let patternValid = true, run = 0, previousDifference;
  for (let index = 1; index < numbers.length; index++) {
    const difference = numbers[index] - numbers[index - 1];
    run = difference === previousDifference ? run + 1 : 1;
    previousDifference = difference;
    if (run >= 15) patternValid = false;
  }
  for (let size = 2; size <= Math.floor(numbers.length / 4); size++) {
    if (numbers.length >= 4 * size && numbers.every((value, index) => value === numbers[index % size])) patternValid = false;
  }
  return { parsedCount: numbers.length, countRatio: ratio, patternValid,
    valid: numbers.length >= 80 && ratio >= 0.8 && ratio <= 1.2 && patternValid };
}

export function verifiedReferenceReceipt(receipt, { config, target, threadId, startedAt }) {
  return Boolean(receipt && receipt.threadId === threadId && receipt.configId === config.id
    && receipt.providerId === target.id && receipt.providerFingerprint === target.fingerprint
    && receipt.transport === 'official' && receipt.sourceKey === null
    && receipt.completed === true && receipt.success === true && receipt.responseEvent === 'response.completed'
    && Number.isInteger(receipt.statusCode) && receipt.statusCode >= 200 && receipt.statusCode < 300
    && receipt.startedAt >= startedAt && receipt.finishedAt >= receipt.startedAt);
}

export function referenceRow({ model, effort, challenge, generated, receipt, config, target, threadId,
  startedAt, cliVersion, collectionId, split = 'train', now = new Date().toISOString() }) {
  const quality = referenceQuality(generated.text, challenge.expected_count);
  const parsedCount = quality.parsedCount;
  const threshold = Math.max(80, Math.ceil(challenge.expected_count * 0.55));
  const routeVerified = verifiedReferenceReceipt(receipt, { config, target, threadId, startedAt });
  const rowId = `${model}__${collectionId}__${challenge.challenge_id}`;
  return {
    row_id: rowId, parent_row_id: rowId, bank_id: 'gpt', source: model, model_id: model,
    response_model: null, exact_version: model, condition_id: challenge.condition,
    nuisance_condition_id: challenge.condition, wrapper_id: challenge.condition,
    wrapper_transport: challenge.transport, challenge_id: challenge.challenge_id, task_index: 0,
    requested_count: challenge.expected_count, parsed_count: parsedCount, strict_threshold: threshold,
    strict_valid: quality.valid && routeVerified, route_verified: routeVerified,
    pattern_valid: quality.patternValid, count_ratio: quality.countRatio,
    output_sha256: createHash('sha256').update(generated.text).digest('hex'),
    training_approved: split === 'train' && routeVerified && quality.valid,
    split, temperature: 'provider_default', config_id: collectionId,
    provider: 'codex', reasoning_effort: effort, cli_version: cliVersion,
    prompt: referenceInput(challenge), base_prompt: challenge.prompt,
    system_prompt: challenge.system, user_prefix: challenge.user_prefix,
    native_system_prefix: ENROLLMENT_INSTRUCTIONS, native_system_prefix_role: 'developer',
    wrapper_system_role: challenge.system ? 'developer' : null,
    text: generated.text, usage: generated.usage, error: null, collected_at: now,
    native_thread_id: threadId,
    route_evidence: receipt ? {
      configId: receipt.configId, providerId: receipt.providerId, providerFingerprint: receipt.providerFingerprint,
      transport: receipt.transport, sourceKey: receipt.sourceKey, statusCode: receipt.statusCode,
      completed: receipt.completed, success: receipt.success, responseEvent: receipt.responseEvent,
      requestId: receipt.requestId, threadId: receipt.threadId, startedAt: receipt.startedAt, finishedAt: receipt.finishedAt,
    } : null,
  };
}

function validateChallenge(challenge) {
  if (!challenge || !/^query-[a-zA-Z0-9-]+$/.test(challenge.challenge_id || '')
    || !/^environment-\d+$/.test(challenge.condition || '')
    || !['clean', 'system', 'user'].includes(challenge.transport)
    || !Number.isInteger(challenge.expected_count) || challenge.expected_count < 80 || challenge.expected_count > 1000
    || !['prompt', 'system', 'user_prefix'].every(key => typeof challenge[key] === 'string') || !challenge.prompt.trim()
    || (challenge.transport !== 'system' && challenge.system) || (challenge.transport !== 'user' && challenge.user_prefix)) {
    throw new Error('Invalid reference challenge');
  }
}

const publicLimits = result => result ? {
  ordinaryUsageAllowed: result.ordinaryUsageAllowed ?? null,
  primary: result.rateLimits?.primary ?? null, secondary: result.rateLimits?.secondary ?? null,
  credits: result.rateLimits?.credits ?? null,
} : null;

// Shared with verification probes; see stream-relay.mjs.
export { referenceRelay };

export async function collectNativeReference(options, runtime = {}, emit = () => {}) {
  const { directory, output, model, effort = 'max', suite, split = 'train',
    providerName = 'OpenAI Official', timeoutSeconds = 180, maxCredits = 35 } = options;
  if (!path.isAbsolute(directory || '') || !path.isAbsolute(output || '')
    || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(model || '')
    || !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)
    || !['train', 'heldout'].includes(split) || !Array.isArray(suite) || !suite.length
    || !Number.isFinite(maxCredits) || maxCredits <= 0 || maxCredits > 200
    || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 600) throw new Error('Invalid native collection options');
  suite.forEach(validateChallenge);
  if (new Set(suite.map(challenge => challenge.challenge_id)).size !== suite.length) throw new Error('Duplicate reference challenge');
  const api = { AppServerClient, CODEX_CLIENT_INFO, codexExecutable, disabledHooksOverride, openAppServer,
    requireTrustedGuard, generateProbe, assertProviderCurrent, gatewayURL, loadGatewayConfig, resolveProvider,
    verifyGatewayReady, readReceipt, ...runtime };
  const env = { ...process.env, MODELTRACE_PROBE_PROCESS: '1' };
  for (const key of ['CODEX_THREAD_ID', 'CODEX_PARENT_THREAD_ID', 'CODEX_AGENT_ID']) delete env[key];
  const config = await api.loadGatewayConfig(directory);
  const target = api.resolveProvider(await api.verifyGatewayReady(directory, config), { name: providerName });
  if (target.transport !== 'official') throw new Error('Reference collection requires an unbound native Official card');
  const collectionId = `native-reference-${randomUUID()}`;
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  await mkdir(output, { mode: 0o700 }); // Never overwrite an earlier collection.
  const save = (name, value) => writeFile(path.join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const cwd = await mkdtemp(path.join(tmpdir(), 'modeltrace-reference-'));
  const startedAt = Date.now();
  const summary = { collectionId, status: 'running', route: target.name, model, effort, split,
    requestedSamples: suite.length, acceptedSamples: 0, rejectedSamples: 0, failedSamples: 0,
    parsedNumbers: 0, outputDirectory: output, bankModified: false,
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, unknownSamples: 0 },
    standardCreditEquivalent: 0, maximumCreditBudget: maxCredits,
    before: null, after: null, cliVersion: null, elapsedSeconds: 0, cleanup: null };
  let management, client, relay;
  try {
    management = await api.openAppServer(env, { nativeOpenai: true });
    const { account } = await management.request('account/read', { refreshToken: false });
    if (account?.type !== 'chatgpt') throw new Error('The native OpenAI process did not find a ChatGPT login');
    const trust = await api.requireTrustedGuard(management, cwd);
    summary.before = publicLimits(await management.request('account/rateLimits/read', {}).catch(() => null));
    await management.close(); management = null;
    relay = await referenceRelay(new URL(api.gatewayURL(config, target.id)));
    const executable = await api.codexExecutable(env);
    const version = spawnSync(executable, ['--version'], { encoding: 'utf8' });
    summary.cliVersion = version.status === 0 ? version.stdout.trim() : null;
    const args = ['app-server', '--stdio', ...api.disabledHooksOverride(trust.otherHookKeys),
      '-c', 'model_provider="openai"', '-c', `openai_base_url=${JSON.stringify(relay.url)}`,
      '-c', `model_reasoning_effort=${JSON.stringify(effort)}`, '-c', 'web_search="disabled"',
      '-c', 'features.shell_tool=false', '-c', 'features.multi_agent=false', '-c', 'features.apps=false'];
    client = new api.AppServerClient(spawn(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }));
    await client.request('initialize', { clientInfo: api.CODEX_CLIENT_INFO, capabilities: { experimentalApi: true } });
    client.write({ method: 'initialized' });
    await save('collection.json', { ...summary, provider: target, configId: config.id,
      challengeIds: suite.map(challenge => challenge.challenge_id), nativeSystemPrefix: ENROLLMENT_INSTRUCTIONS });
    emit({ stage: 'sampling', route: target.name, model, effort, split, requestedSamples: suite.length, outputDirectory: output });
    for (const [index, challenge] of suite.entries()) {
      // Stop before issuing another paid request if its estimated reservation
      // would exceed the selected budget. Actual tokens remain authoritative.
      if (summary.standardCreditEquivalent + 2.5 > maxCredits) throw new Error('Collection credit budget reservation reached; resume remaining challenges in a new bounded segment');
      const sampleStartedAt = Date.now();
      let generated, threadId, receipt, observedUsage = null, charged = false, stage = 'route_preflight';
      const onUsage = message => {
        if (message.method !== 'thread/tokenUsage/updated' || message.params?.threadId !== threadId) return;
        const usage = message.params.tokenUsage?.last;
        if (usage) observedUsage = { inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens,
          outputTokens: usage.outputTokens, cacheWriteInputTokens: usage.cacheWriteInputTokens ?? null };
      };
      const charge = usage => {
        if (charged) return;
        charged = true;
        const credits = standardCreditEquivalent(usage);
        if (credits !== null) {
          for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens']) summary.usage[key] += usage[key];
          summary.standardCreditEquivalent += credits;
        } else summary.usage.unknownSamples++;
      };
      try {
        api.assertProviderCurrent(await api.verifyGatewayReady(directory, config), target);
        stage = 'create_ephemeral_reference_thread';
        const started = await client.request('thread/start', referenceThreadParameters({ model, effort, cwd, challenge }), 30000);
        threadId = started.thread?.id;
        if (!threadId || threadId === process.env.CODEX_THREAD_ID || !started.thread.ephemeral || started.thread.path
          || started.model !== model || started.modelProvider !== 'openai' || started.reasoningEffort !== effort) {
          throw new Error('Native isolated reference settings mismatch');
        }
        stage = 'native_inference';
        client.listeners.add(onUsage);
        const wrapped = { listeners: client.listeners, exited: client.exited,
          request(method, params, timeout) {
            if (method === 'turn/start') params = { ...params, input: [{ type: 'text', text: referenceInput(challenge) }],
              serviceTierForTurn: 'default', environments: [] };
            return client.request(method, params, timeout);
          } };
        generated = await api.generateProbe(wrapped, threadId, { expiresAt: Date.now() + timeoutSeconds * 1000,
          language: challenge.transport === 'clean' && /[\u3400-\u9fff]/.test(challenge.prompt) ? 'zh' : 'en', count: challenge.expected_count });
        // Preserve paid native output before any stricter transport validation.
        await save(`${challenge.challenge_id}.native.json`, { ...generated, threadId, collectedAt: new Date().toISOString() });
        charge(generated.usage);
        const credits = standardCreditEquivalent(generated.usage);
        stage = 'validate_reference_route';
        const receiptDeadline = Date.now() + 10000;
        do {
          receipt = await api.readReceipt(directory, threadId);
          if (verifiedReferenceReceipt(receipt, { config, target, threadId, startedAt: sampleStartedAt })) break;
          // Native transport may retry before the completed answer. A prior
          // failed attempt receipt must not preempt the final stream's receipt.
          await delay(100);
        } while (Date.now() < receiptDeadline);
        api.assertProviderCurrent(await api.verifyGatewayReady(directory, config), target);
        const row = referenceRow({ model, effort, challenge, generated, receipt, config, target, threadId,
          startedAt: sampleStartedAt, cliVersion: summary.cliVersion, collectionId, split });
        await writeFile(path.join(output, `${challenge.challenge_id}.jsonl`), JSON.stringify(row) + '\n', { flag: 'wx', mode: 0o600 });
        if (row.strict_valid) summary.acceptedSamples++; else summary.rejectedSamples++;
        summary.parsedNumbers += row.parsed_count;
        emit({ stage: 'sample_completed', index: index + 1, total: suite.length, challengeId: challenge.challenge_id,
          accepted: row.strict_valid, routeVerified: row.route_verified, parsedNumbers: row.parsed_count,
          requestedNumbers: challenge.expected_count, usage: generated.usage, standardCreditEquivalent: credits,
          elapsedSeconds: (Date.now() - sampleStartedAt) / 1000 });
        if (!row.route_verified) throw new Error('Reference route receipt did not verify; collection stopped before further inference');
        if (credits === null) throw new Error('Token usage unavailable; stop before issuing more paid requests');
      } catch (error) {
        summary.failedSamples++;
        if (stage === 'native_inference' && !charged) charge(observedUsage);
        await save(`${challenge.challenge_id}.failure.json`, { stage, error: error.message, threadId,
          usage: generated?.usage ?? observedUsage, transportObservations: relay.observations.slice(-3) });
        throw error;
      } finally {
        client.listeners.delete(onUsage);
        if (threadId) await client.request('thread/unsubscribe', { threadId }, 1000).catch(() => {});
      }
    }
    summary.status = summary.acceptedSamples === suite.length ? 'completed' : 'completed_with_rejections';
  } catch (error) {
    summary.status = 'failed'; summary.error = error.message;
  } finally {
    if (client && !client.closed) summary.after = publicLimits(await client.request('account/rateLimits/read', {}).catch(() => null));
    try { await management?.close(); await client?.close(); }
    finally {
      await relay?.close();
      try { await rmdir(cwd); summary.cleanup = 'temporary_native_process_closed_and_empty_workspace_removed'; }
      catch { summary.cleanup = 'native_process_closed_temporary_workspace_not_empty_or_unavailable'; }
    }
    summary.elapsedSeconds = (Date.now() - startedAt) / 1000;
    // Include only accepted reference rows in this output; never append the bank.
    const rows = [];
    for (const challenge of suite) {
      const row = await readFile(path.join(output, `${challenge.challenge_id}.jsonl`), 'utf8').catch(error => {
        if (error.code === 'ENOENT') return ''; throw error;
      });
      if (row && JSON.parse(row).strict_valid) rows.push(row.trimEnd());
    }
    await writeFile(path.join(output, 'samples.jsonl'), rows.join('\n') + (rows.length ? '\n' : ''), { flag: 'wx', mode: 0o600 });
    await save('summary.json', summary);
  }
  emit(summary);
  return summary;
}
