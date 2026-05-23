import { describe, it, expect } from "vitest";
import { TOOLS, HANDLERS } from "../src/tools.js";

describe("TOOLS ↔ HANDLERS symmetry", () => {
  it("every tool name has a handler", () => {
    expect(Object.keys(HANDLERS).sort()).toEqual(TOOLS.map(t => t.name).sort());
  });
});
