// The reasoning effort of a terminal session.
//
// Claude Code's TUI owns the level of a running session: the `/effort`
// command opens a slider over the levels the model offers, the arrow keys
// move it, `s` applies the level to that session alone and `Enter` applies
// it as the default for new sessions as well.
//
// OriginRouter drives the session-only path. The other one writes
// `effortLevel` into the reader's own `~/.claude/settings.json`, and the
// level of one session is not the reader's business.
//
// The terminal's own text is what is read here — the badge in its header
// says which level the session is on, and the header repaints that badge
// when the level changes. The terminal writes its words with cursor jumps
// between them, so every match is made against text without spaces.
//
// The lines below are what a live session actually wrote: the badge at
// startup, the slider, and the badge again after the level was applied.

import assert from "node:assert/strict";

import { ClaudeAdapter } from "../src/adapters/claudeAdapter.js";
import { buildRuntimeEventEnvelope } from "../src/agent/bridgeReporter.js";
import { CLAUDE_PTY_EFFORT_LEVELS } from "../src/runtime/agentEffort.js";
import { ExternalAgentRegistry } from "../src/local/externalAgentRegistry.js";

// ---------- the vocabulary ----------

// The levels are the slider's levels, in the slider's order. `none` is not
// among them: the terminal chooses how much thinking there is, it does not
// turn it off.
assert.deepEqual(CLAUDE_PTY_EFFORT_LEVELS, [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
assert.equal(CLAUDE_PTY_EFFORT_LEVELS.includes("none"), false);

// ---------- reading the terminal ----------

// What the terminal actually writes, captured from a live session. The
// badge, the slider, and the line that follows an applied level.
const BADGE = "\u001b[93C\u001b[1B\u001b[38;2;153;153;153m◈ max · /effort";
const SLIDER =
  "\u001b[3C\u001b[1B\u001b[39m\u001b[1mEffort\r\u001b[1B\u001b[22m\u001b[K\r" +
  "\u001b[29C\u001b[1BFaster\u001b[65GSmarter\r\u001b[1B\u001b[38;2;153;153;153m" +
  "────────────────────\u001b[39m\u001b[1m▲\u001b[22m\u001b[38;2;153;153;153m" +
  "─────────────────────\u001b[39m      \u001b[1mUltracode\u001b[22m  " +
  "\u001b[38;2;153;153;153moff\u001b[39m\u001b[K\r\u001b[1B  \u001b[30G" +
  "\u001b[38;2;153;153;153mlow\u001b[38Gmedium\u001b[49G\u001b[38;2;177;185;249m" +
  "\u001b[1mhigh\u001b[58G\u001b[22m\u001b[38;2;153;153;153mxhigh\u001b[69Gmax" +
  "\u001b[78GTab to toggle\r\u001b[1B\u001b[39m\u001b[K\r\u001b[2C\u001b[1B\u001b[K\r" +
  "\u001b[2C\u001b[1B \u001b[38;2;153;153;153m←/→ to adjust · Enter \u001b[27Go " +
  "confirm · s for this session only · Esc to cancel\u001b[39m\u001b[40;1H";
// The confirmation the terminal prints after it applied a level. The words
// are separated by cursor jumps, which is why the text that reaches us has
// no spaces in it.
const appliedText = (level) =>
  `\u001b[49m\u001b[38;2;255;255;255m  ⎿  \u001b[39mSet\u001b[10Geffort\u001b[17Glevel\u001b[23Gto\u001b[26G${level}\u001b[30G(this\u001b[36Gsession\u001b[44Gonly):`;
// The header repaints its badge when the level changes. This is the form
// the terminal writes it in after a change: no space between the sign and
// the level.
const badgeText = (level) =>
  `\u001b[102G\u001b[38;2;153;153;153m◉${level}·/effort`;

// A session that has drawn its badge has the feature, and says so.
const badgeAdapter = new ClaudeAdapter({ args: [] });
badgeAdapter.sessionId = "session-1";
badgeAdapter.handleOutput(BADGE);
const badgeStatus = badgeAdapter.effortStatusEvent();
assert.equal(badgeStatus.effortControl, "supported");
assert.equal(badgeStatus.effort, "max");
assert.deepEqual(badgeStatus.availableEfforts, CLAUDE_PTY_EFFORT_LEVELS);

// A session that has drawn no badge has no control: a level the runtime
// cannot take is a row that fails when it is tapped.
const quietAdapter = new ClaudeAdapter({ args: [] });
quietAdapter.sessionId = "session-1";
quietAdapter.handleOutput("some output that says nothing about effort\r");
assert.equal(quietAdapter.effortStatusEvent().effortControl, "unsupported");
assert.deepEqual(quietAdapter.effortStatusEvent().availableEfforts, []);

// The badge says the level; the words the terminal writes between the
// letters are cursor jumps, and the text that reaches us has no spaces.
const wordyAdapter = new ClaudeAdapter({ args: [] });
wordyAdapter.sessionId = "session-1";
wordyAdapter.handleOutput("\u001b[1B\u001b[38;2;153;153;153m● high · /effort");
assert.equal(wordyAdapter.effortStatusEvent().effort, "high");
assert.equal(wordyAdapter.effortStatusEvent().effortControl, "supported");

// The badge the terminal writes after a change has no space in it.
const changedAdapter = new ClaudeAdapter({ args: [] });
changedAdapter.sessionId = "session-1";
changedAdapter.handleOutput("● high · /effort");
changedAdapter.handleOutput(badgeText("xhigh"));
assert.equal(changedAdapter.effortStatusEvent().effort, "xhigh");

// The terminal also writes "Max effort · /effort to change" when the level
// is capped. That is a sentence about the cap, not a level, and it must not
// be read as one.
const cappedAdapter = new ClaudeAdapter({ args: [] });
cappedAdapter.sessionId = "session-1";
cappedAdapter.handleOutput("● high · /effort");
cappedAdapter.handleOutput("Max effort · /effort to change");
assert.equal(cappedAdapter.effortStatusEvent().effort, "high");

// ---------- changing the level ----------

// The slider a terminal draws, for a model with these levels.
function sliderText(levels) {
  return (
    "Effort Faster Smarter ────────▲──────── Ultracode off " +
    `${levels.join(" ")} Tab to toggle ` +
    "←/→ to adjust · Enter o confirm · s for this session only · Esc to cancel"
  );
}

// A terminal that answers the way the real one does: the slider opens when
// the command is typed, the marker moves with the arrow keys, and the
// header repaints its badge when the level is applied.
function fakeTerminal({ current = "high", levels = CLAUDE_PTY_EFFORT_LEVELS } = {}) {
  const writes = [];
  let level = current;
  const executor = {
    write(data) {
      writes.push(data);
      if (data === "/effort\r") {
        setTimeout(() => adapter.handleOutput(sliderText(levels)), 0);
      } else if (data === "s") {
        // The real terminal repaints its badge and prints no line.
        setTimeout(() => {
          adapter.handleOutput(badgeText(level));
        }, 0);
      } else if (data.includes("\x1b[D")) {
        // The slider clamps at the low end.
        const steps = data.split("\x1b[D").length - 1;
        const index = Math.max(0, levels.indexOf(level) - steps);
        level = levels[index];
      } else if (data.includes("\x1b[C")) {
        const steps = data.split("\x1b[C").length - 1;
        const index = Math.min(levels.length - 1, levels.indexOf(level) + steps);
        level = levels[index];
      }
    },
  };
  const adapter = new ClaudeAdapter({ args: [] });
  adapter.sessionId = "session-1";
  adapter.sessionReady = true;
  adapter.handleOutput(`\u001b[1B\u001b[38;2;153;153;153m● ${level} · /effort`);
  return { adapter, executor, writes, level: () => level };
}

const terminal = fakeTerminal({ current: "high" });
const applied = await terminal.adapter.setEffort(
  { effort: "xhigh", requestId: "req-1" },
  terminal.executor,
);
assert.equal(applied, true);
assert.equal(terminal.level(), "xhigh");

// The command is typed the way the reader would type it, the slider is
// walked to the far left first — so the walk to the wanted level is a fixed
// number of steps whatever the session started on — and `s` applies it for
// this session only.
assert.equal(terminal.writes[0], "/effort\r");
assert.ok(
  terminal.writes.some((write) => write.includes("\x1b[D")),
  "the slider is walked to the low end first",
);
assert.ok(
  terminal.writes.some((write) => write.includes("\x1b[C")),
  "the slider is walked to the wanted level",
);
assert.equal(terminal.writes[terminal.writes.length - 1], "s");
assert.equal(
  terminal.writes.some((write) => write === "\r"),
  false,
  "Enter is never pressed: it would save the level for new sessions too",
);

// The status the session publishes says what happened.
const statuses = terminal.adapter.pendingEvents.filter(
  (event) => event.type === "agent.effort.status",
);
const last = statuses[statuses.length - 1];
assert.equal(last.accepted, true);
assert.equal(last.effort, "xhigh");
assert.equal(last.requestId, "req-1");
assert.deepEqual(last.availableEfforts, CLAUDE_PTY_EFFORT_LEVELS);

// The confirmation line is the other way the terminal says it applied a
// level, and it is taken as the same word.
const spoken = fakeTerminal({ current: "high" });
spoken.executor.write = ((original) => (data) => {
  original(data);
  if (data === "s") {
    setTimeout(() => {
      spoken.adapter.handleOutput(appliedText(spoken.level()));
    }, 0);
  }
})(spoken.executor.write);
assert.equal(
  await spoken.adapter.setEffort({ effort: "low" }, spoken.executor),
  true,
);
assert.equal(spoken.adapter.effortStatusEvent().effort, "low");

// A level the terminal does not have is refused, not tried.
const refused = fakeTerminal({ current: "high" });
assert.equal(
  await refused.adapter.setEffort({ effort: "none" }, refused.executor),
  false,
);
const refusedStatuses = refused.adapter.pendingEvents.filter(
  (event) => event.type === "agent.effort.status",
);
assert.equal(refusedStatuses[refusedStatuses.length - 1].reason, "effort_level_unsupported");

// A session whose terminal never drew the badge has no control at all.
const unsupported = new ClaudeAdapter({ args: [] });
unsupported.sessionId = "session-1";
unsupported.sessionReady = true;
assert.equal(
  await unsupported.setEffort({ effort: "low" }, { write() {} }),
  false,
);
const unsupportedStatuses = unsupported.pendingEvents.filter(
  (event) => event.type === "agent.effort.status",
);
assert.equal(
  unsupportedStatuses[unsupportedStatuses.length - 1].reason,
  "effort_control_unsupported",
);

// A session that is still running a turn is left alone.
const busy = fakeTerminal({ current: "high" });
busy.adapter.taskActive = true;
assert.equal(
  await busy.adapter.setEffort({ effort: "low" }, busy.executor),
  false,
);
const busyStatuses = busy.adapter.pendingEvents.filter(
  (event) => event.type === "agent.effort.status",
);
assert.equal(busyStatuses[busyStatuses.length - 1].reason, "effort_change_busy");

// The slider's own levels are the model's levels. A model that cannot take
// a level does not have it in its slider, and the App is not offered a row
// that fails when it is tapped.
const narrow = fakeTerminal({ current: "high", levels: ["low", "medium", "high"] });
assert.equal(
  await narrow.adapter.setEffort({ effort: "max" }, narrow.executor),
  false,
);
assert.equal(
  narrow.adapter.effortStatusEvent().availableEfforts.join(","),
  "low,medium,high",
  "the published list is the slider's list",
);

// The slider the terminal really drew is read the same way.
const captured = fakeTerminal({ current: "high" });
captured.executor.write = ((original) => (data) => {
  original(data);
  if (data === "/effort\r") {
    setTimeout(() => captured.adapter.handleOutput(SLIDER), 0);
  }
})(captured.executor.write);
assert.equal(
  await captured.adapter.setEffort({ effort: "low" }, captured.executor),
  true,
);
assert.deepEqual(
  captured.adapter.effortStatusEvent().availableEfforts,
  CLAUDE_PTY_EFFORT_LEVELS,
);

// ---------- the session record ----------

// The registry folds the runtime's own statement into the session row, and
// a registration carries the levels the runtime can take — a daemon that
// restarts rebuilds the row from the registration.
const registry = new ExternalAgentRegistry({ now: () => 1 });
registry.register({
  sessionId: "session-1",
  provider: "claude",
  effortControl: "supported",
  availableEfforts: CLAUDE_PTY_EFFORT_LEVELS,
});
registry.appendEvent("session-1", {
  type: "agent.effort.status",
  provider: "claude",
  effort: "xhigh",
  effortControl: "supported",
  availableEfforts: CLAUDE_PTY_EFFORT_LEVELS,
});
const snapshot = registry.controlSnapshot("session-1");
assert.equal(snapshot.effort, "xhigh");
assert.equal(snapshot.effortControl, "supported");
assert.deepEqual(snapshot.availableEfforts, CLAUDE_PTY_EFFORT_LEVELS);

// The row the App's session list reads carries the same facts.
const row = registry.list().find((item) => item.session_id === "session-1");
assert.equal(row.effort, "xhigh");
assert.equal(row.effort_control, "supported");
assert.deepEqual(row.available_efforts, CLAUDE_PTY_EFFORT_LEVELS);

// ---------- the body the cloud receives ----------

// The device says the level, the cloud writes it onto the session row, and
// the App reads the row and draws the levels the device published. The
// middle step is the body the reporter builds, and it is where a level can
// be lost — the App draws no level row at all when the body's list is
// empty.
const wire = new ClaudeAdapter({ args: [] });
wire.sessionId = "session-1";
wire.handleOutput(BADGE);
const effortEvent = wire
  .scanStructuredEvents()
  .find((event) => event.type === "agent.effort.status");
assert.ok(effortEvent, "the badge is what says the session has a control");

const envelope = buildRuntimeEventEnvelope({
  sessionId: "session-1",
  agentType: "claude",
  // The wrapper the runtime's own events travel in.
  eventType: "agent.event",
  event: effortEvent,
});
assert.equal(envelope.effort, "max");
assert.equal(envelope.effort_control, "supported");
assert.deepEqual(
  envelope.available_efforts,
  CLAUDE_PTY_EFFORT_LEVELS,
  "the levels travel with the fact: the App draws the list it is given",
);

// A session whose terminal never drew the badge says nothing, and the
// cloud is told so — an empty list, not a list of levels that would fail.
const quietWire = new ClaudeAdapter({ args: [] });
quietWire.sessionId = "session-1";
quietWire.handleOutput("some output that says nothing about effort\r");
const quietEvent = quietWire
  .scanStructuredEvents()
  .find((event) => event.type === "agent.effort.status");
assert.equal(quietEvent, undefined);

console.log("claude pty effort: ok");
