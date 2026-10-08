import assert from "node:assert/strict";

import { parsePort, resolveLocalPortCandidates } from "../src/daemon/daemonPrimitives.js";

// A recorded port leads, ahead of the default, so a host that had to move stays
// moved. On a shared machine the second user settles on 7438 and must not bounce
// back to 7437 every restart: the App pairs against the port daemon.state.json
// reports, and a port that shifts underneath it breaks that pairing.
//
// The cost is that a record written by mistake is no longer self-correcting, so
// the daemon announces a fallback loudly instead — see the warning test below.
{
  const { explicit, requested, candidates } = resolveLocalPortCandidates({
    recordedPort: 7438,
    defaultPort: 7437,
  });

  assert.equal(explicit, null, "a recorded port is not an explicit request");
  assert.equal(requested, null, "and it is not requested either");
  assert.deepEqual(
    candidates,
    [7438, 7437],
    "the recorded port leads so a settled port stays settled",
  );
  assert.equal(candidates[0], 7438, "no bouncing back to the default on every start");
}

// ...but a port the operator chose must NOT be treated that way. On a service
// install the supervisor starts the daemon with no flags at all, so the file is
// the only channel a chosen port has — stomping it back to the default would
// make `local api set-port` impossible to use.
{
  const { requested, candidates } = resolveLocalPortCandidates({
    recordedPort: 8080,
    portIsOperatorSet: true,
    defaultPort: 7437,
  });

  assert.equal(requested, 8080, "an operator-set port is an instruction");
  assert.equal(
    candidates[0],
    8080,
    "the operator's port is tried first; the default must not pre-empt it",
  );
  assert.ok(candidates.includes(7437), "...but the default remains a fallback");
}

// A recorded port and an operator-chosen port both lead, but only the second is
// "requested" — that is the flag the caller uses to decide whether the record
// may be demoted after a fallback.
{
  const bound = resolveLocalPortCandidates({ recordedPort: 8080, defaultPort: 7437 });
  const chosen = resolveLocalPortCandidates({
    recordedPort: 8080,
    portIsOperatorSet: true,
    defaultPort: 7437,
  });
  assert.equal(bound.candidates[0], 8080, "a recorded port still leads");
  assert.equal(bound.requested, null, "...but it is not a request, so it may demote");
  assert.equal(chosen.candidates[0], 8080);
  assert.equal(chosen.requested, 8080, "...while an operator choice stays requested");
}

// An explicit flag is this run's word against the file's, so the flag leads —
// and it stays in the list so a busy flag port still yields a working daemon.
{
  const { explicit, requested, candidates } = resolveLocalPortCandidates({
    cliPort: 7440,
    recordedPort: 8080,
    portIsOperatorSet: true,
    defaultPort: 7437,
  });
  assert.equal(explicit, 7440);
  assert.equal(requested, 7440);
  assert.equal(candidates[0], 7440, "the flag outranks the operator's file");
  assert.deepEqual(candidates, [7440, 8080, 7437], "and nothing is dropped");
}

// The regression this test exists for: `a ?? b != null ? … : …` binds as
// `(a ?? (b != null)) ? … : …`, so a configured port used to be reported as
// explicit. Explicit requests never fall back, so a busy port became a hard
// startup failure instead of a fallback.
{
  const { explicit } = resolveLocalPortCandidates({
    cliPort: undefined,
    envPort: undefined,
    configuredPort: 7438,
    defaultPort: 7437,
  });

  assert.equal(
    explicit,
    null,
    "no CLI or env override means nothing is explicit, whatever local-api.json says",
  );
}

// An explicit port is an instruction and must be the only candidate: substituting
// a lower one for it would silently ignore what the operator asked for.
{
  const fromFlag = resolveLocalPortCandidates({
    cliPort: "7440",
    recordedPort: 7438,
    defaultPort: 7437,
  });
  assert.equal(fromFlag.explicit, 7440);
  assert.equal(fromFlag.candidates[0], 7440, "explicit leads");

  const fromEnv = resolveLocalPortCandidates({
    envPort: 7441,
    recordedPort: 7438,
    defaultPort: 7437,
  });
  assert.equal(fromEnv.explicit, 7441);
  assert.equal(fromEnv.candidates[0], 7441);
}

// The flag outranks the env var.
{
  const { explicit } = resolveLocalPortCandidates({
    cliPort: 7500,
    envPort: 7441,
    defaultPort: 7437,
  });
  assert.equal(explicit, 7500);
}

// A fresh install has no recorded port: the default is the first thing tried,
// and the caller's `?? 0` fallback may hand the choice to the kernel.
{
  const { explicit, candidates } = resolveLocalPortCandidates({
    configuredPort: undefined,
    defaultPort: 7437,
  });
  assert.equal(explicit, null);
  assert.deepEqual(candidates, [7437], "no duplicate default when nothing is recorded");
}

// An explicit port of 0 means "any free port", not a port to pin — that has been
// the contract since 0.4.9, and `acceptance.e2e.test.js` starts the daemon that
// way. It is dropped so the kernel chooses, exactly as when no port is given;
// treating it as an instruction would invert the meaning, since explicit ports
// never fall back and the one request that says "any free port" would then fail
// on the first busy candidate.
{
  const kernel = { explicit: null, requested: null, candidates: [] };
  assert.deepEqual(
    resolveLocalPortCandidates({ cliPort: 0, defaultPort: 7437 }),
    kernel,
    "cliPort 0 leaves the choice to the kernel",
  );
  assert.deepEqual(
    resolveLocalPortCandidates({ envPort: "0", defaultPort: 7437 }),
    kernel,
    "envPort 0 leaves the choice to the kernel",
  );
  // The request outranks the file. Clearing only `explicit` would let a
  // recorded port supply the answer instead — and on a machine whose real
  // daemon already holds that port, the throwaway start would die with
  // EADDRINUSE rather than getting a port of its own.
  assert.deepEqual(
    resolveLocalPortCandidates({ cliPort: 0, recordedPort: 7437, defaultPort: 7437 }),
    kernel,
    "0 outranks the recorded port",
  );
  assert.deepEqual(
    resolveLocalPortCandidates({
      cliPort: 0, recordedPort: 9000, portIsOperatorSet: true, defaultPort: 7437,
    }),
    kernel,
    "0 outranks even an operator-set port",
  );
  // Contrast: no explicit port at all is a different thing, and keeps the
  // recorded/default list intact.
  assert.deepEqual(
    resolveLocalPortCandidates({ defaultPort: 7437 }),
    { explicit: null, requested: null, candidates: [7437] },
    "an unset port is not a kernel request",
  );
  // ...without disturbing what a real port does.
  assert.equal(
    resolveLocalPortCandidates({ cliPort: 7440, defaultPort: 7437 }).requested,
    7440,
  );
  // A 0 buried in the file is damage, not a request: the kernel only ever
  // assigns a real port, so nothing legitimate writes 0 there. It must not
  // become the lead candidate — the daemon would hand 0 to the kernel while
  // believing it had a pinned port.
  assert.deepEqual(
    resolveLocalPortCandidates({ recordedPort: 0, defaultPort: 7437 }),
    { explicit: null, requested: null, candidates: [7437] },
    "a recorded 0 is discarded, not honoured",
  );
  // A recorded value that is out of range for any reason is still refused.
  assert.throws(
    () => resolveLocalPortCandidates({ recordedPort: 99999, defaultPort: 7437 }),
    /local-api\.json port/,
  );
  // A non-integer is still rejected loudly, so the no-silent-substitution rule
  // keeps its point.
  assert.throws(
    () => resolveLocalPortCandidates({ cliPort: "abc", defaultPort: 7437 }),
    /\[0, 65535\]/,
  );
  // ...while 0 stays meaningful where the kernel is allowed to choose.
  assert.equal(parsePort("0", "port"), 0);
  assert.equal(parsePort(8080, "port"), 8080);
  assert.equal(parsePort(" 8080 ", "port"), 8080);
  assert.equal(parsePort("", "port"), undefined);
  assert.equal(parsePort(null, "port"), undefined);
  // A port is read strictly. `Number.parseInt` would stop at the first
  // character it cannot use and turn each of these into a plausible wrong
  // number instead of an error, so the typo would go unnoticed.
  for (const bad of ["80abc", "80.5", "0x10", "1e3", "8080junk", "-1", "65536", "٣"]) {
    assert.throws(
      () => parsePort(bad, "port"),
      /\[0, 65535\]/,
      `parsePort(${JSON.stringify(bad)}) must be rejected, not truncated`,
    );
  }
}

// Candidates must not repeat: a recorded port equal to the default would
// otherwise be tried, fail, and be tried again.
{
  const { candidates } = resolveLocalPortCandidates({
    configuredPort: 7437,
    defaultPort: 7437,
  });
  assert.deepEqual(candidates, [7437]);
}

console.log("local port candidate tests ok");
