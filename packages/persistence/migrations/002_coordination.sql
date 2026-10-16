ALTER TABLE inbox_events DROP CONSTRAINT inbox_events_disposition_check, ADD CONSTRAINT inbox_events_disposition_check CHECK(disposition IN ('triage','record_only','create_mission'));
-- statement
ALTER TABLE inbox_events DROP CONSTRAINT inbox_events_status_check, ADD CONSTRAINT inbox_events_status_check CHECK(status IN ('accepted','awaiting_coordination','coordinating'));
-- statement
CREATE TABLE coordination_policies (tenant_id uuid NOT NULL, connection_id uuid NOT NULL, version text NOT NULL, policy jsonb NOT NULL, simulation_enabled boolean NOT NULL DEFAULT false, PRIMARY KEY(tenant_id,connection_id), FOREIGN KEY(tenant_id,connection_id) REFERENCES source_connections(tenant_id,id));
-- statement
CREATE TABLE coordination_cases (tenant_id uuid NOT NULL, id uuid NOT NULL, connection_id uuid NOT NULL, inbox_id uuid NOT NULL, workflow text NOT NULL, revision integer NOT NULL CHECK(revision>0), status text NOT NULL CHECK(status IN ('active','paused','blocked','completed','cancelled','handed_off')), snapshot jsonb NOT NULL CHECK(octet_length(snapshot::text)<=131072), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,inbox_id,workflow), FOREIGN KEY(tenant_id,connection_id) REFERENCES source_connections(tenant_id,id), FOREIGN KEY(tenant_id,inbox_id) REFERENCES inbox_events(tenant_id,id));
-- statement
CREATE TABLE coordination_obligations (tenant_id uuid NOT NULL, case_id uuid NOT NULL, id text NOT NULL, revision integer NOT NULL CHECK(revision>0), status text NOT NULL, assignee text NOT NULL, required boolean NOT NULL, PRIMARY KEY(tenant_id,case_id,id), FOREIGN KEY(tenant_id,case_id) REFERENCES coordination_cases(tenant_id,id));
-- statement
CREATE TABLE coordination_dependencies (tenant_id uuid NOT NULL, case_id uuid NOT NULL, obligation_id text NOT NULL, dependency_id text NOT NULL, CHECK(obligation_id<>dependency_id), PRIMARY KEY(tenant_id,case_id,obligation_id,dependency_id), FOREIGN KEY(tenant_id,case_id,obligation_id) REFERENCES coordination_obligations(tenant_id,case_id,id), FOREIGN KEY(tenant_id,case_id,dependency_id) REFERENCES coordination_obligations(tenant_id,case_id,id));
-- statement
CREATE TABLE coordination_journal (tenant_id uuid NOT NULL, case_id uuid NOT NULL, command_id uuid NOT NULL, request_hash char(64) NOT NULL, actor_id text NOT NULL, case_revision integer NOT NULL, evidence_id uuid, operation jsonb NOT NULL, state_hash char(64) NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,case_id,command_id), UNIQUE(tenant_id,case_id,case_revision), FOREIGN KEY(tenant_id,case_id) REFERENCES coordination_cases(tenant_id,id), FOREIGN KEY(tenant_id,evidence_id) REFERENCES evidence_items(tenant_id,id));
-- statement
CREATE TABLE coordination_rejections (tenant_id uuid NOT NULL, case_id uuid NOT NULL, id uuid NOT NULL, evidence_id uuid NOT NULL, request_hash char(64) NOT NULL, reason_code text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,case_id,request_hash,reason_code), FOREIGN KEY(tenant_id,case_id) REFERENCES coordination_cases(tenant_id,id), FOREIGN KEY(tenant_id,evidence_id) REFERENCES evidence_items(tenant_id,id));
-- statement
CREATE TABLE coordination_claims (tenant_id uuid NOT NULL, case_id uuid NOT NULL, obligation_id text NOT NULL, revision integer NOT NULL, evidence_id uuid NOT NULL, claim jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,case_id,obligation_id,revision), FOREIGN KEY(tenant_id,case_id,obligation_id) REFERENCES coordination_obligations(tenant_id,case_id,id), FOREIGN KEY(tenant_id,evidence_id) REFERENCES evidence_items(tenant_id,id));
-- statement
CREATE TABLE coordination_contacts (tenant_id uuid NOT NULL, case_id uuid NOT NULL, id uuid NOT NULL, case_revision integer NOT NULL, contact jsonb NOT NULL, delivery_status text NOT NULL DEFAULT 'simulated' CHECK(delivery_status='simulated'), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,case_id) REFERENCES coordination_cases(tenant_id,id));
-- statement
CREATE TABLE coordination_results (tenant_id uuid NOT NULL, case_id uuid NOT NULL, id uuid NOT NULL, case_revision integer NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,case_id,case_revision), FOREIGN KEY(tenant_id,case_id) REFERENCES coordination_cases(tenant_id,id));
-- statement
CREATE TABLE coordination_result_acks (tenant_id uuid NOT NULL, result_id uuid NOT NULL, id uuid NOT NULL, request_hash char(64) NOT NULL, disposition text NOT NULL CHECK(disposition IN ('accepted','rejected')), reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,result_id), FOREIGN KEY(tenant_id,result_id) REFERENCES coordination_results(tenant_id,id));
-- statement
CREATE TABLE coordination_jobs (tenant_id uuid NOT NULL, case_id uuid NOT NULL, id uuid NOT NULL, expected_revision integer NOT NULL, due_at timestamptz NOT NULL, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','dispatched','processed')), lease_token uuid, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,case_id) REFERENCES coordination_cases(tenant_id,id));
-- statement
CREATE INDEX coordination_jobs_pending ON coordination_jobs(tenant_id,created_at) WHERE state IN ('pending','leased');
-- statement
CREATE INDEX coordination_cases_recent ON coordination_cases(tenant_id,connection_id,updated_at DESC);
-- statement
CREATE INDEX coordination_contacts_recent ON coordination_contacts(tenant_id,case_id,created_at DESC);
-- statement
DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['coordination_rejections','coordination_policies','coordination_cases','coordination_obligations','coordination_dependencies','coordination_journal','coordination_claims','coordination_contacts','coordination_results','coordination_result_acks','coordination_jobs'] LOOP EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl); EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl); END LOOP; END $$;
-- statement
GRANT SELECT ON coordination_policies TO ilien_app;
-- statement
GRANT SELECT,INSERT,UPDATE ON coordination_cases,coordination_obligations,coordination_jobs TO ilien_app;
-- statement
GRANT SELECT,INSERT ON coordination_rejections,coordination_dependencies,coordination_journal,coordination_claims,coordination_contacts,coordination_results,coordination_result_acks TO ilien_app;
-- statement
INSERT INTO schema_migrations(version) VALUES(2);
