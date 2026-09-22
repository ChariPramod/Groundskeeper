ALTER TABLE "WebhookDelivery"
    ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
    ADD COLUMN "lastError" TEXT;
