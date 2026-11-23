import assert from "node:assert/strict";
import { resolve } from "node:path";
import { codexBridgeArgs } from "../src/adapters/codex/nativeBridge.js";

import {
  codexCommandApprovalDecision,
  codexCommandApprovalPresentation,
  codexQuestions,
  codexQuestionResponse,
} from "../src/runtime/codexAppServerSession.js";

const cwd = process.cwd();
const project = resolve(cwd, "project");
assert.deepEqual(codexBridgeArgs(["--cd=project", "-c", "x=1", "--config=y=2", "resume", "--last"], cwd), {
  serverCwd: project, config: ["-c", "x=1", "--config", "y=2"],
  tui: ["--cd", project, "-c", "x=1", "--config", "y=2", "resume", "--last"],
});
for (const args of [["--worktree"], ["exec", "run"], ["--remote", "ws://localhost"], ["--unknown-option"]]) {
  assert.equal(codexBridgeArgs(args, cwd), null);
}

const params = {
  questions: [
    {
      header: "Target",
      question: "Where should this deploy?",
      options: [{ label: "Staging" }, { label: "Production" }],
    },
    {
      id: "checks",
      header: "Checks",
      question: "Which checks?",
      multiSelect: true,
      options: [{ label: "Tests" }, { label: "Analyze" }],
    },
  ],
};

const payload = codexQuestions(params);
assert.equal(payload.questions[0].id, "q1");
assert.equal(payload.questions[0].multiple, false);
assert.equal(payload.questions[0].allow_other, true);
assert.equal(payload.questions[1].multiple, true);
assert.deepEqual(
  codexQuestionResponse(params, {
    answers: { q1: ["Staging"], checks: ["Tests", "Analyze"] },
  }),
  {
    answers: {
      q1: { answers: ["Staging"] },
      checks: { answers: ["Tests", "Analyze"] },
    },
  },
);

const availableDecisions = [
  "accept",
  "acceptForSession",
  {
    acceptWithExecpolicyAmendment: {
      execpolicy_amendment: ["prefix_rule(pattern=[\"npm\", \"test\"])"],
    },
  },
  "decline",
  "cancel",
];
const approvalPresentation = codexCommandApprovalPresentation({ availableDecisions });
assert.deepEqual(approvalPresentation.approval_options, [
  { id: "decision-0", label: "Allow once" },
  { id: "decision-1", label: "Allow for this session" },
  { id: "decision-2", label: "Allow and apply the suggested command rule" },
]);
assert.equal(approvalPresentation.remember_allowed, false);
assert.equal(
  codexCommandApprovalDecision(
    { availableDecisions },
    { action: "allow", response: { approval_option: "decision-2" } },
  ),
  availableDecisions[2],
);
assert.equal(
  codexCommandApprovalDecision(
    { availableDecisions },
    { action: "deny", response: { approval_option: "decision-0" } },
  ),
  "decline",
);
assert.equal(
  codexCommandApprovalDecision({}, {
    action: "allow",
    response: { remember_for_session: true },
  }),
  "acceptForSession",
);

console.log("codex managed interaction tests ok");
