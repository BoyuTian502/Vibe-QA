export type QATestMode = "functional" | "exploratory" | "regression";

// Product modes are fixed; benchmark strategy switches are intentionally separate.
export const ALPHA_EXECUTION_POLICY = {
  functional: { strategy: "deterministic", adaptivePolicyVersion: null },
  regression: { strategy: "deterministic", adaptivePolicyVersion: null },
  exploratory: { strategy: "adaptive", adaptivePolicyVersion: "v2" }
} as const;

export function alphaExecutionPolicy(mode: QATestMode) {
  return ALPHA_EXECUTION_POLICY[mode];
}
