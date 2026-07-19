// Ensamblador CCDD especifico de TED (5 slots de S8).
// Ver knowledge/contracts/ted-assembler.md para el algoritmo exacto.
// Modulo PURO: sin I/O, sin red, sin dependencias de otros modulos ni de un tokenizer real.

export interface AssemblerInput {
  instructionsText: string;
  effectsText: string;
  factsText: string;
  triggerPayload: string;
  worldContext?: string;
  maxTokens: number;
  reserveOutput: number;
}

export type SlotId =
  | "ticket_instructions"
  | "effects_manifest"
  | "signed_facts"
  | "trigger_payload"
  | "world_context";

export interface AssembledSlot {
  id: SlotId;
  content: string;
  truncated: boolean;
}

export interface AssembledContext {
  slots: AssembledSlot[];
  prompt: string;
  totalEstimatedTokens: number;
  budgetExceededBeforeTruncation: boolean;
}

// Sufijo literal obligatorio al truncar contenido no vacio (S8 / contrato).
const TRUNCATED_SUFFIX = "\n[truncado]";

// Estimacion de tokens por caracteres: aprox 4 chars/token (sin dependencia de tokenizer real).
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Trunca `content` a `budget` tokens (presupuesto * 4 caracteres).
// - budget <= 0: el contenido queda "" (truncado si el original no estaba vacio).
// - excede el limite en caracteres: se corta al limite y se agrega TRUNCATED_SUFFIX.
function fitToBudget(content: string, budget: number): { content: string; truncated: boolean } {
  if (budget <= 0) {
    return { content: "", truncated: content.length > 0 };
  }
  const charLimit = budget * 4;
  if (content.length <= charLimit) {
    return { content, truncated: false };
  }
  return { content: content.slice(0, charLimit) + TRUNCATED_SUFFIX, truncated: true };
}

const HEADINGS: Record<SlotId, string> = {
  ticket_instructions: "Instructions",
  effects_manifest: "Effects Manifest",
  signed_facts: "Signed Facts",
  trigger_payload: "Trigger",
  world_context: "World Context",
};

export function assembleContext(input: AssemblerInput): AssembledContext {
  // Presupuesto total disponible para los slots tras reservar la salida.
  const availableForSlots = Math.max(0, input.maxTokens - input.reserveOutput);

  // 1) Slots firmados: NUNCA se truncan. Se incluyen siempre completos.
  const signedInstructions = estimateTokens(input.instructionsText);
  const signedEffects = estimateTokens(input.effectsText);
  const signedFacts = estimateTokens(input.factsText);
  const signedTokens = signedInstructions + signedEffects + signedFacts;

  // 2) Resto del presupuesto tras los firmados (puede ser negativo).
  const remainingAfterSigned = availableForSlots - signedTokens;

  // 3) trigger_payload: tope propio 1000 tokens.
  const triggerBudget = Math.min(1000, Math.max(0, remainingAfterSigned));
  const trigger = fitToBudget(input.triggerPayload, triggerBudget);
  const triggerSlot: AssembledSlot = { id: "trigger_payload", content: trigger.content, truncated: trigger.truncated };

  // 4) Resto tras el trigger YA truncado.
  const remainingAfterTrigger = remainingAfterSigned - estimateTokens(triggerSlot.content);

  // 5) world_context: tope propio 6000 tokens. undefined -> slot vacio, sin truncar.
  const worldBudget = Math.min(6000, Math.max(0, remainingAfterTrigger));
  let worldSlot: AssembledSlot;
  if (input.worldContext === undefined) {
    worldSlot = { id: "world_context", content: "", truncated: false };
  } else {
    const fitted = fitToBudget(input.worldContext, worldBudget);
    worldSlot = { id: "world_context", content: fitted.content, truncated: fitted.truncated };
  }

  const slots: AssembledSlot[] = [
    { id: "ticket_instructions", content: input.instructionsText, truncated: false },
    { id: "effects_manifest", content: input.effectsText, truncated: false },
    { id: "signed_facts", content: input.factsText, truncated: false },
    triggerSlot,
    worldSlot,
  ];

  // Prompt en orden de prioridad; los slots vacios no aparecen (ni encabezado ni cuerpo).
  const prompt = slots
    .filter((s) => s.content.length > 0)
    .map((s) => `## ${HEADINGS[s.id]}\n${s.content}`)
    .join("\n\n");

  const totalEstimatedTokens = slots.reduce((acc, s) => acc + estimateTokens(s.content), 0);

  // Informativo: total SIN truncar vs presupuesto disponible.
  const rawTotal =
    estimateTokens(input.instructionsText) +
    estimateTokens(input.effectsText) +
    estimateTokens(input.factsText) +
    estimateTokens(input.triggerPayload) +
    estimateTokens(input.worldContext ?? "");
  const budgetExceededBeforeTruncation = rawTotal > availableForSlots;

  return { slots, prompt, totalEstimatedTokens, budgetExceededBeforeTruncation };
}