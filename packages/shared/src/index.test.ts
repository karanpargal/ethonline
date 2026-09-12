import { test } from "node:test";
import assert from "node:assert/strict";
import { baseUnitsToUsdc, usdcToBaseUnits } from "./index.js";

test("usdcToBaseUnits handles whole numbers", () => {
  assert.equal(usdcToBaseUnits("5"), 5_000_000n);
  assert.equal(usdcToBaseUnits("0"), 0n);
  assert.equal(usdcToBaseUnits("1000000"), 1_000_000_000_000n);
});

test("usdcToBaseUnits handles decimals", () => {
  assert.equal(usdcToBaseUnits("0.01"), 10_000n);
  assert.equal(usdcToBaseUnits("0.000001"), 1n);
  assert.equal(usdcToBaseUnits("2.50"), 2_500_000n);
  assert.equal(usdcToBaseUnits("1.234567"), 1_234_567n);
});

test("usdcToBaseUnits truncates beyond 6 decimals (no rounding up)", () => {
  assert.equal(usdcToBaseUnits("0.0000019"), 1n);
});

test("baseUnitsToUsdc round-trips", () => {
  for (const v of ["5", "0.01", "2.5", "1.234567", "0.000001", "12345.6789"]) {
    const normalized = baseUnitsToUsdc(usdcToBaseUnits(v));
    assert.equal(usdcToBaseUnits(normalized), usdcToBaseUnits(v), v);
  }
});

test("baseUnitsToUsdc trims trailing zeros", () => {
  assert.equal(baseUnitsToUsdc(2_500_000n), "2.5");
  assert.equal(baseUnitsToUsdc(5_000_000n), "5");
  assert.equal(baseUnitsToUsdc(1n), "0.000001");
});
