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

// Las 11 aristas exactas (S6.3/S6.2). No agregar ni quitar ninguna.
//
// CORRECCION (encontrada al disenar el orquestador, Batch 4): S6.3 paso 3 de
// pending->leased puede fallar de TRES formas una vez adquirido el lease --
// hash contra la atestacion, consulta al CRL, vigencia/frescura -- pero el
// texto normativo solo nombra explicitamente el camino de hash invalido
// (-> failed). Las otras dos fallas ocurren igual DESDE "leased" (el CAS ya
// paso) y necesitan arista propia: `leased -> expired` (vigencia vencida,
// mismo actor "clock" que `pending -> expired`: no hace falta credencial
// nueva, es una comparacion de fecha sobre datos ya firmados) y
// `leased -> cancelled` (hit de CRL: la revocacion que autoriza esta arista
// ya la firmo el creador de antemano, mismo actor "creator" que las otras
// dos aristas hacia cancelled). Ver knowledge/contracts/ted-state-machine.md.
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
  { from: "leased", to: "expired", actor: "clock" },
  { from: "leased", to: "cancelled", actor: "creator" },
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