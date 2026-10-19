CREATE TABLE operations_controls (tenant_id uuid NOT NULL, connection_id uuid NOT NULL, revision integer NOT NULL DEFAULT 1, intake_paused boolean NOT NULL DEFAULT false, agent_paused boolean NOT NULL DEFAULT false, outbound_paused boolean NOT NULL DEFAULT false, results_paused boolean NOT NULL DEFAULT false, retention_days integer NOT NULL DEFAULT 30 CHECK(retention_days BETWEEN 7 AND 3650), legal_hold boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,connection_id), FOREIGN KEY(tenant_id,connection_id) REFERENCES source_connections(tenant_id,id));
-- statement
CREATE TABLE operations_audit (tenant_id uuid NOT NULL, connection_id uuid NOT NULL, id uuid NOT NULL, request_id uuid NOT NULL, request_hash char(64) NOT NULL, actor text NOT NULL, action text NOT NULL, target_id uuid, reason text NOT NULL, detail jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,connection_id,request_id), FOREIGN KEY(tenant_id,connection_id) REFERENCES source_connections(tenant_id,id));
-- statement
CREATE TABLE retention_tombstones (tenant_id uuid NOT NULL, connection_id uuid NOT NULL, case_id uuid NOT NULL, run_id uuid NOT NULL, actor text NOT NULL, context_hash char(64), proposal_hash char(64), redacted_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,run_id), FOREIGN KEY(tenant_id,run_id) REFERENCES ai_runs(tenant_id,id), FOREIGN KEY(tenant_id,connection_id) REFERENCES source_connections(tenant_id,id), FOREIGN KEY(tenant_id,case_id) REFERENCES coordination_cases(tenant_id,id));
-- statement
DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['operations_controls','operations_audit','retention_tombstones'] LOOP EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl); EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl); END LOOP; END $$;
-- statement
GRANT SELECT,INSERT,UPDATE ON operations_controls TO ilien_app;
-- statement
GRANT SELECT,INSERT ON operations_audit TO ilien_app;
-- statement
GRANT SELECT ON retention_tombstones TO ilien_app;
-- statement
ALTER TABLE outbox_jobs ADD COLUMN dispatched_at timestamptz;
-- statement
ALTER TABLE coordination_jobs ADD COLUMN dispatched_at timestamptz;
-- statement
ALTER TABLE outbox_jobs DROP CONSTRAINT outbox_jobs_state_check;
-- statement
ALTER TABLE outbox_jobs ADD CONSTRAINT outbox_jobs_state_check CHECK(state IN ('pending','leased','dispatched','processed','exhausted'));
-- statement
ALTER TABLE coordination_jobs DROP CONSTRAINT coordination_jobs_state_check;
-- statement
ALTER TABLE coordination_jobs ADD CONSTRAINT coordination_jobs_state_check CHECK(state IN ('pending','leased','dispatched','processed','exhausted'));
-- statement
ALTER TABLE channel_deliveries ADD COLUMN queue_attempts integer NOT NULL DEFAULT 0;
-- statement
ALTER TABLE ai_runs ADD COLUMN queue_attempts integer NOT NULL DEFAULT 0;
-- statement
ALTER TABLE ai_runs ADD COLUMN trace_redacted_at timestamptz;
-- statement
ALTER TABLE result_dispatches ADD COLUMN queue_attempts integer NOT NULL DEFAULT 0;
-- statement
ALTER TABLE result_dispatches DROP CONSTRAINT result_dispatches_state_check;
-- statement
ALTER TABLE result_dispatches ADD CONSTRAINT result_dispatches_state_check CHECK(state IN ('pending','publishing','published','superseded','review'));
-- statement
CREATE INDEX operations_audit_recent ON operations_audit(tenant_id,connection_id,created_at DESC);
-- statement
CREATE FUNCTION redact_case_ai_traces(p_source uuid,p_case uuid,p_actor text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ DECLARE t uuid; n integer; control public.operations_controls%ROWTYPE; BEGIN
 t := nullif(current_setting('app.tenant_id',true),'')::uuid;
 SELECT * INTO control FROM public.operations_controls WHERE tenant_id=t AND connection_id=p_source FOR SHARE;
 IF NOT FOUND OR control.legal_hold THEN RAISE EXCEPTION 'retention_hold_or_scope'; END IF;
 PERFORM 1 FROM public.coordination_cases WHERE tenant_id=t AND connection_id=p_source AND id=p_case AND status IN ('completed','cancelled','handed_off') AND updated_at<now()-make_interval(days=>control.retention_days) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'retention_case_not_eligible'; END IF;
 PERFORM id FROM public.ai_runs WHERE tenant_id=t AND connection_id=p_source AND case_id=p_case FOR UPDATE;
 INSERT INTO public.retention_tombstones(tenant_id,connection_id,case_id,run_id,actor,context_hash,proposal_hash) SELECT tenant_id,connection_id,case_id,id,p_actor,context_hash,proposal_hash FROM public.ai_runs WHERE tenant_id=t AND connection_id=p_source AND case_id=p_case AND trace_redacted_at IS NULL AND state IN ('approved','rejected','failed','stale') ON CONFLICT DO NOTHING;
 UPDATE public.ai_steps s SET observation=jsonb_build_object('redacted',true,'sha256',encode(sha256(convert_to(s.observation::text,'UTF8')),'hex'),'at',now()) FROM public.retention_tombstones x WHERE x.tenant_id=t AND x.case_id=p_case AND s.tenant_id=x.tenant_id AND s.run_id=x.run_id AND NOT (s.observation ? 'redacted');
 UPDATE public.ai_runs r SET context=NULL,proposal=NULL,trace_redacted_at=now() FROM public.retention_tombstones x WHERE x.tenant_id=t AND x.case_id=p_case AND r.tenant_id=x.tenant_id AND r.id=x.run_id AND r.trace_redacted_at IS NULL;
 GET DIAGNOSTICS n = ROW_COUNT; RETURN n;
 END $$;
-- statement
REVOKE ALL ON FUNCTION redact_case_ai_traces(uuid,uuid,text) FROM PUBLIC;
-- statement
GRANT EXECUTE ON FUNCTION redact_case_ai_traces(uuid,uuid,text) TO ilien_app;
-- statement
INSERT INTO operations_controls(tenant_id,connection_id) SELECT tenant_id,id FROM source_connections;
-- statement
CREATE TABLE case_health_checks (tenant_id uuid NOT NULL, connection_id uuid NOT NULL, case_id uuid NOT NULL, checked_revision integer NOT NULL, status text NOT NULL CHECK(status IN ('ok','review','skipped')), issues jsonb NOT NULL, checked_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,case_id), FOREIGN KEY(tenant_id,case_id) REFERENCES coordination_cases(tenant_id,id), FOREIGN KEY(tenant_id,connection_id) REFERENCES source_connections(tenant_id,id));
-- statement
ALTER TABLE case_health_checks ENABLE ROW LEVEL SECURITY;
-- statement
CREATE POLICY tenant_scope ON case_health_checks USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
-- statement
GRANT SELECT,INSERT,UPDATE ON case_health_checks TO ilien_app;
-- statement
CREATE INDEX case_health_review ON case_health_checks(tenant_id,connection_id,status,checked_at);
-- statement
INSERT INTO schema_migrations(version) VALUES(6);
