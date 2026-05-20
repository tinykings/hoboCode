import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeModels,
  probeModel,
  probeModels,
  rankModels,
  type NormalizedModel,
  type ProbedModel,
} from '../src/model.ts';

test('normalizeModels keeps only well-formed zero-priced free models', () => {
  const normalized = normalizeModels({
    data: [
      {
        id: 'a/free-model:free',
        context_length: 1000,
        created: 10,
        pricing: { prompt: '0', completion: '0' },
      },
      {
        id: 'a/paid-model',
        context_length: 1000,
        created: 10,
        pricing: { prompt: '0', completion: '0' },
      },
      {
        id: 'a/nonzero:free',
        context_length: 1000,
        created: 10,
        pricing: { prompt: '0.1', completion: '0' },
      },
      {
        id: 'a/missing-context:free',
        created: 10,
        pricing: { prompt: '0', completion: '0' },
      },
      {
        id: 'a/bad-pricing:free',
        context_length: 1000,
        created: 10,
        pricing: { prompt: 'free', completion: '0' },
      },
    ],
  });

  assert.deepEqual(normalized, [
    {
      id: 'a/free-model:free',
      context_length: 1000,
      created: 10,
      pricing: { prompt: '0', completion: '0' },
    },
  ]);
});

test('rankModels sorts by context, unthrottled status, then created time', () => {
  const ranked = rankModels([
    model('old-big', 2000, 1, 'healthy'),
    model('new-small', 1000, 99, 'healthy'),
    model('throttled-big-new', 2000, 99, 'throttled'),
    model('new-big', 2000, 2, 'healthy'),
  ]);

  assert.deepEqual(
    ranked.map((item) => item.id),
    ['new-big', 'old-big', 'throttled-big-new', 'new-small'],
  );
});

test('probeModel classifies HTTP 200 as healthy', async () => {
  const result = await probeModel({
    modelId: 'x:free',
    fetchImpl: async () => new Response('{}', { status: 200 }),
    apiKey: 'key',
    baseUrl: 'https://example.test/v1',
    timeoutMs: 1000,
  });

  assert.deepEqual(result, { ok: true, status: 'healthy' });
});

test('probeModel classifies HTTP 429 as throttled but kept', async () => {
  const result = await probeModel({
    modelId: 'x:free',
    fetchImpl: async () => new Response('{}', { status: 429 }),
    apiKey: 'key',
    baseUrl: 'https://example.test/v1',
    timeoutMs: 1000,
  });

  assert.deepEqual(result, { ok: true, status: 'throttled' });
});

test('probeModels drops failed probes and returns ranked kept models', async () => {
  const models: NormalizedModel[] = [
    baseModel('a:free', 1000, 1),
    baseModel('b:free', 2000, 2),
    baseModel('c:free', 3000, 3),
  ];

  const result = await probeModels({
    models,
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.model === 'a:free') return new Response('{}', { status: 500 });
      if (body.model === 'b:free') return new Response('{}', { status: 429 });
      return new Response('{}', { status: 200 });
    },
    apiKey: 'key',
    baseUrl: 'https://example.test/v1',
    timeoutMs: 1000,
    concurrency: 2,
  });

  assert.deepEqual(
    result.map((item) => [item.id, item.probe_status]),
    [
      ['c:free', 'healthy'],
      ['b:free', 'throttled'],
    ],
  );
});

function baseModel(id: string, context_length: number, created: number): NormalizedModel {
  return {
    id,
    context_length,
    created,
    pricing: { prompt: '0', completion: '0' },
  };
}

function model(
  id: string,
  context_length: number,
  created: number,
  probe_status: ProbedModel['probe_status'],
): ProbedModel {
  return {
    ...baseModel(id, context_length, created),
    probe_status,
  };
}
