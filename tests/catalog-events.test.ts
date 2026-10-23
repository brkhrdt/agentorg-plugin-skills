import { expect, test } from "bun:test";
import { notifyAfterCatalogCommit } from "../src/catalog.ts";

test("successful catalog notification emits once without reporting an error", () => {
  let emitted = 0, reported = 0;
  notifyAfterCatalogCommit(() => { emitted++; }, () => { reported++; });
  expect(emitted).toBe(1);
  expect(reported).toBe(0);
});

test("failed catalog notification reports its error without changing the committed outcome", () => {
  const failure = new Error("event delivery failed");
  const diagnostics: unknown[] = [];
  expect(() => notifyAfterCatalogCommit(() => { throw failure; }, error => { diagnostics.push(error); })).not.toThrow();
  expect(diagnostics).toEqual([failure]);
});

test("failed diagnostic delivery cannot turn a committed catalog mutation into a failure", () => {
  const committed = { name: "registered-skill", status: "retired" };
  const mutate = () => {
    notifyAfterCatalogCommit(() => { throw new Error("event delivery failed"); }, () => { throw new Error("diagnostic delivery failed"); });
    return committed;
  };
  expect(mutate()).toBe(committed);
});
