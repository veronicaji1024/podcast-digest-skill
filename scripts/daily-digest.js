#!/usr/bin/env node
/**
 * daily-digest.js
 * 主流程：RSS/YouTube → 转录 → 摘要 → 跨播客综述 → 发邮件
 *
 * 用法：
 *   node daily-digest.js                         # 完整运行
 *   node daily-digest.js --test --podcast 硅谷101 # 单集测试（不写 state，不发邮件，打印结果）
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const axiosPkg = require('axios');
const axios = axiosPkg.default || axiosPkg;

const { fetchXiaoyuzhouEpisodes, fetchRssEpisodes, pickUnprocessedEpisode } = require('./fetch-rss');
const { pickYouTubeEpisode } = require('./fetch-youtube');
const { buildEmailBody, buildZhAttachment, buildEnAttachment } = require('./format-email');

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(process.env.HOME, '.podcast-digest', 'config.json');
const STATE_PATH = path.join(process.env.HOME, '.podcast-digest', 'state.json');
const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const DASHSCOPE_KEY = config.dashscope.apiKey;
const DASHSCOPE_ASR_URL = 'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription';
const DASHSCOPE_TASKS_URL = 'https://dashscope.aliyuncs.com/api/v1/tasks';
const QWEN_BASE = config.dashscope.baseUrl;
const QWEN_MODEL = config.dashscope.chatModel;
const QWEN_SUMMARIZE_MODEL = config.dashscope.summarizeModel || config.dashscope.chatModel;
const RESEND_KEY = config.email.apiKey;
const PROXY = config.email.proxy;
const TO_EMAIL = config.email.to;
const FROM_EMAIL = config.email.from;
const RSSHUB = config.rsshub;
const TEMP_DIR = config.tempDir || '/tmp/podcast-digest';

// CLI args
const args = process.argv.slice(2);
const TEST_MODE = args.includes('--test');
const TEST_PODCAST = args.includes('--podcast') ? args[args.indexOf('--podcast') + 1] : null;

// ─── State ────────────────────────────────────────────────────────────────────

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (_) {
    return { processedEpisodes: {}, lastRun: null };
  }
}

function saveState(state) {
  if (TEST_MODE) return; // 测试模式不写 state
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function markProcessed(state, podcastName, guid) {
  if (!state.processedEpisodes[podcastName]) {
    state.processedEpisodes[podcastName] = [];
  }
  if (!state.processedEpisodes[podcastName].includes(guid)) {
    state.processedEpisodes[podcastName].push(guid);
    // 只保留最近 50 条记录
    if (state.processedEpisodes[podcastName].length > 50) {
      state.processedEpisodes[podcastName] = state.processedEpisodes[podcastName].slice(-50);
    }
  }
}

// ─── ASR (DashScope Paraformer) ───────────────────────────────────────────────

async function submitAsrTask(audioUrl) {
  const res = await axios.post(
    DASHSCOPE_ASR_URL,
    {
      model: config.dashscope.asrModel,
      input: { file_urls: [audioUrl] },
      parameters: { timestamp_alignment: true, diarization: true },
    },
    {
      headers: {
        Authorization: `Bearer ${DASHSCOPE_KEY}`,
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable',
      },
      timeout: 30000,
    }
  );
  if (res.data?.output?.task_id) return res.data.output.task_id;
  throw new Error('ASR 提交失败：' + JSON.stringify(res.data));
}

async function pollAsrTask(taskId, maxMs = 3600000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await sleep(5000);
    const res = await axios.get(`${DASHSCOPE_TASKS_URL}/${taskId}`, {
      headers: { Authorization: `Bearer ${DASHSCOPE_KEY}` },
      timeout: 15000,
    });
    const status = res.data?.output?.task_status || res.data?.task_status;
    if (status === 'SUCCEEDED') return res.data.output;
    if (status === 'FAILED') throw new Error('ASR 任务失败');
    process.stdout.write('.');
  }
  throw new Error('ASR 超时');
}

async function fetchTranscriptFromUrl(url) {
  const res = await axios.get(url, { timeout: 120000, maxContentLength: 100 * 1024 * 1024 });
  const data = res.data;
  let text = '';
  if (data?.transcripts) {
    for (const t of data.transcripts) {
      if (t.text) text += t.text + '\n';
      else if (t.sentences) text += t.sentences.map((s) => s.text).join('') + '\n';
    }
  } else if (data?.text) {
    text = data.text;
  }
  return text.trim();
}

async function transcribeAudio(audioUrl) {
  console.log(`  [ASR] 提交转录任务: ${audioUrl.slice(0, 80)}...`);
  const taskId = await submitAsrTask(audioUrl);
  console.log(`  [ASR] taskId=${taskId}，等待结果`);
  const result = await pollAsrTask(taskId);
  console.log('\n  [ASR] 完成');

  // 有些模型返回 transcription_url
  if (result?.results?.[0]?.transcription_url) {
    return fetchTranscriptFromUrl(result.results[0].transcription_url);
  }

  // 直接返回文本
  let text = '';
  for (const r of result?.results || []) {
    for (const t of r?.transcripts || []) {
      text += (t.text || '') + '\n';
    }
  }
  return text.trim();
}

// ─── 文本分块 ─────────────────────────────────────────────────────────────────

/**
 * 将长文本分成固定大小的块
 * @param {string} text
 * @param {number} chunkSize  每块字符数
 * @param {number} overlap    相邻块重叠字符数（0 = 无重叠）
 */
function chunkText(text, chunkSize, overlap = 0) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = end - overlap;
  }
  return chunks;
}

// ─── Qwen 调用 ────────────────────────────────────────────────────────────────

const SUMMARIZE_PROMPT = fs.readFileSync(path.join(PROMPTS_DIR, 'summarize-episode.md'), 'utf8');
const SYNTHESIZE_PROMPT = fs.readFileSync(path.join(PROMPTS_DIR, 'synthesize-all.md'), 'utf8');

async function callQwen(systemPrompt, userContent, model = QWEN_MODEL) {
  const res = await axios.post(
    `${QWEN_BASE}/chat/completions`,
    {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      max_tokens: 8192,
    },
    {
      headers: {
        Authorization: `Bearer ${DASHSCOPE_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 300000,
    }
  );
  return res.data?.choices?.[0]?.message?.content || '';
}

// ─── 单集笔记生成（支持分块）────────────────────────────────────────────────

/**
 * 单次调用生成一集笔记（用于短 transcript，或分块后的每段）
 */
async function summarizeEpisodeSingle(podcastName, episodeTitle, transcript, isEnglish, chunkLabel = '') {
  const langNote = isEnglish
    ? '\n\n【语言说明】英文播客。笔记主体用中文，专有名词和重要原话保留英文。不需要附完整文字稿译文（译文单独处理）。'
    : '\n\n【语言说明】中文播客，全程中文。';

  const chunkNote = chunkLabel ? `\n（${chunkLabel}）` : '';

  const userContent = `播客名称：${podcastName}
本集标题：${episodeTitle}${chunkNote}

以下是完整文字稿：

${transcript}
${langNote}`;

  return callQwen(SUMMARIZE_PROMPT, userContent, QWEN_SUMMARIZE_MODEL);
}

/**
 * 生成一集笔记（自动分块处理长 transcript）
 */
async function summarizeEpisodeChunked(podcastName, episodeTitle, transcript, isEnglish) {
  const SINGLE_THRESHOLD = 20000;
  const CHUNK_SIZE = 18000;
  const OVERLAP = 2000;

  if (transcript.length <= SINGLE_THRESHOLD) {
    return summarizeEpisodeSingle(podcastName, episodeTitle, transcript, isEnglish);
  }

  const chunks = chunkText(transcript, CHUNK_SIZE, OVERLAP);
  console.log(`  [${podcastName}] transcript 分块: ${chunks.length} 块，共 ${transcript.length} 字`);

  // 串行对每块生成摘要片段（避免并发过高触发限流）
  const chunkSummaries = [];
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await sleep(1000);
    chunkSummaries.push(
      await summarizeEpisodeSingle(podcastName, episodeTitle, chunks[i], isEnglish, `第 ${i + 1}/${chunks.length} 段`)
    );
  }

  // 合并前清洗：去掉以 meta 指令开头的行（如"续接上文"、"接下来"、"以下为"等）
  const META_PREFIXES = /^(续接|接下来|以下为|以下是|如前所述|综上所述|上文提到|继续|接续)/;
  const cleanedSummaries = chunkSummaries.map((s) =>
    s
      .split('\n')
      .filter((line) => !META_PREFIXES.test(line.trim()))
      .join('\n')
      .trim()
  );

  // 合并：再调用一次整合所有片段
  const mergeSystemPrompt =
    '你是一个认真记播客笔记的人。以下是同一集播客多段文字稿各自生成的笔记片段，请整合成一份完整的结构化笔记。保持原有笔记格式，去掉重复内容，合并相似观点，补全各段互补的信息。';
  const mergeUserContent = `播客名称：${podcastName}\n本集标题：${episodeTitle}\n\n${cleanedSummaries
    .map((s, i) => `## 第 ${i + 1} 段笔记\n${s}`)
    .join('\n\n---\n\n')}`;

  return callQwen(mergeSystemPrompt, mergeUserContent, QWEN_SUMMARIZE_MODEL);
}

// ─── 英文 Transcript 分块翻译 ─────────────────────────────────────────────────

const TRANSLATE_SYSTEM = '请将以下英文播客文字稿翻译成中文。忠实还原原意，专有名词（公司名、产品名、人名、技术术语）保留英文，语言平实自然，口语化表达可适当调整使其通顺，但不改变意思。';

/**
 * 将英文 transcript 分块翻译成中文并拼接
 */
async function translateTranscript(podcastName, transcript) {
  const CHUNK_SIZE = 20000;

  if (transcript.length <= CHUNK_SIZE) {
    return callQwen(TRANSLATE_SYSTEM, transcript, QWEN_SUMMARIZE_MODEL);
  }

  const chunks = chunkText(transcript, CHUNK_SIZE, 0); // 翻译不需要重叠
  console.log(`  [${podcastName}] 英文 transcript 分块翻译: ${chunks.length} 块`);

  const translations = await Promise.all(
    chunks.map((chunk, i) =>
      callQwen(TRANSLATE_SYSTEM, `（第 ${i + 1}/${chunks.length} 段）\n\n${chunk}`, QWEN_SUMMARIZE_MODEL)
    )
  );

  return translations.join('\n\n');
}

// ─── 跨播客综述 ────────────────────────────────────────────────────────────────

/**
 * 基于所有集的笔记生成跨播客综述（邮件正文）
 */
async function synthesizeAll(items) {
  const summaries = items
    .map((r) => {
      const preview = r.notes ? r.notes.slice(0, 8000) : '[无内容]';
      return `【${r.podcast.name}·${r.ep.title}】\n${preview}`;
    })
    .join('\n\n---\n\n');

  return callQwen(SYNTHESIZE_PROMPT, summaries, QWEN_SUMMARIZE_MODEL);
}

// ─── Email 发送 ────────────────────────────────────────────────────────────────

async function sendEmail(subject, bodyText, attachments, date) {
  const { execSync } = require('child_process');

  const payload = JSON.stringify({
    from: FROM_EMAIL,
    to: [TO_EMAIL],
    subject,
    text: bodyText,
    attachments,
  });

  const payloadFile = `/tmp/podcast-resend-${date}.json`;
  fs.writeFileSync(payloadFile, payload);

  const result = execSync(
    `curl -x ${PROXY} -s -X POST https://api.resend.com/emails ` +
      `-H "Authorization: Bearer ${RESEND_KEY}" ` +
      `-H "Content-Type: application/json" ` +
      `-d @${payloadFile}`,
    { encoding: 'utf8', timeout: 30000 }
  );

  fs.unlinkSync(payloadFile);

  if (result.includes('"id"')) {
    console.log(`[Email] 发送成功: ${result.trim()}`);
    return true;
  } else {
    console.error(`[Email] 发送失败: ${result.trim()}`);
    return false;
  }
}

// ─── 音频下载 ─────────────────────────────────────────────────────────────────

async function downloadAudio(audioUrl, outputPath) {
  const { execSync } = require('child_process');
  execSync(`curl -L -o "${outputPath}" "${audioUrl}"`, {
    encoding: 'utf8',
    timeout: 600000, // 10 分钟
  });
  const stat = fs.statSync(outputPath);
  if (stat.size === 0) throw new Error('下载文件为空');
  console.log(`  [Download] ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function today() {
  return new Date().toISOString().split('T')[0];
}

// ─── 主流程（并行优化版）──────────────────────────────────────────────────────

/**
 * 第一阶段：并行拉取所有 RSS / YouTube 元数据 + 选集
 */
async function fetchAllEpisodes(state) {
  // 小宇宙：串行拉取，避免并发请求压垮本地 rsshub
  const zhResults = [];
  for (const podcast of config.podcasts.xiaoyuzhou) {
    if (podcast.skip) continue;
    if (TEST_PODCAST && podcast.name !== TEST_PODCAST) continue;
    const processedGuids = new Set(state.processedEpisodes[podcast.name] || []);
    const { episodes } = await fetchXiaoyuzhouEpisodes(podcast, RSSHUB, config.maxEpisodesPerFeed);
    const ep = pickUnprocessedEpisode(episodes, processedGuids);
    if (ep) zhResults.push({ podcast, ep, type: 'xiaoyuzhou' });
  }

  // YouTube + RSS：并行拉取（各打不同服务器，无需限流）
  const enTasks = [];
  for (const podcast of config.podcasts.youtube) {
    if (podcast.skip) continue;
    if (TEST_PODCAST && podcast.name !== TEST_PODCAST) continue;
    enTasks.push(async () => {
      const processedGuids = new Set(state.processedEpisodes[podcast.name] || []);
      const ep = pickYouTubeEpisode(podcast, processedGuids);
      return ep ? { podcast, ep, type: 'youtube', transcript: ep.transcript } : null;
    });
  }
  for (const podcast of config.podcasts.rss) {
    if (podcast.skip) continue;
    if (TEST_PODCAST && podcast.name !== TEST_PODCAST) continue;
    enTasks.push(async () => {
      const processedGuids = new Set(state.processedEpisodes[podcast.name] || []);
      const { episodes } = await fetchRssEpisodes(podcast, config.maxEpisodesPerFeed);
      const ep = pickUnprocessedEpisode(episodes, processedGuids);
      return ep ? { podcast, ep, type: 'rss' } : null;
    });
  }
  const enResults = await pLimit(enTasks, 8);

  const results = [...zhResults, ...enResults.filter(Boolean)];
  return results;
}

/**
 * 第二阶段：并行提交所有 ASR 任务（小宇宙 + RSS 音频）
 * 返回 taskId map：podcastName → taskId
 */
async function submitAllAsrTasks(items) {
  const audioItems = items.filter((item) => !item.transcript && item.ep.audioUrl);
  if (!audioItems.length) return {};

  console.log(`\n[ASR] 并行提交 ${audioItems.length} 个转录任务...`);
  const taskMap = {};

  await Promise.all(
    audioItems.map(async (item) => {
      try {
        const taskId = await submitAsrTask(item.ep.audioUrl);
        taskMap[item.podcast.name] = taskId;
        console.log(`  [${item.podcast.name}] taskId=${taskId}`);
      } catch (err) {
        console.error(`  [${item.podcast.name}] ASR提交失败: ${err.message}`);
      }
    })
  );

  return taskMap;
}

/**
 * 第三阶段：并行轮询所有 ASR 任务直到全部完成
 */
async function waitAllAsrTasks(taskMap) {
  const names = Object.keys(taskMap);
  if (!names.length) return {};

  console.log(`\n[ASR] 等待 ${names.length} 个任务完成...`);
  const results = {};

  await Promise.all(
    names.map(async (name) => {
      try {
        const output = await pollAsrTask(taskMap[name]);
        let transcript = '';
        if (output?.results?.[0]?.transcription_url) {
          transcript = await fetchTranscriptFromUrl(output.results[0].transcription_url);
        } else {
          for (const r of output?.results || []) {
            for (const t of r?.transcripts || []) transcript += (t.text || '') + '\n';
          }
        }
        results[name] = transcript.trim();
        console.log(`\n  [${name}] 转录完成 (${results[name].length} 字)`);
      } catch (err) {
        console.error(`\n  [${name}] 转录失败: ${err.message}`);
        results[name] = `[转录失败: ${err.message}]`;
      }
    })
  );

  return results;
}

/**
 * 第四阶段：并行生成所有笔记（分块处理）+ 英文 transcript 分块翻译
 */
async function summarizeAll(items) {
  console.log(`\n[Qwen] 生成 ${items.length} 个摘要（并发 2）...`);

  const tasks = items.map((item) => async () => {
    const isEnglish = item.type !== 'xiaoyuzhou';
    try {
      item.notes = await summarizeEpisodeChunked(
        item.podcast.name,
        item.ep.title,
        item.transcript,
        isEnglish
      );
      console.log(`  [${item.podcast.name}] 笔记完成 (${item.notes.length} 字)`);

      if (isEnglish && item.transcript) {
        item.zhTranslation = await translateTranscript(item.podcast.name, item.transcript);
        console.log(`  [${item.podcast.name}] 译文完成 (${item.zhTranslation.length} 字)`);
      }
    } catch (err) {
      console.error(`  [${item.podcast.name}] 处理失败: ${err.message}`);
      item.notes = `[摘要生成失败: ${err.message}]`;
    }
  });

  await pLimit(tasks, 2);
}

/**
 * 简易并发限制器
 */
async function pLimit(tasks, concurrency) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      try {
        results[i] = await tasks[i]();
      } catch (err) {
        console.error(`[pLimit] task ${i} error:`, err.message);
        results[i] = null;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function main() {
  const state = loadState();
  const date = today();

  console.log(`\n=== 播客日报 ${date} ===`);
  if (TEST_MODE) console.log(`[测试模式]${TEST_PODCAST ? ` 仅处理: ${TEST_PODCAST}` : ''}`);

  // 阶段1：并行拉取元数据 + YouTube字幕
  console.log('\n[阶段1] 并行拉取所有播客元数据...');
  const items = await fetchAllEpisodes(state);
  console.log(`  获取到 ${items.length} 集`);

  if (!items.length) {
    console.log('[结束] 无内容可发送');
    return;
  }

  // 打印选集列表
  for (const item of items) {
    const tag = item.ep.isNew ? '(今日新集)' : item.ep.epDate ? `(${item.ep.epDate})` : '';
    console.log(`  • [${item.podcast.name}] 《${item.ep.title}》 ${tag}`);
  }

  // 阶段2+3：并行提交并等待 ASR（YouTube 已有字幕，跳过）
  const taskMap = await submitAllAsrTasks(items);
  const asrResults = await waitAllAsrTasks(taskMap);

  // 将转录结果写回 items
  for (const item of items) {
    if (!item.transcript) {
      item.transcript = asrResults[item.podcast.name] || item.ep.description || '[无文字稿]';
    }
  }

  // 阶段4：并行生成笔记（分块）+ 英文译文（分块）
  await summarizeAll(items);

  const results = items;
  const processedList = items.map((r) => ({ name: r.podcast.name, guid: r.ep.guid }));

  if (results.length === 0) {
    console.log('\n[结束] 无内容可发送');
    return;
  }

  // 阶段5：生成跨播客综述（邮件正文）
  console.log(`\n[阶段5] 生成跨播客综述...`);
  let synthesis = '';
  try {
    synthesis = await synthesizeAll(results);
    console.log(`  综述完成 (${synthesis.length} 字)`);
  } catch (err) {
    console.error('[综述] 失败:', err.message);
  }

  // 阶段6：组装邮件并发送
  const emailBody = buildEmailBody({ date, synthesis, results });
  const zhMarkdown = buildZhAttachment({ date, results });
  const enMarkdown = buildEnAttachment({ date, results });

  const attachments = [];
  if (zhMarkdown) attachments.push({
    filename: `podcast-zh-${date}.md`,
    content: Buffer.from(zhMarkdown).toString('base64'),
  });
  if (enMarkdown) attachments.push({
    filename: `podcast-en-${date}.md`,
    content: Buffer.from(enMarkdown).toString('base64'),
  });

  if (TEST_MODE) {
    // 测试模式：保存到文件，打印预览
    const bodyFile = `/tmp/podcast-digest-body-${date}.txt`;
    fs.writeFileSync(bodyFile, emailBody);
    if (zhMarkdown) fs.writeFileSync(`/tmp/podcast-digest-zh-${date}.md`, zhMarkdown);
    if (enMarkdown) fs.writeFileSync(`/tmp/podcast-digest-en-${date}.md`, enMarkdown);
    console.log(`\n[测试] 邮件正文: ${bodyFile}`);
    if (zhMarkdown) console.log(`[测试] 中文附件: /tmp/podcast-digest-zh-${date}.md`);
    if (enMarkdown) console.log(`[测试] 英文附件: /tmp/podcast-digest-en-${date}.md`);
    console.log('\n--- 邮件正文预览 ---\n');
    console.log(emailBody);
    return;
  }

  // 更新 state
  for (const { name, guid } of processedList) {
    markProcessed(state, name, guid);
  }
  state.lastRun = new Date().toISOString();
  saveState(state);

  // 发送邮件
  const subject = `播客日报 · ${date}（${results.length}集）`;
  await sendEmail(subject, emailBody, attachments, date);

  console.log(`\n=== 完成：处理 ${results.length} 集，已发送邮件 ===`);
}

main().catch((err) => {
  console.error('[Fatal]', err);
  process.exit(1);
});
