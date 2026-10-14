// `suggestLanHost` decides the address a pairing code points the App at.
//
// It matters more than it looks, in both directions. The pairing line used to
// advertise `127.0.0.1`, which on a phone is the phone itself — pairing could
// not work from any other device. That was fixed by scanning the interfaces,
// which fixed the wildcard bind and broke the loopback one: a daemon bound to
// `127.0.0.1` advertised a LAN address nothing was listening on, so pairing
// worked only from the host. The rule is that the answer must be an address
// the daemon actually accepts on. The App still lets the user override
// whatever comes out.

import assert from "node:assert/strict";

import {
  suggestLanHost,
  resolveBindAddress,
  resolveAllowLan,
  bindAddressConflict,
  DEFAULT_BIND_ADDRESS,
  DEFAULT_ALLOW_LAN,
} from "../src/local/localApi.js";

const v4 = (address, extra = {}) => ({ address, family: "IPv4", internal: false, ...extra });
const v6 = (address, extra = {}) => ({ address, family: "IPv6", internal: false, ...extra });

// A configured non-loopback bind is already the answer; guessing would
// override an explicit operator choice.
for (const bind of ["192.168.1.10", "10.1.2.3", "example.internal"]) {
  assert.equal(
    suggestLanHost(bind, {}),
    bind,
    `an explicit bind address of ${bind} must be preserved`,
  );
}

// A wildcard bind accepts on every interface, so the LAN address is real and
// is the one a phone on the same network would use.
for (const bind of ["0.0.0.0", "::", "::0", "", undefined]) {
  assert.equal(
    suggestLanHost(bind, { en0: [v4("192.168.1.42")] }),
    "192.168.1.42",
    `bind ${String(bind)} must resolve to the LAN address`,
  );
}

// A loopback bind answers "only this machine", which is a definite answer and
// not a missing one. Scanning anyway advertised a LAN address with no
// listener behind it, so pairing silently worked only from the host.
for (const bind of ["127.0.0.1", "::1", "localhost"]) {
  assert.equal(
    suggestLanHost(bind, { en0: [v4("192.168.1.42")] }),
    bind,
    `bind ${bind} must stay on loopback; nothing is listening on the LAN address`,
  );
}

// The default the daemon ships with is the wildcard, so the pairing line it
// produces is reachable from a phone. This is the pairing bug in one
// assertion: it fails if the default moves back to loopback while the
// advertised address keeps coming from interface discovery.
assert.equal(DEFAULT_BIND_ADDRESS, "0.0.0.0");
assert.equal(
  suggestLanHost(DEFAULT_BIND_ADDRESS, { en0: [v4("192.168.1.42")] }),
  "192.168.1.42",
  "the shipped default must advertise a LAN address the socket accepts on",
);

// Private ranges win over anything else, so a host with both a public and a
// private interface suggests the one a phone could actually reach.
assert.equal(
  suggestLanHost("0.0.0.0", {
    en0: [v4("203.0.113.7")],
    en1: [v4("10.0.0.5")],
  }),
  "10.0.0.5",
);
assert.equal(
  suggestLanHost("0.0.0.0", {
    en0: [v4("172.20.0.1")],
    en1: [v4("172.32.0.1")],
  }),
  "172.20.0.1",
  "172.16/12 is private; 172.32 is not",
);

// Virtual interfaces are noise: a phone on the same network is never on the
// Docker bridge or a VPN tunnel.
assert.equal(
  suggestLanHost("0.0.0.0", {
    docker0: [v4("172.17.0.1")],
    utun3: [v4("10.8.0.1")],
    en0: [v4("192.168.1.42")],
  }),
  "192.168.1.42",
  "Docker and VPN interfaces must not be suggested",
);

// IPv6-only and loopback-only machines have nothing better to offer, and a
// link-local address is still more useful than the machine itself.
assert.equal(
  suggestLanHost("0.0.0.0", { en0: [v4("169.254.10.1")] }),
  "169.254.10.1",
);
assert.equal(
  suggestLanHost("0.0.0.0", { en0: [v6("fe80::1")] }),
  "127.0.0.1",
  "an IPv6-only machine has no IPv4 answer",
);
assert.equal(
  suggestLanHost("0.0.0.0", {
    lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  }),
  "127.0.0.1",
  "with nothing to go on, fall back to loopback",
);

// `resolveBindAddress` decides which address the daemon binds, and the marker
// is what makes the new default reachable on an install that already has a
// config file.
//
// The daemon records the address it bound into `local-api.json` on every
// start. Without a marker saying whether a human chose it, that record reads
// as an instruction, and the very first daemon to run pins its own default
// forever — which is exactly how the old loopback default became permanent
// and un-upgradeable.

// A config written before the marker existed has no field, and absent reads
// as "nobody chose this". This is the migration: an existing install moves to
// the shipped default without anyone editing a file.
assert.deepEqual(
  resolveBindAddress({ config: { bindAddress: "127.0.0.1" } }),
  { bindAddress: DEFAULT_BIND_ADDRESS, isOperatorSet: false, source: "default" },
  "an unmarked record is where we landed, not what someone asked for",
);

// An operator's choice is honoured and stays honoured.
assert.deepEqual(
  resolveBindAddress({ config: { bindAddress: "127.0.0.1", bindAddressSource: "operator" } }),
  { bindAddress: "127.0.0.1", isOperatorSet: true, source: "config" },
);

// Nothing on disk.
assert.deepEqual(
  resolveBindAddress({ config: {} }),
  { bindAddress: DEFAULT_BIND_ADDRESS, isOperatorSet: false, source: "default" },
);
assert.deepEqual(
  resolveBindAddress({}),
  { bindAddress: DEFAULT_BIND_ADDRESS, isOperatorSet: false, source: "default" },
);

// A flag or an env var is a direct instruction and beats the config.
assert.deepEqual(
  resolveBindAddress({ flag: "10.0.0.5", config: { bindAddress: "0.0.0.0", bindAddressSource: "operator" } }),
  { bindAddress: "10.0.0.5", isOperatorSet: true, source: "flag" },
);
assert.deepEqual(
  resolveBindAddress({ env: "10.0.0.5", config: { bindAddress: "127.0.0.1", bindAddressSource: "operator" } }),
  { bindAddress: "10.0.0.5", isOperatorSet: true, source: "env" },
);

// But neither writes itself back as operator intent: a flag passed to one run
// is a fact about that run, and persisting it would turn a one-shot into a
// permanent change nobody asked for.
assert.equal(
  resolveBindAddress({ flag: "10.0.0.5" }).isOperatorSet === true,
  true,
  "the flag is authoritative for this run",
);

// `startLocalApi` boots on the default alone, with no flag and no config. It
// used to need `--allow-lan` to start at all, because the loopback default and
// the loopback-only consent flag were set independently and could disagree.
assert.equal(DEFAULT_ALLOW_LAN, true, "the consent that guards the default must cover it");

// Consent, and the one migration that would have bricked every existing
// install.
//
// The daemon wrote `allowLan: false` into `local-api.json` on every start
// under the old default, so every config in the field has one. Read as an
// instruction, that `false` meets the new `0.0.0.0` default as a conflict and
// the daemon refuses to start — an upgrade that takes the service down and
// says only that two settings disagree. It is a record of a default, not a
// decision, and the marker is what tells them apart.
assert.equal(
  resolveAllowLan({ bindAddress: "127.0.0.1", config: {} }),
  false,
  "a loopback bind exposes nothing, so consent does not arise",
);
assert.equal(
  resolveAllowLan({ bindAddress: "0.0.0.0", config: {} }),
  true,
  "the shipped pair must start with no config at all",
);
assert.equal(
  resolveAllowLan({ bindAddress: "0.0.0.0", config: { allowLan: false } }),
  true,
  "an unmarked `false` is the old default's record, not an operator's choice",
);
assert.equal(
  resolveAllowLan({
    bindAddress: "0.0.0.0",
    config: { allowLan: false, allowLanSource: "operator" },
  }),
  false,
  "an operator's own `off` is honoured",
);
assert.equal(
  resolveAllowLan({
    bindAddress: "0.0.0.0",
    config: { allowLan: true, allowLanSource: "operator" },
  }),
  true,
);
assert.equal(resolveAllowLan({ bindAddress: "0.0.0.0", env: "0" }), false);
assert.equal(resolveAllowLan({ bindAddress: "0.0.0.0", flag: false }), false);

// The contradiction is reported, not discovered at boot.
assert.match(
  String(bindAddressConflict("0.0.0.0", false)),
  /reachable from other machines but LAN access is off/,
);
assert.equal(bindAddressConflict("0.0.0.0", true), null);
assert.equal(bindAddressConflict("127.0.0.1", false), null);
assert.equal(bindAddressConflict("::1", false), null);

console.log("lan host suggestion tests ok");