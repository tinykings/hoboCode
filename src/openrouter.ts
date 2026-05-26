export type OpenRouterModelDict = Record<string, unknown>;

export async function fetchModels(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<OpenRouterModelDict[]> {
  const response = await fetchImpl(`${trimTrailingSlash(baseUrl)}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  if (!response.ok) {
    throw new Error(`OpenRouter /models returned HTTP ${response.status}: ${await response.text()}`);
  }
  const payload = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    return [];
  }
  return payload.data as OpenRouterModelDict[];
}

export function isChatModel(model: OpenRouterModelDict): boolean {
  const modalities = model.modalities as unknown;
  if (Array.isArray(modalities)) {
    if (!modalities.includes('text')) return false;
    if (modalities.every(m => m === 'text')) return true;
    return true;
  }
  return true;
}

export function isFreeModel(model: OpenRouterModelDict): boolean {
  const id = model.id;
  if (typeof id === 'string' && id.includes(':free')) return true;
  const pricing = model.pricing as unknown;
  if (!isRecord(pricing)) return false;
  const prompt = pricing.prompt;
  if (typeof prompt !== 'string') return false;
  const promptNum = Number(prompt);
  return promptNum === 0;
}

export function filterFreeChatModels(models: OpenRouterModelDict[]): OpenRouterModelDict[] {
  const seen = new Set<string>();
  const result: OpenRouterModelDict[] = [];
  for (const model of models) {
    if (!isChatModel(model)) continue;
    if (!isFreeModel(model)) continue;
    const id = model.id;
    if (typeof id !== 'string') continue;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(model);
  }
  return result;
}

export async function listFreeChatModels(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenRouterModelDict[]> {
  const rawModels = await fetchModels(baseUrl, apiKey, fetchImpl);
  return filterFreeChatModels(rawModels);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}