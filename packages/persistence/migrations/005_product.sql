CREATE TABLE operator_memberships (tenant_id uuid NOT NULL, connection_id uuid NOT NULL, subject uuid NOT NULL UNIQUE, role text NOT NULL CHECK(role IN ('admin','operator','viewer')), enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,subject), FOREIGN KEY(tenant_id,connection_id) REFERENCES source_connections(tenant_id,id));
-- statement
CREATE FUNCTION resolve_operator(p_subject uuid) RETURNS TABLE(tenant_id uuid,id uuid,origin text,role text) LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT s.tenant_id,s.id,s.origin,m.role FROM public.operator_memberships m JOIN public.source_connections s ON s.tenant_id=m.tenant_id AND s.id=m.connection_id WHERE m.subject=p_subject AND m.enabled AND s.enabled $$;
-- statement
REVOKE ALL ON FUNCTION resolve_operator(uuid) FROM PUBLIC;
-- statement
GRANT EXECUTE ON FUNCTION resolve_operator(uuid) TO ilien_app;
-- statement
CREATE TABLE product_settings (tenant_id uuid NOT NULL, connection_id uuid NOT NULL, revision integer NOT NULL DEFAULT 1, configuration jsonb NOT NULL DEFAULT '{"workflows":[],"automaticFallback":false,"whatsappTemplate":null}'::jsonb, PRIMARY KEY(tenant_id,connection_id), FOREIGN KEY(tenant_id,connection_id) REFERENCES source_connections(tenant_id,id));
-- statement
CREATE TABLE configuration_history (tenant_id uuid NOT NULL, connection_id uuid NOT NULL, id uuid NOT NULL, revision integer NOT NULL, actor text NOT NULL, policy jsonb NOT NULL, configuration jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,connection_id,revision), FOREIGN KEY(tenant_id,connection_id) REFERENCES source_connections(tenant_id,id));
-- statement
CREATE TABLE operator_audit (tenant_id uuid NOT NULL, connection_id uuid NOT NULL, id uuid NOT NULL, actor text NOT NULL, action text NOT NULL, request_hash char(64) NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,connection_id) REFERENCES source_connections(tenant_id,id));
-- statement
ALTER TABLE channel_deliveries ADD COLUMN template_snapshot jsonb;
-- statement
CREATE TABLE result_dispatches (tenant_id uuid NOT NULL, connection_id uuid NOT NULL, case_id uuid NOT NULL, result_id uuid NOT NULL, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','publishing','published','superseded')), queued_at timestamptz, started_at timestamptz, provider_id text, attempts integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,result_id), FOREIGN KEY(tenant_id,result_id) REFERENCES coordination_results(tenant_id,id), FOREIGN KEY(tenant_id,connection_id) REFERENCES source_connections(tenant_id,id));
-- statement
CREATE INDEX result_dispatches_pending ON result_dispatches(tenant_id,created_at) WHERE state IN ('pending','publishing');
-- statement
DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['operator_memberships','product_settings','configuration_history','operator_audit','result_dispatches'] LOOP EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl); EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl); END LOOP; END $$;
-- statement
GRANT SELECT,INSERT,UPDATE ON operator_memberships,product_settings,result_dispatches TO ilien_app;
-- statement
GRANT SELECT,INSERT ON configuration_history,operator_audit TO ilien_app;
-- statement
GRANT UPDATE ON coordination_policies TO ilien_app;
-- statement
INSERT INTO product_settings(tenant_id,connection_id) SELECT tenant_id,id FROM source_connections;
-- statement
INSERT INTO schema_migrations(version) VALUES(5);
