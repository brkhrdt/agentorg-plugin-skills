import { expect, test } from "bun:test";
import { sourceIdentity } from "../src/catalog.ts";

test("catalog source identities preserve Git keys and encode local paths unambiguously", () => {
  expect(sourceIdentity({ kind: "git", gitUrl: "https://github.com/example/a" })).toBe("https://github.com/example/a");
  const a = sourceIdentity({ kind: "local", path: "/tmp/a\u0000b" });
  const b = sourceIdentity({ kind: "local", path: "/tmp/a" });
  expect(a).not.toBe(b);
  expect(a.startsWith("local:")).toBe(true);
});
