/**
 * fetch-youtube.js
 * 用 yt-dlp 提取 YouTube 频道/播放列表最新视频的字幕
 * 不下载音频，直接拿自动字幕，秒级完成
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const YT_DLP = process.env.YT_DLP_PATH || 'yt-dlp';

/**
 * 获取频道最新视频列表（yt-dlp --flat-playlist）
 * @param {string} source - @channel 或 playlistId
 * @param {number} maxItems
 * @returns {Array<{id, title, url, uploadDate}>}
 */
function getChannelVideos(source, maxItems = 5) {
  let ytUrl;
  if (source.startsWith('@')) {
    ytUrl = `https://www.youtube.com/${source}/videos`;
  } else {
    ytUrl = `https://www.youtube.com/playlist?list=${source}`;
  }

  try {
    const result = spawnSync(YT_DLP, [
      '--flat-playlist',
      '--playlist-end', String(maxItems),
      '--print', '%(id)s\t%(title)s\t%(upload_date)s',
      '--no-warnings',
      '--quiet',
      ytUrl,
    ], { encoding: 'utf8', timeout: 60000 });

    if (result.error) throw result.error;

    const lines = (result.stdout || '').trim().split('\n').filter(Boolean);
    return lines.map((line) => {
      const parts = line.split('\t');
      const id = parts[0] || '';
      const title = parts[1] || 'Untitled';
      const uploadDate = parts[2] || '';
      return {
        id,
        title,
        url: `https://www.youtube.com/watch?v=${id}`,
        uploadDate, // YYYYMMDD format
        guid: id,
      };
    });
  } catch (err) {
    console.error(`[YouTube] 获取频道视频失败 (${source}): ${err.message}`);
    return [];
  }
}

/**
 * 下载单个视频的字幕（自动字幕优先，人工字幕次之）
 * @param {string} videoId
 * @param {string} lang - 'en' or 'zh'
 * @returns {string|null} 字幕文本
 */
function downloadSubtitles(videoId, lang = 'en') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-yt-'));
  const outTemplate = path.join(tmpDir, 'sub');
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    // 优先自动字幕，不下载音频
    const result = spawnSync(YT_DLP, [
      '--write-auto-sub',
      '--write-sub',
      '--sub-lang', lang,
      '--sub-format', 'vtt/srt/best',
      '--skip-download',
      '--no-warnings',
      '-o', outTemplate,
      videoUrl,
    ], { encoding: 'utf8', timeout: 60000 });

    if (result.error) throw result.error;

    // 找下载的字幕文件
    const files = fs.readdirSync(tmpDir);
    const subFile = files.find((f) => f.endsWith('.vtt') || f.endsWith('.srt'));
    if (!subFile) return null;

    const raw = fs.readFileSync(path.join(tmpDir, subFile), 'utf8');
    return parseSubtitle(raw);
  } catch (err) {
    console.error(`[YouTube] 字幕下载失败 (${videoId}): ${err.message}`);
    return null;
  } finally {
    // 清理临时目录
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

/**
 * 解析 VTT/SRT 字幕，去掉时间戳，返回纯文本
 */
function parseSubtitle(raw) {
  // 去掉 WEBVTT header
  let text = raw.replace(/^WEBVTT.*\n/m, '');
  // 去掉时间戳行 (00:00:00.000 --> 00:00:05.000)
  text = text.replace(/\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}.*/g, '');
  // 去掉 SRT 序号行
  text = text.replace(/^\d+\s*$/gm, '');
  // 去掉 VTT cue 标识符
  text = text.replace(/^[a-f0-9-]{36}\s*$/gm, '');
  // 去掉 HTML 标签
  text = text.replace(/<[^>]+>/g, '');
  // 合并空行，去重相邻重复行
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const deduped = [];
  for (const line of lines) {
    if (deduped[deduped.length - 1] !== line) deduped.push(line);
  }
  return deduped.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * 获取 YouTube 播客的一集（最新未推送）
 * @param {Object} podcast - { name, channel or playlistId, lang }
 * @param {Set} processedGuids
 * @returns {Object|null} episode with subtitle
 */
function pickYouTubeEpisode(podcast, processedGuids) {
  const source = podcast.channel || podcast.playlistId;
  const videos = getChannelVideos(source, 10);

  if (!videos.length) return null;

  // 找最新未推送视频
  let picked = null;
  for (const v of videos) {
    if (!processedGuids.has(v.guid)) {
      picked = v;
      break;
    }
  }
  if (!picked) picked = { ...videos[0], isReplay: true };

  // 下载字幕
  console.log(`[YouTube] 正在获取字幕: ${picked.title}`);
  const subtitle = downloadSubtitles(picked.id, podcast.lang || 'en');

  const today = new Date().toISOString().replace(/-/g, '').split('T')[0];
  return {
    guid: picked.guid,
    title: picked.title,
    audioUrl: null,
    transcript: subtitle,
    pubDate: picked.uploadDate
      ? `${picked.uploadDate.slice(0, 4)}-${picked.uploadDate.slice(4, 6)}-${picked.uploadDate.slice(6, 8)}`
      : null,
    isNew: picked.uploadDate === today,
    epDate: picked.uploadDate
      ? `${picked.uploadDate.slice(0, 4)}-${picked.uploadDate.slice(4, 6)}-${picked.uploadDate.slice(6, 8)}`
      : null,
    url: picked.url,
    isReplay: picked.isReplay || false,
  };
}

module.exports = { getChannelVideos, downloadSubtitles, pickYouTubeEpisode };
