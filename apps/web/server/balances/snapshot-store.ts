import "server-only";

import { getSqlExecutor, type SqlExecutor } from "@/server/db/sql";
import type { BalancesCoverage } from "@/shared/balances/types";
import type { ReadHolding } from "./types";
import { MemoryBalanceSnapshotStore } from "./memory-snapshot-store";

export type BalanceSnapshotRow = {
  chainId: number;
  address: `0x${string}`;
  blockNumber: string;
  blockHash: `0x${string}`;
  blockTimestamp: string;
  observedAt: string;
  staleAt: string | null;
  hotUntil: string | null;
  holdings: ReadHolding[];
  coverage: BalancesCoverage;
};

export type BalanceObservation = Omit<BalanceSnapshotRow, "staleAt" | "hotUntil">;

export interface BalanceSnapshotStore {
  get(chainId: number, address: `0x${string}`): Promise<BalanceSnapshotRow | null>;
  putObservation(row: BalanceObservation): Promise<boolean>;
  /** Signals intentionally no-op before the first observation exists. */
  markStale(chainId: number, address: `0x${string}`, at: Date): Promise<void>;
  /** Signals intentionally no-op before the first observation exists. */
  markHot(chainId: number, address: `0x${string}`, until: Date): Promise<void>;
}

type DatabaseRow = Record<string, unknown>;

export class PostgresBalanceSnapshotStore implements BalanceSnapshotStore {
  constructor(private readonly sql: SqlExecutor) {}

  async get(chainId: number, address: `0x${string}`): Promise<BalanceSnapshotRow | null> {
    const result = await this.sql.query(
      "SELECT * FROM balance_snapshots WHERE chain_id=$1 AND address=$2",
      [chainId, address.toLowerCase()],
    );
    return result.rows[0] ? fromDatabaseRow(result.rows[0] as DatabaseRow) : null;
  }

  async putObservation(row: BalanceObservation): Promise<boolean> {
    const result = await this.sql.query(
      `INSERT INTO balance_snapshots
       (chain_id,address,block_number,block_hash,block_timestamp,observed_at,holdings,coverage)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
       ON CONFLICT (chain_id,address) DO UPDATE SET
         block_number=EXCLUDED.block_number,
         block_hash=EXCLUDED.block_hash,
         block_timestamp=EXCLUDED.block_timestamp,
         observed_at=EXCLUDED.observed_at,
         holdings=EXCLUDED.holdings,
         coverage=EXCLUDED.coverage
       WHERE EXCLUDED.block_number >= balance_snapshots.block_number
       RETURNING 1`,
      [row.chainId, row.address.toLowerCase(), row.blockNumber, row.blockHash,
        row.blockTimestamp, row.observedAt, JSON.stringify(row.holdings), JSON.stringify(row.coverage)],
    );
    return result.rowCount === 1;
  }

  async markStale(chainId: number, address: `0x${string}`, at: Date): Promise<void> {
    await this.sql.query(
      "UPDATE balance_snapshots SET stale_at=GREATEST(stale_at,$3) WHERE chain_id=$1 AND address=$2",
      [chainId, address.toLowerCase(), at.toISOString()],
    );
  }

  async markHot(chainId: number, address: `0x${string}`, until: Date): Promise<void> {
    await this.sql.query(
      "UPDATE balance_snapshots SET hot_until=GREATEST(hot_until,$3) WHERE chain_id=$1 AND address=$2",
      [chainId, address.toLowerCase(), until.toISOString()],
    );
  }
}

let runtimeStore: BalanceSnapshotStore | null = null;
export function getBalanceSnapshotStore(
  env: Readonly<Record<string, string | undefined>> = process.env,
): BalanceSnapshotStore {
  if (runtimeStore) return runtimeStore;
  runtimeStore = env.DATABASE_URL?.trim()
    ? new PostgresBalanceSnapshotStore(getSqlExecutor(env))
    : new MemoryBalanceSnapshotStore();
  return runtimeStore;
}

function fromDatabaseRow(row: DatabaseRow): BalanceSnapshotRow {
  return {
    chainId: Number(row.chain_id),
    address: String(row.address).toLowerCase() as `0x${string}`,
    blockNumber: String(row.block_number),
    blockHash: String(row.block_hash).toLowerCase() as `0x${string}`,
    blockTimestamp: String(row.block_timestamp),
    observedAt: new Date(String(row.observed_at)).toISOString(),
    staleAt: row.stale_at === null ? null : new Date(String(row.stale_at)).toISOString(),
    hotUntil: row.hot_until === null ? null : new Date(String(row.hot_until)).toISOString(),
    holdings: parseJson<ReadHolding[]>(row.holdings),
    coverage: parseJson<BalancesCoverage>(row.coverage),
  };
}

function parseJson<T>(value: unknown): T {
  return typeof value === "string" ? JSON.parse(value) as T : value as T;
}
