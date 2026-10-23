import type { Environment } from '../../config/env.js';
import { OllamaProvider, OpenAICompatibleProvider, type ModelProvider } from '../providers/model-provider.js';
import { AnthropicProvider } from '../providers/anthropic-provider.js';
import { ClaudeCliProvider } from '../providers/claude-cli-provider.js';
import { configuredSyntheticDiagnosticCapture } from '../providers/diagnostic-capture.js';
import { ProviderCallBudgetLedger } from '../providers/call-budget-ledger.js';
import { OrchestrationFailure } from './orchestrator.js';

export function configuredProvider(environment: Environment): { provider: ModelProvider; model: string } | undefined {
  if (environment.aiProvider === 'disabled') return undefined;
  if (!environment.aiModel) throw new OrchestrationFailure('AI_CONFIGURATION_INVALID', 'AI_MODEL precisa estar configurado');
  if (environment.aiProvider === 'ollama') return { provider: new OllamaProvider(environment.ollamaBaseUrl), model: environment.aiModel };
  if (!environment.externalAiApproved) throw new OrchestrationFailure('AI_PROVIDER_NOT_APPROVED', 'O provedor externo não foi habilitado pela política do servidor');
  if (environment.aiProvider === 'anthropic') return { provider: new AnthropicProvider({ effort: environment.anthropicEffort, fallbacks: environment.anthropicFallbacks, maxRetries: environment.anthropicMaxRetries }), model: environment.aiModel };
  if (environment.aiProvider === 'claude-cli') return { provider: new ClaudeCliProvider({ binary: environment.claudeCliBinary, bare: environment.claudeCliBare, maxBudgetUsd: environment.claudeCliMaxBudgetUsd, budget: { maxCalls: environment.aiMaxProviderCalls, maxTokens: environment.aiMaxProviderTokens } }), model: environment.aiModel };
  if (!environment.externalAiBaseUrl || !environment.externalAiApiKey) throw new OrchestrationFailure('AI_CONFIGURATION_INVALID', 'Endpoint e credencial do provedor externo precisam estar configurados no backend');
  const ledgerPath = process.env.AI_PROVIDER_BUDGET_LEDGER_PATH;
  const durableLedger = ledgerPath ? new ProviderCallBudgetLedger(ledgerPath) : undefined;
  const cumulativeCalls = Number(process.env.AI_MAX_CUMULATIVE_PROVIDER_CALLS || 0);
  const durableBudget = durableLedger && Number.isSafeInteger(cumulativeCalls) && cumulativeCalls > 0
    ? { maxCalls: cumulativeCalls, maxTokens: environment.aiMaxProviderTokens }
    : undefined;
  return { provider: new OpenAICompatibleProvider(environment.externalAiBaseUrl, environment.externalAiApiKey, environment.externalAiStructuredOutput, { maxCalls: environment.aiMaxProviderCalls, maxTokens: environment.aiMaxProviderTokens }, 1, undefined, configuredSyntheticDiagnosticCapture(), durableLedger, durableBudget), model: environment.aiModel };
}
