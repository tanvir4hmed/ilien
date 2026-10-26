ALTER TABLE ai_settings ADD COLUMN execution_mode text NOT NULL DEFAULT 'autonomous' CHECK(execution_mode IN ('autonomous','review'));
-- statement
UPDATE ai_settings SET revision=revision+1;
-- statement
ALTER TABLE ai_runs DROP CONSTRAINT ai_runs_state_check;
-- statement
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_state_check CHECK(state IN ('pending','running','proposed','waiting','needs_review','needs_clarification','failed','stale','approved','rejected','uncertain','executed'));
-- statement
CREATE TABLE ai_executions (tenant_id uuid NOT NULL, run_id uuid NOT NULL, actor_id text NOT NULL, proposal_hash char(64) NOT NULL, policy_hash char(64) NOT NULL, settings_revision integer NOT NULL, case_revision integer NOT NULL, operation jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,run_id), FOREIGN KEY(tenant_id,run_id) REFERENCES ai_runs(tenant_id,id));
-- statement
ALTER TABLE ai_executions ENABLE ROW LEVEL SECURITY;
-- statement
CREATE POLICY tenant_scope ON ai_executions USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
-- statement
GRANT SELECT,INSERT ON ai_executions TO ilien_app;
-- statement
INSERT INTO schema_migrations(version) VALUES(9);
