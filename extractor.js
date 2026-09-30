import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const exec = promisify(execFile);
const shortHosts = new Set(['xhslink.cn', 'b23.tv', 't.cn']);
const platformHosts = {
  xiaohongshu: ['xiaohongshu.com'],
  bilibili: ['bilibili.com'],
  weibo: ['weibo.com', 'weibo.cn'],
  '500px': ['500px.com'],
  instagram: ['instagram.com', 'instagr.am'],
};
const mediaHosts = {
  xiaohongshu: ['xhscdn.com'],
  bilibili: ['hdslb.com', 'biliimg.com'],
  weibo: ['sinaimg.cn', 'sinaimg.com', 'weibo.com'],
  '500px': ['500px.com', '500px.org', '500px.cloud', '500pxcdn.com', 'pximg.net'],
  instagram: ['fbcdn.net', 'cdninstagram.com', 'instagram.com'],
};

function matchesHost(host, domain) { return host === domain || host.endsWith(`.${domain}`); }
function platformOf(host) {
  for (const [name, domains] of Object.entries(platformHosts)) if (domains.some(x => matchesHost(host, x))) return name;
  return null;
}
function safeUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('只支持普通 HTTP(S) 作品链接。');
  return url;
}
export async function normalizeLink(input) {
  const match = String(input || '').match(/https?:\/\/[^\s<>"']+/i);
  if (!match) throw new Error('请粘贴包含 http:// 或 https:// 的作品链接。');
  let url = safeUrl(match[0].replace(/[，。！？；、）】~]+$/g, ''));
  if (shortHosts.has(url.hostname.toLowerCase())) {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const location = response.headers.get('location');
    if (!location) throw new Error('短链接没有返回作品地址，可能已经失效。');
    url = safeUrl(new URL(location, url).toString());
    if (url.hostname === 'www.xiaohongshu.com' && url.pathname === '/login' && url.searchParams.has('redirectPath')) {
      url = safeUrl(url.searchParams.get('redirectPath'));
    }
  }
  if (url.hostname === 'www.xiaohongshu.com' && url.pathname === '/login' && url.searchParams.has('redirectPath')) {
    url = safeUrl(url.searchParams.get('redirectPath'));
  }
  url.protocol = 'https:';
  const platform = platformOf(url.hostname.toLowerCase());
  if (!platform) throw new Error('目前只支持小红书、B 站、微博、500px 和 Instagram 的作品链接。');
  const path = url.pathname;
  const allowed = {
    xiaohongshu: /^\/(?:explore|discovery\/item)\/[\da-f]+/i,
    bilibili: /^\/(?:video\/|bangumi\/play\/|read\/)/i,
    weibo: /^\/(?:status\/|detail\/|\d+\/|\d+$)/i,
    '500px': /^\/photo\//i,
    instagram: /^\/(?:p|reel|tv)\//i,
  };
  if (!allowed[platform].test(path)) throw new Error('请使用单篇作品链接，暂不处理个人主页或作品合集。');
  return { url: url.toString(), platform };
}

async function run(command, args, timeout = 45000) {
  try {
    const { stdout, stderr } = await exec(command, args, { timeout, maxBuffer: 25 * 1024 * 1024, encoding: 'utf8' });
    return { ok: true, stdout, stderr };
  } catch (error) {
    return { ok: false, stdout: error.stdout || '', stderr: error.stderr || error.message };
  }
}
function dedupeImages(images) {
  const seen = new Set();
  return images.filter(image => {
    const key = new URL(image.url).pathname.split('/').at(-1).split('!')[0];
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function imageAsset(url, index, role = '图片', metadata = {}) {
  return { id: `image-${index}`, type: 'image', role, url: String(url).replace(/^http:/, 'https:'), width: metadata.width || null, height: metadata.height || null, extension: metadata.extension || null };
}
export async function inspectLink(input) {
  const source = await normalizeLink(input);
  const [videoResult, galleryResult] = await Promise.all([
    run('yt-dlp', ['--ignore-config', '-J', '--no-playlist', '--ignore-no-formats-error', '--socket-timeout', '12', '--retries', '1', source.url]),
    source.platform === 'xiaohongshu' ? Promise.resolve({ ok: false, stderr: '小红书图片由视频提取器读取。' }) : run('gallery-dl', ['--config-ignore', '-J', '--range', '1-30', source.url]),
  ]);
  let videoInfo = null, galleryInfo = [];
  if (videoResult.ok) { try { videoInfo = JSON.parse(videoResult.stdout); } catch { /* report below */ } }
  if (galleryResult.ok) { try { galleryInfo = JSON.parse(galleryResult.stdout); } catch { /* report below */ } }

  const assets = [];
  const hasVideo = Boolean(videoInfo?.formats?.length);
  if (hasVideo) assets.push({ id: 'video', type: 'video', role: '视频', duration: videoInfo.duration || null, preview: String(videoInfo.thumbnail || '').replace(/^http:/, 'https:') });
  if (source.platform === 'xiaohongshu' && videoInfo) {
    const images = dedupeImages((videoInfo.thumbnails || []).filter(x => x.url).map(x => ({ url: x.url, width: x.width, height: x.height })));
    const list = hasVideo ? images.slice(0, 1) : images;
    list.forEach((image, i) => assets.push(imageAsset(image.url, i + 1, hasVideo ? '封面' : '图片', image)));
  } else {
    const images = galleryInfo.filter(x => Array.isArray(x) && x[0] === 3 && typeof x[1] === 'string')
      .map(x => ({ url: x[1], metadata: x[2] || {} }))
      .filter(x => !/^(mp4|mov|webm|m3u8)$/i.test(x.metadata.extension || x.url.split('?')[0].split('.').pop()));
    dedupeImages(images).forEach((image, i) => assets.push(imageAsset(image.url, i + 1, '图片', image.metadata)));
    if (!images.length && hasVideo && videoInfo.thumbnail) assets.push(imageAsset(videoInfo.thumbnail, 1, '封面'));
  }
  const warnings = [];
  if (!assets.length) {
    if (!videoInfo && videoResult.stderr) warnings.push(`视频提取：${videoResult.stderr.trim().slice(-350)}`);
    const galleryError = galleryInfo.find(x => Array.isArray(x) && x[0] === -1)?.[1]?.message;
    if (galleryError || galleryResult.stderr) warnings.push(`图片提取：${String(galleryError || galleryResult.stderr).trim().slice(-350)}`);
  }
  if (!assets.length) throw new Error(`没有取得可用的图片或视频。${warnings.length ? ` ${warnings.join(' ')}` : '作品可能需要登录、已失效或受平台限制。'}`);
  return {
    source: source.url,
    platform: source.platform,
    title: videoInfo?.title || galleryInfo.find(x => Array.isArray(x) && x[0] === 2)?.[1]?.title || '未命名作品',
    author: videoInfo?.uploader || null,
    assets,
    warnings,
  };
}

function safeMediaUrl(value, platform) {
  const url = safeUrl(value);
  if (url.protocol !== 'https:' || !mediaHosts[platform].some(x => matchesHost(url.hostname.toLowerCase(), x))) {
    throw new Error(`媒体地址不在 ${platform} 的预期图片域名中，已停止下载。`);
  }
  return url;
}
export async function previewAsset(inspection, assetId) {
  const asset = inspection.assets.find(x => x.id === assetId);
  if (!asset) throw new Error('未找到图片预览。');
  const url = safeMediaUrl(asset.url || asset.preview, inspection.platform);
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!response.ok || !(response.headers.get('content-type') || '').startsWith('image/')) throw new Error('图片预览暂不可用。');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error('预览图片过大。');
    chunks.push(chunk);
  }
  return { bytes: Buffer.concat(chunks), type: response.headers.get('content-type') };
}
async function saveImage(asset, platform, folder, index) {
  const url = safeMediaUrl(asset.url, platform);
  const response = await fetch(url, { signal: AbortSignal.timeout(45000), headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`第 ${index} 张图片下载失败：HTTP ${response.status}`);
  const type = response.headers.get('content-type') || '';
  if (!type.startsWith('image/')) throw new Error(`第 ${index} 个资源不是图片。`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 40 * 1024 * 1024) throw new Error(`第 ${index} 张图片超过 40 MB 限制。`);
    chunks.push(chunk);
  }
  const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
  const filename = `${String(index).padStart(2, '0')}.${ext}`;
  await writeFile(join(folder, filename), Buffer.concat(chunks));
  return filename;
}
export async function downloadInspection(inspection, root, onProgress = () => {}) {
  const slug = `${inspection.platform}-${Date.now().toString(36)}`;
  const folder = join(root, slug);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'source.json'), JSON.stringify({ source: inspection.source, platform: inspection.platform, title: inspection.title, author: inspection.author }, null, 2));
  const files = ['source.json'], errors = [];
  for (const [i, asset] of inspection.assets.entries()) {
    onProgress(`正在保存 ${i + 1}/${inspection.assets.length}：${asset.role}`);
    try {
      if (asset.type === 'image') {
        files.push(await saveImage(asset, inspection.platform, folder, i + 1));
      } else {
        const result = await run('yt-dlp', ['--ignore-config', '--no-playlist', '--no-progress', '--max-filesize', '2G', '-f', 'bv*+ba/b', '--merge-output-format', 'mp4', '-o', join(folder, 'video.%(ext)s'), inspection.source], 30 * 60 * 1000);
        if (!result.ok) throw new Error(`视频下载失败：${result.stderr.trim().slice(-450)}`);
        const names = await readdir(folder);
        files.push(...names.filter(x => /^video\./.test(x) && !files.includes(x)));
      }
    } catch (error) { errors.push(error.message); }
  }
  if (files.length === 1) throw new Error(errors.join('；') || '未能保存任何媒体。');
  return { folder, slug, files, errors };
}
