# Podcast Digest

A Claude Code skill that automatically scrapes **19 AI/tech podcasts** daily, generates bilingual (Chinese + English) deep-notes, and delivers them via email.

**10 Xiaoyuzhou (小宇宙) podcasts** — fetched via local RSSHub, transcribed with DashScope Paraformer v2
**8 English YouTube podcasts** — subtitles extracted instantly via yt-dlp
**1 English RSS podcast** (Acquired) — transcribed with DashScope Paraformer v2

---

## What You Get

**Email body** — cross-podcast synthesis grouped by domain (AI & Products / Industry / Investment / Culture)

**Attachment A** `podcast-zh-YYYY-MM-DD.md` — structured notes + full transcript for each Xiaoyuzhou episode

**Attachment B** `podcast-en-YYYY-MM-DD.md` — structured notes (in Chinese) + full Chinese translation of each English episode transcript

---

## Prerequisites

| Tool | Purpose | Install |
|------|---------|---------|
| Node.js ≥ 18 | Run the main scripts | `brew install node` |
| yt-dlp | Extract YouTube subtitles | `brew install yt-dlp` |
| Docker | Run local RSSHub | [docs.docker.com](https://docs.docker.com/desktop/mac/install/) |
| DashScope API key | Paraformer v2 ASR + Qwen LLM | [dashscope.aliyuncs.com](https://dashscope.aliyuncs.com) |
| Resend API key | Email delivery | [resend.com](https://resend.com) |

---

## Installation

```bash
bash setup.sh
```

The script will:
1. Check all dependencies
2. Install npm packages
3. Start a local RSSHub Docker container (`--restart always`)
4. Create `~/.podcast-digest/config.json` from the template

Then fill in your credentials:

```bash
vim ~/.podcast-digest/config.json
```

```jsonc
{
  "dashscope": {
    "apiKey": "sk-..."          // DashScope API key (ASR + Qwen)
  },
  "email": {
    "apiKey": "re_...",          // Resend API key
    "to": "you@example.com",
    "proxy": "http://127.0.0.1:7897"  // optional: HTTP proxy
  }
}
```

---

## Usage

### As a Claude Code skill

Place this folder under `~/.claude/skills/podcast-digest/`, then in Claude Code:

```
/podcast              # run full digest and send email
/podcast test 硅谷101 # test a single podcast (no email sent)
/podcast skip 乱翻书  # temporarily skip a podcast
/podcast status       # show last run time and episode counts
```

### From the command line

```bash
# Full run (fetches all 19 podcasts, sends email)
node scripts/daily-digest.js

# Test a single podcast (outputs to /tmp, no email)
node scripts/daily-digest.js --test --podcast "硅谷101"
```

### Scheduled (cron)

Daily at 10:00 AM GMT+8 (02:00 UTC):

```bash
crontab -e
# Add:
0 2 * * * cd ~/.claude/skills/podcast-digest && node scripts/daily-digest.js >> /tmp/podcast-digest.log 2>&1
```

---

## How It Works

```
Phase 1 (parallel)   Fetch all RSS / YouTube metadata + pick episodes + download subtitles
Phase 2 (parallel)   Submit all Xiaoyuzhou / RSS audio to DashScope ASR
Phase 3 (parallel)   Poll until all ASR tasks complete
Phase 4 (parallel)   ├─ Generate per-episode notes (auto-chunked for long transcripts)
                     └─ Translate English transcripts to Chinese (chunked)
Phase 5              Synthesize all notes into cross-podcast overview (email body)
Phase 6              Assemble and send email via Resend API
```

**Chunking strategy:**

| Task | Single-call threshold | Chunk size | Overlap |
|------|-----------------------|------------|---------|
| Episode notes | ≤ 20,000 chars | 18,000 chars | 2,000 chars |
| English translation | — | 20,000 chars | none |

---

## Podcast List

<details>
<summary>小宇宙 (10 podcasts)</summary>

| Name | ID |
|------|----|
| 十字路口 | `60502e253c92d4f62c2a9577` |
| 42章经 | `648b0b641c48983391a63f98` |
| Why Not TV | `686a1832222ae2de21fea940` |
| 张小珺访谈录 | `626b46ea9cbbf0451cf5a962` |
| 乱翻书 | `61358d971c5d56efe5bcb5d2` |
| 科技乱炖 | `5e4243cd418a84a0469573fb` |
| 硅谷101 | `5e5c52c9418a84a04625e6cc` |
| 厚雪长波 | `646d6bfa53a5e5ea14e69c7c` |
| 知行小酒馆 | `6013f9f58e2f7ee375cf4216` |
| AI炼金术 | `63e9ef4de99bdef7d39944c8` |

</details>

<details>
<summary>English YouTube (8 podcasts)</summary>

| Name | Source |
|------|--------|
| Lex Fridman | `@lexfridman` |
| No Priors | `@NoPriorsPodcast` |
| AI & I (Anthropic) | playlist `PLuMcoKK9mKgHtW_o9h5sGO2vXrffKHwJL` |
| All-In | `@theallinpod` |
| Anthropic | `@anthropic-ai` |
| Lenny's Podcast | `@LennysPodcast` |
| Latent Space | playlist `PLWEAb1SXhjlfkEF_PxzYHonU_v5LPMI8L` |
| AI Explained | `@aiexplained-official` |

</details>

<details>
<summary>English RSS (1 podcast)</summary>

| Name | RSS URL |
|------|---------|
| Acquired | `https://feeds.transistor.fm/acquired` |

</details>

---

## Project Structure

```
.
├── README.md
├── SKILL.md               # Claude Code skill definition
├── config.example.json    # Config template (no credentials)
├── setup.sh               # One-command installer
├── package.json
├── scripts/
│   ├── daily-digest.js    # Main pipeline (6 phases)
│   ├── fetch-rss.js       # Xiaoyuzhou + RSS fetching
│   ├── fetch-youtube.js   # YouTube subtitle extraction
│   └── format-email.js    # Email body + attachment builder
└── prompts/
    ├── summarize-episode.md   # Per-episode notes prompt
    └── synthesize-all.md      # Cross-podcast synthesis prompt
```

Runtime state is stored in `~/.podcast-digest/` (outside this repo):
- `config.json` — your credentials and podcast list
- `state.json` — processed episode history (deduplication)

---

## Note Style

Notes follow an *Economist* / Stratechery style: cold, precise, evidence-first. No buzzwords ("底层逻辑", "赋能", "范式转移"). Key facts, numbers, quotes, and named sources are always preserved.

---

## License

MIT
