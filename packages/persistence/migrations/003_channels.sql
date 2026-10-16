ALTER TABLE coordination_contacts DROP CONSTRAINT coordination_contacts_delivery_status_check, ADD CONSTRAINT coordination_contacts_delivery_status_check CHECK(delivery_status IN ('simulated','channel_intent'));
-- statement
GRANT UPDATE(delivery_status) ON coordination_contacts TO ilien_app;
-- statement
CREATE TABLE channel_bindings (tenant_id uuid NOT NULL, connection_id uuid NOT NULL, id uuid NOT NULL, actor_id text NOT NULL, channel text NOT NULL CHECK(channel IN ('whatsapp','email')), address text NOT NULL, consent_ref text NOT NULL, enabled boolean NOT NULL DEFAULT false, priority integer NOT NULL DEFAULT 10, last_inbound_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,connection_id,channel,address), UNIQUE(tenant_id,connection_id,actor_id,channel), FOREIGN KEY(tenant_id,connection_id) REFERENCES source_connections(tenant_id,id));
-- statement
CREATE TABLE channel_deliveries (tenant_id uuid NOT NULL, id uuid NOT NULL, connection_id uuid NOT NULL, case_id uuid NOT NULL, contact_id uuid NOT NULL, binding_id uuid NOT NULL, actor_id text NOT NULL, channel text NOT NULL, address text NOT NULL, token text NOT NULL, obligation_id text NOT NULL, obligation_revision integer NOT NULL, request jsonb NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','accepted','blocked','uncertain','superseded')), reason text, rendered_text text, rendered_sha256 char(64), provider_message_id text, attempt_at timestamptz, queued_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(token), UNIQUE(tenant_id,contact_id,channel), FOREIGN KEY(tenant_id,case_id) REFERENCES coordination_cases(tenant_id,id), FOREIGN KEY(tenant_id,contact_id) REFERENCES coordination_contacts(tenant_id,id), FOREIGN KEY(tenant_id,binding_id) REFERENCES channel_bindings(tenant_id,id));
-- statement
CREATE TABLE channel_receipts (tenant_id uuid NOT NULL, connection_id uuid NOT NULL, id uuid NOT NULL, channel text NOT NULL, provider_message_id text NOT NULL, binding_id uuid, delivery_id uuid, case_id uuid, evidence_id uuid NOT NULL, normalized jsonb NOT NULL, status text NOT NULL CHECK(status IN ('received','applied','needs_review','quarantined','unmatched','duplicate_conflict')), reason text, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,channel,provider_message_id), FOREIGN KEY(tenant_id,evidence_id) REFERENCES evidence_items(tenant_id,id), FOREIGN KEY(tenant_id,binding_id) REFERENCES channel_bindings(tenant_id,id), FOREIGN KEY(tenant_id,delivery_id) REFERENCES channel_deliveries(tenant_id,id));
-- statement
CREATE TABLE channel_delivery_events (tenant_id uuid NOT NULL, id uuid NOT NULL, channel text NOT NULL, provider_message_id text NOT NULL, event_key char(64) NOT NULL, event_type text NOT NULL, evidence_id uuid NOT NULL, occurred_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,event_key), FOREIGN KEY(tenant_id,evidence_id) REFERENCES evidence_items(tenant_id,id));
-- statement
CREATE TABLE channel_binding_audit (tenant_id uuid NOT NULL, id uuid NOT NULL, binding_id uuid NOT NULL, change jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,binding_id) REFERENCES channel_bindings(tenant_id,id));
-- statement
CREATE INDEX channel_deliveries_pending ON channel_deliveries(tenant_id,created_at) WHERE status='pending';
-- statement
CREATE INDEX channel_deliveries_provider ON channel_deliveries(tenant_id,channel,provider_message_id);
-- statement
CREATE INDEX channel_receipts_case ON channel_receipts(tenant_id,case_id,created_at DESC);
-- statement
DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['channel_bindings','channel_deliveries','channel_receipts','channel_delivery_events','channel_binding_audit'] LOOP EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl); EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl); END LOOP; END $$;
-- statement
GRANT SELECT,INSERT,UPDATE ON channel_bindings,channel_deliveries,channel_receipts TO ilien_app;
-- statement
GRANT SELECT,INSERT ON channel_delivery_events,channel_binding_audit TO ilien_app;
-- statement
INSERT INTO schema_migrations(version) VALUES(3);
