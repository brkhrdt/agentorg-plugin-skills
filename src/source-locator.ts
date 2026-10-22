export type RepositoryLocatorKind = "https" | "server-path";

/** Pure transport/path classifier. URL-looking inputs never degrade into filesystem paths. */
export function classifyRepositoryLocator(value: unknown): { kind: RepositoryLocatorKind; source: string } {
  if (typeof value !== "string" || !value || value.length > 4096 || value.includes(String.fromCharCode(0)))
    throw Object.assign(new Error("Source must be a nonempty locator of at most 4,096 characters"), { code: "INVALID_PARAMS" });
  if (value.startsWith("~") && value !== "~" && !value.startsWith("~/"))
    throw Object.assign(new Error("~otheruser paths are unsupported"), { code: "INVALID_PARAMS" });
  const transportLike = /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//") || /^[^/\s]+@[^:\s]+:/.test(value);
  return { kind: transportLike ? "https" : "server-path", source: value };
}
