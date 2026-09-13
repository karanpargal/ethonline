import { tool } from "ai";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { erc20Abi } from "viem";
import { allowlist, getDb, invoices, payees, recurring } from "@autocfo/shared/db";
import { syncPolicyFromAllowlist } from "./policy.js";
import {
  baseUnitsToUsdc,
  explorerTxUrl,
  getChainProfile,
  usdcToBaseUnits,
} from "@autocfo/shared";
import {
  classifyPrivyError,
  publicClient,
  requiredEnv,
  sendUsdcFromTreasury,
} from "./privy.js";
import { pettyCash, pettyCashState } from "./pettycash.js";
import { resolvePayee } from "./ens.js";
import { onboardPayeeOnEns } from "./ens-onboard.js";
import { logActivity } from "./activity.js";
import { randomUUID } from "node:crypto";
import { and } from "drizzle-orm";
import { currentOrg } from "./org.js";
import { checkDailyBudget, recordOutflow, spentTodayBaseUnits } from "./spend.js";

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
        .where(eq(invoices.orgId, currentOrg().orgId))
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
      const treasury = currentOrg().treasuryAddress;
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
          orgPerTxCapUsdc: currentOrg().perTxCapUsdc,
          orgDailyBudgetUsdc: currentOrg().dailyCapUsdc,
          spentTodayUsdc: baseUnitsToUsdc(spentTodayBaseUnits()),
          note: "Per-payee caps (see list_payment_authority) are TEE-enforced; the org daily budget is enforced before every send. Over-cap or over-budget payments must be escalated via propose_approval.",
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
      // Payout address comes from ENSv2 when the payee has a name — resolved
      // live through the Universal Resolver on Sepolia, never from our DB.
      let payTo = payee.address as `0x${string}`;
      let resolvedVia: string | null = null;
      if (payee.ensName) {
        const { address } = await resolvePayee(payee.ensName);
        if (!address)
          return { error: `ENS name ${payee.ensName} did not resolve — refusing to pay` };
        payTo = address;
        resolvedVia = payee.ensName;
      }
      const budgetDenial = checkDailyBudget(BigInt(inv.amountBaseUnits));
      if (budgetDenial) {
        logActivity({
          kind: "policy_denied",
          summary: `Payment of ${baseUnitsToUsdc(BigInt(inv.amountBaseUnits))} USDC to ${payee.name} blocked (daily budget)`,
          detail: { signal: "invoice_due", reason: "daily_budget", budgetDenial },
          invoiceId,
        });
        return { denied: true, reason: "daily_budget", hint: budgetDenial };
      }
      try {
        const { hash, mode } = await sendUsdcFromTreasury(
          payTo,
          BigInt(inv.amountBaseUnits),
        );
        recordOutflow(BigInt(inv.amountBaseUnits), "invoice");
        db.update(invoices)
          .set({ status: "paid", txHash: hash })
          .where(eq(invoices.id, invoiceId))
          .run();
        logActivity({
          kind: "invoice_paid",
          summary: `Paid ${baseUnitsToUsdc(BigInt(inv.amountBaseUnits))} USDC to ${payee.name} (${inv.memo})`,
          detail: {
            signal: "invoice_due",
            mode,
            explorer: explorerTxUrl(hash),
            ...(resolvedVia ? { resolvedVia, resolvedAddress: payTo } : {}),
          },
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
      "Escalate an over-threshold or off-allowlist invoice for human sign-off. The payment is queued; only a human, authorizing with the owner quorum key (which you do not hold), can execute it. Provide a justification the approver can act on.",
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
      if (inv.status !== "pending") return { error: `invoice is ${inv.status}` };
      const payee = db.select().from(payees).where(eq(payees.id, inv.payeeId)).get();
      if (!payee) return { error: "payee not found" };
      const amount = baseUnitsToUsdc(BigInt(inv.amountBaseUnits));
      db.update(invoices)
        .set({ status: "awaiting_approval" })
        .where(eq(invoices.id, invoiceId))
        .run();
      logActivity({
        kind: "intent_proposed",
        summary: `Queued ${amount} USDC to ${payee.name} for owner approval`,
        detail: { signal: "over_threshold", justification },
        invoiceId,
      });
      return { queued: true, awaitingHumanApproval: true };
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
      const budgetDenial = checkDailyBudget(usdcToBaseUnits(amountUsdc));
      if (budgetDenial) return { denied: true, reason: "daily_budget", hint: budgetDenial };
      try {
        const { hash } = await sendUsdcFromTreasury(
          client.address,
          usdcToBaseUnits(amountUsdc),
        );
        recordOutflow(usdcToBaseUnits(amountUsdc), "topup");
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
      const budgetDenial = checkDailyBudget(BigInt(inv.amountBaseUnits));
      if (budgetDenial) return { denied: true, reason: "daily_budget", hint: budgetDenial };
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
        recordOutflow(BigInt(inv.amountBaseUnits), "cross_chain");
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

  grant_payment_authority: tool({
    description:
      "Add an address to the Privy policy allowlist with a per-payment cap, or update its cap. This REWRITES THE ON-CHAIN-ENFORCED MANDATE and is signed with the owner's admin key, so it is strictly human-gated: you may ONLY call it after the human has, in THIS conversation, explicitly confirmed BOTH the address and the cap amount. If they haven't, ask them first instead of calling this.",
    inputSchema: z.object({
      address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
      label: z.string().describe("short payee label for the policy rule"),
      capUsdc: z.string().describe("max USDC per payment the agent may send them"),
      humanConfirmed: z
        .boolean()
        .describe("true ONLY if the human explicitly approved this address AND cap in this conversation"),
    }),
    execute: async ({ address, label, capUsdc, humanConfirmed }) => {
      if (!humanConfirmed)
        return { error: "not confirmed — ask the human to approve the address and cap first" };
      const org = currentOrg();
      if (usdcToBaseUnits(capUsdc) > usdcToBaseUnits(org.perTxCapUsdc))
        return {
          error: `cap $${capUsdc} exceeds this organization's per-transaction limit of $${org.perTxCapUsdc} — tell the human the maximum allowed and ask them to pick a cap within it`,
        };
      const db = getDb();
      const existing = db
        .select()
        .from(allowlist)
        .where(and(eq(allowlist.address, address), eq(allowlist.orgId, currentOrg().orgId)))
        .get();
      if (existing) {
        db.update(allowlist)
          .set({ capBaseUnits: usdcToBaseUnits(capUsdc).toString(), label })
          .where(and(eq(allowlist.address, address), eq(allowlist.orgId, currentOrg().orgId)))
          .run();
      } else {
        db.insert(allowlist)
          .values({
            address,
            orgId: currentOrg().orgId,
            label,
            capBaseUnits: usdcToBaseUnits(capUsdc).toString(),
            createdAt: new Date(),
          })
          .run();
      }
      try {
        const { rules } = await syncPolicyFromAllowlist();
        logActivity({
          kind: "agent_note",
          summary: `Payment authority ${existing ? "updated" : "granted"}: ${label} (${address.slice(0, 8)}…) cap $${capUsdc}/payment — human-confirmed, policy resynced (${rules} rules)`,
          detail: { signal: "human_confirmation", address, capUsdc },
        });
        return { granted: true, address, capUsdc, policyRules: rules };
      } catch (err) {
        return { error: `policy sync failed: ${String(err instanceof Error ? err.message : err)}` };
      }
    },
  }),

  list_payment_authority: tool({
    description: "List which addresses the agent is allowed to pay and each one's per-payment cap.",
    inputSchema: z.object({}),
    execute: async () => {
      return getDb()
        .select()
        .from(allowlist)
        .where(eq(allowlist.orgId, currentOrg().orgId))
        .all()
        .map((r) => ({
          address: r.address,
          label: r.label,
          capUsdc: baseUnitsToUsdc(BigInt(r.capBaseUnits)),
        }));
    },
  }),

  create_recurring_payment: tool({
    description:
      "Set up a standing payment schedule (payroll, subscription): every interval, an invoice is generated automatically and flows through the normal mandate — within-cap payments auto-pay, over-cap ones escalate for human approval. The payee must already exist (onboard_payee first if not).",
    inputSchema: z.object({
      payeeId: z.string().describe("existing payee id (from list_invoices or after onboard_payee)"),
      amountUsdc: z.string().describe("amount per payment, e.g. '1000'"),
      memo: z.string().describe("e.g. 'Monthly retainer'"),
      intervalDays: z.number().int().min(1).max(365).default(30),
      startNow: z
        .boolean()
        .default(true)
        .describe("true: first invoice is due immediately; false: first due after one interval"),
    }),
    execute: async ({ payeeId, amountUsdc, memo, intervalDays, startNow }) => {
      const db = getDb();
      const payee = db.select().from(payees).where(eq(payees.id, payeeId)).get();
      if (!payee) return { error: `payee ${payeeId} not found — onboard them first` };
      const nextDue = startNow
        ? new Date()
        : new Date(Date.now() + intervalDays * 86_400_000);
      const id = `REC-${randomUUID().slice(0, 8)}`;
      db.insert(recurring)
        .values({
          id,
          orgId: currentOrg().orgId,
          payeeId,
          amountBaseUnits: usdcToBaseUnits(amountUsdc).toString(),
          memo,
          intervalDays,
          nextDue,
          active: true,
          createdAt: new Date(),
        })
        .run();
      logActivity({
        kind: "agent_note",
        summary: `Created recurring schedule: ${amountUsdc} USDC to ${payee.name} every ${intervalDays} days (${memo})`,
        detail: { signal: "recurring_created", scheduleId: id },
      });
      const capNote =
        usdcToBaseUnits(amountUsdc) > usdcToBaseUnits(process.env.PER_TX_CAP_USDC ?? "10")
          ? "NOTE: amount exceeds the per-tx mandate cap — every generated invoice will require human approval."
          : undefined;
      return { scheduleId: id, nextDue: nextDue.toISOString(), capNote };
    },
  }),

  onboard_payee: tool({
    description:
      "Onboard a new payee by giving them an on-chain identity: registers <label>.<company>.eth in the company's ENSv2 registry (Sepolia) with their payout address and preferred chain as resolver records, then saves them locally. Uses your bounded ENS key (ROLE_REGISTRAR only — you cannot modify the parent name). NOTE: paying them also requires a human to add the address to the Privy policy allowlist.",
    inputSchema: z.object({
      label: z
        .string()
        .regex(/^[a-z0-9-]{3,20}$/)
        .describe("subname label, e.g. 'acme' → acme.autocfo.eth"),
      displayName: z.string(),
      payoutAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
      preferredChain: z.enum(["arc-testnet", "base-sepolia"]).default("arc-testnet"),
    }),
    execute: async ({ label, displayName, payoutAddress, preferredChain }) => {
      try {
        const { fullName, txHashes } = await onboardPayeeOnEns(
          label,
          payoutAddress as `0x${string}`,
          preferredChain,
        );
        getDb()
          .insert(payees)
          .values({
            id: `PAYEE-${randomUUID().slice(0, 8)}`,
            orgId: currentOrg().orgId,
            name: displayName,
            address: payoutAddress,
            ensName: fullName,
            preferredChain,
            allowlisted: false,
            createdAt: new Date(),
          })
          .run();
        logActivity({
          kind: "payee_onboarded",
          summary: `Onboarded ${displayName} as ${fullName} (ENSv2, agent's bounded key)`,
          detail: {
            signal: "payee_onboarding",
            ensName: fullName,
            sepoliaTxs: txHashes,
            note: "address NOT yet on the Privy allowlist — human action required",
          },
        });
        return { onboarded: true, ensName: fullName, txHashes };
      } catch (err) {
        return { error: String(err instanceof Error ? err.message : err) };
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
      const inv = db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
      if (!inv) return { error: `invoice ${invoiceId} not found — check the exact id` };
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
