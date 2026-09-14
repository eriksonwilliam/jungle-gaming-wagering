const UNIQUE_VIOLATION = "23505";

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === UNIQUE_VIOLATION;
}
