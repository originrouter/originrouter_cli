import { spawn } from "node:child_process";

import { getStateDir } from "../persistence/state.js";
import { isInstalled, pythonBinaryPath } from "./litellm.js";
import { getLitellmProfile, prefixFor } from "./litellmCatalog.js";

const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const RESULT_MARKER = "ORIGINROUTER_LITELLM_PROBE=";
const ERROR_MARKER = "ORIGINROUTER_LITELLM_PROBE_ERROR=";

// Run the same LiteLLM adapter path used by the generated proxy config. This
// deliberately does not guess an upstream HTTP protocol from the provider
// name: Bedrock, Vertex, Azure, Anthropic, OpenAI-compatible endpoints, and
// every other catalog adapter are all invoked through litellm.completion().
// Secrets are delivered over stdin rather than argv so they never appear in
// the process list.
const LITELLM_PROBE_SCRIPT = String.raw`
import json
import os
import sys

os.environ.setdefault("LITELLM_LOG", "ERROR")

try:
    import litellm

    litellm.drop_params = True
    litellm.suppress_debug_info = True

    request = json.load(sys.stdin)
    response = litellm.completion(
        model=request["model"],
        messages=[{"role": "user", "content": "Reply OK"}],
        stream=False,
        max_tokens=8,
        timeout=max(1.0, float(request.get("timeoutMs", 20000)) / 1000.0),
        **request.get("params", {}),
    )

    if hasattr(response, "model_dump"):
        payload = response.model_dump()
    elif isinstance(response, dict):
        payload = response
    elif hasattr(response, "json"):
        payload = json.loads(response.json())
    else:
        raise RuntimeError("LiteLLM returned an unsupported response object")

    choices = payload.get("choices") if isinstance(payload, dict) else None
    if not isinstance(choices, list) or not choices:
        raise RuntimeError("LiteLLM returned no completion choices")

    choice = choices[0] if isinstance(choices[0], dict) else {}
    message = choice.get("message") if isinstance(choice.get("message"), dict) else {}
    content = message.get("content")
    reasoning = message.get("reasoning_content") or message.get("reasoning")
    tool_calls = message.get("tool_calls")
    legacy_text = choice.get("text")

    def has_content(value):
        if isinstance(value, str):
            return bool(value.strip())
        if isinstance(value, list):
            return any(
                (isinstance(item, str) and item.strip())
                or (isinstance(item, dict) and str(item.get("text", "")).strip())
                for item in value
            )
        return False

    if not (
        has_content(content)
        or has_content(reasoning)
        or has_content(legacy_text)
        or (isinstance(tool_calls, list) and len(tool_calls) > 0)
    ):
        raise RuntimeError("LiteLLM returned a completion without generated content")

    result = {
        "responseModel": payload.get("model"),
        "finishReason": choice.get("finish_reason"),
    }
    print("${RESULT_MARKER}" + json.dumps(result, ensure_ascii=False))
except Exception as error:
    failure = {
        "type": type(error).__name__,
        "message": str(error),
    }
    print("${ERROR_MARKER}" + json.dumps(failure, ensure_ascii=False))
    sys.exit(2)
`;

function resolveEnvReference(value, env) {
  if (typeof value !== "string") return value;
  const match = /^os\.environ\/([A-Z_][A-Z0-9_]*)$/.exec(value);
  return match ? env?.[match[1]] || "" : value;
}

function firstEnvironmentValue(hint, env) {
  return String(hint || "")
    .split("/")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => env?.[name])
    .find((value) => typeof value === "string" && value.trim()) || "";
}

function providerField(provider, field, env) {
  const direct = resolveEnvReference(provider?.[field.key], env);
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  return firstEnvironmentValue(field.envVar, env).trim();
}

export function buildLitellmProbeRequest(provider, modelId, { env = process.env } = {}) {
  const id = String(modelId || "").trim();
  if (!id) throw new Error("model id is required");
  const providerId = String(provider?.litellmProvider || "").trim();
  if (!providerId) throw new Error("litellmProvider is required");

  const profile = getLitellmProfile(providerId);
  const params = {};
  for (const field of profile.fields) {
    const value = providerField(provider, field, env);
    if (value) params[field.litellmParam] = value;
  }
  return {
    model: `${prefixFor(providerId)}/${id}`,
    params,
  };
}

function redactedProcessError(message, params = {}) {
  let safe = String(message || "LiteLLM model verification failed");
  for (const [key, value] of Object.entries(params)) {
    if (!/key|token|secret|credential/i.test(key)) continue;
    if (typeof value === "string" && value.length > 3) {
      safe = safe.replaceAll(value, "[redacted]");
    }
  }
  return safe
    .replace(/(authorization:\s*bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .slice(0, 1200);
}

function markerPayload(output, marker) {
  const index = output.lastIndexOf(marker);
  if (index < 0) return null;
  const line = output.slice(index + marker.length).split(/\r?\n/, 1)[0];
  try { return JSON.parse(line); }
  catch { return null; }
}

export async function runLitellmCompletion(request, {
  stateDir = getStateDir(),
  timeoutMs = 20_000,
  spawnFn = spawn,
} = {}) {
  if (!isInstalled(stateDir)) {
    throw new Error("LiteLLM runtime is not installed; install it before testing models");
  }
  const executable = pythonBinaryPath(stateDir);
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer;
    const child = spawnFn(executable, ["-c", LITELLM_PROBE_SCRIPT], {
      env: {
        ...process.env,
        LITELLM_LOG: "ERROR",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const append = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > MAX_PROCESS_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(() => reject(new Error("LiteLLM verification produced too much output")));
        return current;
      }
      return next;
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", (error) => {
      finish(() => reject(new Error(`Could not start LiteLLM verification: ${error.message}`)));
    });
    child.on("close", (code) => {
      finish(() => {
        if (timedOut) {
          reject(new Error("LiteLLM model verification timed out"));
          return;
        }
        const result = markerPayload(stdout, RESULT_MARKER);
        if (code === 0 && result) {
          resolve(result);
          return;
        }
        const failure = markerPayload(stdout, ERROR_MARKER);
        const detail = failure?.message || stderr.trim() || `process exited with code ${code}`;
        reject(new Error(redactedProcessError(detail, request.params)));
      });
    });
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs + 2_000);
    child.stdin.end(JSON.stringify({ ...request, timeoutMs }));
  });
}

export async function probeProviderModel(provider, modelId, {
  completionRunner = runLitellmCompletion,
  env = process.env,
  timeoutMs = 20_000,
} = {}) {
  const request = buildLitellmProbeRequest(provider, modelId, { env });
  const startedAt = Date.now();
  let completion;
  try {
    completion = await completionRunner(request, { timeoutMs });
  } catch (error) {
    throw new Error(`model verification failed through LiteLLM: ${error?.message || "unknown error"}`);
  }
  return {
    ok: true,
    model: String(modelId).trim(),
    litellmModel: request.model,
    responseModel: completion?.responseModel || null,
    finishReason: completion?.finishReason || null,
    latencyMs: Date.now() - startedAt,
    checkedAt: new Date().toISOString(),
  };
}
