import { tool } from "ai";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { erc20Abi } from "viem";
import { getDb, invoices, payees } from "@autocfo/shared/db";
import {
  baseUnitsToUsdc,
  explorerTxUrl,
  getChainProfile,
} from "@autocfo/shared";
import {
  classifyPrivyError,
  proposeTransferIntent,
  publicClient,
  requiredEnv,
  sendUsdcFromTreasury,
} from "./privy.js";
import { logActivity } from "./activity.js";

export const cfoTools = {
  list_invoices: tool({
    description:
      "List invoices with payee details. Use status 'pending' to find bills to evaluate.",
    inputSchema: z.object({
      status: z
        .enum(["pending", "paid", "awaiting_approval", "flagged", "rejected", "all"])
        .default("pending"),
    }),
    execute: async ({ status }) => {
      const db = getDb();
      const rows = db
        .select({
          id: invoices.id,
          amountBaseUnits: invoices.amountBaseUnits,
          memo: invoices.memo,
          dueDate: invoices.dueDate,
          status: invoices.status,
          payeeName: payees.name,
          payeeAddress: payees.address,
          payeeAllowlisted: payees.allowlisted,
          payeePreferredChain: payees.preferredChain,
        })
        .from(invoices)
        .innerJoin(payees, eq(invoices.payeeId, payees.id))
        .all();
      const filtered =
        status === "all" ? rows : rows.filter((r) => r.status === status);
      return filtered.map((r) => ({
        ...r,
        amountUsdc: baseUnitsToUsdc(BigInt(r.amountBaseUnits)),
        dueDate: r.dueDate.toISOString(),
        overdue: r.dueDate.getTime() <= Date.now(),
      }));
    },
  }),

  get_treasury_state: tool({
    description:
      "Current treasury USDC balance on-chain plus burn-rate context. Check before paying.",
    inputSchema: z.object({}),
    execute: async () => {
      const { usdc } = getChainProfile();
      const treasury = requiredEnv("PRIVY_TREASURY_ADDRESS") as `0x${string}`;
      const balance = await publicClient().readContract({
        address: usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [treasury],
      });
      return {
        treasuryAddress: treasury,
        usdcBalance: baseUnitsToUsdc(balance),
        note: "USDC is native gas on Arc; this ERC-20 balance IS the full treasury balance (single representation).",
      };
    },
  }),

  pay_invoice: tool({
    description:
      "Pay a pending invoice from the treasury. Privy's policy engine enforces the mandate (payee allowlist, per-tx cap, rolling daily budget) at signing time — if the policy denies, this returns denied:true and you should escalate with propose_approval instead.",
    inputSchema: z.object({ invoiceId: z.string() }),
    execute: async ({ invoiceId }) => {
      const db = getDb();
      const inv = db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
      if (!inv) return { error: "invoice not found" };
      if (inv.status !== "pending") return { error: `invoice is ${inv.status}` };
      const payee = db.select().from(payees).where(eq(payees.id, inv.payeeId)).get();
      if (!payee) return { error: "payee not found" };
      try {
        const { hash, mode } = await sendUsdcFromTreasury(
          payee.address as `0x${string}`,
          BigInt(inv.amountBaseUnits),
        );
        db.update(invoices)
          .set({ status: "paid", txHash: hash })
          .where(eq(invoices.id, invoiceId))
          .run();
        logActivity({
          kind: "invoice_paid",
          summary: `Paid ${baseUnitsToUsdc(BigInt(inv.amountBaseUnits))} USDC to ${payee.name} (${inv.memo})`,
          detail: { signal: "invoice_due", mode, explorer: explorerTxUrl(hash) },
          invoiceId,
          txHash: hash,
        });
        return { paid: true, txHash: hash, explorer: explorerTxUrl(hash) };
      } catch (err) {
        const reason = classifyPrivyError(err);
        logActivity({
          kind: "policy_denied",
          summary: `Payment of ${baseUnitsToUsdc(BigInt(inv.amountBaseUnits))} USDC to ${payee.name} blocked (${reason})`,
          detail: { signal: "invoice_due", reason, error: String(err) },
          invoiceId,
        });
        return {
          denied: true,
          reason,
          hint:
            reason === "policy_denied"
              ? "Outside your mandate — escalate via propose_approval."
              : "Transaction would fail on-chain; investigate before retrying.",
        };
      }
    },
  }),

  propose_approval: tool({
    description:
      "Escalate an over-threshold or off-allowlist invoice: proposes a Privy transfer intent that a human approves with MFA in the Privy Dashboard. Execution happens automatically once the quorum approves.",
    inputSchema: z.object({
      invoiceId: z.string(),
      justification: z
        .string()
        .describe("Why this payment should be approved — shown to the human approver."),
    }),
    execute: async ({ invoiceId, justification }) => {
      const db = getDb();
      const inv = db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
      if (!inv) return { error: "invoice not found" };
      const payee = db.select().from(payees).where(eq(payees.id, inv.payeeId)).get();
      if (!payee) return { error: "payee not found" };
      const amount = baseUnitsToUsdc(BigInt(inv.amountBaseUnits));
      const { intentId, status } = await proposeTransferIntent(
        payee.address as `0x${string}`,
        amount,
      );
      db.update(invoices)
        .set({ status: "awaiting_approval", privyIntentId: intentId })
        .where(eq(invoices.id, invoiceId))
        .run();
      logActivity({
        kind: "intent_proposed",
        summary: `Proposed ${amount} USDC to ${payee.name} for human approval`,
        detail: { signal: "over_threshold", justification, intentId, status },
        invoiceId,
      });
      return { intentId, status, awaitingHumanApproval: true };
    },
  }),

  flag_anomaly: tool({
    description:
      "Flag a suspicious invoice (duplicate, unusual amount, unknown payee pattern) instead of paying it.",
    inputSchema: z.object({
      invoiceId: z.string(),
      reason: z.string(),
    }),
    execute: async ({ invoiceId, reason }) => {
      const db = getDb();
      db.update(invoices)
        .set({ status: "flagged" })
        .where(eq(invoices.id, invoiceId))
        .run();
      logActivity({
        kind: "anomaly_flagged",
        summary: `Flagged invoice ${invoiceId}: ${reason}`,
        detail: { signal: "anomaly", reason },
        invoiceId,
      });
      return { flagged: true };
    },
  }),
};
