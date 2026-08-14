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
  selector: z.string().min(1),
  href: z.string().url().nullable().optional(),
  inputType: z.string().min(1).nullable().optional()
});

export const ConsoleErrorSchema = z.object({
  type: z.enum(["console", "pageerror"]),
  text: z.string(),
  location: z
    .object({
      url: z.string(),
      lineNumber: z.number().int().nonnegative(),
      columnNumber: z.number().int().nonnegative()
    })
    .nullable()
});

export const PageMetadataSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  viewport: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive()
    })
    .nullable()
});

export const AccessibilityHeadingSchema = z.object({
  level: z.number().int().positive(),
  text: z.string()
});

export const AccessibilityLandmarkSchema = z.object({
  role: z.string(),
  name: z.string().nullable()
});

export const AccessibilityInfoSchema = z.object({
  headings: z.array(AccessibilityHeadingSchema),
  landmarks: z.array(AccessibilityLandmarkSchema),
  interactiveElementCount: z.number().int().nonnegative()
});

export const ObservationSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().datetime(),
  url: z.string().url(),
  title: z.string(),
  metadata: PageMetadataSchema,
  consoleErrors: z.array(ConsoleErrorSchema),
  accessibility: AccessibilityInfoSchema,
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
    type: z.literal("navigate"),
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
    type: z.literal("wait"),
    ms: z.number().int().nonnegative().max(30000)
  }),
  z.object({
    type: z.literal("screenshot"),
    path: z.string().min(1).optional()
  }),
  z.object({
    type: z.literal("assert"),
    selector: z.string().min(1),
    containsText: z.string().min(1)
  }),
  z.object({
    type: z.literal("getCurrentUrl")
  })
]);

export type ConsoleError = z.infer<typeof ConsoleErrorSchema>;
export type ElementInformation = z.infer<typeof ElementInformationSchema>;
export type PageMetadata = z.infer<typeof PageMetadataSchema>;
export type AccessibilityInfo = z.infer<typeof AccessibilityInfoSchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type BrowserAction = z.infer<typeof BrowserActionSchema>;
