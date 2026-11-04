import type { PoolClient } from "pg";

export async function audit(
  client: PoolClient,
  actorId: string | null,
  action: string,
  entityType: string,
  entityId: string | null,
  details: Record<string, unknown>
) {
  await client.query(
    "INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5::jsonb)",
    [actorId, action, entityType, entityId, JSON.stringify(details)]
  );
}
