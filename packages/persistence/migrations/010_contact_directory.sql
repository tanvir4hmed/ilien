-- A person may have several independently consented endpoints. Sender ownership
-- remains unique within a source; demo role mapping is explicit configuration.
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='channel_bindings'::regclass AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (tenant_id, connection_id, actor_id, channel)'
  LOOP EXECUTE format('ALTER TABLE channel_bindings DROP CONSTRAINT %I',item.conname); END LOOP;
END $$;
-- statement
INSERT INTO schema_migrations(version) VALUES(10);
