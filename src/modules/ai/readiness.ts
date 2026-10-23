import { initiatesRequest, normalized } from './semantic-process.js';

type Json = any;

/** A minimum the requester must have stated before a first proposal is compiled. */
export type ReadinessGap = { slot: 'initiator' | 'start-data' | 'approval-outcome'; question: string };
export type ReadinessAssessment = { ready: boolean; gaps: ReadinessGap[]; understanding: string };

// The actor is the grammatical subject of a request verb: "o funcionário solicita", "o servidor informa".
const requestVerb = /\b(solicita|pede|envia|abre|inicia|submete|requer|cadastra|preenche|informa|se inscreve|faz)\b/;
// The requester said which data starts the request: "informando o valor", "preenche o formulário".
const dataCue = /\b(inform\w*|preench\w*|anex\w*|dados|campos?|indicando|contendo|descrevendo)\b/;
// The requester said what follows a decision, including that nothing follows. Matched on normalized text.
const outcomeCue = /\b(se|caso|quando)\b.{0,40}\b(aprov|reprov|negad|recus|rejeit|deferid|indeferid)\w*|\b(termina|encerra|finaliza)\w*/;

function actorStartsRequest(name: string, sourceText: string): boolean {
  if (initiatesRequest(name, sourceText)) return true;
  const role = normalized(name);
  if (!role) return false;
  return sourceText.split(/[.!?;]/).map(normalized).some(clause => {
    const actorIndex = clause.indexOf(role);
    if (actorIndex < 0) return false;
    const verb = clause.slice(actorIndex + role.length).search(requestVerb);
    return verb >= 0 && verb < 30;
  });
}

function approvals(steps: Json[] = []): Json[] {
  return steps.flatMap(step => step?.kind === 'approval' ? [step, ...approvals(step.onApproved), ...approvals(step.onRejected)] : step?.kind === 'decision' ? (step.alternatives ?? []).flatMap((alternative: Json) => approvals(alternative.steps)) : []);
}

function understandingOf(intent: Json): string {
  const actors = (intent.actors ?? []).map((actor: Json) => actor.name).filter(Boolean);
  const steps = (intent.activities ?? []).map((step: Json) => step.name).filter(Boolean);
  const parts = [`Entendi um processo de “${intent.name}”${intent.purpose ? `: ${String(intent.purpose).replace(/\.$/, '')}` : ''}.`];
  if (actors.length) parts.push(`Participantes citados: ${actors.join(', ')}.`);
  if (steps.length) parts.push(`Etapas identificadas: ${steps.join('; ')}.`);
  parts.push('Para montar o fluxo sem inventar regras, preciso confirmar alguns pontos.');
  return parts.join(' ').slice(0, 1000);
}

/**
 * Deterministic readiness gate for a first proposal. It inspects what the requester actually wrote
 * (never what the model inferred) and asks at most three questions. It is applied once per session:
 * after a clarification round has been answered, remaining gaps surface as pending items instead.
 */
export function assessReadiness(intent: Json, sourceText: string): ReadinessAssessment {
  const source = normalized(sourceText);
  const gaps: ReadinessGap[] = [];
  const actors: Json[] = intent?.actors ?? [];
  if (!actors.some(actor => actor?.name && actorStartsRequest(actor.name, sourceText))) {
    gaps.push({ slot: 'initiator', question: 'Quem inicia o pedido (por exemplo: servidor, funcionário, cidadão)?' });
  }
  if (!dataCue.test(source)) {
    gaps.push({ slot: 'start-data', question: 'Quais dados a pessoa informa ao iniciar o pedido?' });
  }
  const openApproval = approvals(intent?.activities).find(step => !(step.onApproved?.length) && !(step.onRejected?.length));
  if (openApproval && !outcomeCue.test(source)) {
    const who = openApproval.actor ? `o ${String(openApproval.actor).toLowerCase()}` : 'o responsável';
    gaps.push({ slot: 'approval-outcome', question: `O que acontece depois que ${who} aprova? E se reprovar, o processo termina ou há outra etapa?`.slice(0, 255) });
  }
  return { ready: gaps.length === 0, gaps, understanding: understandingOf(intent ?? {}) };
}
