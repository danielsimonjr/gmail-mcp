import { describe, it, expect, vi } from "vitest";
import { withRetry, wrap } from "../src/client.js";

describe("withRetry", () => {
  it("returns the result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    expect(await withRetry(fn)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("retries on 429 and succeeds on 2nd attempt", async () => {
    let n = 0;
    const fn = async () => { if (n++ === 0) throw { code: 429, message: "rate" }; return "ok"; };
    expect(await withRetry(fn)).toBe("ok");
  });
  it("retries on 500/503", async () => {
    let n = 0;
    const fn = async () => { if (n++ < 2) throw { code: 503, message: "down" }; return "ok"; };
    expect(await withRetry(fn)).toBe("ok");
  });
  it("does NOT retry on 401", async () => {
    const fn = vi.fn().mockRejectedValue({ code: 401, message: "expired" });
    await expect(withRetry(fn)).rejects.toMatchObject({ code: 401 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("does NOT retry on 403 or 404", async () => {
    const fn403 = vi.fn().mockRejectedValue({ code: 403, message: "forbidden" });
    await expect(withRetry(fn403)).rejects.toMatchObject({ code: 403 });
    expect(fn403).toHaveBeenCalledTimes(1);
  });
  it("throws after max retries (3)", async () => {
    const fn = vi.fn().mockRejectedValue({ code: 429, message: "rate" });
    await expect(withRetry(fn)).rejects.toMatchObject({ code: 429 });
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe("wrap", () => {
  it("returns the function's JSON output on success", async () => {
    const result = await wrap("test", async () => ({ status: "ok", n: 42 }));
    expect(JSON.parse(result)).toEqual({ status: "ok", n: 42 });
  });
  it("wraps thrown errors as {status:error, error:message}", async () => {
    const result = await wrap("test", async () => { throw new Error("boom"); });
    expect(JSON.parse(result)).toEqual({ status: "error", error: "boom" });
  });
  it("includes code when error has one", async () => {
    const result = await wrap("test", async () => { throw { code: 404, message: "not found" }; });
    expect(JSON.parse(result)).toEqual({ status: "error", error: "not found", code: 404 });
  });
});
