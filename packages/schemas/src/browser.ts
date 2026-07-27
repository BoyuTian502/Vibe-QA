import { z } from "zod";

export const ElementInformationSchema = z.object({
  id: z.string().min(1),
  tagName: z.string().min(1),
  role: z.string().nullable(),
  accessibleName: z.string().nullable(),
  text: z.string(),
  visible: z.boolean(),
  enabled: z.boolean(),
  editable: z.boolean(),
  selector: z.string().min(1)
});

export const ObservationSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().datetime(),
  url: z.string().url(),
  title: z.string(),
  elements: z.array(ElementInformationSchema),
  textSample: z.string(),
  screenshotPath: z.string().nullable()
});

export const BrowserActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("goto"),
    url: z.string().url()
  }),
  z.object({
    type: z.literal("click"),
    selector: z.string().min(1)
  }),
  z.object({
    type: z.literal("type"),
    selector: z.string().min(1),
    value: z.string()
  }),
  z.object({
    type: z.literal("getText"),
    selector: z.string().min(1)
  }),
  z.object({
    type: z.literal("screenshot"),
    path: z.string().min(1).optional()
  }),
  z.object({
    type: z.literal("getCurrentUrl")
  })
]);

export type ElementInformation = z.infer<typeof ElementInformationSchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type BrowserAction = z.infer<typeof BrowserActionSchema>;
