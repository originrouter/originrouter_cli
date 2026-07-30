// Stage 9.8: 集中式 CLI 错误信息产品化。
//
// 目标：所有 originrouter 子命令抛出的错误，最终用户在终端看到的是
//   ✗ <headline>          ← 用用户语言说发生了什么
//     <detail — 选填>      ← 技术细节（出现时缩进一行）
//     Next: <actionable>   ← 一个具体命令或动作
// 而不是一串技术栈 trace 或 HTTP 状态码。
//
// 调用方式（每个 handleX 末尾）：
//   } catch (err) {
//     formatCliError(err);   // 直接打印到 stderr 并设 process.exitCode = 1
//     return;
//   }
//
// 不直接抛错的子命令（比如 `handleAuthRotate`）也可以用
// `reportCliError(headline, { next })` 替代手写 console.error。

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";

// 是否启用 ANSI 颜色：管道到文件时不染色
const _useColor = process.stderr && process.stderr.isTTY === true;

/**
 * @typedef {Object} CliErrorView
 * @property {string} headline   一句话告诉用户发生了什么
 * @property {string} [detail]   选填：技术细节（错误码、原始 message 等）
 * @property {string} [next]     选填：可执行的下一步
 */

/**
 * 把任意 thrown value 映射成 CliErrorView。
 * 识别顺序：
 *   1) AuthClientError（HTTP 状态 + 后端 body）
 *   2) err.code 显式标注（PROVIDER_UNSUPPORTED / RELAY_*）
 *   3) err.message 含特定关键词（"revoked" / "expired" / "network" 等）
 *   4) 兜底
 *
 * @param {unknown} err
 * @returns {CliErrorView}
 */
export function classifyError(err) {
  if (!err) {
    return { headline: "Something went wrong.", next: "Run `originrouter doctor` for diagnostics." };
  }

  // AuthClientError: originrouter-cli backend 返回 4xx/5xx
  if (err.name === "AuthClientError" || typeof err.status === "number") {
    return _fromAuthClientError(err);
  }

  // 显式 code 标注
  if (typeof err.code === "string") {
    const view = _fromCode(err.code, err.message);
    if (view) return view;
  }

  // message 关键词匹配（针对 device flow / 内部抛的 plain Error）
  const msg = String(err.message || "");
  if (msg.startsWith("device_flow_expired")) {
    return {
      headline: "Authorization timed out before you approved it.",
      detail: "The 10-minute window expired. Codes are single-use.",
      next: "Run `originrouter login` again.",
    };
  }
  if (msg.startsWith("device_flow_denied")) {
    return {
      headline: "You denied the authorization in the browser.",
      next: "Run `originrouter login` if you want to try again.",
    };
  }
  if (msg.startsWith("device_flow_timeout") || msg.startsWith("device_flow_timeout_after_")) {
    return {
      headline: "No one approved the request before it expired.",
      next: "Run `originrouter login` again, and approve the device in the browser.",
    };
  }
  if (msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND") || msg.includes("fetch failed")) {
    return {
      headline: "Couldn't reach OriginRouter.",
      detail: msg,
      next: "Check your network connection and try again. If the problem persists, run `originrouter doctor`.",
    };
  }

  // 兜底
  return {
    headline: "Something went wrong.",
    detail: msg || String(err),
    next: "Run `originrouter doctor` for diagnostics.",
  };
}

function _fromAuthClientError(err) {
  const coded = typeof err.code === "string"
    ? _fromCode(err.code, err.message)
    : null;
  if (coded) return coded;
  const status = err.status;
  const bodyMsg = (err.body && (err.body.msg || err.body.message)) || "";
  const combined = `${err.message || ""} ${bodyMsg}`.toLowerCase();

  if (status === 401) {
    if (combined.includes("revoked") || combined.includes("invalid_grant")) {
      return {
        headline: "This device was revoked.",
        detail: bodyMsg || undefined,
        next: "Run `originrouter login` to reconnect.",
      };
    }
    return {
      headline: "Sign-in expired.",
      detail: bodyMsg || undefined,
      next: "Run `originrouter login` again.",
    };
  }
  if (status === 403) {
    return {
      headline: "Permission denied.",
      detail: bodyMsg || undefined,
      next: "Run `originrouter doctor` to check your access.",
    };
  }
  if (status === 404) {
    return {
      headline: "OriginRouter server didn't recognize the request.",
      detail: bodyMsg || undefined,
      next: "Check `--api-base-url` matches your server.",
    };
  }
  if (status === 408 || status === 504) {
    return {
      headline: "OriginRouter took too long to respond.",
      detail: `HTTP ${status}.`,
      next: "Try again. If it keeps failing, run `originrouter doctor`.",
    };
  }
  if (status >= 500) {
    return {
      headline: "OriginRouter server is having trouble.",
      detail: `HTTP ${status}${bodyMsg ? ` — ${bodyMsg}` : ""}.`,
      next: "Try again in a minute. If it keeps failing, run `originrouter doctor`.",
    };
  }
  return {
    headline: `OriginRouter rejected the request (HTTP ${status}).`,
    detail: bodyMsg || err.message || undefined,
    next: "Run `originrouter doctor` for diagnostics.",
  };
}

function _fromCode(code, message) {
  switch (code) {
    case "device_flow_denied":
      return {
        headline: "Sign-in was not approved.",
        detail: "This device's saved security credential was cleared.",
        next: "Run `originrouter login` again to create a new device credential.",
      };
    case "device_revoked":
    case "device_identity_revoked":
    case "device_key_recovery_required":
    case "account_encryption_recovery_required":
    case "account_epoch_mismatch":
    case "key_id_mismatch":
    case "invalid_self_signature":
      return {
        headline: "This device needs a new security identity.",
        detail: message,
        next: "Run `originrouter login` again. The pending replacement key will be reused and is not active until authorization finishes.",
      };
    case "unsupported_e2ee_protocol":
    case "unsupported_signing_algorithm":
    case "unsupported_agreement_algorithm":
      return {
        headline: "This OriginRouter CLI version is too old for device sign-in.",
        detail: message,
        next: "Update OriginRouter CLI, then run `originrouter login` again.",
      };
    case "RELAY_LOGIN_REQUIRED":
      return {
        headline: "You're not signed in to OriginRouter.",
        detail: message,
        next: "Run `originrouter login`.",
      };
    case "RELAY_GRANT_REVOKED":
      return {
        headline: "This device was revoked or expired.",
        detail: message,
        next: "Run `originrouter login` to reconnect.",
      };
    case "RELAY_REFRESH_FAILED":
      return {
        headline: "Couldn't refresh your OriginRouter token.",
        detail: message,
        next: "Run `originrouter doctor` to check connectivity to the relay.",
      };
    case "PROVIDER_UNSUPPORTED":
      // claudeConfig.js 抛的，message 通常已含 "Run `originrouter login`"
      return {
        headline: message || "OriginRouter provider isn't ready.",
        next: "Run `originrouter login` if you haven't signed in yet.",
      };
    case "active_device_limit_reached":
      return {
        headline: "This account already has 50 active devices.",
        next: "Revoke a device you no longer use in the App, then try again.",
      };
    case "daily_key_rotation_limit_reached":
      return {
        headline: "This account has already rotated device keys 10 times today.",
        next: "Try again after the next UTC day begins.",
      };
    case "ENOENT":
      return {
        headline: "File not found.",
        detail: message,
        next: "Run `originrouter login` to set up credentials.",
      };
    default:
      return null;
  }
}

/**
 * 把 CliErrorView 渲染成多行字符串（带 ANSI 颜色）。
 */
export function renderCliError(view) {
  const c = _useColor;
  const x = (code) => (c ? code : "");
  const lines = [];
  lines.push(`${x(RED)}${x(BOLD)}✗ ${view.headline}${x(RESET)}`);
  if (view.detail) {
    lines.push(`${x(DIM)}  ${view.detail}${x(RESET)}`);
  }
  if (view.next) {
    lines.push(`${x(DIM)}  Next: ${view.next}${x(RESET)}`);
  }
  return lines.join("\n");
}

/**
 * 一站式：分类 → 渲染 → 打印到 stderr → 设置 exitCode = 1。
 * 适用于 try/catch 末尾。
 */
export function formatCliError(err) {
  const view = classifyError(err);
  process.stderr.write(renderCliError(view) + "\n");
  process.exitCode = 1;
  return view;
}

/**
 * 直接报告一个错误（不需要 thrown value）。
 * 用于像 handleAuthRotate 这种"我自己决定要不要走 catch"的地方。
 */
export function reportCliError(headline, opts = {}) {
  const view = { headline, detail: opts.detail, next: opts.next };
  process.stderr.write(renderCliError(view) + "\n");
  process.exitCode = 1;
  return view;
}
