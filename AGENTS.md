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

Do not put a real API key in this file, source control, prompts, logs, or chat
messages.
