import { createServer } from "node:http";

import { PlaywrightBrowserController } from "@vibeqa/browser-playwright";
import type { TestCase, TestResult, TestTaskOptions } from "@vibeqa/test-engine";
import type { Observation } from "@vibeqa/schemas";
import { describe, expect, it, vi } from "vitest";

import {
  createFunctionalFormSteps,
  parseFunctionalForm
} from "../src/functional-form.js";
import {
  assertFunctionalPlan,
  localFunctionalKind
} from "../src/functional-objective.js";
import {
  AgentTestRequestExecutor,
  type TestArtifactStore
} from "../src/test-workflow.js";

describe("explicit Functional form commands", () => {
  it("identifies an unsupported custom control rather than generating a partial workflow", async () => {
    const observation: Observation = {
      id: "custom",
      timestamp: new Date().toISOString(),
      url: "http://localhost/",
      title: "Custom form",
      metadata: { url: "http://localhost/", title: "Custom form", viewport: null },
      elements: [],
      consoleErrors: [],
      screenshotPath: null,
      textSample: "Country",
      accessibility: { headings: [], landmarks: [], interactiveElementCount: 0 }
    };
    const browser = {
      navigate: vi.fn(async () => {}),
      wait: vi.fn(async () => {}),
      observe: async () => observation,
      getText: vi.fn(async () => {
        throw new Error("No matching native select");
      })
    };
    await expect(
      createFunctionalFormSteps(
        [{ kind: "select", label: "Country", value: "India" }],
        browser,
        observation.url
      )
    ).rejects.toThrow(
      /UNSUPPORTED_FUNCTIONAL_OBJECTIVE.*control "Country".*not a supported native control/
    );
  });

  it("parses native fill, select, choice, checkbox and submit commands in order", () => {
    expect(
      parseFunctionalForm(
        "Enter Ada in First Name\nSelect India as Country\nChoose Email as Communication\nCheck checkbox Terms\nClick Submit\nVerify success text"
      )
    ).toEqual([
      { kind: "fill", label: "First Name", value: "Ada" },
      { kind: "select", label: "Country", value: "India" },
      { kind: "choose", label: "Email", group: "Communication" },
      { kind: "choose", label: "Terms", checkbox: true },
      { kind: "click", label: "Submit" }
    ]);
    expect(
      parseFunctionalForm(
        'Enter "Ada Lovelace" in "Full Name"; Select "Dr." from Title; Submit form'
      )
    ).toHaveLength(3);
    expect(parseFunctionalForm("Enter 阿达 in 名字")).toEqual([
      { kind: "fill", label: "名字", value: "阿达" }
    ]);
  });

  it.each([
    "Enter Ada in First Name\nDo the rest of the form",
    "Select a suitable country",
    "Enter secret-value in Password",
    'Enter "unterminated in First Name'
  ])(
    "rejects unsupported instructions without discarding steps or echoing values: %s",
    (objective) => {
      expect(() => localFunctionalKind(objective, false)).toThrow(
        /UNSUPPORTED_FUNCTIONAL_OBJECTIVE/
      );
      try {
        parseFunctionalForm(objective);
      } catch (error) {
        expect(String(error)).not.toContain("secret-value");
      }
    }
  );

  it("requires every explicit action and preserves ordinary page checks", () => {
    const objective = "Enter Ada in First Name\nClick Submit";
    const textOnly: TestCase = {
      goal: objective,
      startUrl: "http://localhost/",
      steps: [
        {
          name: "Text",
          action: { type: "getText", selector: "body" },
          expected: { requiredText: "Done" }
        }
      ]
    };
    expect(() => assertFunctionalPlan(objective, textOnly)).toThrow(
      /every explicit form instruction/
    );
    expect(() =>
      assertFunctionalPlan(objective, {
        ...textOnly,
        steps: [
          {
            name: "Wrong input",
            action: { type: "type", selector: "#first", value: "Wrong" }
          },
          { name: "Submit", action: { type: "click", selector: "#submit" } },
          ...textOnly.steps
        ]
      })
    ).toThrow(/every explicit form instruction/);
    expect(
      localFunctionalKind("Verify that the homepage loads successfully.", false)
    ).toBe("text");
    expect(localFunctionalKind("Navigate to Products and verify the page", false)).toBe(
      "navigation"
    );
    expect(() => localFunctionalKind(objective, true)).toThrow(/structured TestCase/);
  });

  it("executes all native controls, preserves Unicode, and asserts only after approved submit", async () => {
    const approvals: string[] = [];
    const result = await runForm(
      [
        "Select India as Country",
        "Select Dr. as Title",
        "Enter Ada in First Name",
        "Enter Lovelace in Last Name",
        "Enter 阿达 in 名字",
        "Enter 1990-12-10 in Date of Birth",
        "Enter ada@example.test in Email Address",
        "Enter 2025550100 in Phone Number",
        "Choose Email as Communication",
        "Check checkbox Terms",
        "Click Submit"
      ].join("\n"),
      async (request) => {
        approvals.push(request.requestId);
        return true;
      }
    );
    expect(result.status).toBe("passed");
    expect(result.executedSteps.map((step) => step.action.type)).toEqual([
      "wait",
      ...Array<string>(8).fill("type"),
      "click",
      "click",
      "click",
      "wait",
      "getText"
    ]);
    expect(result.executedSteps.at(-1)?.observation?.textSample).toContain(
      "Details Successfully Added"
    );
    expect(approvals).toHaveLength(2);
    expect(new Set(approvals).size).toBe(2);
    expect(
      result.trace.steps.filter((step) => step.approvalStatus === "approved")
    ).toHaveLength(2);
  });

  it("keeps submit pending without an approval callback", async () => {
    const result = await runForm("Enter Ada in First Name\nClick Submit");
    expect(result.status).toBe("failed");
    expect(
      result.trace.steps.find((step) => step.approvalStatus === "pending")?.result
        .success
    ).toBe(false);
    expect(
      result.trace.steps.some((step) =>
        step.observation?.textSample.includes("Details Successfully Added")
      )
    ).toBe(false);
  });

  it("records denial and never executes denied submit", async () => {
    const approval = vi.fn(async () => false);
    const result = await runForm("Enter Ada in First Name\nClick Submit", approval);
    expect(result.status).toBe("failed");
    expect(approval).toHaveBeenCalledTimes(1);
    expect(
      result.trace.steps.find((step) => step.approvalStatus === "denied")?.result
        .success
    ).toBe(false);
  });

  it("cannot approve a blocked destructive action", async () => {
    const approval = vi.fn(async () => true);
    const result = await runForm(
      "Enter Ada in First Name\nClick Delete account",
      approval
    );
    expect(result.status).toBe("failed");
    expect(result.trace.steps.some((step) => step.safetyDecision === "block")).toBe(
      true
    );
    expect(approval).not.toHaveBeenCalled();
  });

  it("supports fill-only checks and rejects a missing native option during execution", async () => {
    const filled = await runForm("Enter Ada in First Name", undefined, "Form ready");
    expect(filled.status).toBe("passed");
    const absent = await runForm("Select Atlantis as Country", undefined, "Form ready");
    expect(absent.status).toBe("failed");
    expect(
      absent.errors.some((error) => error.includes("UNSUPPORTED_FUNCTIONAL_CONTROL"))
    ).toBe(true);
  });
});

async function runForm(
  objective: string,
  onApproval?: TestTaskOptions["onApproval"],
  expectedBehavior = "Details Successfully Added"
): Promise<TestResult> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<html><body><h1>Form ready</h1><form id="practice">
      <label for="country">Country</label><select id="country" name="country"><option value="">Select</option><option value="IN">India</option></select>
      <div><label>Title</label><select name="title"><option>Mr.</option><option>Dr.</option></select></div>
      <label>First Name<input name="first"></label><label for="last">Last Name</label><input id="last" name="last">
      <label for="chinese">名字</label><input id="chinese" name="chinese">
      <div><label>Date of Birth</label><div><input type="date" name="dob"></div></div>
      <label for="email">Email Address</label><input id="email" name="email" type="email">
      <div><label>Phone Number</label><input name="phone" type="tel"></div>
      <fieldset><legend>Communication</legend><input id="email-choice" name="comm" value="email" type="radio"><label for="email-choice">Email</label></fieldset>
      <label>Terms<input name="terms" type="checkbox"></label>
      <button type="submit">Submit</button><button type="button">Delete account</button>
      </form><p id="result"></p><script>
      document.querySelector('form').onsubmit = event => {
        event.preventDefault(); const data = new FormData(event.target);
        const valid = data.get('country')==='IN' && data.get('title')==='Dr.' && data.get('first')==='Ada' && data.get('last')==='Lovelace' && data.get('chinese')==='阿达' && data.get('dob')==='1990-12-10' && data.get('email')==='ada@example.test' && data.get('phone')==='2025550100' && data.get('comm')==='email' && data.get('terms')==='on';
        document.querySelector('#result').textContent = valid ? 'Details Successfully Added' : 'Incomplete form';
      };</script></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let saved: TestResult | null = null;
  let closed = false;
  const store: TestArtifactStore = {
    screenshotDirectory: () => "run-output/functional-form-tests",
    save: async (_id, result) => {
      saved = result;
    }
  };
  const generate = vi.fn().mockRejectedValue(new Error("Unexpected model call"));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    const executor = new AgentTestRequestExecutor({
      outputRoot: "unused",
      onApproval,
      artifactStore: store,
      explorationClient: { generate },
      launchBrowser: async () => {
        const browser = await PlaywrightBrowserController.launch({ headless: true });
        const close = browser.close.bind(browser);
        browser.close = async () => {
          await close();
          closed = true;
        };
        return browser;
      }
    });
    await executor.execute(
      {
        websiteUrl: `http://127.0.0.1:${address.port}`,
        objective,
        expectedBehavior,
        mode: "functional",
        credentials: null
      },
      "form-test"
    );
    expect(closed).toBe(true);
    expect(generate).not.toHaveBeenCalled();
    if (!saved) throw new Error("Missing test report");
    return saved;
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}
