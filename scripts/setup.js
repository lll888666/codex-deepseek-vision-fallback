#!/usr/bin/env node
/**
 * 🔑 视觉 API 密钥配置向导（交互式"盒子"）
 *
 * 使用人只需说一句话（如"配置 API key"），智能体运行本脚本即可：
 *   1. 展示各大厂商配置表单（终端 ANSI 盒子）
 *   2. 逐项隐藏输入密钥（不回显、不进聊天记录）
 *   3. 立即调用验证逻辑测试密钥是否有效
 *   4. 写入 macOS Keychain 或 scripts/.env（git-ignored）保存配置
 *
 * 用法:
 *   node scripts/setup.js        # 交互式配置
 *   node scripts/setup.js --check-only   # 只检测当前配置，不进入填写流程
 *   node scripts/setup.js --non-interactive VISION_API_KEY=xxx AGNES_API_KEY=yyy
 *                                 # 非交互：临时密钥只验证，不保存
 *
 * 零 npm 依赖，仅 Node.js 内置模块。
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { execFileSync, spawnSync } = require("child_process");

const { PLATFORMS, env, verifyApiKey, maskKey } = require("./check-keys.js");

const KEYCHAIN_SERVICE = "vision-fallback";
const ENV_FILE = path.join(__dirname, ".env");
const isTTY = Boolean(process.stdin.isTTY);

// ---------- 终端样式 ----------
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};
const color = (code, s) => (isTTY ? `${code}${s}${C.reset}` : s);

function box(title, lines, opts = {}) {
  const maxWidth = opts.maxWidth || 84;
  const body = [...lines];
  const width = Math.min(maxWidth, Math.max(title.length + 4, ...body.map((l) => l.length + 2), 46));
  const fit = (s) => (s.length > width - 4 ? s.slice(0, width - 7) + "…" : s);
  const pad = (s) => `│ ${fit(s).padEnd(width - 4)} │`;
  const out = [];
  out.push(`┌${"─".repeat(width - 2)}┐`);
  out.push(`│ ${color(C.bold + C.cyan, fit(title).padEnd(width - 4))} │`);
  out.push(`├${"─".repeat(width - 2)}┤`);
  for (const l of body) out.push(pad(l));
  out.push(`└${"─".repeat(width - 2)}┘`);
  return out.join("\n");
}

// ---------- 交互基础 ----------
// 非 TTY（管道/自动化）下自行管理行队列：一次性到达的输入行全部入队，
// 避免 readline.question 的 Promise 微任务与同步消费竞争导致丢行。
let lineQueue = [];
let lineWaiters = [];
let inputEnded = false;
let sharedRl = null;
function ensureNonTtyReader() {
  if (sharedRl) return;
  sharedRl = readline.createInterface({ input: process.stdin, output: process.stdout });
  sharedRl.on("line", (line) => {
    const v = line.trim();
    if (lineWaiters.length) lineWaiters.shift()(v);
    else lineQueue.push(v);
  });
  sharedRl.on("close", () => {
    inputEnded = true;
    while (lineWaiters.length) lineWaiters.shift()("");
  });
}

function ask(question) {
  if (!isTTY) {
    ensureNonTtyReader();
    process.stdout.write(question);
    if (lineQueue.length) return Promise.resolve(lineQueue.shift());
    if (inputEnded) return Promise.resolve("");
    return new Promise((resolve) => lineWaiters.push(resolve));
  }
  // TTY：实时输入，每次新建 readline 即可
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(val);
    };
    rl.question(question, (ans) => finish(ans.trim()));
    // 输入流 EOF 时 question 回调不会触发，兜底返回空
    rl.on("close", () => finish(""));
  });
}

/** 密钥输入：TTY 下 raw mode 隐藏回显；非 TTY（管道）下无回显顾虑，复用 ask。 */
function readSecret(question) {
  if (!isTTY) return ask(question);
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let input = "";
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\u0003") {
          // Ctrl+C
          process.stdout.write("\n");
          process.exit(130);
        } else if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(input);
          return;
        } else if (ch === "\u007f" || ch === "\b") {
          input = input.slice(0, -1);
        } else {
          input += ch;
        }
      }
    };
    stdin.on("data", onData);
  });
}

// ---------- 保存 ----------
function upsertEnvFile(key, value) {
  let content = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
  const lines = content ? content.split(/\r?\n/) : [];
  let found = false;
  const out = lines.map((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && m[1] === key) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) out.push(`${key}=${value}`);
  fs.writeFileSync(ENV_FILE, out.join("\n") + "\n");
  return ENV_FILE;
}

function saveKeychain(key, value) {
  if (process.platform !== "darwin") throw new Error("Keychain 仅支持 macOS，请改用 .env 文件保存");
  execFileSync(
    "security",
    ["add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", key, "-w", value, "-U"],
    { stdio: "ignore" }
  );
  return `${KEYCHAIN_SERVICE}/${key}`;
}

// ---------- 主流程 ----------
async function main() {
  const argv = process.argv.slice(2);
  const nonInteractive = argv.includes("--non-interactive");
  const checkOnly = argv.includes("--check-only");

  // 非交互 / 只检测：直接透传给 check-keys.js（临时密钥只验证、不落盘）
  if (nonInteractive || checkOnly) {
    if (nonInteractive && !argv.some((a) => a.includes("=") && !a.startsWith("--"))) {
      console.error("用法: node scripts/setup.js --non-interactive VISION_API_KEY=xxx AGNES_API_KEY=yyy");
      process.exit(1);
    }
    const checkKeysPath = path.join(__dirname, "check-keys.js");
    const args = argv.filter((a) => a !== "--non-interactive" && a !== "--check-only");
    const r = spawnSync(process.execPath, [checkKeysPath, ...args], { stdio: "inherit" });
    process.exit(r.status ?? 1);
  }

  // ---------- 交互模式 ----------
  console.log(
    box(
      "🔑 视觉 API 密钥配置向导",
      [
        "填写各大厂商密钥 → 自动测试有效性 → 保存配置。",
        "密钥输入时不会显示，也不会进入聊天记录。",
        "保存位置：macOS Keychain（系统加密）或 scripts/.env（已被 .gitignore 忽略）。",
      ]
    )
  );
  console.log();

  // 当前状态概览
  const statusLines = PLATFORMS.map((p) => {
    const key = p.keyNames.find((n) => env[n]);
    return key ? `${color(C.green, "✅")} ${p.name.padEnd(14)} 已配置 ${color(C.dim, maskKey(env[key]))}` : `${color(C.dim, "  ")} ${p.name.padEnd(14)} 未配置`;
  });
  console.log(box("当前配置状态", statusLines));
  console.log();

  const results = [];
  let index = 0;
  for (const platform of PLATFORMS) {
    index++;
    const existingKey = platform.keyNames.find((n) => env[n]);
    const existing = existingKey ? env[existingKey] : "";

    console.log(
      color(C.bold, `[${index}/${PLATFORMS.length}] ${platform.name}`) +
        color(C.dim, `（${platform.note}）`)
    );
    if (existing) {
      const ans = await ask(
        `  当前已配置 ${maskKey(existing)}。是否重新配置？(y/N) `
      );
      if (!/^y/i.test(ans)) {
        console.log(color(C.dim, "  保持现有配置，跳过。"));
        results.push({ name: platform.name, status: "⏭ 跳过", detail: "保持现有配置" });
        console.log();
        continue;
      }
    } else {
      const ans = await ask("  是否配置此平台？(y/N) ");
      if (!/^y/i.test(ans)) {
        console.log(color(C.dim, "  跳过。"));
        results.push({ name: platform.name, status: "⏭ 跳过", detail: "未配置" });
        console.log();
        continue;
      }
    }

    // 输入密钥（隐藏回显）
    const key = await readSecret(`  请输入密钥（输入时不显示）: `);
    if (!key) {
      console.log(color(C.yellow, "  未输入，跳过。"));
      results.push({ name: platform.name, status: "⏭ 跳过", detail: "未输入密钥" });
      console.log();
      continue;
    }

    // 立即验证
    process.stdout.write(color(C.dim, "  正在测试密钥有效性… "));
    const res = await verifyApiKey(platform, key);
    const ok = res.ok;
    console.log(ok ? color(C.green, `✅ ${res.method} 通过 (HTTP ${res.status})`) : color(C.red, `❌ ${res.detail || `HTTP ${res.status}`}`));
    if (!ok) {
      const retry = await ask("  密钥无效，仍要保存吗？(y/N) ");
      if (!/^y/i.test(retry)) {
        results.push({ name: platform.name, status: "❌ 无效", detail: "未保存" });
        console.log();
        continue;
      }
    }

    // 选择保存方式
    const keyName = platform.keyName;
    let storeAns = "";
    if (process.platform === "darwin") {
      storeAns = await ask("  保存到？(1) macOS Keychain  (2) scripts/.env  [1/2]: ");
    }
    storeAns = storeAns.trim() === "2" ? "env" : "keychain";
    try {
      const dest = storeAns === "keychain" ? saveKeychain(keyName, key) : upsertEnvFile(keyName, key);
      console.log(color(C.green, `  ✅ 已保存：${dest}`));
      // 同步更新内存 env，便于后续平台引用
      env[keyName] = key;
      results.push({
        name: platform.name,
        status: ok ? "✅ 有效并已保存" : "⚠️ 已保存（验证未通过）",
        detail: `${dest} · ${res.method || ""}`.trim(),
      });
    } catch (err) {
      console.log(color(C.red, `  ❌ 保存失败：${err.message}`));
      results.push({ name: platform.name, status: "❌ 保存失败", detail: err.message });
    }
    console.log();
  }

  // ---------- 汇总 ----------
  console.log(box("配置完成 · 结果汇总", results.map((r) => `${r.status.padEnd(18)} ${r.name.padEnd(12)} ${color(C.dim, r.detail)}`)));
  console.log(color(C.dim, "\n提示：随时可运行 node scripts/check-keys.js 重新检测全部密钥。"));
}

main().catch((err) => {
  console.error("\n配置向导出错:", err.message);
  process.exit(1);
});
