// STUB -- implementado por el dev delegado bajo knowledge/contracts/ted-constraints.md
import type { ConstraintEvalResult, ConstraintLedgerSnapshot } from "../types.ts";

export class ConstraintCompileError extends Error {}

export interface CompiledConstraint {
  source: string;
}

export function compileConstraint(_source: string): CompiledConstraint {
  throw new Error("not implemented");
}

export function evaluateConstraint(
  _compiled: CompiledConstraint,
  _params: Record<string, unknown>,
  _facts: Record<string, unknown>,
  _ledger: ConstraintLedgerSnapshot,
  _now: string,
): ConstraintEvalResult {
  throw new Error("not implemented");
}

export function evaluateAll(
  _compiled: CompiledConstraint[],
  _params: Record<string, unknown>,
  _facts: Record<string, unknown>,
  _ledger: ConstraintLedgerSnapshot,
  _now: string,
): ConstraintEvalResult {
  throw new Error("not implemented");
}
