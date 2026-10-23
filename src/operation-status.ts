export function isTerminalOperation(operation: { status?: string }): boolean {
  return operation.status === "completed" || operation.status === "failed" ||
    operation.status === "stopped" || operation.status === "interrupted";
}
