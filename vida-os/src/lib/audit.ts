import { db } from "./db";
import type { CurrentUser } from "./auth";
import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient | typeof db;

/** Append one row to the tamper-proof audit trail. Never update or delete audit rows. */
export async function audit(
  user: Pick<CurrentUser, "id" | "name"> | null,
  action: string,
  entityType: string,
  entityId: string | null,
  summary: string,
  change?: { before?: unknown; after?: unknown },
  tx: Tx = db,
) {
  await tx.auditLog.create({
    data: {
      userId: user?.id ?? null,
      userName: user?.name ?? "System",
      action,
      entityType,
      entityId,
      summary,
      before: change?.before === undefined ? null : JSON.stringify(change.before),
      after: change?.after === undefined ? null : JSON.stringify(change.after),
    },
  });
}
