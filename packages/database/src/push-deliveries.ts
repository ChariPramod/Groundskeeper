import { randomUUID } from "node:crypto";
import type { PrismaClient, WebhookDelivery } from "@prisma/client";

export const PUSH_MAX_ATTEMPTS = 5;

export class PushLeaseLostError extends Error {
  constructor() {
    super("Push delivery lease is no longer owned by this worker");
    this.name = "PushLeaseLostError";
  }
}

/** Claim one available push atomically. Expired claims consume an attempt. */
export async function claimNextPush(database: PrismaClient): Promise<WebhookDelivery | null> {
  return database.$transaction(async (tx) => {
    await tx.$executeRaw`
      WITH exhausted AS (
        SELECT id FROM "WebhookDelivery"
        WHERE event = 'push' AND "processedAt" IS NULL AND "failedAt" IS NULL
          AND "attemptCount" >= ${PUSH_MAX_ATTEMPTS}
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= clock_timestamp())
        LIMIT 100 FOR UPDATE SKIP LOCKED
      )
      UPDATE "WebhookDelivery" AS delivery
      SET "failedAt" = clock_timestamp(), "leaseToken" = NULL, "leaseExpiresAt" = NULL,
          "nextAttemptAt" = NULL, "lastError" = COALESCE("lastError", 'LeaseExpired')
      FROM exhausted WHERE delivery.id = exhausted.id
    `;
    const rows = await tx.$queryRaw<WebhookDelivery[]>`
      WITH candidate AS (
        SELECT id FROM "WebhookDelivery"
        WHERE event = 'push' AND "processedAt" IS NULL AND "failedAt" IS NULL
          AND "attemptCount" < ${PUSH_MAX_ATTEMPTS}
          AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= clock_timestamp())
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= clock_timestamp())
        ORDER BY "receivedAt", id
        LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      UPDATE "WebhookDelivery" AS delivery
      SET "leaseToken" = ${randomUUID()},
          "leaseExpiresAt" = clock_timestamp() + interval '10 minutes',
          "attemptCount" = "attemptCount" + 1, "nextAttemptAt" = NULL
      FROM candidate WHERE delivery.id = candidate.id
      RETURNING delivery.*
    `;
    return rows[0] ?? null;
  });
}

/** A stale worker cannot acknowledge a reclaimed or expired delivery. */
export async function ackPush(database: PrismaClient, id: string, token: string): Promise<boolean> {
  const changed = await database.$executeRaw`
    UPDATE "WebhookDelivery"
    SET "processedAt" = clock_timestamp(), "leaseToken" = NULL, "leaseExpiresAt" = NULL,
        "nextAttemptAt" = NULL, "lastError" = NULL
    WHERE id = ${id} AND event = 'push' AND "leaseToken" = ${token}
      AND "leaseExpiresAt" > clock_timestamp() AND "processedAt" IS NULL AND "failedAt" IS NULL
  `;
  return changed === 1;
}

/** Record only a bounded error category, never exception messages or payloads. */
export async function failPush(
  database: PrismaClient,
  id: string,
  token: string,
  errorName: string,
): Promise<boolean> {
  const category = /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(errorName) ? errorName : "Error";
  const changed = await database.$executeRaw`
    UPDATE "WebhookDelivery"
    SET "lastError" = ${category}, "leaseToken" = NULL, "leaseExpiresAt" = NULL,
        "failedAt" = CASE WHEN "attemptCount" >= ${PUSH_MAX_ATTEMPTS} THEN clock_timestamp() ELSE NULL END,
        "nextAttemptAt" = CASE WHEN "attemptCount" < ${PUSH_MAX_ATTEMPTS}
          THEN clock_timestamp() + interval '5 minutes' ELSE NULL END
    WHERE id = ${id} AND event = 'push' AND "leaseToken" = ${token}
      AND "leaseExpiresAt" > clock_timestamp() AND "processedAt" IS NULL AND "failedAt" IS NULL
  `;
  return changed === 1;
}

/** Explicit operator recovery, scoped to the installation owning the delivery. */
export async function retryFailedPush(
  database: PrismaClient,
  id: string,
  installationId: bigint,
): Promise<boolean> {
  const changed = await database.$executeRaw`
    UPDATE "WebhookDelivery"
    SET "failedAt" = NULL, "leaseToken" = NULL, "leaseExpiresAt" = NULL,
        "nextAttemptAt" = NULL, "lastError" = NULL, "attemptCount" = 0
    WHERE id = ${id} AND "installationId" = ${installationId} AND event = 'push'
      AND "processedAt" IS NULL AND "failedAt" IS NOT NULL
  `;
  return changed === 1;
}
