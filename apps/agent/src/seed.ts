import "./env.js";
import { activity, getDb, invoices, payees } from "@autocfo/shared/db";
import { usdcToBaseUnits } from "@autocfo/shared";

// Short, distinct ids — long UUIDs get garbled by LLM tool calls.
let payeeSeq = 0;
let invoiceSeq = 0;
const payeeId = () => `PAYEE-${++payeeSeq}`;
const invoiceId = () => `INV-${1000 + ++invoiceSeq}`;

// Demo data: two allowlisted vendors, one contractor on another chain,
// one big invoice (escalation beat), one duplicate (anomaly beat).
// Pass --reset to wipe existing rows first (clean demo takes).
const db = getDb();

if (process.argv.includes("--reset")) {
  db.delete(activity).run();
  db.delete(invoices).run();
  db.delete(payees).run();
  console.log("Cleared existing payees, invoices, and activity.");
}

const now = Date.now();
const day = 24 * 60 * 60 * 1000;

const vendorIds = {
  hosting: payeeId(),
  dataApi: payeeId(),
  contractor: payeeId(),
};

db.insert(payees)
  .values([
    {
      id: vendorIds.hosting,
      name: "NimbusHost Cloud",
      ensName: process.env.ENS_USER_REGISTRY ? "nimbushost.autocfo.eth" : null,
      address: process.env.SEED_PAYEE_1 ?? "0x1111111111111111111111111111111111111111",
      preferredChain: "arc-testnet",
      allowlisted: true,
      createdAt: new Date(now - 30 * day),
    },
    {
      id: vendorIds.dataApi,
      name: "MarketFeed Data Inc",
      ensName: process.env.ENS_USER_REGISTRY ? "marketfeed.autocfo.eth" : null,
      address: process.env.SEED_PAYEE_2 ?? "0x2222222222222222222222222222222222222222",
      preferredChain: "arc-testnet",
      allowlisted: true,
      createdAt: new Date(now - 20 * day),
    },
    {
      id: vendorIds.contractor,
      name: "Dana Contractor",
      ensName: process.env.ENS_USER_REGISTRY ? "dana.autocfo.eth" : null,
      address: process.env.SEED_PAYEE_3 ?? "0x3333333333333333333333333333333333333333",
      preferredChain: "base-sepolia",
      allowlisted: true,
      createdAt: new Date(now - 10 * day),
    },
  ])
  .run();

db.insert(invoices)
  .values([
    {
      id: invoiceId(),
      payeeId: vendorIds.hosting,
      amountBaseUnits: usdcToBaseUnits("5").toString(),
      memo: "September cloud hosting",
      dueDate: new Date(now - day),
      status: "pending",
      createdAt: new Date(now - 5 * day),
    },
    {
      id: invoiceId(),
      payeeId: vendorIds.dataApi,
      // Deliberately over the $10 per-tx cap → the escalation demo beat.
      amountBaseUnits: usdcToBaseUnits("12").toString(),
      memo: "Enterprise data license renewal (annual)",
      dueDate: new Date(now),
      status: "pending",
      createdAt: new Date(now - 2 * day),
    },
    {
      id: invoiceId(),
      payeeId: vendorIds.hosting,
      amountBaseUnits: usdcToBaseUnits("5").toString(),
      memo: "September cloud hosting",
      dueDate: new Date(now - day + 60_000),
      status: "pending",
      createdAt: new Date(now - day),
    },
    {
      id: invoiceId(),
      payeeId: vendorIds.contractor,
      amountBaseUnits: usdcToBaseUnits("2").toString(),
      memo: "Design sprint milestone 2",
      dueDate: new Date(now + day),
      status: "pending",
      createdAt: new Date(now - 3 * day),
    },
  ])
  .run();

console.log("Seeded 3 payees and 4 invoices (incl. one over-threshold, one duplicate).");
