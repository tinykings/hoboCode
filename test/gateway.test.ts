import test from 'node:test';
import assert from 'node:assert/strict';
import { SYNTHETIC_MODEL_ID } from '../src/model.ts';
import { completeWithFallback, createGateway, type GatewayConfig } from '../src/gateway.ts';

test('gateway routes synthetic model and falls back to next ranked model', async () => {
  const completionModels: string[] = [];
  const config = testConfig();
  const gateway = createGateway(config, async (input, init) => {
    const url = String(input);

    if (url.endsWith('/models')) {
      return jsonResponse({
        data: [
          freeModel('top:free', 2000, 2),
          freeModel('fallback:free', 1000, 1),
        ],
      });
    }

    if (url.endsWith('/chat/completions')) {
      const body = JSON.parse(String(init?.body));

      if (body.messages?.[0]?.content === 'ping') {
        return new Response('{}', { status: 200 });
      }

      completionModels.push(body.model);
      if (body.model === 'top:free') {
        return jsonResponse({ error: { message: 'upstream failed' } }, 500);
      }
      return jsonResponse({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 1,
        model: body.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      });
    }

    return new Response('not found', { status: 404 });
  });

  await gateway.refreshModels();
  assert.deepEqual(
    gateway.state.rankedModels.map((model) => model.id),
    ['top:free', 'fallback:free'],
  );

  const response = await completeWithFallback(
    {
      model: SYNTHETIC_MODEL_ID,
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 4,
    },
    gateway.state,
    config,
    async (input, init) => {
      const body = JSON.parse(String(init?.body));
      completionModels.push(body.model);
      if (body.model === 'top:free') {
        return jsonResponse({ error: { message: 'upstream failed' } }, 500);
      }
      return jsonResponse({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 1,
        model: body.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      });
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-openrouter-upstream-model'), 'fallback:free');
  assert.equal((await response.json()).model, 'fallback:free');
  assert.deepEqual(completionModels, ['top:free', 'fallback:free']);
});

test('completeWithFallback rejects unsupported requested model ids', async () => {
  const response = await completeWithFallback(
    { model: 'not-the-synthetic-model' },
    {
      rankedModels: [
        {
          id: 'healthy:free',
          context_length: 1000,
          created: 1,
          pricing: { prompt: '0', completion: '0' },
          probe_status: 'healthy',
        },
      ],
      refreshInFlight: false,
    },
    testConfig(),
    async () => jsonResponse({}),
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'unsupported_model');
});

function testConfig(): GatewayConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    openRouterApiKey: 'openrouter-key',
    localApiKey: 'local-key',
    openRouterBaseUrl: 'https://openrouter.test/api/v1',
    refreshIntervalMs: 60_000,
    probeConcurrency: 2,
    probeTimeoutMs: 1000,
    upstreamTimeoutMs: 1000,
  };
}

function freeModel(id: string, context_length: number, created: number) {
  return {
    id,
    context_length,
    created,
    pricing: { prompt: '0', completion: '0' },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
