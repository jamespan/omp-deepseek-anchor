# omp-deepseek-anchor

## 背景：为什么需要这个插件

**前因：模型是在官方脚手架上训练出来的。** DeepSeek V4 Pro 的官方运行环境是 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。其 `minimal` 预设的首请求固定为：官方 RL 原句 `You are a helpful software engineer assistant.` 作为唯一 system 内容、工具目录只有 `bash` + `str_replace_editor`（官方 schema）、适配器默认 `maxTokens = 256000`。模型在训练/评测里大量见到这套组合，行为上把它当成了"启动环境信号"——也就是对训练脚手架的过拟合。官方 Project2 评测可见一斑：同一个模型用 Standard/PTC 预设是 91/92 分，换成 Minimal 预设就是 99/96 分。

**后果：换一个 harness 就跑偏。** 在 omp 这类第三方 harness 里，默认首请求是全量工具目录 + 自定义 system prompt，与训练脚手架对不上，模型就退回"通用模式"：首行变成 "The user wants me to…"、"let me" 密度约涨 10 倍、工具选择也不再贴合 Minimal 轨迹。问题不在模型能力，而在启动环境不对。

**对策：只在首请求重建脚手架，之后放开。** 本插件把首请求按 Minimal 逐字节复刻（persona 原句 + 双工具 schema + 256000 maxTokens，omp 上还要求 `/v1/responses` 信封），让模型落在 "We need" 轨迹上；出现首个持久信号（工具调用或首条回复）后轨迹已锁定，立即恢复 omp 的完整工具目录和 system prompt。这样既拿到 Minimal 的启动行为，又不放弃 Standard 的完整能力。


[`dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard) 的 omp 移植：让 DeepSeek V4 Pro 以 Minimal 对齐的 scaffold 启动首个请求（官方 persona + `bash` + `str_replace_editor` + 256000 maxTokens），首个持久信号后恢复完整 omp 工具目录与特色 system prompt。扩展本体见 [`index.ts`](./index.ts)。

## 原理（一分钟版）

DeepSeek V4 Pro 对首个请求的 scaffold 高度敏感。实测结论：

1. **Responses 信封**：`/v1/responses` 请求格式（`input`/`instructions`）是 "We need" 轨迹的必要条件——chat-completions 信封下同一套锚定只出 "The user wants me to…"。
2. **官方 persona 打头**：`You are a helpful software engineer assistant.`（RL 训练原句）是语态开关；system prompt 必须以它开头，任何其他角色陈述开头都会让语态回到 let-me。
3. **两阶段**：首请求只暴露 `bash` + `str_replace_editor`（dsh minimal 原配）+ 256000 maxTokens；首个持久信号后恢复完整工具目录与 omp 特色 system prompt。

## 前置条件

- omp（macOS/Linux，支持 `omp install` 插件机制）
- 一个 DeepSeek API key（官方端点 `api.deepseek.com`，需支持 `/v1/responses`；实测可用）
- 目标模型 id 为 `deepseek-v4-pro`（其他模型不受影响）

## 安装

```sh
omp install npm:omp-deepseek-anchor        # 发布版
omp install /path/to/omp-deepseek-anchor   # 本地目录（link）
omp plugin list                            # 确认已安装
```

手动兜底：把本仓库的 [`index.ts`](./index.ts) 复制为 `~/.omp/agent/extensions/anchored.ts`。

## 配置模型 provider

在 `~/.omp/agent/models.yml` 的 `providers:` 下加（把 `sk-xxx` 换成你的 key；其余保留已有 provider 不动）：

```yaml
  deepseek-responses:
    baseUrl: https://api.deepseek.com/v1
    api: openai-responses
    apiKey: sk-xxx
    models:
      - id: deepseek-v4-pro
        name: DeepSeek V4 Pro (Responses)
        contextWindow: 1048576
        maxTokens: 393216
        thinking:
          mode: effort
          efforts: [high, max]
```

要点：

- `api: openai-responses` 是必须的——Responses 信封是 "We need" 轨迹的必要条件（chat-completions 信封下不生效）。
- `thinking.efforts: [high, max]` 对齐内置 deepseek 的思考档位；缺了它 `:max` 不可选。
- `contextWindow`/`maxTokens` 取内置目录同值（1M / 384K）。

## 设为默认模型（可选）

`~/.omp/agent/config.yml`：

```yaml
modelRoles:
  default: deepseek-responses/deepseek-v4-pro:max
```

不设默认也可以每次用 `omp --model deepseek-responses/deepseek-v4-pro:max`。

## 验证

1. **模型可见且 max 可选**：

   ```sh
   omp models find deepseek-v4-pro
   # 期望 deepseek-responses 行显示 context 1M / max-out 393K / thinking high,max
   ```

2. **请求通路**：

   ```sh
   omp -p "reply with exactly: PONG" --model deepseek-responses/deepseek-v4-pro:max
   ```

3. **锚定生效**（重启会话后，扩展在会话启动时加载）：

   ```sh
   ANCHORED_DEBUG=1 omp -p "reply with exactly: PONG" --model deepseek-responses/deepseek-v4-pro --no-session --no-title
   cat /tmp/anchored-debug.jsonl
   # 期望 anchored 事件：toolsAfter = ["bash","str_replace_editor"]，persona = 官方原句
   ```

4. **轨迹风格**（英文题面才能正确统计 we/let me）：

   ```sh
   omp -p "Fix the bug in /path/to/script.py ..." --model deepseek-responses/deepseek-v4-pro:max --mode json
   # 首个 thinking 块应以 "We need" 开头
   ```

## 开关一览

| env | 默认 | 作用 |
|---|---|---|
| `ANCHORED_TARGET` | `deepseek-v4-pro` | 目标模型（裸 id 精确匹配） |
| `ANCHORED_PERSONA` | 官方 RL 原句 | 首请求/晋升后 system 的 persona（**不要换成其他角色陈述，语态会崩**） |
| `ANCHORED_TOOLS` | `bash,str_replace_editor` | bootstrap 工具对 |
| `ANCHORED_MAX_TOKENS` | `256000` | 首请求 max_tokens（dsh 证据条件） |
| `ANCHORED_BASH_DESC` | dsh 原样 | bash wire 描述覆盖 |
| `ANCHORED_PROMOTED_MODE` | `lean` | 晋升后 system：`persona`（纯语态）/ `lean`（默认，persona 打头 + 全部 omp 原文段 + xd:// + 工具清单，仅 critical 用仿写）/ `upstream`（persona 全程为 system，原 omp 上下文整体转为 user 消息，对齐 pi 移植的 personaScope=always）/ `full`（原版 omp，let_me 会回归）/ `abl`（消融实验） |
| `ANCHORED_SECTIONS` | — | `abl` 模式的段列表（`role,conventions,urls,inventory,policy,workflow,contract,personality,workstation,mcp,xd,critical`） |
| `ANCHORED_REWRITE` | `0` | `abl` 模式下 `1`=全用 dsh 仿写变体 |
| `ANCHORED_TOOL_LIST` | 有 | `0` 去掉晋升后工具清单 |
| `ANCHORED_DEBUG` | 关 | `1` 写事件到 `/tmp/anchored-debug.jsonl` |

## 行为说明

- **Bootstrap**：会话首个请求 system = 官方 persona 原句，wire 工具 = `[bash, str_replace_editor]`（dsh minimal 原配，schema 逐字节复刻），`max_tokens` 对齐 256000；非最小工具调用被硬拦截（等价 dsh 的"工具不存在"）。
- **晋升**：首个持久信号（首次合法工具调用 / 对话中出现第一条 assistant 消息）后，工具目录恢复全量，system 按 `ANCHORED_PROMOTED_MODE` 重建：默认 `lean`（persona 打头 + 项目注入 + omp 原文段 + xd:// 设备文档 + 紧凑工具清单）；`upstream`（persona 全程为 system，原 omp 上下文整体转为 user 消息，对齐 pi 移植）。
- **`/dsh-anchor` 命令**：`status`（默认）查看相位；`promote` 立即晋升；`on`/`off` 为本会话重新武装/禁用 bootstrap。TUI 底栏在晋升前显示 `bootstrap: bash/str_replace_editor`，晋升后清除。
- **`str_replace_editor`**：注册为常驻工具，view/create/str_replace/insert 四命令、官方文案、晋升后保留。

## 已知限制

1. key 明文存于 `models.yml`；建议开启 omp secret 混淆（`secrets.enabled: true`）或使用环境变量引用。
2. 子代理（task）会话的首次请求同样被锚定（无主/子会话区分）。
3. "We need" 轨迹依赖 persona 打头——自定义 `ANCHORED_PERSONA` 换掉官方原句会导致语态回到 let-me 风格（实测）。
4. `full` 模式（原版 omp system prompt）实测 let_me 密度涨 ~10 倍，不推荐与语态目标同用。
5. dsh 的评测分数（Project2 98/99）在 omp 上未复现完整持续性；本配置复现的是首请求锚定与工具选择层行为。

## 小结：什么时候该装

- **装的理由**：你在 omp 里用 `deepseek-v4-pro`，且想要官方 Minimal 的首请求轨迹（"We need" 语态 + 双工具选择），同时保留晋升后的完整工具目录。
- **不装也不影响功能**：模型照常工作，只是首请求走 "The user wants me to…" 的通用轨迹；其他模型完全不受本插件影响。
- **本质**：这不是能力增强插件，而是行为锚定——把模型放回它训练时的启动环境，首请求之后按需放开。对语态无感的场景可以不用。

## 回滚

- `omp plugin uninstall omp-deepseek-anchor`（手动安装则删除 `~/.omp/agent/extensions/anchored.ts`）。
- `models.yml` 删除 `deepseek-responses` 块。
- `config.yml` 的 default 改回原模型（如 `deepseek/deepseek-v4-pro:max`）。

## 许可与署名

MIT。上游衍生自 [`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard)（MIT）与 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)（BSD-3-Clause，冻结提交 `47f9438`），详见 [NOTICE](./NOTICE)。
