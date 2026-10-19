CREATE TABLE ai_settings (tenant_id uuid NOT NULL, connection_id uuid NOT NULL, enabled boolean NOT NULL DEFAULT true, auto_receipts boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1, PRIMARY KEY(tenant_id,connection_id), FOREIGN KEY(tenant_id,connection_id) REFERENCES source_connections(tenant_id,id));
-- statement
CREATE TABLE ai_knowledge (tenant_id uuid NOT NULL, connection_id uuid NOT NULL, id uuid NOT NULL, document_key text NOT NULL, version integer NOT NULL CHECK(version>0), group_id text NOT NULL, title text NOT NULL, body text NOT NULL CHECK(octet_length(body)<=8000), sha256 char(64) NOT NULL, approved_by text NOT NULL, effective_at timestamptz NOT NULL, expires_at timestamptz NOT NULL CHECK(expires_at>effective_at), revoked boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,connection_id,document_key,version), FOREIGN KEY(tenant_id,connection_id) REFERENCES source_connections(tenant_id,id));
-- statement
CREATE INDEX ai_knowledge_search ON ai_knowledge USING gin(to_tsvector('simple',title || ' ' || body));
-- statement
CREATE TABLE ai_runs (tenant_id uuid NOT NULL, connection_id uuid NOT NULL, case_id uuid NOT NULL, id uuid NOT NULL, receipt_id uuid, expected_revision integer NOT NULL, request_key text NOT NULL, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','proposed','waiting','needs_review','failed','stale','approved','rejected','uncertain')), reason text, model_id text NOT NULL, prompt_version text NOT NULL, settings_revision integer NOT NULL, lease_token uuid, started_at timestamptz, queued_at timestamptz, context jsonb, context_hash char(64), proposal jsonb, proposal_hash char(64), input_tokens integer NOT NULL DEFAULT 0, output_tokens integer NOT NULL DEFAULT 0, reserved_tokens integer NOT NULL DEFAULT 100000, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,connection_id,request_key), FOREIGN KEY(tenant_id,case_id) REFERENCES coordination_cases(tenant_id,id), FOREIGN KEY(tenant_id,connection_id) REFERENCES source_connections(tenant_id,id), FOREIGN KEY(tenant_id,receipt_id) REFERENCES channel_receipts(tenant_id,id));
-- statement
CREATE INDEX ai_runs_pending ON ai_runs(tenant_id,created_at) WHERE state='pending';
-- statement
CREATE TABLE ai_steps (tenant_id uuid NOT NULL, run_id uuid NOT NULL, step integer NOT NULL, observation jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,run_id,step), FOREIGN KEY(tenant_id,run_id) REFERENCES ai_runs(tenant_id,id));
-- statement
CREATE TABLE ai_reviews (tenant_id uuid NOT NULL, run_id uuid NOT NULL, reviewer text NOT NULL, disposition text NOT NULL CHECK(disposition IN ('approve','reject')), proposal_hash char(64) NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,run_id), FOREIGN KEY(tenant_id,run_id) REFERENCES ai_runs(tenant_id,id));
-- statement
CREATE TABLE ai_config_audit (tenant_id uuid NOT NULL, id uuid NOT NULL, connection_id uuid NOT NULL, actor text NOT NULL, change jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,connection_id) REFERENCES source_connections(tenant_id,id));
-- statement
DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['ai_settings','ai_knowledge','ai_runs','ai_steps','ai_reviews','ai_config_audit'] LOOP EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl); EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl); END LOOP; END $$;
-- statement
GRANT SELECT,INSERT,UPDATE ON ai_settings,ai_runs TO ilien_app;
-- statement
GRANT SELECT,INSERT ON ai_knowledge,ai_steps,ai_reviews,ai_config_audit TO ilien_app;
-- statement
GRANT UPDATE(revoked) ON ai_knowledge TO ilien_app;
-- statement
INSERT INTO ai_settings(tenant_id,connection_id) SELECT tenant_id,id FROM source_connections WHERE origin='simulated';
-- statement
INSERT INTO schema_migrations(version) VALUES(4);
