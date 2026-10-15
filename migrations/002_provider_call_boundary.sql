ALTER TABLE process_ai_generation_runs ADD COLUMN IF NOT EXISTS provider_started_at timestamptz;
