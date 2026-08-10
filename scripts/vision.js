#!/usr/bin/env node
/**
 * OpenAI-compatible image description fallback.
 * Reads scripts/.env from the skill directory; no npm dependencies.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const http = require("http");
const { execFileSync } = require("child_process");

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

// --- macOS Keychain 支持：密钥不落明文磁盘，优先从系统钥匙串读取（非 macOS 自动跳过）---
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
// 环境变量 / .env 缺失时，从 Keychain 补充密钥
for (const k of ["AGNES_API_KEY", "CLOUDFLARE_API_TOKEN", "VISION_API_KEY", "DASHSCOPE_API_KEY", "GLM_THINKING_API_KEY", "QWEN3_API_KEY"]) {
  if (!env[k]) {
    const v = keychainGet(k);
    if (v) env[k] = v;
  }
}

const MAX_RETRIES = Number(env.VISION_MAX_RETRIES || 1); // 失败一次立即切换下一个模型，不等重试
const RETRY_DELAY_MS = Number(env.VISION_RETRY_DELAY_MS || 3000);
const TIMEOUT_MS = Number(env.VISION_TIMEOUT_MS || 25000); // 单次请求超时，超时立即切下一个 provider
const COMPRESS_MIN_BYTES = Number(env.VISION_COMPRESS_MIN_BYTES || 1572864); // 超过 1.5MB 自动压缩
const COMPRESS_MAX_EDGE = Number(env.VISION_COMPRESS_MAX_EDGE || 1280); // 最长边像素

/** provider 表：glm / qwen。顺序由 VISION_PROVIDER_ORDER 控制（默认 glm,qwen）。 */
const PROVIDER_TABLE = {
  // Agnes（用户指定平台，OpenAI 兼容，flash 最快 2.0s）
  agnes: {
    apiKey: () => env.AGNES_API_KEY || "",
    baseUrl: () => (env.AGNES_BASE_URL || "https://apihub.agnes-ai.com/v1").replace(/\/+$/, ""),
    model: () => env.AGNES_MODEL || "agnes-2.0-flash",
  },
  agnes25: {
    apiKey: () => env.AGNES_API_KEY || "",
    baseUrl: () => (env.AGNES_BASE_URL || "https://apihub.agnes-ai.com/v1").replace(/\/+$/, ""),
    model: () => env.AGNES25_MODEL || "agnes-2.5-flash",
  },
  // 主力：千问旗舰视觉（质量最接近顶级）
  qwen3: {
    apiKey: () => env.QWEN3_API_KEY || env.DASHSCOPE_API_KEY || "",
    baseUrl: () => (env.QWEN3_BASE_URL || env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, ""),
    model: () => env.QWEN3_MODEL || "qwen3-vl-plus",
  },
  // Cloudflare Workers AI（边缘快速免费）
  cloudflare: {
    apiKey: () => env.CLOUDFLARE_API_TOKEN || "",
    baseUrl: () =>
      (env.CLOUDFLARE_BASE_URL || `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID || ""}/ai/v1`).replace(/\/+$/, ""),
    model: () => env.CLOUDFLARE_MODEL || "@cf/meta/llama-4-scout-17b-16e-instruct",
  },
  // 智谱免费快模型（比 4.6v 稳）
  glm4v: {
    apiKey: () => env.GLM4V_API_KEY || env.VISION_API_KEY || "",
    baseUrl: () => (env.GLM4V_BASE_URL || env.VISION_BASE_URL || "https://open.bigmodel.cn/api/paas/v4").replace(/\/+$/, ""),
    model: () => env.GLM4V_MODEL || "glm-4v-flash",
  },
  glm: {
    apiKey: () => env.VISION_API_KEY || env.ZHIPU_API_KEY || env.GLM_API_KEY || "",
    baseUrl: () => (env.VISION_BASE_URL || env.ZHIPU_BASE_URL || env.GLM_BASE_URL || "https://open.bigmodel.cn/api/paas/v4").replace(/\/+$/, ""),
    model: () => env.VISION_MODEL || env.GLM_MODEL || "glm-4.6v-flash",
  },
  "glm-thinking": {
    apiKey: () => env.GLM_THINKING_API_KEY || env.VISION_API_KEY || env.ZHIPU_API_KEY || env.GLM_API_KEY || "",
    baseUrl: () => (env.GLM_THINKING_BASE_URL || env.VISION_BASE_URL || "https://open.bigmodel.cn/api/paas/v4").replace(/\/+$/, ""),
    model: () => env.GLM_THINKING_MODEL || "glm-4.1v-thinking-flash",
  },
  qwen: {
    apiKey: () => env.DASHSCOPE_API_KEY || "",
    baseUrl: () => (env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, ""),
    model: () => env.DASHSCOPE_MODEL || "qwen-vl-max",
  },
};

/** 按 VISION_PROVIDER_ORDER 返回有序可用 provider 列表；未列出的已配置 provider 按表内顺序追加兜底。 */
function loadProviders(e) {
  const order = (e.VISION_PROVIDER_ORDER || "glm,qwen").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  const pick = (key) => {
    const def = PROVIDER_TABLE[key];
    if (!def) return null;
    const p = { apiKey: def.apiKey(), baseUrl: def.baseUrl(), model: def.model() };
    return p.apiKey ? p : null;
  };
  const providers = [];
  const exists = (p) => providers.some((x) => x.baseUrl === p.baseUrl && x.model === p.model);
  for (const key of order) {
    const p = pick(key);
    if (p && !exists(p)) providers.push(p);
  }
  for (const key of Object.keys(PROVIDER_TABLE)) {
    const p = pick(key);
    if (p && !exists(p)) providers.push(p);
  }
  return providers;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 剥离 thinking 模型的 <think> 推理块，只保留 <answer> 答案，避免噪音进上下文。 */
function cleanContent(text) {
  if (typeof text !== "string") return text;
  const m = text.match(/<answer>([\s\S]*?)<\/answer>/);
  if (m) return m[1].trim();
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

function parseArgs() {
  const argv = process.argv.slice(2);
  let imageSource = "";
  let prompt = "";
  let isUrl = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--url" && argv[i + 1]) {
      isUrl = true;
      imageSource = argv[++i];
    } else if (!imageSource && !argv[i].startsWith("--")) {
      imageSource = argv[i];
    } else if (imageSource && !argv[i].startsWith("--")) {
      prompt = prompt ? `${prompt} ${argv[i]}` : argv[i];
    }
  }

  if (!prompt) prompt = "请详细描述这张图片的内容。";
  return { imageSource, prompt, isUrl };
}

/** 大图用 sips 压缩：缩放最长边 + 转 JPEG，减小上传体积与模型处理耗时。gif 保留原样。 */
function maybeCompress(resolved, ext) {
  const stat = fs.statSync(resolved);
  if (ext === "gif" || stat.size <= COMPRESS_MIN_BYTES) return { file: resolved, mime: ext };
  const tmp = path.join(os.tmpdir(), `vision-${process.pid}-${Date.now()}.jpg`);
  execFileSync(
    "/usr/bin/sips",
    ["-Z", String(COMPRESS_MAX_EDGE), "-s", "format", "jpeg", "-s", "formatOptions", "80", resolved, "--out", tmp],
    { stdio: "ignore" }
  );
  return { file: tmp, mime: "jpeg" };
}

function resolveImageUrl(source, isUrl) {
  if (isUrl) return source;
  const resolved = path.resolve(source);
  if (!fs.existsSync(resolved)) throw new Error(`文件不存在: ${resolved}`);
  const ext = path.extname(resolved).toLowerCase().replace(".", "");
  const mimeMap = {
    jpg: "jpeg",
    jpeg: "jpeg",
    png: "png",
    gif: "gif",
    webp: "webp",
    bmp: "bmp",
  };
  const { file, mime } = maybeCompress(resolved, ext);
  const data = fs.readFileSync(file);
  return `data:image/${mimeMap[mime] || "jpeg"};base64,${data.toString("base64")}`;
}

function requestOnce(payload, provider) {
  const url = new URL(`${provider.baseUrl}/chat/completions`);
  const body = JSON.stringify(payload);
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode >= 400) {
            reject(new Error(`API ${res.statusCode}: ${data.slice(0, 300)}`));
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const msg = parsed?.choices?.[0]?.message;
            // 部分 GLM 模型把内容放在 reasoning_content（content 为空），需兜底
            const text = msg?.content || msg?.reasoning_content || parsed || data;
            resolve(cleanContent(text));
          } catch {
            resolve(cleanContent(data));
          }
        });
      }
    );
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy(new Error(`请求超时（${TIMEOUT_MS / 1000}s）`));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function request(payload, provider) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await requestOnce(payload, provider);
    } catch (err) {
      lastError = err;
      const retryable = /访问量过大|429|繁忙/.test(err.message);
      if (!retryable || attempt === MAX_RETRIES) throw err;
      console.error(`模型繁忙，${(RETRY_DELAY_MS * attempt) / 1000}s 后重试 (${attempt}/${MAX_RETRIES})`);
      await wait(RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

async function main() {
  const providers = loadProviders(env);
  if (providers.length === 0) {
    console.error("请设置 VISION_API_KEY / GLM_API_KEY / DASHSCOPE_API_KEY 环境变量，或在 scripts/.env 中配置。");
    process.exit(1);
  }

  const { imageSource, prompt, isUrl } = parseArgs();
  if (!imageSource) {
    console.error("用法: node vision.js <图片路径> [问题]");
    console.error("      node vision.js --url <图片链接> [问题]");
    process.exit(1);
  }

  const imageUrl = resolveImageUrl(imageSource, isUrl);
  const payload = {
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageUrl } },
          { type: "text", text: prompt },
        ],
      },
    ],
    stream: false,
  };

  // thinking 模型思考过程长，单独给更高 token 上限，避免答案被截断
  const maxTokensByModel = { "glm-4.1v-thinking-flash": 2048, "glm-4.6v-flash": 1024 };

  let lastError;
  for (const provider of providers) {
    try {
      const result = await request(
        { ...payload, model: provider.model, max_tokens: maxTokensByModel[provider.model] || 512 },
        provider
      );
      console.log(result);
      return;
    } catch (err) {
      lastError = err;
      console.error(`[${provider.model}] 失败: ${err.message}`);
    }
  }
  console.error("识图失败:", lastError?.message || "所有视觉 provider 均不可用");
  console.error("提示: 可转本地 OCR —— bash ~/.reasonix/skills/vision-fallback/scripts/local_ocr.sh <图片路径>");
  process.exit(1);
}

main();
