CREATE TABLE channel_receipt_audit (tenant_id uuid NOT NULL, connection_id uuid NOT NULL, id uuid NOT NULL, receipt_id uuid NOT NULL, actor text NOT NULL, reason text NOT NULL, change jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,receipt_id) REFERENCES channel_receipts(tenant_id,id));
-- statement
ALTER TABLE channel_receipt_audit ENABLE ROW LEVEL SECURITY;
-- statement
CREATE POLICY tenant_scope ON channel_receipt_audit USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
-- statement
GRANT SELECT,INSERT ON channel_receipt_audit TO ilien_app;
-- statement
CREATE INDEX channel_receipts_sender ON channel_receipts(tenant_id,connection_id,channel,(normalized->>'sender'),created_at DESC);
-- statement
INSERT INTO schema_migrations(version) VALUES(7);
