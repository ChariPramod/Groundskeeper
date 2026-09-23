import type { Probot } from "probot";

export interface Delivery {
  id: string;
  event: string;
  installationId: number;
  repositoryId?: number;
  payload: Record<string, unknown>;
}

export interface DeliveryStore {
  /** Persist before acknowledging. Return false for an already stored delivery. */
  save(delivery: Delivery): Promise<boolean>;
}

export function createApp(store: DeliveryStore) {
  return (app: Probot) => {
    app.on(
      ["installation", "installation_repositories", "push", "pull_request"],
      async (context) => {
        const payload = context.payload;
        const installationId = "installation" in payload ? payload.installation?.id : undefined;
        if (!installationId) return;
        if (context.name === "push") {
          const push = context.payload as {
            ref: string;
            deleted: boolean;
            repository: { default_branch: string };
          };
          if (push.deleted || push.ref !== `refs/heads/${push.repository.default_branch}`) return;
        }
        // Keep routing metadata only. Source, diffs and credentials do not belong in the inbox.
        const repository = "repository" in payload ? payload.repository : undefined;
        const metadata: Record<string, unknown> = {};
        for (const key of ["action", "before", "after", "ref", "number"] as const) {
          if (key in payload) metadata[key] = payload[key as keyof typeof payload];
        }
        if (repository) metadata.full_name = repository.full_name;
        if (context.name === "pull_request" && "pull_request" in payload) {
          const pull = payload.pull_request;
          metadata.base_sha = pull.base.sha;
          metadata.head_sha = pull.head.sha;
        }
        const created = await store.save({
          id: context.id,
          event: context.name,
          installationId,
          repositoryId: repository?.id,
          payload: metadata,
        });
        context.log.info({ deliveryId: context.id, created }, "Webhook recorded in durable inbox");
      },
    );
  };
}
