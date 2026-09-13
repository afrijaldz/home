-- Retire the pre-#294 Coinbase hosted-session payment method. This migration is
-- idempotent: after the first pass every matching row is terminal.
UPDATE funding_orders
SET state = 'failed',
    provider_status = 'HOSTED_SESSION_RETIRED',
    instructions = NULL,
    version = version + 1,
    updated_at = now()
WHERE provider_id = 'coinbase'
  AND payment_method = 'hosted'
  AND state = 'reserving';

UPDATE funding_orders
SET state = 'expired',
    provider_status = 'HOSTED_SESSION_RETIRED',
    instructions = NULL,
    version = version + 1,
    updated_at = now()
WHERE provider_id = 'coinbase'
  AND payment_method = 'hosted'
  AND state NOT IN (
    'reserving',
    'dispatch-ambiguous',
    'received',
    'expired',
    'cancelled',
    'failed',
    'refunded'
  );
