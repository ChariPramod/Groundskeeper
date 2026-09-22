ALTER TABLE "WebhookDelivery"
  ADD COLUMN "leaseToken" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "failedAt" TIMESTAMP(3);

CREATE INDEX "WebhookDelivery_event_processedAt_failedAt_nextAttemptAt_le_idx"
  ON "WebhookDelivery"("event", "processedAt", "failedAt", "nextAttemptAt", "leaseExpiresAt");
