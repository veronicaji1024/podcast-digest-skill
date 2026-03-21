---
name: podcast-digest
description: Daily podcast digest — scrapes 19 podcasts (10 Xiaoyuzhou + 8 YouTube + 1 RSS), generates bilingual deep-notes, sends via email. Trigger with /podcast or /播客.
metadata:
  openclaw:
    requires:
      bins:
        - node
        - yt-dlp
        - docker
---

# Podcast Digest

每天自动抓取 **19 个** AI / 科技播客，生成中英双语深度笔记，通过邮件发送。

- **10 个小宇宙播客**：通过本地 RSSHub 获取 RSS，DashScope Paraformer v2 语音转录
- **8 个英文 YouTube 播客**：yt-dlp 直接拉取自动字幕（秒级）
- **1 个英文 RSS 播客**（Acquired）：DashScope Paraformer v2 语音转录

---

## 快速安装

```bash
bash ~/.claude/skills/podcast-digest/setup.sh
```

安装脚本会自动：
1. 检查依赖（node、yt-dlp、docker）
2. 安装 npm 依赖
3. 启动本地 RSSHub Docker 容器
4. 创建 `~/.podcast-digest/config.json`（从模板复制）

安装后编辑配置文件，填入你的 API Key：

```bash
# 必填字段：
# dashscope.apiKey  → 阿里云 DashScope（ASR + Qwen）
# email.apiKey      → Resend API Key
# email.to          → 收件人邮箱
vim ~/.podcast-digest/config.json
```

配置模板见：`config.example.json`

---

## 触发方式

| 命令 | 效果 |
|------|------|
| `/podcast` 或 `/播客` | 完整运行，处理所有播客并发送邮件 |
| `/podcast test 硅谷101` | 单集测试，不发邮件，输出到 /tmp |
| `/podcast skip 科技乱炖` | 临时跳过某个播客（写入 config.json） |
| `/podcast status` | 显示上次运行时间和已处理集数 |

---

## 定时任务

每天 10:00 GMT+8 自动运行（即 UTC 02:00）：

```bash
crontab -e
# 加入以下一行：
0 2 * * * cd ~/.claude/skills/podcast-digest && node scripts/daily-digest.js >> /tmp/podcast-digest.log 2>&1
```

---

## 系统架构

```
阶段1（并行）  拉取所有 RSS / YouTube 元数据 + 选集 + YouTube 字幕
阶段2（并行）  提交所有小宇宙 / RSS 音频 ASR 任务
阶段3（并行）  轮询等待所有 ASR 任务完成
阶段4（并行）  ├─ 对每个 transcript 分块生成单集笔记
               └─ 对英文 transcript 分块翻译成中文
阶段5          用所有笔记生成跨播客综述（邮件正文）
阶段6          组装邮件，通过 Resend API 发送
```

### 分块策略

| 场景 | 阈值 | 块大小 | 重叠 |
|------|------|--------|------|
| 单集笔记 | ≤ 20,000 字：单次调用 | 18,000 字 | 2,000 字 |
| 英文译文 | 无阈值 | 20,000 字 | 无重叠 |

---

## 邮件结构

```
正文：跨播客综述
  └─ 按领域分类（AI与产品 / 产业与制造 / 投资与商业 / 文化与其他）
  └─ 每集独立呈现，不强行关联

附件 A：podcast-zh-YYYY-MM-DD.md
  └─ 小宇宙各集：结构化笔记 + 完整文字稿（折叠）

附件 B：podcast-en-YYYY-MM-DD.md
  └─ 英文各集：结构化笔记（中文）+ 完整文字稿中文译文（折叠）
```

---

## 文件结构

```
~/.claude/skills/podcast-digest/
├── SKILL.md                  # 本文件
├── config.example.json       # 配置模板（无敏感信息）
├── setup.sh                  # 一键安装脚本
├── package.json
├── scripts/
│   ├── daily-digest.js       # 主流程（6阶段）
│   ├── fetch-rss.js          # 小宇宙 + RSS 抓取
│   ├── fetch-youtube.js      # YouTube 字幕提取
│   └── format-email.js       # 邮件 + 附件组装
└── prompts/
    ├── summarize-episode.md  # 单集笔记 prompt
    └── synthesize-all.md     # 跨播客综述 prompt

~/.podcast-digest/
├── config.json               # 运行配置（含 API Key，本地保存）
└── state.json                # 已处理 episode 记录（防重复推送）
```

---

## 依赖说明

| 依赖 | 用途 | 安装 |
|------|------|------|
| Node.js | 运行主脚本 | `brew install node` |
| yt-dlp | YouTube 字幕提取 | `brew install yt-dlp` |
| Docker | 运行本地 RSSHub | [docs.docker.com](https://docs.docker.com/desktop/mac/install/) |
| DashScope | 语音转录（Paraformer v2）+ Qwen LLM | [dashscope.aliyuncs.com](https://dashscope.aliyuncs.com) |
| Resend | 邮件发送 API | [resend.com](https://resend.com) |

---

## 当用户触发 /podcast 时

```bash
node ~/.claude/skills/podcast-digest/scripts/daily-digest.js
```

带参数处理：
- `test <播客名>` → `node ... --test --podcast "<name>"`
- `skip <播客名>` → 在 config.json 对应播客加 `"skip": true`
- `status` → 读取并展示 state.json 最后运行信息及各播客已处理集数
