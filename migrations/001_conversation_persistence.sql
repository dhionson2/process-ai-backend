CREATE TABLE IF NOT EXISTS process_ai_projects (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  name text NOT NULL,
  target_profile text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS process_ai_sessions (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id uuid NOT NULL REFERENCES process_ai_projects(id),
  state text NOT NULL DEFAULT 'draft',
  current_revision integer NOT NULL DEFAULT 0,
  pending_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  confirmed_facts jsonb NOT NULL DEFAULT '[]'::jsonb,
  version bigint NOT NULL DEFAULT 0,
  generation_started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
ALTER TABLE process_ai_sessions ADD COLUMN IF NOT EXISTS confirmed_facts jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE process_ai_sessions ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 0;
ALTER TABLE process_ai_sessions ADD COLUMN IF NOT EXISTS generation_started_at timestamptz;

CREATE TABLE IF NOT EXISTS process_ai_messages (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  session_id uuid NOT NULL REFERENCES process_ai_sessions(id),
  role text NOT NULL CHECK (role IN ('user','assistant')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS process_ai_messages_session_idx ON process_ai_messages(tenant_id, session_id, created_at);

CREATE TABLE IF NOT EXISTS process_ai_revisions (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  session_id uuid NOT NULL REFERENCES process_ai_sessions(id),
  revision integer NOT NULL,
  base_revision integer NOT NULL,
  status text NOT NULL CHECK (status IN ('proposed','accepted')),
  process_spec jsonb NOT NULL,
  artifacts jsonb,
  summary text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, session_id, revision)
);

CREATE TABLE IF NOT EXISTS process_ai_generation_runs (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  session_id uuid NOT NULL REFERENCES process_ai_sessions(id),
  status text NOT NULL,
  result jsonb,
  error_code text,
  provider text,
  model text,
  metrics jsonb,
  operation_id text,
  request_hash text,
  source_message_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE process_ai_generation_runs ADD COLUMN IF NOT EXISTS operation_id text;
ALTER TABLE process_ai_generation_runs ADD COLUMN IF NOT EXISTS request_hash text;
ALTER TABLE process_ai_generation_runs ADD COLUMN IF NOT EXISTS source_message_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS process_ai_generation_operation_idx
  ON process_ai_generation_runs(tenant_id, session_id, operation_id) WHERE operation_id IS NOT NULL;
