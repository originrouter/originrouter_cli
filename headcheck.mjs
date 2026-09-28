import { createHash } from "node:crypto";

// Real rows from the live DB for user_id=1
const rows = [
 ["device-862668c5512fd8aadef7f266456de1a0","originrouter_cli",1,1,"sha256:yxHsO_OrrOfmWrhK3e1x-O3FBYdhjiDk5k1oEWqdgO8",null],
 ["device-fdc03b4b8ec94badee9dc2f84c6aef96","originrouter_cli",1,1,"sha256:0wHj_uwsQxCuGdI4P72j9_D3pvamTAww5bwaI5qeb4A",null],
 ["originrouter_app_3eae2c6c5628e6690218e5fc0b771862","originrouter_app",1,1,"sha256:hTVe05IdwxKlH-z_NqVOfDiC2u4JrGIhkEYfaYv1JTQ",null],
 ["originrouter_app_b5f71f8c6c576045b958156476691e0a","originrouter_app",1,1,"sha256:Q2INZlf53uDP3ZecXBqB9THgmCXcF2GM7eBCy_tvmHk",1790501412],
 ["originrouter_app_b5f71f8c6c576045b958156476691e0a","originrouter_app",1,2,"sha256:Y5DkgHxkwfGxkJQsnZLDYU7RdMhEuuZXy2pEFGPi6yA",null],
];
console.log("live (revoked_at IS NULL) rows:");
for (const r of rows) console.log(" ", r[0], "v"+r[3], r[5] ? "REVOKED" : "live");
console.log("\ndistinct devices:", new Set(rows.map(r=>r[0])).size);
console.log("total key rows:", rows.length);
