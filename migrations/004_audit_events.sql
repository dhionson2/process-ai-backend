-- Audit trail of state-changing API calls: who, what, when and the outcome. Never stores request content.
CREATE TABLE IF NOT EXISTS process_ai_audit_events (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  subject text NOT NULL,
  action text NOT NULL,
  session_id uuid,
  status_code integer NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS process_ai_audit_events_tenant_idx ON process_ai_audit_events(tenant_id, created_at DESC);
