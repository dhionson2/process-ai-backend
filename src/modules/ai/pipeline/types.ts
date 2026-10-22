import type { generateArtifacts } from '../../generation/artifact-generator.js';
import type { ConfirmedFact, ProjectTarget } from '../../projects/conversation.repository.js';
import type { ProviderDiagnostic, ProviderUsage } from '../../providers/model-provider.js';
import type { GraphIRSchemaDiagnosticSet } from '../../graph-ir/graph-ir.js';
import type { RequirementLedgerV1 } from '../requirement-coverage.js';

export type Json = Record<string, any>;
export type ConversationTurn = { role: 'user' | 'assistant'; content: string };
export type PipelineDiagnostic = { stage: string; status: string; details: Record<string, unknown> };
export type GenerationArguments = { text: string; history: ConversationTurn[]; sourceMessageId?: string; sourceMessageType?: 'user' | 'confirmed-answer'; originalSource?: { id: string; text: string }; authoritativeUserMessages?: Array<{ id: string; text: string }>; dataClassification?: 'synthetic' | 'public'; currentSpec?: Record<string, unknown>; targetProfile?: ProjectTarget; confirmedFacts?: ConfirmedFact[]; requirementLedger?: RequirementLedgerV1; onProviderCallStart?: () => Promise<void> | void };
export type GenerationOutcome = (
  | { kind: 'need_clarification'; questions: Array<{ question: string; blocking: boolean; questionId?: string; requirementId?: string; semanticSlot?: string; status?: 'pending' | 'answered' }>; summary?: string; provider: string; model: string; latencyMs: number; usage: ProviderUsage; knowledgeVersion: string; knowledgeModules: string[]; intermediate?: Json }
  | { kind: 'proposed_spec'; spec: Record<string, unknown>; changeSummary: string; validation: { valid: boolean; diagnostics: Array<{ code: string; path: string; message: string; severity: string }> }; artifacts?: Awaited<ReturnType<typeof generateArtifacts>>; provider: string; model: string; latencyMs: number; usage: ProviderUsage; repairAttempts: number; knowledgeVersion: string; knowledgeModules: string[]; intermediate?: Json }) & { diagnostics?: PipelineDiagnostic[] };

export class OrchestrationFailure extends Error {
  diagnostics?: PipelineDiagnostic[];
  graphIrSchemaDiagnostics?: GraphIRSchemaDiagnosticSet;
  constructor(readonly code: string, message: string, readonly retryable = false, readonly retryAfterMs?: number, readonly providerDiagnostic?: ProviderDiagnostic) { super(message); this.name = 'OrchestrationFailure'; }
}

/** A stage either hands a value to the next stage or ends the turn with an outcome. */
export type StageResult<T> = { next: T } | { stop: GenerationOutcome };
export const next = <T>(value: T): StageResult<T> => ({ next: value });
export const stop = <T>(outcome: GenerationOutcome): StageResult<T> => ({ stop: outcome });

export type RepairKind = 'structural' | 'repeated-question' | 'omission' | 'validation';

/**
 * The corrective-call policy of a turn, in one place:
 * - a structural (schema) correction is always allowed once;
 * - a repeated-question recovery is allowed once;
 * - an omission correction only on a turn that needed no other correction;
 * - a validation correction only when no semantic correction (repeated question or omission) ran.
 * At most two model corrections ever happen in a turn (structural + one semantic).
 */
export class RepairBudget {
  private readonly used = new Map<RepairKind, number>();
  count(kind: RepairKind): number { return this.used.get(kind) ?? 0; }
  canUse(kind: RepairKind): boolean {
    if (this.count(kind) > 0) return false;
    if (kind === 'omission') return this.count('structural') + this.count('repeated-question') === 0;
    if (kind === 'validation') return this.count('repeated-question') + this.count('omission') === 0;
    return true;
  }
  consume(kind: RepairKind): void { this.used.set(kind, this.count(kind) + 1); }
  /** Public `repairAttempts`: a validation correction reports 1, as in the v1 contract (maximum 1). */
  reported(): number {
    if (this.count('validation')) return 1;
    return this.count('structural') + this.count('repeated-question') + this.count('omission');
  }
}
