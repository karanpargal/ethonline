import { randomUUID } from "node:crypto";
import { getDb, invoices, payees } from "@autocfo/shared/db";
import { usdcToBaseUnits } from "@autocfo/shared";

// Demo data: two allowlisted vendors, one contractor on another chain,
// one big invoice (escalation beat), one duplicate (anomaly beat).
const db = getDb();

const now = Date.now();
const day = 24 * 60 * 60 * 1000;

const vendorIds = {
  hosting: randomUUID(),
  dataApi: randomUUID(),
  contractor: randomUUID(),
};

db.insert(payees)
  .values([
    {
      id: vendorIds.hosting,
      name: "NimbusHost Cloud",
      address: process.env.SEED_PAYEE_1 ?? "0x1111111111111111111111111111111111111111",
      preferredChain: "arc-testnet",
      allowlisted: true,
      createdAt: new Date(now - 30 * day),
    },
    {
      id: vendorIds.dataApi,
      name: "MarketFeed Data Inc",
      address: process.env.SEED_PAYEE_2 ?? "0x2222222222222222222222222222222222222222",
      preferredChain: "arc-testnet",
      allowlisted: true,
      createdAt: new Date(now - 20 * day),
    },
    {
      id: vendorIds.contractor,
      name: "Dana Contractor",
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
      id: randomUUID(),
      payeeId: vendorIds.hosting,
      amountBaseUnits: usdcToBaseUnits("5").toString(),
      memo: "September cloud hosting",
      dueDate: new Date(now - day),
      status: "pending",
      createdAt: new Date(now - 5 * day),
    },
    {
      id: randomUUID(),
      payeeId: vendorIds.dataApi,
      amountBaseUnits: usdcToBaseUnits("500").toString(),
      memo: "Enterprise data license renewal (annual)",
      dueDate: new Date(now),
      status: "pending",
      createdAt: new Date(now - 2 * day),
    },
    {
      id: randomUUID(),
      payeeId: vendorIds.hosting,
      amountBaseUnits: usdcToBaseUnits("5").toString(),
      memo: "September cloud hosting",
      dueDate: new Date(now - day + 60_000),
      status: "pending",
      createdAt: new Date(now - day),
    },
    {
      id: randomUUID(),
      payeeId: vendorIds.contractor,
      amountBaseUnits: usdcToBaseUnits("12").toString(),
      memo: "Design sprint milestone 2",
      dueDate: new Date(now + day),
      status: "pending",
      createdAt: new Date(now - 3 * day),
    },
  ])
  .run();

console.log("Seeded 3 payees and 4 invoices (incl. one over-threshold, one duplicate).");
