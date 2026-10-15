import type { Environment } from '../../config/env.js';
import { OllamaProvider, OpenAICompatibleProvider, type ModelProvider } from '../providers/model-provider.js';
import { OrchestrationFailure } from './orchestrator.js';

export function configuredProvider(environment: Environment): { provider: ModelProvider; model: string } | undefined {
  if (environment.aiProvider === 'disabled') return undefined;
  if (!environment.aiModel) throw new OrchestrationFailure('AI_CONFIGURATION_INVALID', 'AI_MODEL precisa estar configurado');
  if (environment.aiProvider === 'ollama') return { provider: new OllamaProvider(environment.ollamaBaseUrl), model: environment.aiModel };
  if (!environment.externalAiApproved) throw new OrchestrationFailure('AI_PROVIDER_NOT_APPROVED', 'O provedor externo não foi habilitado pela política do servidor');
  if (!environment.externalAiBaseUrl || !environment.externalAiApiKey) throw new OrchestrationFailure('AI_CONFIGURATION_INVALID', 'Endpoint e credencial do provedor externo precisam estar configurados no backend');
  return { provider: new OpenAICompatibleProvider(environment.externalAiBaseUrl, environment.externalAiApiKey, environment.externalAiStructuredOutput, { maxCalls: environment.aiMaxProviderCalls, maxTokens: environment.aiMaxProviderTokens }), model: environment.aiModel };
}
