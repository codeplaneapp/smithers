ALTER TABLE _smithers_integration_deliveries ADD COLUMN status TEXT NOT NULL DEFAULT 'completed';
ALTER TABLE _smithers_integration_deliveries ADD COLUMN claim_token TEXT;
ALTER TABLE _smithers_integration_deliveries ADD COLUMN claim_expires_at_ms INTEGER;
ALTER TABLE _smithers_integration_deliveries ADD COLUMN completed_at_ms INTEGER;
