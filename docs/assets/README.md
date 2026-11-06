# README screenshots

The Chinese and English READMEs share these screenshots of the actual PromptLens web renderer. The interface is shown in Chinese. `<picture>` selects the dark image for a dark color scheme; the light image is the fallback. The brand mark is the existing [SVG logo](../../resources/promptlens-mark.svg).

| Asset | View | Size |
| --- | --- | --- |
| [promptlens-anatomy-light.png](promptlens-anatomy-light.png) | Prompt analysis, light theme | 1440 × 900 |
| [promptlens-anatomy-dark.png](promptlens-anatomy-dark.png) | Prompt analysis, dark theme | 1440 × 900 |

Captured on 2026-11-03 from the current workspace renderer after `npm run build:main` and `npm run build:renderer`. These are direct browser screenshots, without compositing or UI retouching.

All three sessions, prompts, tool definitions, tool outputs, model responses and usage values are synthetic documentation examples. `demo-model`, `https://demo.invalid/v1/responses` and `/demo/task-board` are placeholders. Token values are explicitly supplied in the synthetic response's `usage` field, not estimated from text. These images demonstrate the interface, not model performance or real-agent compatibility.

To refresh the screenshots, use an independent temporary SQLite database and a random loopback port with the existing `StorageEngine`, `CoreManager.handleCapturePayload` and `WebServer` fixture pattern in [capture-ui-fixture.cjs](../../scripts/capture-ui-fixture.cjs). Supply synthetic Responses API requests with instructions, three tool definitions, user input, a tool call/output and a response with explicit usage. Codex session titles require matching turn metadata and `user.text` source annotations; see [session_names.test.cjs](../../tests/session_names.test.cjs). Do not substitute real captures.

At 1440 × 900, select the demo session “为任务列表添加状态筛选”, open “Prompt 解析”, and capture both themes with the theme menu closed. Keep all five prompt layers visible. Review names, paths, addresses and text before replacing these assets. Stop only the fixture process and remove its temporary database afterward; no real proxy, CA or agent is needed.
