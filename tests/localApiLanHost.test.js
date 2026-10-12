// `suggestLanHost` decides the address a pairing code points the App at.
//
// It matters more than it looks: the pairing line used to advertise
// `127.0.0.1`, which on a phone is the phone itself — the pairing could not
// work from any other device. These rules are what replaced that, and the App
// still lets the user override whatever comes out.

import assert from "node:assert/strict";

import { suggestLanHost } from "../src/local/localApi.js";

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

// The wildcard and loopback binds are exactly the cases the old line got
// wrong, so they are the ones that must fall through to interface discovery.
for (const bind of ["0.0.0.0", "::", "::0", "127.0.0.1", "::1", "localhost", "", undefined]) {
  assert.equal(
    suggestLanHost(bind, { en0: [v4("192.168.1.42")] }),
    "192.168.1.42",
    `bind ${String(bind)} must resolve to the LAN address`,
  );
}

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

console.log("lan host suggestion tests ok");