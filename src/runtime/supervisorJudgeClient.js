import { accessTokenFor, OAUTH_RESOURCES } from "./authContract.js";
import { ensureFreshAccessToken } from "./oauthTokenRefresher.js";
import { redactDisplayText } from "../security/displayRedaction.js";

const DEFAULT_ENDPOINT = "https://app.easytransnote.com/ai/v1/supervisor/judge";
const POLICY = Object.freeze({
  verdict_only: true,
  untrusted_snapshot: true,
  fallback_to_skip_on_error: true,
});
const VERDICTS = new Set(["act", "skip", "needs_user"]);
// The server holds the same floor; holding it here too means a server that
// forgot cannot talk the device past it.
const ACT_CONFIDENCE_FLOOR = 0.7;

// The runtime supervisor's AI judgement (docs/runtime-tasks.md §8): whether
// one card should act at one checkpoint. A verdict and nothing else comes
// back; the action stays the one written in the card.
export class SupervisorJudgeClient {
  constructor({
    stateDir,
    endpoint = process.env.ORIGINROUTER_SUPERVISOR_JUDGE_URL || DEFAULT_ENDPOINT,
    fetchFn = globalThis.fetch,
    ensureFreshAccessTokenFn = ensureFreshAccessToken,
    timeoutMs = 30_000,
  } = {}) {
    this.stateDir = stateDir;
    this.endpoint = endpoint;
    this.fetchFn = fetchFn;
    this.ensureFreshAccessTokenFn = ensureFreshAccessTokenFn;
    this.timeoutMs = timeoutMs;
  }

  async judge({ judgeId, runtime, snapshot, instruction }) {
    const credential = await this.ensureFreshAccessTokenFn({
      stateDir: this.stateDir,
      resource: OAUTH_RESOURCES.AI,
      fetchFn: this.fetchFn,
    });
    const token = accessTokenFor(credential, OAUTH_RESOURCES.AI)?.token;
    if (!token) throw Object.assign(new Error("OriginRouter AI access token is unavailable"), { code: "SUPERVISOR_JUDGE_AUTH_REQUIRED" });
    const response = await this.fetchFn(this.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        protocol_version: "1",
        judge_id: String(judgeId || "").replace(/[^A-Za-z0-9._~:-]/g, "_").slice(0, 191),
        agent: { runtime: String(runtime || "unknown").slice(0, 32) },
        snapshot: {
          checkpoint: snapshot.checkpoint,
          end_reason: snapshot.endReason,
          error_class: snapshot.error?.class || null,
          last_reply: redactDisplayText(snapshot.lastReply || "", 4000),
          last_reply_empty: snapshot.lastReplyEmpty === true,
          idle_seconds: Math.max(0, Math.floor(Number(snapshot.idleSeconds) || 0)),
        },
        instruction: String(instruction || "").slice(0, 1000),
        policy: POLICY,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw Object.assign(new Error(`supervisor judge HTTP ${response.status}`), { code: "SUPERVISOR_JUDGE_FAILED" });
    }
    const judgement = (await response.json())?.data?.judgement;
    const verdict = String(judgement?.verdict || "");
    const confidence = Number(judgement?.confidence);
    if (!VERDICTS.has(verdict) || !Number.isFinite(confidence)) {
      throw Object.assign(new Error("supervisor judge returned an invalid verdict"), { code: "SUPERVISOR_JUDGE_INVALID" });
    }
    return {
      verdict: verdict === "act" && confidence < ACT_CONFIDENCE_FLOOR ? "skip" : verdict,
      confidence,
      reason: String(judgement.reason || "").slice(0, 400),
    };
  }
}
