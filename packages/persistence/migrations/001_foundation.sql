CREATE TABLE schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
-- statement
CREATE TABLE tenants (id uuid PRIMARY KEY, name text NOT NULL);
-- statement
CREATE TABLE source_connections (tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL, principal_arn text NOT NULL UNIQUE, origin text NOT NULL CHECK(origin IN ('simulated','external')), enabled boolean NOT NULL DEFAULT true, PRIMARY KEY(tenant_id,id));
-- statement
CREATE TABLE evidence_items (tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL, origin text NOT NULL CHECK(origin IN ('simulated','external')), original_text text NOT NULL CHECK(octet_length(original_text)<=262144), sha256 char(64) NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id));
-- statement
CREATE TABLE inbox_events (tenant_id uuid NOT NULL, id uuid NOT NULL, connection_id uuid NOT NULL, external_id text NOT NULL, event_type text NOT NULL, occurred_at timestamptz NOT NULL, evidence_id uuid NOT NULL, content_hash char(64) NOT NULL, disposition text NOT NULL DEFAULT 'triage' CHECK(disposition IN ('triage','record_only')), status text NOT NULL DEFAULT 'accepted' CHECK(status IN ('accepted','awaiting_coordination')), received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,connection_id,external_id), FOREIGN KEY(tenant_id,connection_id) REFERENCES source_connections(tenant_id,id), FOREIGN KEY(tenant_id,evidence_id) REFERENCES evidence_items(tenant_id,id));
-- statement
CREATE TABLE outbox_jobs (tenant_id uuid NOT NULL, id uuid NOT NULL, inbox_id uuid NOT NULL, kind text NOT NULL CHECK(kind='event.accepted'), state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','dispatched','processed')), attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), lease_token uuid, lease_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,inbox_id,kind), FOREIGN KEY(tenant_id,inbox_id) REFERENCES inbox_events(tenant_id,id));
-- statement
CREATE INDEX inbox_recent ON inbox_events(tenant_id,received_at DESC);
-- statement
CREATE INDEX outbox_pending ON outbox_jobs(tenant_id,created_at) WHERE state IN ('pending','leased');
-- statement
CREATE FUNCTION resolve_source(p_principal text) RETURNS TABLE(tenant_id uuid,id uuid,origin text) LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT tenant_id,id,origin FROM public.source_connections WHERE principal_arn=p_principal AND enabled $$;
-- statement
REVOKE ALL ON FUNCTION resolve_source(text) FROM PUBLIC;
-- statement
ALTER TABLE source_connections ENABLE ROW LEVEL SECURITY;
-- statement
ALTER TABLE evidence_items ENABLE ROW LEVEL SECURITY;
-- statement
ALTER TABLE inbox_events ENABLE ROW LEVEL SECURITY;
-- statement
ALTER TABLE outbox_jobs ENABLE ROW LEVEL SECURITY;
-- statement
CREATE POLICY tenant_scope ON source_connections USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
-- statement
CREATE POLICY tenant_scope ON evidence_items USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
-- statement
CREATE POLICY tenant_scope ON inbox_events USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
-- statement
CREATE POLICY tenant_scope ON outbox_jobs USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
-- statement
GRANT USAGE ON SCHEMA public TO ilien_app;
-- statement
GRANT SELECT ON source_connections TO ilien_app;
-- statement
GRANT SELECT,INSERT ON evidence_items TO ilien_app;
-- statement
GRANT SELECT,INSERT,UPDATE ON inbox_events,outbox_jobs TO ilien_app;
-- statement
GRANT EXECUTE ON FUNCTION resolve_source(text) TO ilien_app;
-- statement
INSERT INTO schema_migrations(version) VALUES(1);
