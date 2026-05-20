export const SYNTHETIC_MODEL_ID = 'openrouter/free-auto';

export type RawOpenRouterModel = {
  id?: unknown;
  context_length?: unknown;
  created?: unknown;
  pricing?: unknown;
};

export type NormalizedModel = {
  id: string;
  context_length: number;
  created: number;
  pricing: {
    prompt: string;
    completion: string;
  };
};

export type ProbeStatus = 'healthy' | 'throttled';

export type ProbedModel = NormalizedModel & {
  probe_status: ProbeStatus;
};

export type ProbeResult =
  | { ok: true; status: ProbeStatus }
  | { ok: false; reason: string; statusCode?: number };

export type ProbeFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export function normalizeModels(payload: unknown): NormalizedModel[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    return [];
  }

  const models: NormalizedModel[] = [];
  for (const item of payload.data) {
    const model = normalizeModel(item);
    if (model) {
      models.push(model);
    }
  }
  return models;
}

export function rankModels(models: ProbedModel[]): ProbedModel[] {
  return [...models].sort((a, b) => {
    const contextDelta = b.context_length - a.context_length;
    if (contextDelta !== 0) return contextDelta;

    if (a.probe_status !== b.probe_status) {
      return a.probe_status === 'healthy' ? -1 : 1;
    }

    return b.created - a.created;
  });
}

export async function probeModels(options: {
  models: NormalizedModel[];
  fetchImpl: ProbeFetch;
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  concurrency: number;
}): Promise<ProbedModel[]> {
  const concurrency = Math.max(1, Math.floor(options.concurrency));
  const results: ProbedModel[] = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < options.models.length) {
      const model = options.models[nextIndex++];
      const probe = await probeModel({
        modelId: model.id,
        fetchImpl: options.fetchImpl,
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        timeoutMs: options.timeoutMs,
      });

      if (probe.ok) {
        results.push({ ...model, probe_status: probe.status });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, options.models.length) }, () =>
      worker(),
    ),
  );

  return rankModels(results);
}

export async function probeModel(options: {
  modelId: string;
  fetchImpl: ProbeFetch;
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
}): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await options.fetchImpl(
      `${trimTrailingSlash(options.baseUrl)}/chat/completions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: options.modelId,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false,
        }),
        signal: controller.signal,
      },
    );

    if (response.status === 200) {
      return { ok: true, status: 'healthy' };
    }
    if (response.status === 429) {
      return { ok: true, status: 'throttled' };
    }
    return {
      ok: false,
      reason: `unexpected HTTP ${response.status}`,
      statusCode: response.status,
    };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error && error.name === 'AbortError'
          ? 'timeout'
          : error instanceof Error
            ? error.message
            : 'fetch failed',
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeModel(item: unknown): NormalizedModel | null {
  if (!isRecord(item)) return null;
  if (typeof item.id !== 'string' || !item.id.endsWith(':free')) return null;
  if (!Number.isFinite(item.context_length) || item.context_length <= 0) {
    return null;
  }
  if (!Number.isFinite(item.created)) return null;
  if (!isRecord(item.pricing)) return null;

  const prompt = item.pricing.prompt;
  const completion = item.pricing.completion;
  if (typeof prompt !== 'string' || typeof completion !== 'string') return null;

  const promptPrice = Number(prompt);
  const completionPrice = Number(completion);
  if (
    !Number.isFinite(promptPrice) ||
    !Number.isFinite(completionPrice) ||
    promptPrice + completionPrice !== 0
  ) {
    return null;
  }

  return {
    id: item.id,
    context_length: item.context_length,
    created: item.created,
    pricing: { prompt, completion },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
