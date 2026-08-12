# Codex / DeepSeek 视觉回退（多模型自动切换）

![宣传图片](assets/promo-banner.png)

让没有原生视觉能力的编码代理（如 DeepSeek）自动读图：把图片转成文字描述，交还给原模型继续处理。**官方 Codex / GPT 保持原生识图，绝不把图片额外发送给第三方 API**。

## 特性

- **多模型自动切换**：每个模型失败一次立即切下一个（429 限流 / 超时 / 密钥无效等），无需手工干预
- **全免费 + 速度优先**默认链路，也支持接入付费旗舰模型
- **大图自动压缩**：>1.5MB 用 macOS `sips` 压缩到 1280px 再上传，显著降低延迟
- **密钥不落明文**：支持环境变量 / `.env` / macOS Keychain 三种方式，Keychain 为系统级加密存储
- **零 npm 依赖**：只用 Node.js 内置模块

## 原理

```text
用户发图
  ├─ 官方 Codex / GPT ──> 原生识图（不出站）
  └─ 文本模型 ──> scripts/vision.js ──> [模型链，失败自动切换] ──> 中文图片描述 ──> 原模型继续处理
```

默认模型链（`VISION_PROVIDER_ORDER` 可调，顺序即优先级）：

| # | 模型 | 平台 | 实测 | 费用 |
|---|------|------|------|------|
| 1 | `agnes-2.5-flash` | Agnes (`apihub.agnes-ai.com`) | ~0.8s | 依账号额度 |
| 2 | `glm-4v-flash` | 智谱 | ~0.9s | 免费 |
| 3 | `@cf/meta/llama-4-scout-17b-16e-instruct` | Cloudflare Workers AI | ~1.3s | 免费额度 |
| 4 | `agnes-2.0-flash` | Agnes | ~2s | 依账号额度 |
| 5 | `glm-4.6v-flash` | 智谱 | 常 429 | 免费 |
| 6 | `glm-4.1v-thinking-flash` | 智谱 | 5-6s | 免费 |

全部失败后自动提示转本地 OCR（`local_ocr.sh`，tesseract）。

## 安装

```bash
git clone https://github.com/lll888666/codex-deepseek-vision-fallback.git ~/.codex/skills/vision-fallback
cp scripts/.env.example scripts/.env
```

## 密钥安全配置（重要）

**不要把真实密钥写进 `.env` 并提交！** 密钥文件已被 `.gitignore` 忽略。推荐三种方式（按优先级）：

1. **环境变量**（跨平台）：
   ```bash
   export AGNES_API_KEY=xxx
   export CLOUDFLARE_API_TOKEN=xxx
   ```

2. **macOS Keychain**（系统级加密，推荐本机使用）：
   ```bash
   security add-generic-password -s vision-fallback -a AGNES_API_KEY -w <密钥>
   security add-generic-password -s vision-fallback -a CLOUDFLARE_API_TOKEN -w <密钥>
   security add-generic-password -s vision-fallback -a VISION_API_KEY -w <密钥>
   security add-generic-password -s vision-fallback -a DASHSCOPE_API_KEY -w <密钥>
   ```

3. **`.env` 文件**（仅本地，绝不上传）：复制 `.env.example` 后填写。

支持的密钥键名：`AGNES_API_KEY`、`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`（非密钥，可放 `.env`）、`VISION_API_KEY`（智谱）、`DASHSCOPE_API_KEY`（千问）。

## 命令行用法

```bash
# 本地文件
node scripts/vision.js "/tmp/photo.jpg" "提取画面主体、文字和界面状态"

# 远程 URL
node scripts/vision.js --url "https://example.com/image.png" "请描述图片"

# 本地 OCR 兜底（API 全部失败时）
bash scripts/local_ocr.sh "/tmp/photo.jpg"
```

## 可选环境变量

| 变量 | 作用 |
| --- | --- |
| `VISION_PROVIDER_ORDER` | 模型尝试顺序，逗号分隔，如 `qwen3,cloudflare,glm4v,...` |
| `VISION_MAX_RETRIES` | 每模型重试次数，默认 `1`（失败一次立即切换） |
| `VISION_TIMEOUT_MS` | 单请求超时毫秒，默认 `25000` |
| `VISION_COMPRESS_MIN_BYTES` | 触发压缩的字节阈值，默认 `1572864`（1.5MB） |
| `VISION_COMPRESS_MAX_EDGE` | 压缩后最长边像素，默认 `1280` |

## 开源安全清单

- [x] `.env` 被 `.gitignore` 忽略，仓库只提供 `.env.example` 占位符
- [x] 支持 Keychain / 环境变量存储密钥，无明文落盘
- [x] 提交前请扫描历史：`git grep -nE "sk-|cfat_|Bearer " $(git rev-list --all)`
- [ ] 若密钥曾出现在任何提交/截图/聊天中，请立即在对应平台撤销并重新生成

## 许可证

[MIT](LICENSE)
