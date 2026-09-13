import { createCdpActivitySubscription } from "../server/balances/webhook-subscriptions";

const origin = process.env.HOME_WEBHOOK_ORIGIN?.trim();
const addresses = process.argv.slice(2).filter((value): value is `0x${string}` =>
  /^0x[0-9a-fA-F]{40}$/.test(value)
);
if (!origin) throw new Error("HOME_WEBHOOK_ORIGIN is required.");
if (addresses.length === 0) {
  throw new Error("Pass at least one smart-account address after `--`.");
}
if (addresses.length > 100) throw new Error("A CDP activity subscription accepts at most 100 addresses.");

const created = await createCdpActivitySubscription({ origin, addresses });
console.log(`Created CDP webhook subscription ${created.id}.`);
console.log("Set CDP_WEBHOOK_SECRET to the following base64 secret in the same environment:");
console.log(created.secret);
