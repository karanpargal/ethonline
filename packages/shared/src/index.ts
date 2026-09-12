export * from "./chain.js";

export function usdcToBaseUnits(amount: string | number): bigint {
  const [whole, frac = ""] = String(amount).split(".");
  return BigInt(whole || "0") * 1_000_000n + BigInt(frac.padEnd(6, "0").slice(0, 6));
}

export function baseUnitsToUsdc(units: bigint | string): string {
  const u = BigInt(units);
  const whole = u / 1_000_000n;
  const frac = (u % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
