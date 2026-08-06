import { z } from "zod";

import { BrowserActionSchema, ObservationSchema } from "./browser.js";

export const AgentStatusSchema = z.enum([
  "idle",
  "observing",
  "deciding",
  "executing",
  "completed",
  "failed"
]);

export const BrowserActionResultSchema = z.object({
  ok: z.boolean(),
  value: z.string().optional(),
  error: z.string().optional()
});

export const ActionRecordSchema = z.object({
  step: z.number().int().nonnegative(),
  action: BrowserActionSchema,
  result: BrowserActionResultSchema,
  timestamp: z.string().datetime()
});

export const AgentStateSchema = z.object({
  goal: z.string().min(1),
  currentObservation: ObservationSchema.nullable(),
  actionHistory: z.array(ActionRecordSchema),
  observationHistory: z.array(ObservationSchema),
  stepCount: z.number().int().nonnegative(),
  status: AgentStatusSchema
});

export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export type BrowserActionResult = z.infer<typeof BrowserActionResultSchema>;
export type ActionRecord = z.infer<typeof ActionRecordSchema>;
export type AgentState = z.infer<typeof AgentStateSchema>;
