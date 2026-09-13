import "server-only";

import { emitServerEvent } from "@/server/observability/log";

export function fireAndForgetBalanceSignal(
  run: () => Promise<void> | undefined,
): void {
  try {
    const pending = run();
    if (pending) void pending.catch(() => observeFailure());
  } catch {
    observeFailure();
  }
}

function observeFailure(): void {
  emitServerEvent("balances-signal", {
    route: "/api/balances",
    code: "BALANCE_SIGNAL_FAILED",
    outcome: "unavailable",
    durationMs: 0,
  });
}
