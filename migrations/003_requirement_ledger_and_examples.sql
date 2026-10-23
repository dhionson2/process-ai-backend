-- Requirement ledger: business items of a session (participants, steps, decisions, fields) with their origin
-- and the requester's verdict. Confirmed items become facts in the prompt; rejected ones become constraints.
CREATE TABLE IF NOT EXISTS process_ai_requirements (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  session_id uuid NOT NULL REFERENCES process_ai_sessions(id),
  kind text NOT NULL CHECK (kind IN ('actor','activity','decision','field')),
  label text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('user','confirmed-answer','inference','unknown')),
  state text NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed','confirmed','rejected')),
  first_revision integer NOT NULL,
  last_revision integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, session_id, kind, label)
);
CREATE INDEX IF NOT EXISTS process_ai_requirements_session_idx ON process_ai_requirements(tenant_id, session_id);

-- Accepted examples: request text and accepted result summary, used as same-tenant few-shot patterns (opt-in).
CREATE TABLE IF NOT EXISTS process_ai_accepted_examples (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  session_id uuid NOT NULL REFERENCES process_ai_sessions(id),
  revision integer NOT NULL,
  request_text text NOT NULL,
  summary text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, session_id, revision)
);
CREATE INDEX IF NOT EXISTS process_ai_accepted_examples_tenant_idx ON process_ai_accepted_examples(tenant_id, created_at DESC);
