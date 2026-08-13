#!/usr/bin/env node
/**
 * 各大厂商 API key 有效性检测。
 * 对每个已配置（或临时传入）的密钥，依次尝试：
 *   1. GET {baseUrl}/models（OpenAI 兼容端点，零费用）
 *   2. 兜底：最小 chat/completions 请求（max_tokens=1）
 *
 * 用法:
 *   node scripts/check-keys.js                          # 检测当前已配置的全部密钥
 *   node scripts/check-keys.js --all                    # 连未配置的密钥一起展示
 *   node scripts/check-keys.js AGNES_API_KEY=sk-xxx VISION_API_KEY=yyy   # 检测临时密钥（不落盘）
 *
 * 零 npm 依赖，仅 Node.js 内置模块。
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { execFileSync } = require("child_process");

// ---------- 与 vision.js 相同的密钥读取：环境变量 → scripts/.env → 父目录 .env → macOS Keychain ----------
function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const result = {};
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

const env = {
  ...process.env,
  ...parseEnvFile(path.join(__dirname, ".env")),
  ...parseEnvFile(path.join(__dirname, "..", ".env")),
};

const KEYCHAIN_SERVICE = "vision-fallback";
function keychainGet(name) {
  if (process.platform !== "darwin") return "";
  try {
    const v = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return v.trim();
  } catch {
    return "";
  }
}

const KEY_NAMES = [
  "AGNES_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "VISION_API_KEY",
  "GLM4V_API_KEY",
  "GLM_THINKING_API_KEY",
  "DASHSCOPE_API_KEY",
  "QWEN3_API_KEY",
];
for (const k of KEY_NAMES) {
  if (!env[k]) {
    const v = keychainGet(k);
    if (v) env[k] = v;
  }
}

const TIMEOUT_MS = Number(env.CHECK_TIMEOUT_MS || 15000);

// ---------- 平台定义 ----------
const PLATFORMS = [
  {
    id: "zhipu",
    name: "智谱 GLM",
    keyNames: ["VISION_API_KEY", "GLM4V_API_KEY", "GLM_THINKING_API_KEY"],
    keyName: "VISION_API_KEY",
    baseUrl: () => (env.VISION_BASE_URL || "https://open.bigmodel.cn/api/paas/v4").replace(/\/+$/, ""),
    model: () => env.GLM4V_MODEL || "glm-4v-flash",
    note: "免费额度 · glm-4v-flash",
  },
  {
    id: "agnes",
    name: "Agnes 聚合",
    keyNames: ["AGNES_API_KEY"],
    keyName: "AGNES_API_KEY",
    baseUrl: () => (env.AGNES_BASE_URL || "https://apihub.agnes-ai.com/v1").replace(/\/+$/, ""),
    model: () => env.AGNES25_MODEL || "agnes-2.5-flash",
    note: "OpenAI 兼容聚合平台",
  },
  {
    id: "dashscope",
    name: "阿里云千问",
    keyNames: ["DASHSCOPE_API_KEY", "QWEN3_API_KEY"],
    keyName: "DASHSCOPE_API_KEY",
    baseUrl: () => (env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, ""),
    model: () => env.QWEN3_MODEL || "qwen3-vl-plus",
    note: "付费可选",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    keyNames: ["CLOUDFLARE_API_TOKEN"],
    keyName: "CLOUDFLARE_API_TOKEN",
    baseUrl: () =>
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID || ""}/ai/v1`.replace(/\/+$/, ""),
    needsAccountId: true,
    model: () => env.CLOUDFLARE_MODEL || "@cf/meta/llama-4-scout-17b-16e-instruct",
    note: "免费额度 · 需 Account ID",
  },
];

// ---------- HTTP 请求 ----------
function httpJson(method, url, headers, body) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      resolve({ status: 0, body: "", error: `非法 URL: ${url}` });
      return;
    }
    const transport = u.protocol === "https:" ? https : http;
    const req = transport.request(
      u,
      {
        method,
        headers: { Accept: "application/json", ...headers },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: data, error: "" }));
      }
    );
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ status: 0, body: "", error: e.message }));
    if (body) req.write(body);
    req.end();
  });
}

function extractError(body) {
  try {
    const j = JSON.parse(body);
    if (j.error) {
      if (typeof j.error === "string") return j.error.slice(0, 160);
      if (j.error.message) return String(j.error.message).slice(0, 160);
      if (j.error.code) return String(j.error.code).slice(0, 160);
    }
    if (j.errors && j.errors[0]) return String(j.errors[0].message || JSON.stringify(j.errors[0])).slice(0, 160);
    if (j.message) return String(j.message).slice(0, 160);
  } catch {
    /* 非 JSON，忽略 */
  }
  return body ? body.replace(/\s+/g, " ").trim().slice(0, 120) : "";
}

// ---------- 核心验证 ----------
async function verifyApiKey(platform, apiKey) {
  const auth = { Authorization: `Bearer ${apiKey}` };

  // Cloudflare 缺 Account ID 时，退回验证 token 本身（无需 account id）
  if (platform.id === "cloudflare" && !env.CLOUDFLARE_ACCOUNT_ID) {
    const r = await httpJson("GET", "https://api.cloudflare.com/client/v4/user/tokens/verify", auth);
    if (r.status === 200) {
      return {
        ok: true,
        status: 200,
        method: "tokens/verify",
        detail: "Token 有效，但缺 CLOUDFLARE_ACCOUNT_ID（在 .env 或 Keychain 中补上即可用）",
      };
    }
    return {
      ok: false,
      status: r.status,
      method: "tokens/verify",
      detail: extractError(r.body) || r.error || `HTTP ${r.status}`,
    };
  }

  // 1) 零费用验证：GET /models
  const r1 = await httpJson("GET", `${platform.baseUrl()}/models`, auth);
  if (r1.status >= 200 && r1.status < 300) {
    return { ok: true, status: r1.status, method: "GET /models", detail: "" };
  }
  if (r1.status === 429) {
    return { ok: true, status: 429, method: "GET /models", detail: "密钥有效但被限流（429）" };
  }

  // 2) 兜底：最小 chat 请求（部分平台 models 端点不可用）
  const payload = {
    model: platform.model(),
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 1,
    stream: false,
  };
  const r2 = await httpJson(
    "POST",
    `${platform.baseUrl()}/chat/completions`,
    { ...auth, "Content-Type": "application/json" },
    JSON.stringify(payload)
  );
  if (r2.status >= 200 && r2.status < 300) {
    return { ok: true, status: r2.status, method: "chat/completions", detail: "" };
  }
  if (r2.status === 429) {
    return { ok: true, status: 429, method: "chat/completions", detail: "密钥有效但被限流（429）" };
  }
  return {
    ok: false,
    status: r2.status || r1.status,
    method: r2.status ? "chat/completions" : "GET /models",
    detail: extractError(r2.body) || extractError(r1.body) || r2.error || r1.error || `HTTP ${r2.status || r1.status}`,
  };
}

function statusText(res) {
  if (res.ok) return "✅ 有效";
  if (res.status === 401 || res.status === 403) return "❌ 无效";
  if (res.status === 0) return "❌ 网络错误";
  return "❌ 失败";
}

function maskKey(k) {
  if (!k) return "";
  if (k.length <= 8) return "****";
  return `…${k.slice(-4)}`;
}

// ---------- 结果表格 ----------
function renderTable(rows) {
  const w = { name: 0, status: 0, detail: 0 };
  for (const r of rows) {
    w.name = Math.max(w.name, r.name.length);
    w.status = Math.max(w.status, r.status.length);
    w.detail = Math.max(w.detail, r.detail.length);
  }
  const sep = `├─${"─".repeat(w.name + 2)}─┬─${"─".repeat(w.status + 2)}─┬─${"─".repeat(Math.min(w.detail, 60) + 2)}─┤`;
  const lines = [`┌─${"─".repeat(w.name + 2)}─┬─${"─".repeat(w.status + 2)}─┬─${"─".repeat(Math.min(w.detail, 60) + 2)}─┐`];
  lines.push(`│ ${"平台".padEnd(w.name)} │ ${"状态".padEnd(w.status)} │ ${"说明".padEnd(Math.min(w.detail, 60))} │`);
  lines.push(sep);
  for (const r of rows) {
    const detail = r.detail.length > 60 ? r.detail.slice(0, 57) + "…" : r.detail;
    lines.push(`│ ${r.name.padEnd(w.name)} │ ${r.status.padEnd(w.status)} │ ${detail.padEnd(60)} │`);
  }
  lines.push(`└─${"─".repeat(w.name + 2)}─┴─${"─".repeat(w.status + 2)}─┴─${"─".repeat(Math.min(w.detail, 60) + 2)}─┘`);
  return lines.join("\n");
}

// ---------- 主流程 ----------
async function main() {
  const argv = process.argv.slice(2);
  const showAll = argv.includes("--all");
  const tempKeys = {};
  for (const arg of argv) {
    if (arg.includes("=") && !arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      tempKeys[arg.slice(0, eq).trim()] = arg.slice(eq + 1).trim();
    }
  }

  const rows = [];
  const tasks = [];

  for (const platform of PLATFORMS) {
    let apiKey = "";
    let source = "";
    for (const name of platform.keyNames) {
      if (tempKeys[name]) {
        apiKey = tempKeys[name];
        source = "临时参数";
        break;
      }
    }
    if (!apiKey) {
      for (const name of platform.keyNames) {
        if (env[name]) {
          apiKey = env[name];
          source = name;
          break;
        }
      }
    }

    if (!apiKey) {
      rows.push({
        name: platform.name,
        status: showAll ? "⏭ 未配置" : "",
        detail: showAll ? `${platform.note} · 键名 ${platform.keyNames.join(" / ")}` : "",
        show: showAll,
      });
      continue;
    }

    tasks.push(
      verifyApiKey(platform, apiKey).then((res) => {
        const detail = [
          res.method,
          source === "临时参数" ? "临时传入（未落盘）" : source ? `来自 ${source}` : "",
          res.detail,
        ]
          .filter(Boolean)
          .join(" · ");
        rows.push({
          name: platform.name,
          status: statusText(res),
          detail,
          show: true,
        });
      })
    );
  }

  await Promise.all(tasks);
  rows.sort((a, b) => (a.show === b.show ? 0 : a.show ? -1 : 1));
  console.log(renderTable(rows));

  const okCount = rows.filter((r) => r.show && r.status.startsWith("✅")).length;
  const badCount = rows.filter((r) => r.show && r.status.startsWith("❌")).length;
  if (okCount || badCount) {
    console.log(`\n共验证 ${okCount + badCount} 个密钥：${okCount} 个有效，${badCount} 个无效。`);
  }
  if (badCount > 0) process.exitCode = 1;
}

// 被 setup.js require 时作为模块复用，不自动运行主流程
if (require.main === module) {
  main();
}

module.exports = { PLATFORMS, env, verifyApiKey, maskKey, main };
