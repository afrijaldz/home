import { MemoryBalanceSnapshotStore } from "./memory-snapshot-store";
import { balanceSnapshotStoreContract } from "./snapshot-store.contract";

let store = new MemoryBalanceSnapshotStore();
balanceSnapshotStoreContract({
  name: "Memory",
  createStore: () => store,
  reset: () => { store = new MemoryBalanceSnapshotStore(); },
});
