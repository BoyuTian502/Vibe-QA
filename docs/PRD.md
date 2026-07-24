# VibeQA Product Requirements Document

## 1. Product summary

VibeQA is an AI website tester for people who build and release websites without a dedicated QA team.

The initial target users are:

- Vibe-coding developers using Cursor, Lovable, Bolt, Replit, v0, Claude Code, or similar tools
- Indie hackers
- Solo developers
- Small startup teams
- Freelance developers and small agencies

These users often release functional web applications quickly but do not have the time, experience, or budget to manually inspect every workflow after each change.

VibeQA gives them an AI tester that can log in, use the product like a customer, explore important workflows, detect failures, collect evidence, and explain what should be fixed.

## 2. Core user problem

The target user commonly experiences the following:

- They do not know what should be tested.
- They only click through a few obvious pages.
- Authentication and post-login workflows are often under-tested.
- UI changes frequently invalidate conventional selectors.
- Data persistence, loading, and API errors are easy to miss.
- They have no QA engineer.
- Existing enterprise test platforms feel too complex or expensive.
- AI-generated code can appear correct while failing in actual use.

The real user need is not “more test cases.”

The user needs confidence that the application is safe to release.

## 3. Product promise

The user provides:

- Website URL
- Product description
- Authentication method
- Optional critical workflows
- Explicit safety restrictions
- A bounded testing budget

VibeQA returns:

- Which workflows passed
- Which confirmed bugs were found
- Which suspicious behaviors need review
- Reproduction steps
- Screenshots and browser traces
- Console and network evidence
- Severity and confidence
- A fix prompt that can be copied into Cursor or another coding agent

## 4. Primary testing modes

### 4.1 Release Check

The user specifies one or more important flows.

Example:

```text
A user should be able to:
1. Log in
2. Create a project
3. Save it
4. Refresh the page
5. See the project again
6. Log out
```

VibeQA converts the flow into explicit missions with success criteria and executes them.

### 4.2 Explore My App

The user provides a product description but no detailed workflow.

VibeQA:

1. Understands the current page.
2. Identifies important features.
3. Creates test hypotheses.
4. Scores candidate experiments.
5. Executes the highest-value safe experiment.
6. Detects anomalies.
7. Reproduces suspected bugs.
8. Stops when the testing budget or coverage criteria are met.

## 5. Authentication requirements

V1 supports:

### Test-account login

The user supplies a dedicated test account through a secure secret interface.

Passwords must never be passed to the LLM or written into traces or logs.

### Manual authenticated session

The platform opens an isolated browser.

The user completes Google OAuth, GitHub OAuth, magic-link authentication, CAPTCHA, or 2FA manually.

VibeQA saves the resulting Playwright storage state and resumes testing.

V1 does not bypass CAPTCHA or 2FA.

## 6. Safety requirements

The user must be able to prohibit actions such as:

- Real payments
- Account deletion
- Workspace deletion
- Sending external email
- Inviting users
- Publishing content
- Deploying changes
- Cancelling subscriptions

The browser worker must enforce these policies before execution.

Prompt instructions alone are not sufficient.

## 7. Bug classes targeted by V1

### High-confidence technical failures

- Uncaught JavaScript exceptions
- HTTP 500–599 responses
- Failed core mutation requests
- Blank pages
- Crashed browser pages
- Infinite loading
- Broken links
- Clicks that produce no expected effect
- Failed navigation

### Functional failures

- Valid forms cannot be submitted
- Invalid forms are accepted without reasonable handling
- Data is lost after refresh
- Edited data does not update
- Duplicate submissions create unintended duplicate records
- Logout leaves private application state accessible
- Core flows cannot be completed

### Basic interface failures

- Critical controls are hidden or blocked
- Modal dialogs cannot be closed
- Long text breaks important layout
- Error messages are absent or misleading

## 8. Report requirements

Each confirmed bug must contain:

- Title
- Severity
- Confidence
- Affected page
- Test environment
- Preconditions
- Reproduction steps
- Expected behavior
- Actual behavior
- Screenshot
- Relevant console evidence
- Relevant network evidence
- Trace reference
- Suggested developer fix prompt

The system must clearly separate:

- Confirmed Bug
- Likely Bug
- Needs Review
- Rejected Anomaly

## 9. Product differentiation

VibeQA is designed for developers who want a release decision, not a traditional QA management platform.

The main differentiation is:

```text
Paste your app URL.
VibeQA logs in, uses the product like a real customer,
finds what broke, and tells your coding agent what to inspect.
```

## 10. Non-goals for Alpha-0

Alpha-0 will not include:

- Full production SaaS UI
- Billing
- Team management
- Enterprise SSO
- Native mobile testing
- Multi-browser testing
- Performance testing
- Penetration testing
- Security exploit generation
- Automatic source-code changes
- Automatic deployment
- Unlimited autonomous exploration
- A guarantee of discovering all bugs

## 11. Alpha-0 success definition

Alpha-0 is successful when it can repeatedly test one controlled benchmark application and reliably detect known seeded bugs with limited false positives.

Minimum success requirements:

- At least 90% completion of the benchmark app’s critical happy path over 10 runs
- Detection of the seeded persistence bug
- Detection of HTTP 500 and uncaught console errors
- No execution of forbidden destructive actions
- Confirmed bugs include reproducible evidence
- The run stops reliably when the action budget is reached
