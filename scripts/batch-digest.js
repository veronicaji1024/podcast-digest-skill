#!/usr/bin/env node
/**
 * batch-digest.js
 * 批量处理指定播客的多期内容，保存 transcript 到本地，合并发送一封邮件
 * 用法: node batch-digest.js
 */

const fs = require('fs');
const path = require('path');
const axiosPkg = require('axios');
const axios = axiosPkg.default || axiosPkg;

const { fetchXiaoyuzhouEpisodes } = require('./fetch-rss');

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(process.env.HOME, '.podcast-digest', 'config.json');
const STATE_PATH  = path.join(process.env.HOME, '.podcast-digest', 'state.json');
const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');
const TRANSCRIPTS_DIR = path.join(process.env.HOME, 'Downloads', '小程序', 'podcast-digest', 'transcripts');

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const DASHSCOPE_KEY      = config.dashscope.apiKey;
const DASHSCOPE_ASR_URL  = 'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription';
const DASHSCOPE_TASKS_URL = 'https://dashscope.aliyuncs.com/api/v1/tasks';
const QWEN_BASE  = config.dashscope.baseUrl;
const QWEN_MODEL = config.dashscope.summarizeModel || config.dashscope.chatModel;
const RESEND_KEY = config.email.apiKey;
const PROXY      = config.email.proxy;
const TO_EMAIL   = config.email.to;
const FROM_EMAIL = config.email.from;
const RSSHUB     = config.rsshub;

// ─── 目标播客配置 ──────────────────────────────────────────────────────────────

const TARGET_PODCASTS  = ['42章经', '十字路口'];
const EPISODES_COUNT   = 6;

// ─── Prompts ──────────────────────────────────────────────────────────────────

const SUMMARIZE_PROMPT  = fs.readFileSync(path.join(PROMPTS_DIR, 'summarize-episode.md'), 'utf8');
const SYNTHESIZE_PROMPT = fs.readFileSync(path.join(PROMPTS_DIR, 'synthesize-all.md'), 'utf8');

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sanitizeFilename(str) {
  return str.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);
}

function saveTranscript(podcastName, episodeTitle, transcript) {
  if (!transcript || transcript.startsWith('[')) return;
  try {
    const podDir = path.join(TRANSCRIPTS_DIR, sanitizeFilename(podcastName));
    ensureDir(podDir);
    const filename = sanitizeFilename(episodeTitle) + '.txt';
    fs.writeFileSync(path.join(podDir, filename), transcript, 'utf8');
    console.log(`  [Transcript] 已保存: ${podcastName}/${filename}`);
  } catch (err) {
    console.error(`  [Transcript] 保存失败: ${err.message}`);
  }
}

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

async function pLimit(tasks, concurrency) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      try { results[i] = await tasks[i](); }
      catch (err) { console.error(`[pLimit] task ${i} error:`, err.message); results[i] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

// ─── State ────────────────────────────────────────────────────────────────────

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch (_) { return { processedEpisodes: {}, lastRun: null }; }
}

function markProcessed(state, podcastName, guid) {
  if (!state.processedEpisodes[podcastName]) state.processedEpisodes[podcastName] = [];
  if (!state.processedEpisodes[podcastName].includes(guid)) {
    state.processedEpisodes[podcastName].push(guid);
    if (state.processedEpisodes[podcastName].length > 50)
      state.processedEpisodes[podcastName] = state.processedEpisodes[podcastName].slice(-50);
  }
}

// ─── ASR ──────────────────────────────────────────────────────────────────────

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
      text += (t.text || t.sentences?.map(s => s.text).join('') || '') + '\n';
    }
  } else if (data?.text) {
    text = data.text;
  }
  return text.trim();
}

// ─── Qwen 摘要 ────────────────────────────────────────────────────────────────

async function callQwen(systemPrompt, userContent) {
  const res = await axios.post(
    `${QWEN_BASE}/chat/completions`,
    {
      model: QWEN_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      max_tokens: 8192,
    },
    {
      headers: { Authorization: `Bearer ${DASHSCOPE_KEY}`, 'Content-Type': 'application/json' },
      timeout: 300000,
    }
  );
  return res.data?.choices?.[0]?.message?.content || '';
}

async function summarizeEpisodeSingle(podcastName, episodeTitle, transcript, chunkLabel = '') {
  const chunkNote = chunkLabel ? `\n（${chunkLabel}）` : '';
  return callQwen(
    SUMMARIZE_PROMPT,
    `播客名称：${podcastName}\n本集标题：${episodeTitle}${chunkNote}\n\n以下是完整文字稿：\n\n${transcript}\n\n【语言说明】中文播客，全程中文。`
  );
}

async function summarizeEpisodeChunked(podcastName, episodeTitle, transcript) {
  const SINGLE_THRESHOLD = 20000;
  const CHUNK_SIZE = 18000;
  const OVERLAP = 2000;

  if (transcript.length <= SINGLE_THRESHOLD)
    return summarizeEpisodeSingle(podcastName, episodeTitle, transcript);

  const chunks = chunkText(transcript, CHUNK_SIZE, OVERLAP);
  console.log(`  [${podcastName}] transcript 分块: ${chunks.length} 块，共 ${transcript.length} 字`);

  const chunkSummaries = [];
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await sleep(1000);
    chunkSummaries.push(
      await summarizeEpisodeSingle(podcastName, episodeTitle, chunks[i], `第 ${i + 1}/${chunks.length} 段`)
    );
  }

  const META_PREFIXES = /^(续接|接下来|以下为|以下是|如前所述|综上所述|上文提到|继续|接续)/;
  const cleaned = chunkSummaries.map(s =>
    s.split('\n').filter(l => !META_PREFIXES.test(l.trim())).join('\n').trim()
  );

  return callQwen(
    '你是一个认真记播客笔记的人。以下是同一集播客多段文字稿各自生成的笔记片段，请整合成一份完整的结构化笔记。保持原有笔记格式，去掉重复内容，合并相似观点，补全各段互补的信息。',
    `播客名称：${podcastName}\n本集标题：${episodeTitle}\n\n${cleaned.map((s, i) => `## 第 ${i + 1} 段笔记\n${s}`).join('\n\n---\n\n')}`
  );
}

// ─── 邮件发送 ─────────────────────────────────────────────────────────────────

async function sendEmail(subject, bodyText, attachments, date) {
  const { execSync } = require('child_process');
  const payload = JSON.stringify({ from: FROM_EMAIL, to: [TO_EMAIL], subject, text: bodyText, attachments });
  const payloadFile = `/tmp/podcast-batch-${date}.json`;
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
  }
  console.error(`[Email] 发送失败: ${result.trim()}`);
  return false;
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────

async function main() {
  const date = new Date().toISOString().split('T')[0];
  console.log(`\n=== 播客特刊 ${date} ===`);
  console.log(`目标：${TARGET_PODCASTS.join('、')}，各取最近 ${EPISODES_COUNT} 集\n`);

  // 查找目标播客配置
  const targetConfigs = config.podcasts.xiaoyuzhou.filter(p => TARGET_PODCASTS.includes(p.name));
  if (!targetConfigs.length) {
    console.error('[Fatal] 找不到目标播客配置');
    process.exit(1);
  }

  // 阶段1：串行拉取元数据（同一 rsshub，避免超时）
  console.log('[阶段1] 拉取播客元数据...');
  const allItems = [];
  for (const podcast of targetConfigs) {
    const { episodes } = await fetchXiaoyuzhouEpisodes(podcast, RSSHUB, EPISODES_COUNT + 2);
    const sorted = [...episodes].sort((a, b) => b.pubDateMs - a.pubDateMs);
    const picked = sorted.slice(0, EPISODES_COUNT);
    console.log(`  [${podcast.name}] 获取到 ${picked.length} 集`);
    for (const ep of picked) {
      const epDate = ep.pubDate ? new Date(ep.pubDate).toISOString().split('T')[0] : null;
      allItems.push({ podcast, ep: { ...ep, epDate, isNew: false }, type: 'xiaoyuzhou' });
      console.log(`    • 《${ep.title}》 (${epDate || '未知日期'})`);
    }
  }

  if (!allItems.length) {
    console.log('[结束] 无内容');
    return;
  }

  // 阶段2：并行提交所有 ASR 任务
  console.log(`\n[阶段2] 并行提交 ${allItems.length} 个 ASR 任务...`);
  const taskMap = {};
  await Promise.all(allItems.map(async (item, i) => {
    const label = `${item.podcast.name}·${item.ep.title.slice(0, 15)}`;
    try {
      const taskId = await submitAsrTask(item.ep.audioUrl);
      taskMap[i] = taskId;
      console.log(`  [${label}] taskId=${taskId}`);
    } catch (err) {
      console.error(`  [${label}] ASR提交失败: ${err.message}`);
    }
  }));

  // 阶段3：并行等待所有转录完成
  console.log(`\n[阶段3] 等待转录完成...`);
  await Promise.all(allItems.map(async (item, i) => {
    const label = `${item.podcast.name}·${item.ep.title.slice(0, 15)}`;
    if (!taskMap[i]) {
      item.transcript = '[转录提交失败]';
      return;
    }
    try {
      const output = await pollAsrTask(taskMap[i]);
      let transcript = '';
      if (output?.results?.[0]?.transcription_url) {
        transcript = await fetchTranscriptFromUrl(output.results[0].transcription_url);
      } else {
        for (const r of output?.results || [])
          for (const t of r?.transcripts || []) transcript += (t.text || '') + '\n';
      }
      item.transcript = transcript.trim();
      console.log(`\n  [${label}] 转录完成 (${item.transcript.length} 字)`);
    } catch (err) {
      console.error(`\n  [${label}] 转录失败: ${err.message}`);
      item.transcript = `[转录失败: ${err.message}]`;
    }
  }));

  // 阶段4：保存 transcript 到本地
  console.log('\n[阶段4] 保存 transcript 到本地...');
  ensureDir(TRANSCRIPTS_DIR);
  for (const item of allItems) {
    saveTranscript(item.podcast.name, item.ep.title, item.transcript);
  }

  // 阶段5：并行生成摘要（并发 2）
  console.log(`\n[阶段5] 生成摘要（并发 2）...`);
  await pLimit(allItems.map(item => async () => {
    const label = `${item.podcast.name}·${item.ep.title.slice(0, 15)}`;
    try {
      item.notes = await summarizeEpisodeChunked(item.podcast.name, item.ep.title, item.transcript);
      console.log(`  [${label}] 笔记完成 (${item.notes.length} 字)`);
    } catch (err) {
      console.error(`  [${label}] 失败: ${err.message}`);
      item.notes = `[摘要生成失败: ${err.message}]`;
    }
  }), 2);

  // 阶段6：生成综述
  console.log('\n[阶段6] 生成综述...');
  const summaries = allItems.map(r =>
    `【${r.podcast.name}·${r.ep.title}】\n${(r.notes || '[无内容]').slice(0, 8000)}`
  ).join('\n\n---\n\n');

  let synthesis = '[综述生成失败]';
  try {
    synthesis = await callQwen(SYNTHESIZE_PROMPT, summaries);
    console.log(`  综述完成 (${synthesis.length} 字)`);
  } catch (err) {
    console.error('综述失败:', err.message);
  }

  // 组装邮件
  const emailBody = [
    `播客特刊 — ${date}`,
    `本期共 ${allItems.length} 集：${TARGET_PODCASTS.join('、')} 各 ${EPISODES_COUNT} 期\n`,
    '━━━━━━━━━━━━━━━━━━━━\n',
    synthesis,
    '\n━━━━━━━━━━━━━━━━━━━━',
    '详细笔记见附件。',
  ].join('\n');

  const attachmentSections = [`# 播客特刊 — ${date}\n`];
  for (const r of allItems) {
    const url = r.ep.url ? `\n[收听原集](${r.ep.url})` : '';
    attachmentSections.push(`## ${r.podcast.name} · 《${r.ep.title}》 ${r.ep.epDate || ''}\n`);
    attachmentSections.push(r.notes || '[笔记生成失败]');
    if (r.transcript && !r.transcript.startsWith('[')) {
      attachmentSections.push(
        `\n<details><summary>完整文字稿（点击展开）</summary>\n\n${r.transcript}\n\n</details>`
      );
    }
    attachmentSections.push(url + '\n\n---\n');
  }

  const attachments = [{
    filename: `podcast-batch-${date}.md`,
    content: Buffer.from(attachmentSections.join('\n')).toString('base64'),
  }];

  // 发送邮件
  const subject = `播客特刊 · ${TARGET_PODCASTS.join('+')} · ${date}（共${allItems.length}集）`;
  await sendEmail(subject, emailBody, attachments, date);

  // 标记为已处理（避免 daily 脚本重复发送）
  const state = loadState();
  for (const item of allItems) markProcessed(state, item.podcast.name, item.ep.guid);
  state.lastRun = new Date().toISOString();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(`\n[状态] 已标记 ${allItems.length} 集为已处理`);

  console.log('\n=== 完成 ===');
}

main().catch(err => {
  console.error('[Fatal]', err);
  process.exit(1);
});
