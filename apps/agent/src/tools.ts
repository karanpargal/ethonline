import { tool } from "ai";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { erc20Abi } from "viem";
import { getDb, invoices, payees } from "@autocfo/shared/db";
import {
  baseUnitsToUsdc,
  explorerTxUrl,
  getChainProfile,
  usdcToBaseUnits,
} from "@autocfo/shared";
import {
  classifyPrivyError,
  proposeTransferIntent,
  publicClient,
  requiredEnv,
  sendUsdcFromTreasury,
} from "./privy.js";
import { pettyCash, pettyCashState } from "./pettycash.js";
import { logActivity } from "./activity.js";

// Maps our payee preferred-chain slugs to Gateway chain names.
const GATEWAY_CHAINS: Record<string, "arcTestnet" | "baseSepolia"> = {
  "arc-testnet": "arcTestnet",
  "base-sepolia": "baseSepolia",
};

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
        mandate: {
          perTxCapUsdc: process.env.PER_TX_CAP_USDC ?? "50",
          dailyBudgetUsdc: process.env.DAILY_BUDGET_USDC ?? "200",
          note: "Payments over the per-tx cap or to non-allowlisted payees WILL be policy-denied — escalate those via propose_approval directly instead of attempting.",
        },
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

  get_petty_cash_state: tool({
    description:
      "Petty-cash wallet balances: on-chain USDC plus the Circle Gateway balance used for gasless x402 micropayments. Check before buying data or topping up.",
    inputSchema: z.object({}),
    execute: async () => {
      const state = await pettyCashState();
      return JSON.parse(
        JSON.stringify(state, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      );
    },
  }),

  top_up_petty_cash: tool({
    description:
      "Two-step top-up of the petty-cash lane: transfers USDC from the treasury to the petty-cash wallet (policy applies — the petty-cash address must be on the allowlist), then deposits it into Circle Gateway for gasless spending. Keep amounts small; that is the point of petty cash.",
    inputSchema: z.object({
      amountUsdc: z.string().describe("Decimal USDC amount, e.g. '2.50'"),
    }),
    execute: async ({ amountUsdc }) => {
      const client = pettyCash();
      try {
        const { hash } = await sendUsdcFromTreasury(
          client.address,
          usdcToBaseUnits(amountUsdc),
        );
        await publicClient().waitForTransactionReceipt({
          hash: hash as `0x${string}`,
        });
        const deposit = await client.deposit(amountUsdc);
        logActivity({
          kind: "petty_cash_topup",
          summary: `Topped up petty cash with ${amountUsdc} USDC and deposited into Gateway`,
          detail: { signal: "petty_cash_low", explorer: explorerTxUrl(hash), deposit: String((deposit as { depositTxHash?: string }).depositTxHash ?? "") },
          txHash: hash,
        });
        return { toppedUp: true, treasuryTx: hash };
      } catch (err) {
        const reason = classifyPrivyError(err);
        logActivity({
          kind: "policy_denied",
          summary: `Petty-cash top-up of ${amountUsdc} USDC blocked (${reason})`,
          detail: { signal: "petty_cash_low", reason, error: String(err) },
        });
        return { denied: true, reason };
      }
    },
  }),

  x402_fetch: tool({
    description:
      "Buy pay-per-call data over the x402 protocol using the petty-cash Gateway balance (gasless USDC nanopayment, batched settlement). Use when the dashboard or your analysis needs external market data.",
    inputSchema: z.object({
      url: z
        .string()
        .describe("The x402-priced endpoint URL")
        .default("http://localhost:3002/api/market-brief"),
    }),
    execute: async ({ url }) => {
      try {
        const { data } = await pettyCash().pay(url);
        logActivity({
          kind: "x402_purchase",
          summary: `Bought x402 data from ${new URL(url).host}${new URL(url).pathname}`,
          detail: { signal: "data_needed", url },
        });
        return { data };
      } catch (err) {
        return { error: String(err), hint: "Petty cash Gateway balance may be empty — top up first." };
      }
    },
  }),

  payout_cross_chain: tool({
    description:
      "Pay an invoice to a payee whose preferred chain is NOT Arc: sends USDC from the petty-cash Gateway unified balance, minted on the payee's chain in under a second. Use pay_invoice instead for Arc-native payees.",
    inputSchema: z.object({ invoiceId: z.string() }),
    execute: async ({ invoiceId }) => {
      const db = getDb();
      const inv = db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
      if (!inv) return { error: "invoice not found" };
      if (inv.status !== "pending") return { error: `invoice is ${inv.status}` };
      const payee = db.select().from(payees).where(eq(payees.id, inv.payeeId)).get();
      if (!payee) return { error: "payee not found" };
      const chain = GATEWAY_CHAINS[payee.preferredChain];
      if (!chain) return { error: `unsupported payout chain ${payee.preferredChain}` };
      const amount = baseUnitsToUsdc(BigInt(inv.amountBaseUnits));
      try {
        const result = await pettyCash().withdraw(amount, {
          chain,
          recipient: payee.address as `0x${string}`,
        });
        const txHash = String(
          (result as { transferTxHash?: string; txHash?: string }).transferTxHash ??
            (result as { txHash?: string }).txHash ??
            "",
        );
        db.update(invoices)
          .set({ status: "paid", txHash })
          .where(eq(invoices.id, invoiceId))
          .run();
        logActivity({
          kind: "cross_chain_payout",
          summary: `Paid ${amount} USDC to ${payee.name} on ${payee.preferredChain} via Gateway`,
          detail: { signal: "invoice_due", chain: payee.preferredChain },
          invoiceId,
          txHash: txHash || undefined,
        });
        return { paid: true, chain: payee.preferredChain, txHash };
      } catch (err) {
        return { error: String(err), hint: "Gateway balance may be too low — top up petty cash." };
      }
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
