/** Generic, composable business patterns compiled by semantic-process.ts. */
export const BUSINESS_PATTERN_LIBRARY = {
  request: { id: 'request', scope: 'process-start', compilesTo: ['startEvent', 'start-form'] },
  humanTask: { id: 'human-task', intentKind: 'task', compilesTo: ['userTask', 'task-form'] },
  approval: { id: 'approval', intentKind: 'approval', compilesTo: ['userTask', 'exclusiveGateway', 'approved-route', 'rejected-route'] },
  forwarding: { id: 'forwarding', intentKind: 'decision', compilesTo: ['exclusiveGateway', 'recipient-routes'] },
  conditionalDecision: { id: 'conditional-decision', intentKind: 'decision', compilesTo: ['exclusiveGateway', 'condition-expressions'] },
  declarativeIntegration: { id: 'declarative-integration', intentKind: 'integration', compilesTo: ['serviceTask', 'catalog-operation'] },
  notification: { id: 'notification', intentKind: 'integration', requiresCatalogOperation: true, compilesTo: ['serviceTask'] },
  recordUpdate: { id: 'record-update', intentKind: 'integration', requiresCatalogOperation: true, requiresApprovalAndIdempotency: true, compilesTo: ['serviceTask'] },
  termination: { id: 'termination', scope: 'process-end', compilesTo: ['endEvent'] },
} as const;

export type BusinessActivityKind = 'task' | 'approval' | 'decision' | 'integration';

export function businessPatternForActivity(kind: string) {
  if (kind === 'task') return BUSINESS_PATTERN_LIBRARY.humanTask;
  if (kind === 'approval') return BUSINESS_PATTERN_LIBRARY.approval;
  if (kind === 'decision') return BUSINESS_PATTERN_LIBRARY.conditionalDecision;
  if (kind === 'integration') return BUSINESS_PATTERN_LIBRARY.declarativeIntegration;
  return undefined;
}
