import { expect, test } from "bun:test";
import { classifyRepositoryLocator } from "../src/source-locator.ts";

test.each([
  ["https://github.com/team/skill", "https"],
  ["http://github.com/team/skill", "https"],
  ["ssh://host/team/skill", "https"],
  ["file:///tmp/skill", "https"],
  ["git@github.com:team/skill", "https"],
  ["//github.com/team/skill", "https"],
  ["~/skills/my skill", "server-path"],
  ["./name:part", "server-path"],
  ["relative skill", "server-path"],
] as const)("classifies %s without path fallback", (source, kind) => {
  expect(classifyRepositoryLocator(source)).toEqual({ source, kind });
});

test("rejects NUL, oversized, empty and unsupported user-home locators", () => {
  for (const source of ["", "~otheruser/skill", "x".repeat(4097), `a${String.fromCharCode(0)}b`])
    expect(() => classifyRepositoryLocator(source)).toThrow();
});
