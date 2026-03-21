/**
 * format-email.js
 * 邮件正文：跨播客综述
 * 附件 A：podcast-zh-YYYY-MM-DD.md（小宇宙播客笔记 + transcript）
 * 附件 B：podcast-en-YYYY-MM-DD.md（英文播客笔记 + 中文译文）
 */

/**
 * 生成邮件正文（跨播客综述）
 */
function buildEmailBody({ date, synthesis, results }) {
  const lines = [];
  lines.push(`播客日报 — ${date}`);
  lines.push(`本期共 ${results.length} 集\n`);

  const zh = results.filter((r) => r.type === 'xiaoyuzhou');
  const en = results.filter((r) => r.type !== 'xiaoyuzhou');

  if (zh.length) {
    lines.push('小宇宙：' + zh.map((r) => r.podcast.name).join('、'));
  }
  if (en.length) {
    lines.push('英文：' + en.map((r) => r.podcast.name).join(', '));
  }

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━\n');

  if (synthesis) {
    lines.push(synthesis);
  } else {
    lines.push('[综述生成失败]');
  }

  lines.push('\n━━━━━━━━━━━━━━━━━━━━');
  lines.push('详细笔记见附件。每日 10:00 GMT+8 自动发送。');

  return lines.join('\n');
}

/**
 * 生成中文播客附件（小宇宙，含结构化笔记 + 完整 transcript）
 */
function buildZhAttachment({ date, results }) {
  const zhResults = results.filter((r) => r.type === 'xiaoyuzhou');
  if (!zhResults.length) return null;

  const sections = [`# 小宇宙播客笔记 — ${date}\n`];

  for (const r of zhResults) {
    const tag = r.ep.isReplay ? ' ♻️ 重播' : !r.ep.isNew && r.ep.epDate ? ` 📅 发布于 ${r.ep.epDate}` : '';
    const url = r.ep.url ? `\n[🔗 收听原集](${r.ep.url})` : '';

    sections.push(`## ${r.podcast.name} · 《${r.ep.title}》${tag}\n`);
    sections.push(r.notes || '[笔记生成失败]');
    sections.push('');

    if (r.transcript) {
      sections.push(
        `<details><summary>📄 完整文字稿（点击展开）</summary>\n\n${r.transcript}\n\n</details>`
      );
    }

    sections.push(url);
    sections.push('\n---\n');
  }

  return sections.join('\n');
}

/**
 * 生成英文播客附件（含结构化笔记（中文）+ 完整 transcript 的中文译文）
 */
function buildEnAttachment({ date, results }) {
  const enResults = results.filter((r) => r.type !== 'xiaoyuzhou');
  if (!enResults.length) return null;

  const sections = [`# English Podcast Notes — ${date}\n`];

  for (const r of enResults) {
    const tag = r.ep.isReplay ? ' ♻️ Replay' : !r.ep.isNew && r.ep.epDate ? ` 📅 ${r.ep.epDate}` : '';
    const url = r.ep.url ? `\n[🔗 Listen](${r.ep.url})` : '';

    sections.push(`## ${r.podcast.name} · 《${r.ep.title}》${tag}\n`);
    sections.push(r.notes || '[笔记生成失败]');
    sections.push('');

    if (r.zhTranslation) {
      sections.push(
        `<details><summary>📄 中文译文（点击展开）</summary>\n\n${r.zhTranslation}\n\n</details>`
      );
    }

    sections.push(url);
    sections.push('\n---\n');
  }

  return sections.join('\n');
}

module.exports = { buildEmailBody, buildZhAttachment, buildEnAttachment };
