# Vision fallback routing policy

When a user attaches an image, decide using the **currently selected backend**:

- Official Codex / OpenAI GPT: use native image understanding. Do **not** call
  `scripts/vision.js` or any external vision API.
- DeepSeek or another text-only backend: call the fallback once per image before
  attempting OCR. Use its returned description as the image context.
- If the current backend is unknown: only call the fallback after the image is
  reported unsupported or unreadable. Never call it as a duplicate check.

Local image:

```bash
node scripts/vision.js "<absolute-image-path>" "请用中文详细描述这张图片的内容。"
```

Remote image:

```bash
node scripts/vision.js --url "<image-url>" "请用中文详细描述这张图片的内容。"
```

The script tries providers in `VISION_PROVIDER_ORDER` (default
`agnes25,glm4v,cloudflare,agnes,glm,glm-thinking`), switching on every failure.
If all providers fail, use local OCR:

```bash
bash scripts/local_ocr.sh "<absolute-image-path>"
```

Do not put a real API key in this file, source control, prompts, logs, or chat
messages. Use environment variables, `.env` (git-ignored), or macOS Keychain
(`security add-generic-password -s vision-fallback -a <KEY_NAME> -w <secret>`).

# 密钥配置路由（一句话触发）

When the user says something like「配置 API key」「设置密钥」「帮我配 key」:

- Interactive terminal: run `node scripts/setup.js` — it opens a terminal "box"
  form, hides key input, tests each key, and saves to Keychain / `.env`.
- Non-interactive (no TTY): run `node scripts/setup.js --check-only` to show the
  current key status. If the user pastes keys into chat, validate them without
  persisting first via
  `node scripts/setup.js --non-interactive VISION_API_KEY=xxx AGNES_API_KEY=yyy`,
  then write them only after the user confirms.
- To re-test existing keys anytime: `node scripts/check-keys.js`.
