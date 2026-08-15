## What this is

**`omp-deepseek-anchor`** — a port of `dsh-anchored-standard` for [Oh My Pi](https://github.com/can1357/oh-my-pi) (omp), the pi/omp coding harness. Two-phase anchor for DeepSeek V4 Pro: Minimal-aligned bootstrap on request `#1`, full tool catalog after the first durable signal.

- **GitHub**: https://github.com/jamespan/omp-deepseek-anchor
- **npm**: `omp-deepseek-anchor` (v1.0.1)
- **Install**: `omp install npm:omp-deepseek-anchor`

## Upstream parity

Implemented against the frozen harness commit `47f9438`, byte-identical where it matters:

| Upstream | omp port |
| --- | --- |
| Persona `You are a helpful software engineer assistant.` | ✓ same text |
| `bash` + `str_replace_editor` official schemas/descriptions | ✓ byte-identical wire presentation |
| Editor `view/create/str_replace/insert` semantics, error texts, 16000-char truncation | ✓ same texts (verified against the minimal-preset snapshot) |
| `promoteOn: either`, durable phase across resume | ✓ |
| Zero-anchor / `bootstrapMaxTokens` / persona scope | ✓ configurable (`ANCHORED_*` env) |
| `/dsh-anchor` status/promote/on/off command + TUI footer | ✓ |

## Findings from the port that may interest this repo

Three observations measured in omp (English prompts, per-1K-char we/let_me density, ~35 runs):

1. **The Responses envelope is a necessary condition in omp.** The same bootstrap (persona + 2 tools + 256000) anchors "We need…" on the OpenAI Responses wire (`input`/`instructions`) but produces "The user wants me to…" on chat-completions (`messages`) — even with byte-identical tool schemas. The upstream README doesn't mention this because dsh's adapter is its own envelope; on other harnesses the envelope may be the hidden variable.

2. **Persona-first is the voice switch.** Any composition with the official persona leading keeps `let_me ≈ 0–0.5/1K`; the full omp system prompt without the persona (equivalent to dsh standard's own identity) pushes `let_me` to ~2.6/1K (~10×). Rule wording (we-form vs must/never) doesn't matter; the persona string does.

3. **A 12-section controlled ablation ladder** (role, conventions, urls, inventory, policy, workflow, contract, personality, workstation, mcp, xd:// devices, critical) shows the omp prompt can be re-added almost entirely behind the persona without voice loss; only the `<critical>` block needed a dsh-style rewrite.

## Attribution

MIT license with a NOTICE crediting this repo (MIT) and `deepseek-ai/deepseek-harness` (BSD-3-Clause, commit `47f9438`). Not affiliated with DeepSeek.

Feedback and cross-checking welcome — especially if anyone can isolate the envelope variable further.

---

## 这是什么

**`omp-deepseek-anchor`**——把 `dsh-anchored-standard` 移植到 [Oh My Pi](https://github.com/can1357/oh-my-pi)（omp，pi 的后续 harness）。DeepSeek V4 Pro 的两阶段锚定：请求 `#1` Minimal 对齐启动，首个持久信号后恢复完整工具目录。

- **GitHub**：https://github.com/jamespan/omp-deepseek-anchor
- **npm**：`omp-deepseek-anchor`（v1.0.1）
- **安装**：`omp install npm:omp-deepseek-anchor`

## 与上游的对齐

基于冻结提交 `47f9438` 实现，关键点逐字节一致：

| 上游 | omp 移植 |
| --- | --- |
| persona `You are a helpful software engineer assistant.` | ✓ 同文本 |
| `bash` + `str_replace_editor` 官方 schema/描述 | ✓ wire 呈现逐字节一致 |
| 编辑器 view/create/str_replace/insert 语义、错误文案、16000 截断 | ✓ 同文案（对照 minimal-preset 快照验证） |
| `promoteOn: either`、跨 resume 持久 | ✓ |
| zero-anchor / `bootstrapMaxTokens` / persona 作用域 | ✓ 均可配置（`ANCHORED_*`） |
| `/dsh-anchor` 命令 + TUI 底栏 | ✓ |

## 移植过程中的发现（可能对本仓库有参考价值）

omp 上的实测（英文题面、we/let_me 每千字符密度、约 35 次运行）：

1. **Responses 信封在 omp 上是必要条件。** 同一套 bootstrap（persona + 双工具 + 256000）在 OpenAI Responses wire（`input`/`instructions`）下锚定出 "We need…"，在 chat-completions（`messages`）下只出 "The user wants me to…"——即使工具 schema 逐字节一致。上游 README 没提这点，因为 dsh 的 adapter 是自有信封；在其他 harness 上"信封"可能就是那个隐藏变量。

2. **persona 打头是语态开关。** 官方 persona 打头的任何组合 `let_me ≈ 0–0.5/1K`；没有 persona 的完整 omp system prompt（相当于 dsh standard 自己的身份）把 `let_me` 推到 ~2.6/1K（约 10 倍）。规则用 we 语态还是 must/never 无所谓，persona 字符串本身才是开关。

3. **12 段受控消融阶梯**（role/conventions/urls/inventory/policy/workflow/contract/personality/workstation/mcp/xd:// 设备/critical）证明 omp 的 system prompt 几乎可以全部加回 persona 之后而不损失语态；只有 `<critical>` 块需要 dsh 风格改写。

## 署名与许可

MIT，NOTICE 中署名本仓库（MIT）与 `deepseek-ai/deepseek-harness`（BSD-3-Clause，提交 `47f9438`）。与 DeepSeek 无关联。

欢迎交流与交叉验证——尤其如果谁能进一步把"信封"这个变量拆出来。
