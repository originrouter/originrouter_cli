import { createHash } from "node:crypto";
const h = (s) => createHash("sha256").update(s).digest("base64url").slice(0,22);
// Three cache files observed => three past/current sessions on this machine
const suffixes = ["1QSaFerg2j3WCdQK7Og-Pg","CXoFuJgVtIHAhcqYJG9h2m","pDmb24ApSfvEzWnlYDXo9D"];
console.log("cache files = distinct sessionIds ever used on this machine:", suffixes.length);
console.log("current session suffix:", h("or_ses_UYZnzwQvpitYwLkzCi3HzPt7nBeVEgo4"));
