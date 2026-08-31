# v0.1.0-alpha Release Notes (Prepared)

Status: release candidate documentation, awaiting final review. No Git tag or
GitHub release is created by this milestone; workspace package versions remain
unchanged.

## Included

- Deterministic Functional and Regression checks, including normalized visible
  text, login, exact-label navigation, and explicit native-form commands.
- Adaptive V2 Exploratory execution, with local Ollama escalation, state coverage,
  and bounded recovery from invalid model-selected targets.
- Redirect-aware product exploration and automatic main-document HTTP 404/5xx or
  conservative visible page-not-found findings, with screenshots and navigation paths.
- Real Playwright browser sessions, temporary authentication, credential
  redaction, screenshots, trace, and structured evidence.
- Deterministic safety policy: allow, block, and require approval. Core callback
  approvals preserve the same session; the product dashboard safely stops.
- Local New Test, status, Dashboard, History, and Run Details views. Summaries
  distinguish website findings, failed expectations, safety stops, unsupported
  objectives, and execution/setup errors.
- Clearly labeled local analysis, with optional OpenAI-compatible analysis.

## Important Limits

The local model can produce invalid JSON, invalid references, or early termination.
Recovery is bounded and success is not guaranteed. Functional objectives are not
arbitrary natural-language programs. The dashboard has no approval/resume UI,
multi-user auth, cloud browser, or production persistence. Safety heuristics are
not a network security boundary.

## Start Locally

Run `npm ci`, then `npm run dashboard:qa`. A system Chrome/Chromium installation is
supported; `npx playwright install chromium` supplies a browser when needed.
Exploratory escalation needs running Ollama with `qwen2.5-coder:7b`.
The default endpoint remains `http://127.0.0.1:11434`; `OLLAMA_BASE_URL` overrides it.
No paid API is required. Restart the dashboard after updating the code.

See [README](../README.md) for the user guide and
[release readiness](ALPHA_RELEASE_READINESS.md) for measured smoke outcomes.
