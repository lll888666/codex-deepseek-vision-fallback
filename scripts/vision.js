#!/usr/bin/env node
/**
 * OpenAI-compatible image description fallback.
 * Reads scripts/.env from the skill directory; no npm dependencies.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

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

const BASE_URL = (
  env.VISION_BASE_URL ||
  env.ZHIPU_BASE_URL ||
  env.GLM_BASE_URL ||
  env.DASHSCOPE_BASE_URL ||
  "https://open.bigmodel.cn/api/paas/v4"
).replace(/\/+$/, "");
const API_KEY =
  env.VISION_API_KEY ||
  env.ZHIPU_API_KEY ||
  env.GLM_API_KEY ||
  env.DASHSCOPE_API_KEY ||
  "";
const MODEL =
  env.VISION_MODEL ||
  env.GLM_MODEL ||
  env.DASHSCOPE_MODEL ||
  "glm-4.6v-flash";
const MAX_RETRIES = Number(env.VISION_MAX_RETRIES || 5);
const RETRY_DELAY_MS = Number(env.VISION_RETRY_DELAY_MS || 3000);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const data = fs.readFileSync(resolved);
  return `data:image/${mimeMap[ext] || "jpeg"};base64,${data.toString("base64")}`;
}

function requestOnce(payload) {
  const url = new URL(`${BASE_URL}/chat/completions`);
  const body = JSON.stringify(payload);
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
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
            resolve(JSON.parse(data)?.choices?.[0]?.message?.content || data);
          } catch {
            resolve(data);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function request(payload) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await requestOnce(payload);
    } catch (err) {
      lastError = err;
      const retryable = /访问量过大|429/.test(err.message);
      if (!retryable || attempt === MAX_RETRIES) throw err;
      console.error(`模型繁忙，${(RETRY_DELAY_MS * attempt) / 1000}s 后重试 (${attempt}/${MAX_RETRIES})`);
      await wait(RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

async function main() {
  if (!API_KEY) {
    console.error("请设置 ZHIPU_API_KEY / VISION_API_KEY 环境变量，或在 scripts/.env 中配置。");
    process.exit(1);
  }

  const { imageSource, prompt, isUrl } = parseArgs();
  if (!imageSource) {
    console.error("用法: node vision.js <图片路径> [问题]");
    console.error("      node vision.js --url <图片链接> [问题]");
    process.exit(1);
  }

  try {
    const imageUrl = resolveImageUrl(imageSource, isUrl);
    const result = await request({
      model: MODEL,
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
      max_tokens: 1024,
    });
    console.log(result);
  } catch (err) {
    console.error("识图失败:", err.message);
    process.exit(1);
  }
}

main();
