import { createServer } from 'node:http';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectLink, downloadInspection, previewAsset } from './extractor.js';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const model = process.env.OLLAMA_MODEL || 'qwen3-vl:8b';
const ollama = 'http://127.0.0.1:11434';
const downloadRoot = join(root, 'downloads');
const inspections = new Map();
const tasks = new Map();
const prompt = `你是一位摄影与电影摄影导师。分析所给图片或按时间顺序排列的视频抽帧，使用中文，务必基于可见证据。
输出严格 JSON 对象，字段为 summary、composition、color、lighting、video、practice。每个字段为简短字符串；video 对单张图片写“单张图片，无时间变化”。
composition 指出主体位置、视线引导、层次、留白和画幅；color 指出主色、冷暖关系、饱和度、对比度，并区分观察与推测；lighting 指出光向、软硬和明暗；video 只分析抽帧可见的镜头与色彩变化，运动或节奏无法从抽帧确定时明确说明；practice 给出可操作的复现步骤。不要猜测相机型号、焦段、LUT 名称或精确调色参数。`;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 18 * 1024 * 1024) {
        reject(new Error('图片数据过大，请减少视频抽帧数量或尺寸。'));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

async function modelStatus() {
  try {
    const response = await fetch(`${ollama}/api/tags`, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) throw new Error('本地模型服务未就绪。');
    const data = await response.json();
    const installed = (data.models || []).some(x => x.name === model || x.model === model);
    return { aiReady: installed, model, serviceReady: true, message: installed ? `本地模型已就绪 · ${model}` : `本地服务已运行，但未安装 ${model}` };
  } catch {
    return { aiReady: false, model, serviceReady: false, message: '未检测到本地视觉模型服务' };
  }
}

const imageTypes = { '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.webp':'image/webp', '.avif':'image/avif' };
async function downloadedImages() {
  const images = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes:true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.(jpe?g|png|webp|avif)$/i.test(entry.name)) {
        const id = relative(downloadRoot, path);
        images.push({ id, name:entry.name, folder:dirname(id), url:`/api/downloaded-image?path=${encodeURIComponent(id)}` });
      }
    }
  }
  try { await visit(downloadRoot); } catch (error) { if(error.code !== 'ENOENT') throw error; }
  return images.sort((a,b)=>a.id.localeCompare(b.id));
}
const server = createServer(async (req, res) => {
  const requestUrl = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && ['/color-analysis.js', '/composition.js', '/auto-lines.js'].includes(requestUrl.pathname)) {
    send(res, 200, await readFile(join(root, requestUrl.pathname.slice(1)), 'utf8'), 'text/javascript; charset=utf-8'); return;
  }
  if (req.method === 'GET' && /^\/composition-references\/(manifest\.json|(?:0[1-9]|1[0-4])\.jpg)$/.test(requestUrl.pathname)) {
    try { const bytes=await readFile(join(root, requestUrl.pathname.slice(1))); send(res,200,bytes,requestUrl.pathname.endsWith('.json')?'application/json; charset=utf-8':'image/jpeg'); }
    catch { send(res,404,{error:'构图范本不存在。'}); }
    return;
  }
  if (req.method === 'GET' && requestUrl.pathname === '/api/downloaded-images') {
    try { send(res, 200, { images:await downloadedImages() }); }
    catch { send(res, 500, { error:'无法读取下载目录。' }); }
    return;
  }
  if (req.method === 'GET' && requestUrl.pathname === '/api/downloaded-image') {
    try {
      const id = requestUrl.searchParams.get('path');
      if (!id || isAbsolute(id)) throw new Error('无效路径');
      const path = await realpath(join(downloadRoot, id));
      const base = await realpath(downloadRoot);
      const rel = relative(base, path);
      if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('无效路径');
      const ext = path.match(/\.[^.]+$/)?.[0].toLowerCase();
      if (!imageTypes[ext]) throw new Error('不支持的图片');
      const bytes = await readFile(path);
      res.writeHead(200, { 'Content-Type':imageTypes[ext], 'Cache-Control':'no-store' }); res.end(bytes);
    } catch { send(res, 404, { error:'图片不存在或不在下载目录中。' }); }
    return;
  }
  if (req.method === 'GET' && req.url === '/') {
    try {
      send(res, 200, await readFile(join(root, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    } catch {
      send(res, 500, { error: '无法读取页面。' });
    }
    return;
  }
  if (req.method === 'GET' && req.url === '/analyze') {
    try { send(res, 200, await readFile(join(root, 'analyze.html'), 'utf8'), 'text/html; charset=utf-8'); }
    catch { send(res, 500, { error: '无法读取分析页面。' }); }
    return;
  }
  if (req.method === 'POST' && req.url === '/api/extract') {
    try {
      const { url } = JSON.parse(await readBody(req));
      if (typeof url !== 'string' || url.length > 4000) throw new Error('链接无效或过长。');
      const info = await inspectLink(url);
      const id = randomUUID();
      inspections.set(id, info);
      send(res, 200, { id, ...info });
    } catch (error) { send(res, 400, { error: error.message || '解析失败。' }); }
    return;
  }
  const previewMatch = req.url?.match(/^\/api\/preview\/([0-9a-f-]{36})\/(image-\d+|video)$/);
  if (req.method === 'GET' && previewMatch) {
    const inspection = inspections.get(previewMatch[1]);
    if (!inspection) { send(res, 404, { error: '解析结果已失效。' }); return; }
    try {
      const { bytes, type } = await previewAsset(inspection, previewMatch[2]);
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(bytes);
    } catch (error) { send(res, 404, { error: error.message }); }
    return;
  }
  if (req.method === 'POST' && req.url === '/api/save') {
    try {
      const { id } = JSON.parse(await readBody(req));
      const info = inspections.get(id);
      if (!info) { send(res, 404, { error: '解析结果已失效，请重新解析链接。' }); return; }
      const taskId = randomUUID();
      const task = { status: 'running', message: '准备保存…', files: [], errors: [] };
      tasks.set(taskId, task);
      downloadInspection(info, downloadRoot, message => { task.message = message; })
        .then(result => { task.status = 'done'; task.message = '保存完成'; task.folder = result.folder; task.files = result.files; task.errors = result.errors; })
        .catch(error => { task.status = 'error'; task.message = error.message || '保存失败。'; });
      send(res, 202, { taskId });
    } catch (error) { send(res, 400, { error: error.message || '无法开始保存。' }); }
    return;
  }
  const taskMatch = req.url?.match(/^\/api\/tasks\/([0-9a-f-]{36})$/);
  if (req.method === 'GET' && taskMatch) {
    const task = tasks.get(taskMatch[1]);
    if (!task) { send(res, 404, { error: '任务不存在。' }); return; }
    send(res, 200, { status: task.status, message: task.message, files: task.files, errors: task.errors, folder: task.folder || null });
    return;
  }
  const fileMatch = req.url?.match(/^\/api\/files\/([0-9a-f-]{36})\/([^/?]+)$/);
  if (req.method === 'GET' && fileMatch) {
    const task = tasks.get(fileMatch[1]);
    let filename;
    try { filename = decodeURIComponent(fileMatch[2]); }
    catch { send(res, 400, { error: '文件名无效。' }); return; }
    if (!task || task.status !== 'done' || !task.files.includes(filename)) { send(res, 404, { error: '文件不存在。' }); return; }
    try {
      const data = await readFile(join(task.folder, filename));
      const ext = filename.split('.').pop().toLowerCase();
      const types = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', json: 'application/json' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${filename.replace(/["\\]/g, '')}"`, 'Cache-Control': 'no-store' });
      res.end(data);
    } catch { send(res, 404, { error: '文件读取失败。' }); }
    return;
  }
  if (req.method === 'GET' && req.url === '/api/status') {
    send(res, 200, await modelStatus());
    return;
  }
  if (req.method === 'POST' && req.url === '/api/analyze') {
    const status = await modelStatus();
    if (!status.aiReady) {
      send(res, 503, { error: `${status.message}。可先使用页面上的基础本地分析；安装后运行 ollama pull ${model}。` });
      return;
    }
    try {
      const { images, kind } = JSON.parse(await readBody(req));
      if (!Array.isArray(images) || images.length < 1 || images.length > 9 || images.some(x => typeof x !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(x))) {
        send(res, 400, { error: '请提供 1–9 张 JPEG 图片。' });
        return;
      }
      const upstream = await fetch(`${ollama}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(600000),
        body: JSON.stringify({
          model,
          stream: false,
          format: 'json',
          messages: [{
            role: 'user',
            content: `${prompt}\n素材类型：${kind === 'video' ? '按时间顺序排列的视频抽帧' : '单张图片'}。共有 ${images.length} 张画面。`,
            images: images.map(x => x.split(',')[1])
          }]
        })
      });
      const data = await upstream.json();
      if (!upstream.ok) {
        send(res, 502, { error: data.error || '本地视觉模型暂时不可用。' });
        return;
      }
      const answer = data.message?.content || '';
      let result;
      try { result = JSON.parse(answer.replace(/^```(?:json)?\s*|\s*```$/g, '')); }
      catch { result = { summary: answer }; }
      send(res, 200, { result });
    } catch (error) {
      send(res, 502, { error: error.name === 'TimeoutError' ? '本地模型分析超时。' : (error.message || '分析失败。') });
    }
    return;
  }
  send(res, 404, { error: '未找到页面。' });
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 已被占用。若 Frame Study 已在运行，直接打开 http://127.0.0.1:${port}；否则可运行 PORT=4174 npm start。`);
    process.exitCode = 1;
    return;
  }
  console.error(error);
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Frame Study: http://127.0.0.1:${port}`);
});
