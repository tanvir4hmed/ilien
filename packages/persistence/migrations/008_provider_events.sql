ALTER TABLE channel_deliveries ADD COLUMN channel_message_id text, ADD COLUMN provider_error jsonb;
-- statement
ALTER TABLE channel_delivery_events ADD COLUMN normalized jsonb NOT NULL DEFAULT '{}'::jsonb;
-- statement
UPDATE channel_delivery_events d SET normalized=jsonb_build_object('providerRequestId',e.original_text::jsonb->>'messageId','channelMessageId',d.provider_message_id,'failure',((e.original_text::jsonb->>'whatsAppWebhookEntry')::jsonb#>'{changes,0,value,statuses,0,errors,0}')) FROM evidence_items e WHERE e.tenant_id=d.tenant_id AND e.id=d.evidence_id AND d.channel='whatsapp' AND e.original_text::jsonb ? 'whatsAppWebhookEntry';
-- statement
UPDATE channel_deliveries d SET channel_message_id=e.normalized->>'channelMessageId',status='blocked',reason='provider_delivery_failed',provider_error=jsonb_build_object('code',e.normalized#>>'{failure,code}','message',e.normalized#>>'{failure,title}') FROM channel_delivery_events e WHERE e.tenant_id=d.tenant_id AND e.normalized->>'providerRequestId'=d.provider_message_id AND e.event_type='failed' AND NOT EXISTS(SELECT 1 FROM channel_delivery_events confirmed WHERE confirmed.tenant_id=e.tenant_id AND confirmed.normalized->>'providerRequestId'=d.provider_message_id AND confirmed.event_type IN ('delivered','read'));
-- statement
CREATE INDEX channel_delivery_events_request ON channel_delivery_events(tenant_id,(normalized->>'providerRequestId'));
-- statement
CREATE INDEX channel_deliveries_channel_id ON channel_deliveries(tenant_id,channel,channel_message_id);
-- statement
INSERT INTO schema_migrations(version) VALUES(8);
