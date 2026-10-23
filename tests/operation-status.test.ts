import { expect, test } from "bun:test";
import { isTerminalOperation } from "../src/operation-status.ts";

test("terminal operation predicate includes completed, failed, stopped, and interrupted", () => {
  for (const status of ["completed", "failed", "stopped", "interrupted"]) {
    expect(isTerminalOperation({ status })).toBe(true);
  }
  for (const status of ["queued", "running", "unknown", undefined]) {
    expect(isTerminalOperation({ status })).toBe(false);
  }
});
