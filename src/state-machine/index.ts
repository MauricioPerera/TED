// Grafo de la maquina de estados de TED (S6). Modulo PURO: solo datos y
// consultas estructurales. No ejecuta transiciones (eso es src/store con CAS)
// ni verifica credenciales criptograficas (eso es src/attestation / src/crypto).
// Ver knowledge/contracts/ted-state-machine.md para la tabla vinculante.
import type { TicketState, Actor } from "../types.ts";

export interface TransitionEdge {
  from: TicketState;
  to: TicketState;
  actor: Actor;
}

// Las 9 aristas exactas (S6.3/S6.2). No agregar ni quitar ninguna.
export const TRANSITIONS: readonly TransitionEdge[] = [
  { from: "pending", to: "leased", actor: "fulfillment_system" },
  { from: "leased", to: "fulfilled", actor: "orchestrator" },
  { from: "leased", to: "failed", actor: "orchestrator" },
  { from: "leased", to: "pending", actor: "clock" },
  { from: "leased", to: "escalated", actor: "orchestrator" },
  { from: "escalated", to: "pending", actor: "creator" },
  { from: "escalated", to: "cancelled", actor: "creator" },
  { from: "pending", to: "cancelled", actor: "creator" },
  { from: "pending", to: "expired", actor: "clock" },
];

export function isLegalTransition(
  from: TicketState,
  to: TicketState,
  actor: Actor,
): boolean {
  return TRANSITIONS.some(
    (e) => e.from === from && e.to === to && e.actor === actor,
  );
}

export function legalTargets(from: TicketState, actor: Actor): TicketState[] {
  return TRANSITIONS.filter(
    (e) => e.from === from && e.actor === actor,
  ).map((e) => e.to);
}