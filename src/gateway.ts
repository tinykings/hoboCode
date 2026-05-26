import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import {
  SYNTHETIC_MODEL_ID,
  type ProbeFetch,
  type ProbedModel,
  normalizeModels,
  probeModels,
} from './model.ts';

export type GatewayConfig = {
  lazyRefresh?: boolean;
  host: string;
  port: number;
  openRouterApiKey: string;
  localApiKey?: string;
  openRouterBaseUrl: string;
  refreshIntervalMs: number;
  probeConcurrency: number;
  probeTimeoutMs: number;
  upstreamTimeoutMs: number;
};

export type RefreshState = {
  rankedModels: ProbedModel[];
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastError?: string;
  lastLoggedCurrentModel?: string;
  lastLoggedUsedModel?: string;
  refreshInFlight: boolean;
  requestCount: number;
};

type UpstreamFailure = {
  model: string;
  status?: number;
  body?: string;
  message: string;
};

type Gateway = {
  server: Server;
  state: RefreshState;
  refreshModels: () => Promise<void>;
};

export function createGateway(config: GatewayConfig, fetchImpl: ProbeFetch = fetch): Gateway {
  const state: RefreshState = {
    rankedModels: [],
    refreshInFlight: false,
    requestCount: 0,
  };

  async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    state.requestCount++;
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (state.requestCount === 1 && state.rankedModels.length === 0) {
        await refreshModels();
      }

      if (req.method === 'OPTIONS') {
        writeCors(res);
        res.writeHead(204);
        res.end();
        return;
      }

      if (url.pathname === '/health' && req.method === 'GET') {
        writeJson(res, 200, {
          ok: state.rankedModels.length > 0,
          synthetic_model: SYNTHETIC_MODEL_ID,
          current_model: state.rankedModels[0]?.id ?? null,
          model_count: state.rankedModels.length,
          top_model: state.rankedModels[0] ?? null,
          last_started_at: state.lastStartedAt,
          last_completed_at: state.lastCompletedAt,
          last_error: state.lastError,
          refresh_in_flight: state.refreshInFlight,
        });
        return;
      }

      if (url.pathname === '/v1/models' && req.method === 'GET') {
        if (!authorize(req, res, config)) return;
        writeJson(res, 200, openAiModelList(state));
        return;
      }

      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        if (!authorize(req, res, config)) return;
        await handleChatCompletions(req, res, state, config, fetchImpl);
        return;
      }

      writeJson(res, 404, openAiError('not_found', `No route for ${req.method} ${url.pathname}`));
    } catch (error) {
      writeJson(
        res,
        500,
        openAiError(
          'internal_error',
          error instanceof Error ? error.message : 'Unexpected server error',
        ),
      );
    } finally {
      state.requestCount--;
    }
  }


  async function refreshModels() {
    if (state.refreshInFlight) return;

    state.refreshInFlight = true;
    state.lastStartedAt = new Date().toISOString();

    try {
      const response = await fetchImpl(`${trimTrailingSlash(config.openRouterBaseUrl)}/models`, {
        headers: {
          Authorization: `Bearer ${config.openRouterApiKey}`,
        },
      });

      if (!response.ok) {
        throw new Error(`OpenRouter /models returned HTTP ${response.status}: ${await response.text()}`);
      }

      const normalized = normalizeModels(await response.json());
      const ranked = await probeModels({
        models: normalized,
        fetchImpl,
        apiKey: config.openRouterApiKey,
        baseUrl: config.openRouterBaseUrl,
        timeoutMs: config.probeTimeoutMs,
        concurrency: config.probeConcurrency,
      });

      state.rankedModels = ranked;
      state.lastError = undefined;
      state.lastCompletedAt = new Date().toISOString();
      console.log(`Refreshed ${ranked.length} healthy free models`);
      logCurrentModelChange(state);
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : 'Refresh failed';
      state.lastCompletedAt = new Date().toISOString();
      console.error(`Model refresh failed: ${state.lastError}`);
    } finally {
      state.refreshInFlight = false;
    }
  }

  return {
    server: createServer((req, res) => {
      void handleRequest(req, res);
    }),
    state,
    refreshModels,
  };
}

export async function startGateway(config: GatewayConfig) {
  const gateway = createGateway(config);
  if (!config.lazyRefresh) {
    await gateway.refreshModels();
  }

  gateway.server.listen(config.port, config.host, () => {
    console.log(
      `OpenRouter free-model gateway listening on http://${config.host}:${config.port}/v1`,
    );
    console.log(`Synthetic model: ${SYNTHETIC_MODEL_ID}`);
    console.log(`Healthy free models: ${gateway.state.rankedModels.length}`);
    logCurrentModelChange(gateway.state);
  });

  if (!config.lazyRefresh) {
    setInterval(() => {
      void gateway.refreshModels();
    }, config.refreshIntervalMs).unref();
  }
}

export function readConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  const openRouterApiKey = env.OPENROUTER_API_KEY;
  if (!openRouterApiKey) {
    throw new Error('OPENROUTER_API_KEY is required');
  }

  return {
    host: env.HOST ?? '127.0.0.1',
    port: readIntEnv(env.PORT, 4141),
    openRouterApiKey,
    localApiKey: env.LOCAL_API_KEY,
    openRouterBaseUrl: env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
      lazyRefresh: env.LAZY_REFRESH ? env.LAZY_REFRESH !== '0' : true,
    refreshIntervalMs: readIntEnv(env.REFRESH_INTERVAL_MS, 30 * 60 * 1000),
    probeConcurrency: readIntEnv(env.PROBE_CONCURRENCY, 4),
    probeTimeoutMs: readIntEnv(env.PROBE_TIMEOUT_MS, 10_000),
    upstreamTimeoutMs: readIntEnv(env.UPSTREAM_TIMEOUT_MS, 120_000),
  };
}

async function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  state: RefreshState,
  config: GatewayConfig,
  fetchImpl: ProbeFetch,
) {
  const body = await readJsonBody(req);
  if (!isRecord(body)) {
    writeJson(res, 400, openAiError('invalid_request', 'Expected a JSON object request body'));
    return;
  }

  const response = await completeWithFallback(body, state, config, fetchImpl);
  if (body.stream === true && response.ok) {
    await proxyStreamingResponse(response, res);
  } else {
    await proxyBufferedResponse(response, res);
  }
}

export async function completeWithFallback(
  body: Record<string, unknown>,
  state: RefreshState,
  config: GatewayConfig,
  fetchImpl: ProbeFetch,
): Promise<Response> {
  if (state.rankedModels.length === 0) {
    return jsonFetchResponse(
      openAiError('no_healthy_models', 'No healthy free models are available'),
      503,
    );
  }

  const requestedModel = typeof body.model === 'string' ? body.model : SYNTHETIC_MODEL_ID;
  if (requestedModel !== SYNTHETIC_MODEL_ID) {
    return jsonFetchResponse(
      openAiError(
        'unsupported_model',
        `This gateway only exposes ${SYNTHETIC_MODEL_ID}; received ${requestedModel}`,
      ),
      400,
    );
  }

  const failures: UpstreamFailure[] = [];

  for (const candidate of state.rankedModels) {
    let response: Response;
    try {
      response = await callOpenRouter({ ...body, model: candidate.id }, config, fetchImpl);
    } catch (error) {
      failures.push({
        model: candidate.id,
        message: error instanceof Error ? error.message : 'OpenRouter request failed',
      });
      continue;
    }

    if (response.ok) {
      logUsedModelChange(state, candidate.id);
      return withUpstreamModelHeader(response, candidate.id);
    }

    failures.push({
      model: candidate.id,
      status: response.status,
      body: await safeReadText(response),
      message: `OpenRouter returned HTTP ${response.status}`,
    });
  }

  return jsonFetchResponse(
    openAiError('upstream_failed', 'All healthy free models failed', {
      failures,
    }),
    failures.at(-1)?.status ?? 502,
  );
}

async function callOpenRouter(
  body: Record<string, unknown>,
  config: GatewayConfig,
  fetchImpl: ProbeFetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);

  try {
    return await fetchImpl(`${trimTrailingSlash(config.openRouterBaseUrl)}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openRouterApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function openAiModelList(state: RefreshState) {
  const top = state.rankedModels[0];
  return {
    object: 'list',
    data: [
      {
        id: SYNTHETIC_MODEL_ID,
        object: 'model',
        created: top?.created ?? 0,
        owned_by: 'openrouter',
        context_length: top?.context_length ?? 0,
        upstream_model: top?.id ?? null,
        upstream_probe_status: top?.probe_status ?? null,
      },
    ],
  };
}

async function proxyStreamingResponse(response: Response, res: ServerResponse) {
  if (!response.body) {
    writeJson(res, 502, openAiError('empty_stream', 'OpenRouter returned an empty stream'));
    return;
  }

  writeCors(res);
  res.writeHead(response.status, copyHeaders(response.headers));
  await new Promise<void>((resolve, reject) => {
    const stream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
    stream.on('error', reject);
    res.on('error', reject);
    res.on('finish', resolve);
    stream.pipe(res);
  });
}

async function proxyBufferedResponse(response: Response, res: ServerResponse) {
  const bytes = Buffer.from(await response.arrayBuffer());
  writeCors(res);
  res.writeHead(response.status, copyHeaders(response.headers));
  res.end(bytes);
}

function copyHeaders(headers: Headers): Record<string, string> {
  const copied: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) {
      copied[key] = value;
    }
  }
  return copied;
}

function withUpstreamModelHeader(response: Response, modelId: string): Response {
  const headers = new Headers(response.headers);
  headers.set('x-openrouter-upstream-model', modelId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function logCurrentModelChange(state: RefreshState) {
  const currentModel = state.rankedModels[0]?.id ?? 'none';
  if (state.lastLoggedCurrentModel === currentModel) return;

  state.lastLoggedCurrentModel = currentModel;
  console.log(`Current upstream model changed: ${currentModel}`);
}

function logUsedModelChange(state: RefreshState, modelId: string) {
  if (state.lastLoggedUsedModel === modelId) return;

  state.lastLoggedUsedModel = modelId;
  console.log(`Using upstream model changed: ${modelId}`);
}

function authorize(
  req: IncomingMessage,
  res: ServerResponse,
  config: GatewayConfig,
): boolean {
  if (!config.localApiKey) return true;

  if (req.headers.authorization === `Bearer ${config.localApiKey}`) return true;
  writeJson(res, 401, openAiError('unauthorized', 'Missing or invalid local bearer token'));
  return false;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > 20 * 1024 * 1024) {
      throw new Error('Request body exceeds 20MB');
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function writeJson(res: ServerResponse, status: number, body: unknown) {
  writeCors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function jsonFetchResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function writeCors(res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function openAiError(code: string, message: string, extra?: Record<string, unknown>) {
  return {
    error: {
      message,
      type: code,
      code,
      ...extra,
    },
  };
}

async function safeReadText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 2000);
  } catch {
    return '';
  }
}

function readIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
