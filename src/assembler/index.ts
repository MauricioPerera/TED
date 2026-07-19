// STUB -- implementado por el dev delegado bajo knowledge/contracts/ted-assembler.md

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

export function assembleContext(_input: AssemblerInput): AssembledContext {
  throw new Error("not implemented");
}
