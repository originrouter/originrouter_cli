import { createHash } from "node:crypto";
const h = (s) => createHash("sha256").update(s).digest("base64url").slice(0,22);
console.log("this session or_ses_UYZnzwQvpitYwLkzCi3HzPt7nBeVEgo4 ->", h("or_ses_UYZnzwQvpitYwLkzCi3HzPt7nBeVEgo4"));
console.log("account ns da4ac1f6... ->", h("da4ac1f6bb8941db0a5c8888100005ecdc7e5feafbe11293a3d49213bc95f61c"));
console.log("caches present: 1QSaFerg2j3WCdQK7Og-Pg, CXoFuJgVtIHAhcqYJG9h2m, pDmb24ApSfvEzWnlYDXo9D");
