/**
 * fetch-rss.js
 * 拉取小宇宙（via RSSHub）和 RSS 播客的最新集数
 * 对比 state.json，选出"最新未推送"的一集
 */

const axiosPkg = require('axios');
const axios = axiosPkg.default || axiosPkg;
const xml2js = require('xml2js');

const parser = new xml2js.Parser({ explicitArray: false });

/**
 * 拉取 RSS feed，返回最近 N 集的 episode 列表
 */
async function fetchFeed(rssUrl, maxItems = 10) {
  const response = await axios.get(rssUrl, {
    headers: { 'User-Agent': 'PodcastDigest/1.0' },
    timeout: 30000,
  });

  const result = await parser.parseStringPromise(response.data);
  const channel = result.rss?.channel || result.feed;
  if (!channel) throw new Error(`Invalid RSS: ${rssUrl}`);

  const rawItems = channel.item || channel.entry || [];
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];

  return items.slice(0, maxItems).map((item) => {
    // 提取音频 URL（enclosure）
    let audioUrl = null;
    if (item.enclosure) {
      const enc = Array.isArray(item.enclosure) ? item.enclosure[0] : item.enclosure;
      audioUrl = enc?.$ ? enc.$.url : enc?.url || null;
      // 去掉查询参数（避免 DashScope 拒绝带参数的 URL）
      if (audioUrl) audioUrl = audioUrl.split('?')[0];
    }

    // 提取 GUID（用于去重）
    let guid = null;
    if (item.guid) {
      guid = typeof item.guid === 'string' ? item.guid : item.guid?._ || item.guid;
    }
    if (!guid) guid = audioUrl || item.title || Math.random().toString();

    // 发布日期
    const pubDate = item.pubDate || item.published || item.updated || '';
    const pubDateMs = pubDate ? new Date(pubDate).getTime() : 0;

    return {
      guid: String(guid).trim(),
      title: (item.title?._ || item.title || 'Untitled').trim(),
      audioUrl,
      pubDate: pubDate,
      pubDateMs,
      description: item.description?._ || item.description || item.summary || '',
    };
  });
}

/**
 * 为一个小宇宙播客获取 RSS URL 并拉取集数
 */
async function fetchXiaoyuzhouEpisodes(podcast, rsshubBase, maxItems = 10) {
  const rssUrl = `${rsshubBase}/xiaoyuzhou/podcast/${podcast.id}`;
  try {
    const episodes = await fetchFeed(rssUrl, maxItems);
    return { podcast, episodes, rssUrl };
  } catch (err) {
    console.error(`[RSS] 小宇宙 ${podcast.name} 拉取失败: ${err.message}`);
    return { podcast, episodes: [], rssUrl, error: err.message };
  }
}

/**
 * 为一个 RSS 播客拉取集数
 */
async function fetchRssEpisodes(podcast, maxItems = 10) {
  try {
    const episodes = await fetchFeed(podcast.rssUrl, maxItems);
    return { podcast, episodes, rssUrl: podcast.rssUrl };
  } catch (err) {
    console.error(`[RSS] ${podcast.name} 拉取失败: ${err.message}`);
    return { podcast, episodes: [], rssUrl: podcast.rssUrl, error: err.message };
  }
}

/**
 * 从 episodes 列表中找出"最新的、未推送过的"一集
 * processedGuids: Set<string>
 * 返回 episode 对象（带 isNew 字段），如果全都处理过则返回最新的并标记为重播
 */
function pickUnprocessedEpisode(episodes, processedGuids) {
  if (!episodes || episodes.length === 0) return null;

  // 按发布时间降序排序
  const sorted = [...episodes].sort((a, b) => b.pubDateMs - a.pubDateMs);

  // 找最新未推送集
  for (const ep of sorted) {
    if (!processedGuids.has(ep.guid)) {
      const today = new Date().toISOString().split('T')[0];
      const epDate = ep.pubDate ? new Date(ep.pubDate).toISOString().split('T')[0] : null;
      return { ...ep, isNew: epDate === today, epDate };
    }
  }

  // 所有集都推送过了 → 返回最新的一集（标记为重播）
  const latest = sorted[0];
  return { ...latest, isNew: false, epDate: latest.pubDate ? new Date(latest.pubDate).toISOString().split('T')[0] : null, isReplay: true };
}

module.exports = { fetchXiaoyuzhouEpisodes, fetchRssEpisodes, pickUnprocessedEpisode };
