// STUB -- implementado por el dev delegado bajo knowledge/contracts/ted-state-machine.md
import type { TicketState, Actor } from "../types.ts";

export interface TransitionEdge {
  from: TicketState;
  to: TicketState;
  actor: Actor;
}

export const TRANSITIONS: readonly TransitionEdge[] = [];

export function isLegalTransition(
  _from: TicketState,
  _to: TicketState,
  _actor: Actor,
): boolean {
  throw new Error("not implemented");
}

export function legalTargets(_from: TicketState, _actor: Actor): TicketState[] {
  throw new Error("not implemented");
}
