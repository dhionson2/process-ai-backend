import { ProviderCallBudgetLedger } from './call-budget-ledger.js';

export type ProviderUsage = { inputTokens?: number; outputTokens?: number };
export type StructuredRequest = {
  model: string;
  system: string;
  prompt: string;
  outputSchema: Record<string, unknown>;
  timeoutMs: number;
  contextTokens: number;
  maxOutputTokens: number;
  temperature?: number;
  dataClassification?: 'synthetic' | 'public';
  captureDiagnosticResponse?: boolean;
  onTransportMetrics?: (metrics: { jsonBytes: number; messageCount: number; systemChars: number; systemBytes: number; promptChars: number; promptBytes: number; schemaChars: number; schemaBytes: number; estimatedInputTokens: number }) => void;
};
export type ExternalStructuredOutputMode = 'json-object' | 'json-schema-strict';
export type StructuredResponse = { value: unknown; usage: ProviderUsage; latencyMs: number; model: string };

export interface ModelProvider {
  readonly id: string;
  generateStructured(request: StructuredRequest): Promise<StructuredResponse>;
}

export type ProviderFailureCode = 'PROVIDER_TIMEOUT' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_RATE_LIMITED' | 'PROVIDER_INVALID_RESPONSE' | 'PROVIDER_REJECTED';
export class ProviderFailure extends Error {
  constructor(readonly code: ProviderFailureCode, message: string, readonly retryAfterMs?: number, readonly diagnostic?: ProviderDiagnostic) { super(message); this.name = 'ProviderFailure'; }
}
export type ProviderDiagnostic = { httpStatus?: number; providerCode?: string; providerType?: string; providerParam?: string; providerMessage?: string; category: string; latencyMs?: number; attempts?: number; retryAfterMs?: number; requestId?: string; summary?: string };

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(value) ? value : undefined;
}
const safeProviderParams = new Set(['model', 'messages', 'response_format', 'max_completion_tokens', 'max_tokens', 'temperature', 'top_p', 'reasoning_effort']);
function classifyProviderMessage(message: unknown, code: string | undefined): { category?: string; summary?: string } {
  if (typeof message !== 'string') return {};
  const normalized = message.toLowerCase().replace(/\s+/g, ' ').trim();
  if (/invalid schema|unsupported schema|schema .*not supported|not permitted in .*schema/.test(normalized)) return { category: 'schema_rejected', summary: 'O provedor rejeitou a definição do JSON Schema.' };
  if (/generated json does not match|failed to match .*schema|json .*does not conform/.test(normalized)) return { category: 'structured_output_mismatch', summary: 'A saída estruturada não correspondeu ao schema.' };
  if (/maximum context|context length|too many tokens|token limit/.test(normalized)) return { category: 'token_limit', summary: 'O provedor informou limite de contexto ou tokens.' };
  if (/json mode cannot be combined|response_format.*(invalid|unsupported)|invalid.*response_format/.test(normalized)) return { category: 'structured_output_parameters', summary: 'O provedor rejeitou parâmetros de saída estruturada.' };
  if (code === 'json_validate_failed') return { category: 'structured_output_validation', summary: 'O provedor rejeitou a validação da saída estruturada; detalhe omitido por segurança.' };
  return { summary: 'Detalhe do provedor omitido por segurança.' };
}
function rejectionDiagnostic(response: Response, body: any, latencyMs: number): ProviderDiagnostic {
  const providerCode = safeIdentifier(body?.error?.code);
  const providerType = safeIdentifier(body?.error?.type);
  const rawParam = body?.error?.param;
  const providerParam = typeof rawParam === 'string' && safeProviderParams.has(rawParam) ? rawParam : undefined;
  const classified = classifyProviderMessage(body?.error?.message, providerCode);
  const category = response.status === 400 ? classified.category || 'bad_request' : response.status === 401 || response.status === 403 ? 'authentication' : response.status === 413 ? 'payload_too_large' : response.status === 429 ? 'rate_limit' : response.status >= 500 ? 'upstream' : 'rejected';
  return { httpStatus: response.status, category, latencyMs, ...(providerCode ? { providerCode } : {}), ...(providerType ? { providerType } : {}), ...(providerParam ? { providerParam } : {}), ...(classified.summary ? { providerMessage: classified.summary } : {}), ...(safeIdentifier(response.headers.get('x-request-id')) ? { requestId: safeIdentifier(response.headers.get('x-request-id')) } : {}), summary: `HTTP ${response.status} (${category})` };
}

async function postJson(url: string, requestBody: unknown, timeoutMs: number, headers: Record<string, string> = {}): Promise<{ body: any; latencyMs: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof requestBody === 'string' ? requestBody : JSON.stringify(requestBody), signal: controller.signal });
    let body: any;
    try { body = await response.json(); }
    catch { if (!response.ok) body = undefined; else throw new ProviderFailure('PROVIDER_INVALID_RESPONSE', 'O provedor retornou uma resposta que não é JSON válido', undefined, { httpStatus: response.status, category: 'invalid_response', latencyMs: Date.now() - started }); }
    if (!response.ok) {
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      const diagnostic = { ...rejectionDiagnostic(response, body, Date.now() - started), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
      if (response.status === 429) throw new ProviderFailure('PROVIDER_RATE_LIMITED', 'Limite do provedor atingido', retryAfterMs, diagnostic);
      if (response.status >= 500) throw new ProviderFailure('PROVIDER_UNAVAILABLE', 'Provedor temporariamente indisponível', retryAfterMs, diagnostic);
      throw new ProviderFailure('PROVIDER_REJECTED', 'Provedor recusou a solicitação configurada', undefined, diagnostic);
    }
    return { body, latencyMs: Date.now() - started };
  } catch (error) {
    if (controller.signal.aborted) throw new ProviderFailure('PROVIDER_TIMEOUT', 'Tempo limite do provedor excedido', undefined, { category: 'timeout', latencyMs: Date.now() - started });
    if (error instanceof ProviderFailure) throw error;
    throw new ProviderFailure('PROVIDER_UNAVAILABLE', 'Não foi possível conectar ao provedor configurado', undefined, { category: 'network', latencyMs: Date.now() - started });
  } finally { clearTimeout(timer); }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function parseStructuredContent(content: unknown): unknown {
  if (typeof content !== 'string') throw new ProviderFailure('PROVIDER_INVALID_RESPONSE', 'Conteúdo estruturado ausente na resposta do provedor');
  try { return JSON.parse(content); }
  catch { throw new ProviderFailure('PROVIDER_INVALID_RESPONSE', 'Conteúdo do modelo não é JSON válido'); }
}

export class OllamaProvider implements ModelProvider {
  readonly id = 'ollama';
  constructor(private readonly baseUrl: string) {}
  async generateStructured(request: StructuredRequest): Promise<StructuredResponse> {
    const { body, latencyMs } = await postJson(`${this.baseUrl.replace(/\/$/, '')}/api/chat`, {
      model: request.model,
      stream: false,
      format: request.outputSchema,
      options: { num_ctx: request.contextTokens, num_predict: request.maxOutputTokens, temperature: request.temperature ?? 0.1 },
      messages: [{ role: 'system', content: `${request.system}\n\nSchema JSON obrigatório para a resposta:\n${JSON.stringify(request.outputSchema)}` }, { role: 'user', content: request.prompt }],
    }, request.timeoutMs);
    return {
      value: parseStructuredContent(body.message?.content),
      usage: { inputTokens: Number.isFinite(body.prompt_eval_count) ? body.prompt_eval_count : undefined, outputTokens: Number.isFinite(body.eval_count) ? body.eval_count : undefined },
      latencyMs,
      model: typeof body.model === 'string' ? body.model : request.model,
    };
  }
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id = 'openai-compatible';
  private calls = 0;
  private tokens = 0;
  private retries = 0;
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly structuredOutputMode: ExternalStructuredOutputMode = 'json-object',
    private readonly budget: { maxCalls?: number; maxTokens?: number } = {},
    private readonly maxRateLimitRetries = 0,
    private readonly observeStructuredResponse?: (value: unknown) => void,
    private readonly captureRawStructuredResponse?: (raw: string) => void,
    private readonly durableBudgetLedger?: ProviderCallBudgetLedger,
    private readonly durableBudget?: { maxCalls?: number; maxTokens?: number },
  ) {}
  private lastRetryAfterMs?: number;
  get usageTotals(): { calls: number; tokens: number; retries: number; lastRetryAfterMs?: number } { return { calls: this.calls, tokens: this.tokens, retries: this.retries, ...(this.lastRetryAfterMs !== undefined ? { lastRetryAfterMs: this.lastRetryAfterMs } : {}) }; }
  async generateStructured(request: StructuredRequest): Promise<StructuredResponse> {
    const schemaChars = this.structuredOutputMode === 'json-schema-strict' ? JSON.stringify(request.outputSchema).length : 0;
    const reservation = Math.ceil((request.system.length + request.prompt.length + schemaChars) / 3) + request.maxOutputTokens;
    if (this.budget.maxTokens && this.tokens + reservation > this.budget.maxTokens) throw new ProviderFailure('PROVIDER_RATE_LIMITED', 'Orçamento local de tokens configurado para o provider foi atingido');
    const endpoint = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const responseFormat = this.structuredOutputMode === 'json-schema-strict'
      ? { type: 'json_schema', json_schema: { name: 'process_ai_response', strict: true, schema: toStrictProviderSchema(request.outputSchema) } }
      : { type: 'json_object' };
    let posted: { body: any; latencyMs: number } | undefined;
    for (let attempt = 0; attempt <= this.maxRateLimitRetries; attempt++) {
      if (this.budget.maxCalls && this.calls >= this.budget.maxCalls) throw new ProviderFailure('PROVIDER_RATE_LIMITED', 'Limite local de chamadas configurado para o provider foi atingido');
      try { this.durableBudgetLedger?.reserve(reservation, this.durableBudget?.maxCalls || this.budget.maxCalls || 0, this.durableBudget?.maxTokens || this.budget.maxTokens || 0); }
      catch { throw new ProviderFailure('PROVIDER_RATE_LIMITED', 'Limite cumulativo local de chamadas/tokens foi atingido ou o ledger está indisponível'); }
      this.calls++;
      try {
        const requestBody = {
          model: request.model,
          stream: false,
          max_completion_tokens: request.maxOutputTokens,
          temperature: request.temperature ?? 0.1,
          ...(request.model.startsWith('openai/gpt-oss-') ? { reasoning_effort: 'low' } : {}),
          messages: [{ role: 'system', content: this.structuredOutputMode === 'json-object' ? `${request.system}\n\nReturn the response as a valid json object.` : request.system }, { role: 'user', content: request.prompt }],
          response_format: responseFormat,
        };
        const serializedBody = JSON.stringify(requestBody);
        const schemaText = this.structuredOutputMode === 'json-schema-strict' ? JSON.stringify(responseFormat) : '';
        const systemText = requestBody.messages[0].content;
        request.onTransportMetrics?.({
          jsonBytes: Buffer.byteLength(serializedBody, 'utf8'), messageCount: requestBody.messages.length,
          systemChars: systemText.length, systemBytes: Buffer.byteLength(systemText, 'utf8'),
          promptChars: request.prompt.length, promptBytes: Buffer.byteLength(request.prompt, 'utf8'),
          schemaChars: schemaText.length, schemaBytes: Buffer.byteLength(schemaText, 'utf8'),
          // Deliberately coarse estimate; provider tokenizers differ and JSON framing is not modeled.
          estimatedInputTokens: Math.ceil((systemText.length + request.prompt.length + schemaText.length) / 3),
        });
        // Permanent HTTP errors (especially 400) are surfaced immediately. Only
        // explicit 429 Retry-After responses can be retried by the outer loop.
        posted = await postJson(endpoint, serializedBody, request.timeoutMs, { authorization: `Bearer ${this.apiKey}` });
        break;
      } catch (error) {
        if (error instanceof ProviderFailure && error.code === 'PROVIDER_RATE_LIMITED') this.lastRetryAfterMs = error.retryAfterMs;
        const mayRetry = error instanceof ProviderFailure && error.code === 'PROVIDER_RATE_LIMITED' && attempt < this.maxRateLimitRetries && error.retryAfterMs !== undefined && error.retryAfterMs <= 60000;
        if (!mayRetry) { if (error instanceof ProviderFailure && error.diagnostic) error.diagnostic.attempts = attempt + 1; throw error; }
        this.retries++;
        await new Promise(resolve => setTimeout(resolve, error.retryAfterMs));
      }
    }
    if (!posted) throw new ProviderFailure('PROVIDER_UNAVAILABLE', 'Provedor não retornou uma resposta');
    const { body, latencyMs } = posted;
    const choice = body.choices?.[0]?.message;
    if (request.captureDiagnosticResponse === true && request.dataClassification === 'synthetic' && typeof choice?.content === 'string') this.captureRawStructuredResponse?.(choice.content);
    const usage = { inputTokens: Number.isFinite(body.usage?.prompt_tokens) ? body.usage.prompt_tokens : undefined, outputTokens: Number.isFinite(body.usage?.completion_tokens) ? body.usage.completion_tokens : undefined };
    const actualTokens = usage.inputTokens !== undefined && usage.outputTokens !== undefined ? usage.inputTokens + usage.outputTokens : reservation;
    this.tokens += actualTokens;
    try { this.durableBudgetLedger?.settle(reservation, actualTokens); } catch { /* the held reservation remains conservative if durable settlement fails */ }
    return {
      value: parseExternalStructuredContent(choice?.content, request.outputSchema, this.structuredOutputMode, this.observeStructuredResponse),
      usage,
      latencyMs,
      model: typeof body.model === 'string' ? body.model : request.model,
    };
  }
}

/** Converts the internal draft-2020-12 schema into Groq's strict Structured Outputs subset.
 * Optional draft fields become required nullable fields; the original schema remains authoritative in the orchestrator.
 */
export function toStrictProviderSchema(input: Record<string, unknown>): Record<string, unknown> {
  const defs = (input.$defs && typeof input.$defs === 'object' ? input.$defs : {}) as Record<string, unknown>;
  const convert = (value: unknown): any => {
    if (Array.isArray(value)) return value.map(convert);
    if (!value || typeof value !== 'object') return value;
    const source = value as Record<string, any>;
    if (source.$ref) return { $ref: source.$ref };
    const result: Record<string, any> = {};
    for (const key of ['type', 'enum', 'description', 'items', 'properties', 'required', 'anyOf', 'oneOf', 'const', '$defs', 'additionalProperties']) {
      if (Object.hasOwn(source, key)) {
        if (key === '$defs' && source[key] && typeof source[key] === 'object') result.$defs = Object.fromEntries(Object.entries(source[key]).map(([name, definition]) => [name, convert(definition)]));
        else result[key === 'oneOf' ? 'anyOf' : key] = convert(source[key]);
      }
    }
    if (Object.hasOwn(source, 'const')) { delete result.const; result.enum = [source.const]; }
    if (Array.isArray(result.enum) && result.type === undefined) {
      const enumTypes = [...new Set(result.enum.map((item: unknown) => item === null ? 'null' : typeof item === 'string' ? 'string' : typeof item === 'number' ? 'number' : typeof item === 'boolean' ? 'boolean' : undefined).filter(Boolean))] as string[];
      if (enumTypes.length === 1) result.type = enumTypes[0];
      else if (enumTypes.length === 2 && enumTypes.includes('null')) result.type = enumTypes;
      else if (enumTypes.length > 1) {
        const values = result.enum;
        delete result.enum;
        result.anyOf = enumTypes.map(type => ({ type, enum: values.filter((item: unknown) => (item === null ? 'null' : typeof item) === type) }));
      }
    }
    if (Array.isArray(source.type) && source.type.length > 1 && (source.type.filter((type: string) => type !== 'null').length > 1 || !source.type.includes('null'))) {
      delete result.type;
      result.anyOf = source.type.map((type: string) => ({ type }));
    }
    if (source.type === 'object' || source.properties) {
      if (source.additionalProperties && source.additionalProperties !== false && typeof source.additionalProperties === 'object') {
        throw new ProviderFailure('PROVIDER_REJECTED', 'Schema estrito não aceita mapas dinâmicos do contrato interno');
      }
      const properties = (source.properties || {}) as Record<string, unknown>;
      const required = new Set(Array.isArray(source.required) ? source.required : []);
      result.type = 'object';
      result.properties = Object.fromEntries(Object.entries(properties).map(([name, schema]) => {
        const converted = convert(schema);
        return [name, required.has(name) ? converted : nullable(converted)];
      }));
      result.required = Object.keys(properties);
      result.additionalProperties = false;
    } else if (source.additionalProperties === false) {
      result.additionalProperties = false;
    }
    return result;
  };
  const nullable = (value: any): any => {
    if (value?.$ref && typeof value.$ref === 'string' && value.$ref.startsWith('#/$defs/')) {
      const definition = defs[value.$ref.slice('#/$defs/'.length)];
      if (definition) value = convert(definition);
    }
    if (Array.isArray(value?.type)) return { ...value, type: [...new Set([...value.type, 'null'])], ...(Array.isArray(value.enum) ? { enum: [...value.enum, null] } : {}) };
    if (typeof value?.type === 'string') {
      if (Array.isArray(value.enum)) return { ...value, type: [value.type, 'null'], enum: [...value.enum, null] };
      return { ...value, type: [value.type, 'null'] };
    }
    if (Array.isArray(value?.enum)) {
      const sample = value.enum.find((item: unknown) => item !== null);
      const type = typeof sample === 'string' ? 'string' : typeof sample === 'number' ? 'number' : typeof sample === 'boolean' ? 'boolean' : undefined;
      return { ...value, ...(type ? { type: [type, 'null'] } : {}), enum: [...value.enum, null] };
    }
    if (Array.isArray(value?.anyOf)) return { anyOf: [...value.anyOf, { type: 'null' }] };
    return { anyOf: [value, { type: 'null' }] };
  };
  const clean = (value: any): any => {
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value !== 'object') return value;
    const result: Record<string, any> = {};
    for (const [key, item] of Object.entries(value)) {
      // Groq currently accepts the structural subset below; domain constraints remain checked by Ajv/Validation Engine.
      if (['$schema', 'pattern', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'].includes(key)) continue;
      result[key] = clean(item);
    }
    return result;
  };
  const converted = convert(input);
  const rootUnion = Array.isArray(input.oneOf) || Array.isArray(input.anyOf);
  const responseSchema = rootUnion ? { anyOf: converted.anyOf || converted.oneOf } : converted;
  const schema = { type: 'object', properties: { response: responseSchema }, required: ['response'], additionalProperties: false, ...(Object.keys(defs).length ? { $defs: converted.$defs } : {}) };
  return clean(schema);
}

function parseExternalStructuredContent(content: unknown, schema: Record<string, unknown>, mode: ExternalStructuredOutputMode, observer?: (value: unknown) => void): unknown {
  const parsed = parseStructuredContent(content);
  observer?.(structuredClone(parsed));
  if (mode !== 'json-schema-strict') return parsed;
  const payload = parsed as Record<string, unknown>;
  if (!payload || typeof payload !== 'object' || !Object.hasOwn(payload, 'response')) throw new ProviderFailure('PROVIDER_INVALID_RESPONSE', 'Envelope estruturado ausente na resposta do provedor');
  const unwrapped = payload.response;
  return normalizeStrictResponse(schema, unwrapped);
}

function normalizeStrictResponse(rootSchema: Record<string, unknown>, value: unknown): unknown {
  const defs = (rootSchema.$defs && typeof rootSchema.$defs === 'object' ? rootSchema.$defs : {}) as Record<string, any>;
  const resolve = (schema: any): any => typeof schema?.$ref === 'string' && schema.$ref.startsWith('#/$defs/') ? defs[schema.$ref.slice('#/$defs/'.length)] : schema;
  const matchingVariant = (schema: any, actual: any): any => {
    const variants = schema?.oneOf || schema?.anyOf;
    if (!Array.isArray(variants) || !actual || typeof actual !== 'object') return schema;
    for (const variant of variants) {
      const properties = variant.properties || {};
      const discriminator = ['kind', 'op'].find(key => properties[key]?.const !== undefined || properties[key]?.enum);
      if (discriminator) {
        const rule = properties[discriminator];
        if (rule.const === actual[discriminator] || rule.enum?.includes(actual[discriminator])) return variant;
      }
    }
    return variants.find((variant: any) => Object.keys(variant.properties || {}).every(key => Object.hasOwn(actual, key))) || schema;
  };
  const walk = (rawSchema: any, actual: any): any => {
    let current = resolve(rawSchema);
    if (!current) return actual;
    current = matchingVariant(current, actual);
    current = resolve(current);
    if (Array.isArray(actual) && current.items) return actual.map(item => walk(current.items, item));
    if (actual && typeof actual === 'object' && !Array.isArray(actual) && current.properties) {
      const properties = current.properties as Record<string, any>;
      const required = new Set(Array.isArray(current.required) ? current.required : []);
      const normalized: Record<string, unknown> = {};
      for (const [key, childSchema] of Object.entries(properties)) {
        const child = (actual as Record<string, any>)[key];
        if (!required.has(key) && child === null) continue;
        if (Object.hasOwn(actual, key)) normalized[key] = walk(childSchema, child);
      }
      return normalized;
    }
    return actual;
  };
  return walk(rootSchema, value);
}

export class ProviderConcurrencyLimit {
  private active = 0;
  constructor(private readonly maximum: number) {}
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.maximum) throw new ProviderFailure('PROVIDER_RATE_LIMITED', 'Concorrência local máxima do gateway atingida');
    this.active++;
    try { return await operation(); }
    finally { this.active--; }
  }
}
