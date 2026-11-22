'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
let archiver;
try {
  archiver = require('archiver');
} catch (err) {
  console.error('[Win-AirLink] Missing dependency "archiver". Open a terminal in the project folder and run: npm install');
  process.exit(1);
}
const { pipeline, Transform } = require('stream');
const { exec, spawn } = require('child_process');
const { URL } = require('url');
const QRCode = require('./qr');
const QRErrorCorrectLevel = require('./qr/QRErrorCorrectLevel');

let parseAudioFile = null;
let sharpImage = null;
try { ({ parseFile: parseAudioFile } = require('music-metadata')); }
catch (err) { console.warn('[Win-AirLink] Audio-cover metadata support is unavailable. Run npm install.'); }
try { sharpImage = require('sharp'); }
catch (err) { console.warn('[Win-AirLink] Audio-cover image processing is unavailable. Run npm install.'); }

const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const FILES_FILE    = path.join(DATA_DIR, 'files.json');
const INDEX_FILE = path.join(ROOT, 'index.html');
let INDEX_HTML = null;
try { INDEX_HTML = fs.readFileSync(INDEX_FILE); } catch (e) {}

const messages = [];
let seq = 0;
const files = new Map(); 
const clients = new Map();
const zipDownloadTokens = new Map();
const eventStreams = new Set();

function cleanupEventStream(stream) {
  if (!stream) return;
  clearInterval(stream.heartbeat);
  eventStreams.delete(stream);
}

function broadcastSse(eventName, payload) {
  const message = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const stream of eventStreams) {
    const res = stream.res;
    if (res.destroyed || res.writableEnded) {
      clearInterval(stream.heartbeat);
      eventStreams.delete(stream);
      continue;
    }
    try { res.write(message); }
    catch (err) {
      clearInterval(stream.heartbeat);
      eventStreams.delete(stream);
    }
  }
}

async function getDiskSpace() {
  try {
    let stats = null;
    if (fs.promises && typeof fs.promises.statfs === 'function') stats = await fs.promises.statfs(ROOT);
    else if (typeof fs.statfsSync === 'function') stats = fs.statfsSync(ROOT);
    if (stats) {
      const totalBytes = stats.blocks * stats.bsize;
      const freeBytes = stats.bfree * stats.bsize;
      const usedBytes = totalBytes - freeBytes;
      return {
        total: (totalBytes / 1073741824).toFixed(1),
        used: (usedBytes / 1073741824).toFixed(1),
        freeGB: (freeBytes / 1073741824).toFixed(1),
        freeMB: (freeBytes / 1048576).toFixed(0),
        percent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0
      };
    }
  } catch (e) {}

  // Older Node builds on Windows may lack statfs. Keep this fallback asynchronous.
  if (process.platform === 'win32') {
    try {
      const drive = path.parse(ROOT).root.replace('\\', '').replace(':', '');
      const command = `Get-PSDrive ${drive} | Select-Object -Property Used,Free | ConvertTo-Json`;
      const stdout = await new Promise((resolve, reject) => {
        exec(`powershell -NoProfile -NonInteractive -Command "${command}"`, {
          encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024
        }, (error, output) => error ? reject(error) : resolve(output));
      });
      const data = JSON.parse(stdout);
      if (Number.isFinite(data.Used) && Number.isFinite(data.Free)) {
        const totalBytes = data.Used + data.Free;
        const freeBytes = data.Free;
        return {
          total: (totalBytes / 1073741824).toFixed(1),
          used: (data.Used / 1073741824).toFixed(1),
          freeGB: (freeBytes / 1073741824).toFixed(1),
          freeMB: (freeBytes / 1048576).toFixed(0),
          percent: totalBytes > 0 ? Math.round((data.Used / totalBytes) * 100) : 0
        };
      }
    } catch (e) {}
  }
  return { error: 'unavailable' };
}

function cleanDisplayName(input){
  let name = String(input || 'file').replace(/[\\/]/g, '/').split('/').pop();
  name = name.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!name || name === '.' || name === '..') name = 'file';
  return Array.from(name).slice(0, 240).join('');
}
function safeDiskName(name){
  let out = String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim();
  if (!out) out = 'file';
  const dot = out.lastIndexOf('.');
  const base = dot > 0 ? out.slice(0, dot) : out;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) out = '_' + out;
  if (out.length > 240){
    const i = out.lastIndexOf('.');
    const ext = i > 0 && out.length - i <= 24 ? out.slice(i) : '';
    out = out.slice(0, 240 - ext.length) + ext;
  }
  return out;
}
function isLocalRequest(ip){
  if (ip === '127.0.0.1' || ip === '::1') return true;
  return getLocalIPs().includes(ip);
}
function removeStoredFile(filePath){
  try {
    if (path.dirname(filePath) === UPLOAD_DIR) fs.unlinkSync(filePath);
    else fs.rmSync(path.dirname(filePath), { recursive:true, force:true });
  } catch(e) { try { fs.unlinkSync(filePath); } catch(_){} }
}

const MIME_MAP = {
  jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif',
  webp:'image/webp', bmp:'image/bmp', svg:'image/svg+xml', ico:'image/x-icon',
  avif:'image/avif', tif:'image/tiff', tiff:'image/tiff', heic:'image/heic',
  heif:'image/heif', jfif:'image/jpeg',
  mp4:'video/mp4', webm:'video/webm', mkv:'video/x-matroska', mov:'video/quicktime',
  avi:'video/x-msvideo', m4v:'video/x-m4v', ogv:'video/ogg', wmv:'video/x-ms-wmv',
  flv:'video/x-flv', '3gp':'video/3gpp', mpg:'video/mpeg', mpeg:'video/mpeg',
  ts:'video/mp2t', mts:'video/mp2t',
  mp3:'audio/mpeg', wav:'audio/wav', ogg:'audio/ogg', oga:'audio/ogg', flac:'audio/flac',
  m4a:'audio/mp4', m4b:'audio/mp4', aac:'audio/aac', opus:'audio/opus',
  wma:'audio/x-ms-wma', aiff:'audio/aiff', aif:'audio/aiff', aifc:'audio/aiff',
  ape:'audio/ape', alac:'audio/alac', wv:'audio/wavpack', mpc:'audio/x-musepack',
  mka:'audio/x-matroska', dsf:'audio/dsf', dff:'audio/dff', tta:'audio/tta', tak:'audio/tak',
  mid:'audio/midi', midi:'audio/midi',
  pdf:'application/pdf', txt:'text/plain', md:'text/markdown',
  html:'text/html', css:'text/css', js:'application/javascript',
  json:'application/json', xml:'application/xml',
  zip:'application/zip', rar:'application/vnd.rar',
  '7z':'application/x-7z-compressed', tar:'application/x-tar',
  doc:'application/msword', docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls:'application/vnd.ms-excel', xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt:'application/vnd.ms-powerpoint', pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  exe:'application/x-msdownload', msi:'application/x-msi', blend:'application/x-blender'
};
function getMimeByName(name){
  const ext = (name.split('.').pop() || '').toLowerCase();
  return MIME_MAP[ext] || '';
}

function getJpegDimensions(buffer){
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  const sof = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
  let offset = 2;
  while (offset < buffer.length - 3){
    if (buffer[offset] !== 0xff) { offset++; continue; }
    while (buffer[offset] === 0xff) offset++;
    const marker = buffer[offset++];
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if (sof.has(marker) && length >= 7){
      return { height:buffer.readUInt16BE(offset + 3), width:buffer.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return null;
}

// Keep generated posters in a dedicated subdirectory. A fixed sibling name such
// as "preview.jpg" collides with a perfectly valid user upload of the same name.
function previewStoragePath(file){
  const posterDir = path.join(path.dirname(file.path), path.basename(file.path) + '.win-airlink-preview');
  return path.join(posterDir, 'preview.jpg');
}
function sameResolvedPath(a, b){
  const left = path.resolve(a), right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function resolveStoredPreviewPath(file){
  const currentPath = previewStoragePath(file);
  try { if (fs.statSync(currentPath).isFile()) return currentPath; } catch (e) {}

  // Backward compatibility with v1.1.1's former preview.jpg location.
  // Never mistake an original upload named preview.jpg for its own thumbnail.
  const legacyPath = path.join(path.dirname(file.path), 'preview.jpg');
  if (sameResolvedPath(legacyPath, file.path)) return null;
  try { if (fs.statSync(legacyPath).isFile()) return legacyPath; } catch (e) {}
  return null;
}

const AUDIO_EXTENSIONS = new Set([
  'mp3','flac','wav','ogg','oga','opus','m4a','m4b','aac','wma',
  'aiff','aif','aifc','ape','alac','wv','mpc','mka','dsf','dff','tta','tak','mid','midi'
]);
function isAudioFile(file){
  const mime = String(file && file.mime || '').toLowerCase();
  const ext = path.extname(String(file && file.name || '')).slice(1).toLowerCase();
  return mime.startsWith('audio/') || AUDIO_EXTENSIONS.has(ext);
}

// Artwork extraction runs off the upload request and one track at a time. This
// keeps large music batches from spiking CPU/RAM while all clients share the
// resulting JPEG through the existing /api/preview endpoint.
const audioCoverQueue = [];
const audioCoverQueuedIds = new Set();
let audioCoverWorkerRunning = false;
function enqueueAudioCover(file){
  if (!file || file.status !== 'ready' || !isAudioFile(file) || file.hasPreview || file.audioCoverChecked) return;
  if (!parseAudioFile || !sharpImage) return;
  if (audioCoverQueuedIds.has(file.id)) return;
  audioCoverQueuedIds.add(file.id);
  audioCoverQueue.push(file);
  void drainAudioCoverQueue();
}
async function extractAudioCover(file){
  const metadata = await parseAudioFile(file.path, { duration:false });
  const pictures = metadata && metadata.common && Array.isArray(metadata.common.picture)
    ? metadata.common.picture : [];
  if (!pictures.length) return false;

  // Prefer a front-cover picture, then use the first embedded image available.
  const picture = pictures.find(item => /front/i.test(String(item.type || ''))) || pictures[0];
  const raw = Buffer.isBuffer(picture.data) ? picture.data : Buffer.from(picture.data || []);
  if (!raw.length || raw.length > 16 * 1024 * 1024) return false;

  const result = await sharpImage(raw, { failOn:'none', limitInputPixels:40_000_000 })
    .rotate()
    .resize({ width:256, height:256, fit:'inside', withoutEnlargement:true })
    .jpeg({ quality:86, mozjpeg:true })
    .toBuffer({ resolveWithObject:true });
  if (!result || !result.data || !result.info || !result.info.width || !result.info.height) return false;
  if (result.info.width > 256 || result.info.height > 256 || result.data.length > 320 * 1024) return false;
  if (files.get(file.id) !== file || file.status !== 'ready') return false;

  const previewPath = previewStoragePath(file);
  const previewDir = path.dirname(previewPath);
  const tempPath = previewPath + '.' + process.pid + '.tmp';
  await fs.promises.mkdir(previewDir, { recursive:true });
  try {
    await fs.promises.writeFile(tempPath, result.data);
    // On Windows rename does not replace an existing target, so remove it first.
    await fs.promises.rm(previewPath, { force:true });
    await fs.promises.rename(tempPath, previewPath);
    file.hasPreview = true;
    return true;
  } finally {
    await fs.promises.rm(tempPath, { force:true }).catch(() => {});
  }
}
async function drainAudioCoverQueue(){
  if (audioCoverWorkerRunning) return;
  audioCoverWorkerRunning = true;
  try {
    while (audioCoverQueue.length){
      const file = audioCoverQueue.shift();
      if (!file) continue;
      try {
        if (files.get(file.id) === file && file.status === 'ready' && !file.hasPreview) {
          await extractAudioCover(file);
        }
        file.audioCoverChecked = true;
        saveState();
      } catch (err) {
        // Mark this file as checked to avoid repeating a corrupt/unsupported tag
        // parse on every poll or every server restart.
        file.audioCoverChecked = true;
        console.warn('[Win-AirLink] Could not extract embedded audio artwork for', file.name + ':', err.message || err);
        saveState();
      } finally {
        audioCoverQueuedIds.delete(file.id);
      }
    }
  } finally {
    audioCoverWorkerRunning = false;
    if (audioCoverQueue.length) void drainAudioCoverQueue();
  }
}

function getLocalIPs(){
  const ifaces = os.networkInterfaces();
  const out = [];
  for (const list of Object.values(ifaces)) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      if (i.address.startsWith('169.254.') || i.address.startsWith('127.')) continue;
      out.push(i.address);
    }
  }
  const score = ip => ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3;
  out.sort((a,b) => score(a)-score(b));
  return out;
}
function clientIp(req){
  let ip = req.socket.remoteAddress || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip;
}
function touchClient(id, name, ip){
  if (!id) return;
  const c = clients.get(id) || {};
  clients.set(id, { id, name:(name||c.name||'Аноним').slice(0,24), ip, lastSeen: Date.now() });
}
function activeClients(){
  const now = Date.now();
  return Array.from(clients.values())
    .filter(c => now - c.lastSeen < 60000)
    .sort((a,b) => b.lastSeen - a.lastSeen)
    .map(c => ({ id:c.id, name:c.name, ip:c.ip }));
}

function json(res, obj, code = 200){
  res.writeHead(code, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 1e6){
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit){ reject(new Error('too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const publicFile = f => ({
  id: f.id, name: f.name, size: f.size, mime: f.mime || '',
  time: f.time, status: f.status || 'ready', relativePath: f.relativePath || '',
  received: f.status === 'uploading' ? (f.received || 0) : f.size,
  hasPreview: Boolean(f.hasPreview)
});
function contentDisposition(name, attachment = true){
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '\\"');
  const star = encodeURIComponent(name).replace(/[!'()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
  return `${attachment ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${star}`;
}

// ZIP archive generation uses archiver and streams source files directly.
// No temporary staging directory and no full archive buffer are created.
function uniqueZipName(parts, used) {
  const safe = parts.map(safeDiskName).filter(Boolean);
  if (!safe.length) safe.push('file');
  const filename = safe.pop();
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  let candidate = [...safe, filename];
  let value = candidate.join('/');
  const keyOf = v => process.platform === 'win32' ? v.toLowerCase() : v;
  let n = 2;
  while (used.has(keyOf(value))) {
    candidate = [...safe, `${stem} (${n++})${ext}`];
    value = candidate.join('/');
  }
  used.add(keyOf(value));
  return { parts: candidate, name: value };
}

async function buildZipJobs(fileEntries) {
  const uploadRoot = path.resolve(UPLOAD_DIR);
  const rootPrefix = uploadRoot.endsWith(path.sep) ? uploadRoot : uploadRoot + path.sep;
  const rootKey = process.platform === 'win32' ? rootPrefix.toLowerCase() : rootPrefix;
  const used = new Set();
  const jobs = [];

  for (const item of fileEntries) {
    const f = item.file;
    const source = path.resolve(f.path);
    const sourceKey = process.platform === 'win32' ? source.toLowerCase() : source;
    if (!sourceKey.startsWith(rootKey)) continue;

    let stat;
    try { stat = await fs.promises.stat(source); }
    catch (err) { continue; }

    if (!stat.isFile()) continue;
    const picked = uniqueZipName(item.parts || [f.name || path.basename(source)], used);
    jobs.push({
      source,
      size: stat.size,
      name: picked.name,
      mtime: stat.mtime
    });
  }
  return jobs;
}

async function streamZipResponse(req, res, fileEntries, downloadName) {
  let jobs;
  try {
    jobs = await buildZipJobs(fileEntries);
  } catch (err) {
    console.error('Win-AirLink ZIP preparation failed:', err && err.stack || err);
    if (!res.headersSent && !res.destroyed) {
      return json(res, { ok:false, error:String(err.message || 'ZIP preparation failed').slice(0,500) }, 500);
    }
    if (!res.destroyed) res.destroy(err);
    return;
  }

  if (!jobs.length) {
    return json(res, { ok:false, error:'no accessible uploaded files to archive' }, 404);
  }

  const safeDownloadName = String(downloadName || 'Win-AirLink-files.zip')
    .replace(/[^a-zA-Z0-9._-]/g, '_');

  let archive;
  try {
    archive = archiver('zip', {
      store: true,
      forceZip64: true
    });
  } catch (err) {
    console.error('Win-AirLink archiver initialization failed:', err && err.stack || err);
    return json(res, { ok:false, error:'ZIP library could not be initialized. Run npm install archiver.' }, 500);
  }

  let clientDisconnected = false;
  let archiveFailed = false;
  const sourceStreams = new Set();

  const stopSources = () => {
    for (const source of sourceStreams) {
      if (!source.destroyed) source.destroy();
    }
    sourceStreams.clear();
  };

  const onClientClose = () => {
    // A normal completed response also emits "close". Only abort unfinished
    // downloads, and treat user cancellation as expected rather than a server error.
    if (res.writableFinished) return;
    clientDisconnected = true;
    archive.abort();
    stopSources();
  };

  const onArchiveError = err => {
    if (clientDisconnected || res.destroyed || archiveFailed) return;
    archiveFailed = true;
    console.error('Win-AirLink ZIP archive failed:', err && err.stack || err);

    if (!res.headersSent) {
      json(res, { ok:false, error:String(err.message || 'ZIP creation failed').slice(0,500) }, 500);
    } else {
      res.destroy(err);
    }
    stopSources();
  };

  archive.on('warning', err => {
    // Missing/inaccessible files must fail the archive, not silently create a
    // seemingly successful but incomplete ZIP.
    if (err && (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EPERM')) {
      onArchiveError(err);
    } else {
      console.warn('Win-AirLink ZIP warning:', err && err.message || err);
    }
  });
  archive.on('error', onArchiveError);

  res.once('close', onClientClose);
  res.once('finish', () => {
    res.removeListener('close', onClientClose);
    stopSources();
  });

  // Headers are set before archive.pipe(), as required for browser downloads.
  res.writeHead(200, {
    'Content-Type':'application/zip',
    'Content-Disposition':contentDisposition(safeDownloadName, true),
    'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff'
  });

  archive.pipe(res);

  for (const job of jobs) {
    if (clientDisconnected || archiveFailed || res.destroyed) break;

    const source = fs.createReadStream(job.source, { highWaterMark: 1024 * 1024 });
    sourceStreams.add(source);
    source.once('close', () => sourceStreams.delete(source));
    source.once('error', err => {
      if (!clientDisconnected && !archiveFailed) onArchiveError(err);
    });

    archive.append(source, {
      name: job.name,
      date: job.mtime || new Date(),
      mode: 0o644
    });
  }

  if (!clientDisconnected && !archiveFailed && !res.destroyed) {
    try {
      const finalized = archive.finalize();
      if (finalized && typeof finalized.catch === 'function') finalized.catch(onArchiveError);
    } catch (err) {
      onArchiveError(err);
    }
  }
}

function streamStoredFile(req, res, file, attachment){
  let stat;
  try { stat = fs.statSync(file.path); }
  catch(e){ res.writeHead(404); return res.end('file not found'); }
  if (!stat.isFile()){ res.writeHead(404); return res.end('not a file'); }
  const size = stat.size;
  const mime = file.mime || getMimeByName(file.name) || 'application/octet-stream';
  const headers = {
    'Content-Type': mime, 'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
  };
  if (attachment) headers['Content-Disposition'] = contentDisposition(file.name, true);
  const range = req.headers.range;
  if (range){
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match || size === 0){
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    let start, end;
    if (match[1] === ''){
      const suffixLength = Number(match[2]);
      if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0){
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
        return res.end();
      }
      start = Math.max(0, size - suffixLength);
      end = size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] === '' ? size - 1 : Number(match[2]);
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start){
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    end = Math.min(end, size - 1);
    res.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}` });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file.path, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(file.path).pipe(res);
}

function loadState(){
  try {
    const raw = fs.readFileSync(MESSAGES_FILE, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)){
      messages.push(...arr);
      seq = arr.reduce((m, msg) => Math.max(m, msg.seq || 0), 0);
    }
  } catch(e){}

  try {
    const raw = fs.readFileSync(FILES_FILE, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)){
      for (const f of arr){
        const fpath = path.isAbsolute(f.path) ? f.path : path.join(ROOT, f.path);
        if (fs.existsSync(fpath)){
          const loadedFile = { ...f, path: fpath, status: 'ready', received: f.size, audioCoverChecked:Boolean(f.audioCoverChecked) };
          loadedFile.hasPreview = Boolean(resolveStoredPreviewPath(loadedFile));
          files.set(f.id, loadedFile);
          if (isAudioFile(loadedFile) && !loadedFile.hasPreview && !loadedFile.audioCoverChecked) enqueueAudioCover(loadedFile);
        }
      }
    }
  } catch(e){}
}

let saveTimer = null;
function flushState(){
  if (saveTimer){ clearTimeout(saveTimer); saveTimer = null; }
  try {
    const tmp = MESSAGES_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(messages, null, 2));
    fs.renameSync(tmp, MESSAGES_FILE);
  } catch(e){}
  try {
    const ready = Array.from(files.values())
      .filter(f => f.status === 'ready')
      .map(f => ({ id: f.id, name: f.name, relativePath:f.relativePath||'', size: f.size, mime: f.mime, time: f.time, path: path.relative(ROOT, f.path), audioCoverChecked:Boolean(f.audioCoverChecked) }));
    const tmp = FILES_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(ready, null, 2));
    fs.renameSync(tmp, FILES_FILE);
  } catch(e){}
}
function saveState(){
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushState, 400);
}

const server = http.createServer(async (req, res) => {
  const ip = clientIp(req);
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }
  const p = u.pathname, q = u.searchParams;

  try {
    if (p === '/api/disk-space' && req.method === 'GET'){
      return json(res, await getDiskSpace());
    }

    if (p === '/api/events' && req.method === 'GET'){
      const eventClientId = String(q.get('clientId') || '').slice(0,64);
      const eventClientName = String(q.get('name') || '').slice(0,24);
      touchClient(eventClientId, eventClientName, ip);
      res.writeHead(200, {
        'Content-Type':'text/event-stream; charset=utf-8',
        'Cache-Control':'no-cache, no-transform',
        'Connection':'keep-alive',
        'X-Accel-Buffering':'no'
      });
      res.write(': Win-AirLink live events connected\n\n');
      const stream = { id:eventClientId, res, heartbeat:null };
      stream.heartbeat = setInterval(() => {
        if (!res.destroyed && !res.writableEnded) {
          try { res.write(': ping\n\n'); } catch (err) { cleanupEventStream(stream); }
        } else cleanupEventStream(stream);
      }, 25000);
      if (typeof stream.heartbeat.unref === 'function') stream.heartbeat.unref();
      eventStreams.add(stream);
      res.once('close', () => cleanupEventStream(stream));
      return;
    }

    if (p === '/api/info'){
      touchClient(q.get('clientId') || '', q.get('name') || '', ip);
      const ips = getLocalIPs();
      return json(res, { host: ips[0] || 'localhost', port: PORT, urls: ips.map(a => `http://${a}:${PORT}`), clientIp: ip });
    }

    if (p === '/api/qr.svg' && req.method === 'GET'){
      const value = String(q.get('text') || '').slice(0, 1200);
      if (!value) return json(res, { ok:false, error:'missing text' }, 400);
      try {
        const qr = new QRCode(0, QRErrorCorrectLevel.M);
        qr.addData(value);
        qr.make();
        const count = qr.getModuleCount();
        const quiet = 4;
        const side = count + quiet * 2;
        let pathData = '';
        for (let y = 0; y < count; y++){
          for (let x = 0; x < count; x++){
            if (qr.isDark(y, x)) pathData += `M${x + quiet} ${y + quiet}h1v1h-1z`;
          }
        }
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" role="img" aria-label="QR-код подключения"><rect width="100%" height="100%" fill="#fff"/><path d="${pathData}" fill="#101318"/></svg>`;
        res.writeHead(200, { 'Content-Type':'image/svg+xml; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' });
        return res.end(svg);
      } catch(err){ return json(res, { ok:false, error:'qr generation failed' }, 500); }
    }

    if (p === '/api/clients'){
      touchClient(q.get('clientId') || '', q.get('name') || '', ip);
      return json(res, activeClients());
    }

    if (p === '/api/messages' && req.method === 'GET'){
      touchClient(q.get('clientId') || '', q.get('name') || '', ip);
      return json(res, messages);
    }
    if (p === '/api/messages' && req.method === 'DELETE'){
      const removedSeqs = messages.map(message => message.seq);
      const removed = messages.length;
      messages.length = 0;
      saveState();
      broadcastSse('messages-cleared', { seqs:removedSeqs, clientId:String(req.headers['x-client-id'] || q.get('clientId') || '').slice(0,64), removedAt:Date.now() });
      return json(res, { ok:true, removed });
    }
    const mMessage = p.match(/^\/api\/messages\/(\d+)$/);
    if (mMessage && req.method === 'DELETE'){
      const messageSeq = Number(mMessage[1]);
      const index = messages.findIndex(m => m.seq === messageSeq);
      if (index < 0) return json(res, { ok:false, error:'not found' }, 404);
      messages.splice(index, 1);
      saveState();
      broadcastSse('message-deleted', { seq:messageSeq, clientId:String(req.headers['x-client-id'] || q.get('clientId') || '').slice(0,64), removedAt:Date.now() });
      return json(res, { ok:true });
    }
    if (p === '/api/messages' && req.method === 'POST'){
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const text = String(body.text || '').slice(0, 4000).trim();
      if (!text) return json(res, { ok:false }, 400);
      const id = String(body.clientId || '').slice(0,64);
      const name = String(body.name || 'Аноним').slice(0,24);
      touchClient(id, name, ip);
      const msg = { seq: ++seq, clientId: id, name, text, time: Date.now() };
      messages.push(msg);
      if (messages.length > 2000) messages.splice(0, messages.length - 2000);
      saveState();
      return json(res, { ok:true });
    }

    if (p === '/api/files' && req.method === 'GET'){
      return json(res, Array.from(files.values()).map(publicFile));
    }

    if (p === '/api/files/all' && req.method === 'DELETE'){
      const removedIds = Array.from(files.keys());
      let removed = 0;
      for (const [, f] of files){
        try { if (fs.existsSync(f.path)) removeStoredFile(f.path); removed++; } catch(e){}
      }
      files.clear();
      saveState();
      broadcastSse('files-deleted', { ids:removedIds, clientId:String(req.headers['x-client-id'] || q.get('clientId') || '').slice(0,64), removedAt:Date.now() });
      return json(res, { ok:true, removed });
    }

    if (p === '/api/upload' && req.method === 'POST'){
      let rawName = 'file';
      const encodedName = req.headers['x-file-name-b64'];
      if (encodedName) {
        try {
          const decoded = Buffer.from(String(encodedName), 'base64').toString('utf8');
          if (decoded && !decoded.includes('\uFFFD')) rawName = decoded;
        } catch(e) {}
      } else {
        try { rawName = decodeURIComponent(req.headers['x-file-name'] || 'file'); }
        catch(e) { rawName = String(req.headers['x-file-name'] || 'file'); }
      }
      const originalName = cleanDisplayName(rawName);
      const diskName = safeDiskName(originalName);
      const clientMime = String(req.headers['x-file-type'] || '').slice(0,200).split(';')[0].trim().toLowerCase();
      const senderClientId = String(req.headers['x-client-id'] || '').slice(0,64);
      const extensionMime = getMimeByName(originalName);
      const declaredSize = Number(req.headers['content-length'] || 0);
      let id = String(req.headers['x-file-id'] || '').trim();
      if (!/^[a-zA-Z0-9_-]{8,64}$/.test(id) || files.has(id)) id = crypto.randomBytes(8).toString('hex');
      const fileDir = path.join(UPLOAD_DIR, id);
      fs.mkdirSync(fileDir, { recursive:true });
      const fpath = path.join(fileDir, diskName);
      const mime = extensionMime || (clientMime && clientMime !== 'application/octet-stream' ? clientMime : 'application/octet-stream');
      let rawRel=''; try { rawRel=Buffer.from(String(req.headers['x-relative-path']||''),'base64').toString('utf8'); } catch(e){} rawRel=rawRel.replace(/\\/g,'/').split('/').filter(Boolean).map(safeDiskName).join('/').slice(0,700);
      const entry = { id, name:originalName, relativePath:rawRel, diskName, size:declaredSize, mime, time:Date.now(), path:fpath, status:'uploading', received:0, hasPreview:false };
      files.set(id, entry);
      const ws = fs.createWriteStream(fpath);
      const counter = new Transform({
        transform(chunk, encoding, callback) {
          entry.received += chunk.length;
          callback(null, chunk);
        }
      });
      // pipeline preserves backpressure and also cleans up correctly when a client
      // disconnects or the destination disk reports an error.
      pipeline(req, counter, ws, err => {
        if (err) {
          files.delete(id);
          fs.promises.rm(fileDir, { recursive:true, force:true }).catch(() => {});
          if (!res.destroyed && !res.writableEnded) json(res, {ok:false,error:'upload failed'}, 500);
          return;
        }
        entry.status = 'ready';
        entry.size = entry.received;
        saveState();
        if (isAudioFile(entry)) enqueueAudioCover(entry);
        // Notify every connected browser only after the destination stream has
        // finished and the file is marked ready. The sender ID lets its own
        // browser ignore the event while all receiving clients animate at once.
        broadcastSse('file-received', { file:publicFile(entry), senderId:senderClientId, receivedAt:Date.now() });
        if (!res.destroyed && !res.writableEnded) json(res, { ok:true, file:publicFile(entry) });
      });
      return;
    }

    if (p === '/api/folder-download' && req.method === 'GET'){
      const folderName = String(u.searchParams.get('folder') || '').replace(/\\/g,'/').split('/').filter(Boolean).map(safeDiskName).join('/');
      if (!folderName) { res.writeHead(400); return res.end('folder required'); }
      const matches = Array.from(files.values()).filter(f => f.status === 'ready' && f.relativePath && f.relativePath.replace(/\\/g,'/').startsWith(folderName + '/'));
      if (!matches.length) { res.writeHead(404); return res.end('folder empty'); }
      const entries = matches.map(file => ({ file, parts:String(file.relativePath || '').replace(/\\/g,'/').split('/').filter(Boolean) }));
      const archiveName = (folderName.split('/').pop() || 'folder') + '.zip';
      return streamZipResponse(req, res, entries, archiveName);
    }

    if (p === '/api/files/zip-selected' && req.method === 'POST'){
      let payload;
      try { payload = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8') || '{}'); }
      catch (e) { return json(res, {ok:false,error:'invalid request body'}, 400); }

      const rawIds = payload && Array.isArray(payload.selectedIds) ? payload.selectedIds : [];
      if (!rawIds.length) return json(res, {ok:false,error:'no selected files'}, 400);
      if (rawIds.length > 50000 || rawIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(id))) {
        return json(res, {ok:false,error:'invalid selected file ids'}, 400);
      }

      const selected = new Set(rawIds);
      if (!selected.size) return json(res, {ok:false,error:'no selected files'}, 400);
      const matches = Array.from(files.values()).filter(f => f.status === 'ready' && selected.has(f.id));
      if (!matches.length) return json(res,{ok:false,error:'no selected files are ready to archive'},400);
      if (matches.length !== selected.size) return json(res,{ok:false,error:'some selected files are no longer available'},409);

      const entries = matches.map(file => ({
        file,
        parts:String(file.relativePath || '').replace(/\\/g,'/').split('/').filter(Boolean).length
          ? String(file.relativePath || '').replace(/\\/g,'/').split('/').filter(Boolean)
          : [file.name || path.basename(file.path)]
      }));

      // Keep the selection on the server briefly. The browser then starts a
      // normal attachment download instead of buffering the entire ZIP in Blob memory.
      const now = Date.now();
      for (const [token, item] of zipDownloadTokens) {
        if (item.expiresAt <= now) zipDownloadTokens.delete(token);
      }
      const token = crypto.randomBytes(24).toString('hex');
      zipDownloadTokens.set(token, {
        entries,
        filename:'Win-AirLink-selected.zip',
        expiresAt:now + 10 * 60 * 1000
      });
      return json(res, {
        ok:true,
        downloadUrl:'/api/files/zip-selected-download/' + token,
        fileCount:entries.length
      });
    }

    const mZipDownload = p.match(/^\/api\/files\/zip-selected-download\/([a-f0-9]{48})$/);
    if (mZipDownload && req.method === 'GET'){
      const item = zipDownloadTokens.get(mZipDownload[1]);
      if (!item || item.expiresAt <= Date.now()) {
        zipDownloadTokens.delete(mZipDownload[1]);
        return json(res, {ok:false,error:'ZIP download link expired. Select the files again.'}, 410);
      }
      return streamZipResponse(req, res, item.entries, item.filename);
    }

    const mFile = p.match(/^\/api\/file\/([a-z0-9_-]{8,64})$/i);
    if (mFile){
      const f = files.get(mFile[1]);
      if (!f) { res.writeHead(404); return res.end('not found'); }
      if (req.method === 'DELETE'){
        files.delete(f.id);
        removeStoredFile(f.path);
        saveState();
        broadcastSse('file-deleted', { id:f.id, clientId:String(req.headers['x-client-id'] || q.get('clientId') || '').slice(0,64), removedAt:Date.now() });
        return json(res, { ok:true });
      }
      if (req.method === 'GET' || req.method === 'HEAD'){
        if (f.status !== 'ready'){ res.writeHead(409); return res.end('still uploading'); }
        return streamStoredFile(req, res, f, true);
      }
    }

    const mPreview = p.match(/^\/api\/preview\/([a-z0-9_-]{8,64})$/i);
    if (mPreview && req.method === 'POST') {
      const f = files.get(mPreview[1]);
      if (!f || f.status !== 'ready') return json(res, {ok:false,error:'file not ready'}, 404);
      let total = 0;
      const chunks = [];
      let tooLarge = false;
      req.on('data', chunk => {
        total += chunk.length;
        if (total > 320 * 1024) { tooLarge = true; chunks.length = 0; }
        else if (!tooLarge) chunks.push(chunk);
      });
      req.on('end', async () => {
        if (tooLarge) return json(res, {ok:false,error:'thumbnail too large'}, 413);
        const data = Buffer.concat(chunks);
        const dimensions = getJpegDimensions(data);
        if (!dimensions || dimensions.width < 1 || dimensions.height < 1 || dimensions.width > 256 || dimensions.height > 256) {
          return json(res, {ok:false,error:'JPEG thumbnail must be at most 256x256'}, 415);
        }
        const previewPath = previewStoragePath(f);
        const previewDir = path.dirname(previewPath);
        const tempPath = previewPath + '.tmp';
        try {
          await fs.promises.mkdir(previewDir, { recursive:true });
          await fs.promises.writeFile(tempPath, data);
          await fs.promises.rename(tempPath, previewPath);
          f.hasPreview = true;
          return json(res, {ok:true, size:data.length});
        } catch (e) {
          try { await fs.promises.rm(tempPath, {force:true}); } catch (_) {}
          return json(res, {ok:false,error:'preview save failed'}, 500);
        }
      });
      req.on('error', () => { if (!res.destroyed && !res.writableEnded) json(res, {ok:false,error:'request failed'}, 400); });
      return;
    }
    if (mPreview && (req.method === 'GET' || req.method === 'HEAD')) {
      const f = files.get(mPreview[1]);
      if (!f || f.status !== 'ready') { res.writeHead(404, {'Cache-Control':'no-store'}); return res.end('preview not available'); }
      const previewPath = resolveStoredPreviewPath(f);
      let stat;
      try { if (previewPath) stat = fs.statSync(previewPath); } catch (e) {}
      if (!previewPath || !stat || !stat.isFile()) { res.writeHead(404, {'Cache-Control':'no-store'}); return res.end('preview not generated'); }
      res.writeHead(200, {
        'Content-Type':'image/jpeg', 'Content-Length':stat.size,
        'Cache-Control':'public, max-age=86400', 'X-Content-Type-Options':'nosniff'
      });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(previewPath).pipe(res);
    }

    const mReveal = p.match(/^\/api\/reveal\/([a-z0-9_-]{8,64})$/i);
    if (mReveal && req.method === 'POST'){
      const f = files.get(mReveal[1]);
      if (!f) return json(res, { ok:false, error:'not found' }, 404);
      if (f.status !== 'ready') return json(res, { ok:false, error:'still uploading' }, 409);
      if (process.platform !== 'win32') return json(res, { ok:false, error:'windows only' }, 400);
      if (!isLocalRequest(ip)) return json(res, { ok:false, error:'remote-client' }, 403);
      try {
        const child = spawn('explorer.exe', ['/select,' + path.resolve(f.path)], { detached:true, stdio:'ignore', windowsHide:true });
        child.once('error', err => console.error('Не удалось запустить Проводник:', err.message));
        child.unref();
        return json(res, { ok:true, selected:true });
      } catch(e){ return json(res, { ok:false, error:e.message }, 500); }
    }

    if (p === '/qr'){
      const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0f1115"><title>Подключение — Win-AirLink</title><style>
      *{box-sizing:border-box}body{--qr-dim:.42;--qr-blur:0px;margin:0;min-height:100vh;background:radial-gradient(ellipse at 50% 0,#1b2a44 0,#0f1115 55%);color:#e7eaf0;font:15px/1.5 system-ui,Segoe UI,Arial,sans-serif;display:grid;place-items:center;padding:24px;position:relative;isolation:isolate;overflow-x:hidden}body:before{content:"";position:fixed;inset:-3%;z-index:-2;background-image:var(--qr-wallpaper,none);background-position:center;background-size:cover;background-repeat:no-repeat;filter:blur(var(--qr-blur));transform:scale(1.04)}body:after{content:"";position:fixed;inset:0;z-index:-1;background:rgba(8,12,20,var(--qr-dim))}.card{width:min(94vw,470px);max-height:calc(100dvh - 32px);overflow-y:auto;background:rgba(23,26,33,.68);-webkit-backdrop-filter:blur(28px) saturate(165%);backdrop-filter:blur(28px) saturate(165%);border:1px solid rgba(190,210,255,.22);border-radius:26px;padding:26px;text-align:center;box-shadow:0 20px 70px #0008,inset 0 1px 0 rgba(255,255,255,.1);position:relative}.close{position:absolute;right:12px;top:12px;width:34px;height:34px;border:1px solid rgba(255,255,255,.18);border-radius:50%;background:rgba(48,52,60,.58);backdrop-filter:blur(12px);color:#b8bec8;font-size:20px;line-height:1;cursor:pointer}.close:hover{background:#454b56;color:#fff}.brand{color:#9ec1ff;font-weight:700;letter-spacing:.04em;margin:0 0 8px}.qr-wrap{background:#fff;border-radius:16px;padding:14px;width:min(76vw,310px);aspect-ratio:1;margin:20px auto 16px;display:grid;place-items:center}.qr-wrap img{width:100%;height:100%;object-fit:contain}.url{display:block;overflow-wrap:anywhere;color:#9ec1ff;background:rgba(11,14,19,.52);border:1px solid rgba(190,210,255,.2);border-radius:9px;padding:10px;margin:12px 0}.hint{color:#9aa3b2;font-size:13px}.status{min-height:24px;color:#7ee0b2;font-weight:600}.back{margin-top:12px;border:1px solid rgba(255,255,255,.18);background:rgba(48,52,60,.58);backdrop-filter:blur(12px);color:#d1d5dc;border-radius:9px;padding:9px 16px;cursor:pointer}.back:hover{background:#454b56;color:white}@media(max-width:520px){body{padding:12px}.card{width:100%;max-height:calc(100dvh - 24px);padding:22px 16px}.qr-wrap{width:min(72vw,290px)}}@media(prefers-reduced-transparency:reduce){.card{background:#171a21;backdrop-filter:none}}</style></head><body><main class="card"><button class="close" id="close" aria-label="Вернуться в чат" title="Закрыть и вернуться">×</button><div class="brand">Win-AirLink</div><h1 style="font-size:22px;margin:0">Подключение по QR-коду</h1><p class="hint">Открой камеру телефона и наведи её на код</p><div class="qr-wrap"><img id="qr" alt="QR-код подключения"></div><code class="url" id="url">Подготовка адреса…</code><div class="status" id="status">Ожидание подключения устройства…</div><p class="hint">Когда новое устройство подключится, страница автоматически вернётся в чат.</p><button class="back" id="back">← Вернуться в чат</button></main><script>
      (async()=>{const $=id=>document.getElementById(id);const en=localStorage.getItem('lm_lang')==='en';
      try{document.body.style.setProperty('--qr-dim',(Number(localStorage.getItem('lm_wallpaper_dim')??42)/100).toFixed(2));document.body.style.setProperty('--qr-blur',(Number(localStorage.getItem('lm_wallpaper_blur')??0))+'px');const db=await new Promise(resolve=>{const q=indexedDB.open('win-airlink-wallpaper',1);q.onsuccess=()=>resolve(q.result);q.onerror=()=>resolve(null);});if(db&&db.objectStoreNames.contains('wallpaper')){const blob=await new Promise(resolve=>{const q=db.transaction('wallpaper','readonly').objectStore('wallpaper').get('main');q.onsuccess=()=>resolve(q.result||null);q.onerror=()=>resolve(null);});if(blob){const u=URL.createObjectURL(blob);document.body.style.setProperty('--qr-wallpaper','url("'+u+'")');}}}catch(e){}
      if(en){document.documentElement.lang='en';document.title='Connect — Win-AirLink';document.querySelector('h1').textContent='Connect with QR code';document.querySelectorAll('.hint')[0].textContent='Open your phone camera and point it at the code';document.querySelectorAll('.hint')[1].textContent='When a new device connects, this page will automatically return to the chat.';document.querySelector('.status').textContent='Waiting for a device to connect…';document.querySelector('.close').title='Close and return';document.querySelector('.close').setAttribute('aria-label','Return to chat');document.querySelector('.back').textContent='← Back to chat';$('url').textContent='Preparing address…';}const clientId=localStorage.getItem('lm_cid')||'';const name=localStorage.getItem('lm_name')||(en?'Device':'Устройство');const qs='clientId='+encodeURIComponent(clientId)+'&name='+encodeURIComponent(name);let base=location.origin;let known=new Set();try{const info=await fetch('/api/info?'+qs,{cache:'no-store'}).then(r=>r.json());if((location.hostname==='localhost'||location.hostname==='127.0.0.1')&&info.urls&&info.urls.length)base=info.urls[0];const target=base+'/';$('url').textContent=target;$('qr').src='/api/qr.svg?text='+encodeURIComponent(target);const initial=await fetch('/api/clients?'+qs,{cache:'no-store'}).then(r=>r.json());known=new Set(initial.map(x=>x.id));}catch(e){$('status').textContent=en?'Could not get the server address':'Не удалось получить адрес сервера';return;}let returning=false;const goBack=()=>{if(returning)return;returning=true;$('status').textContent=en?'Device connected. Returning to chat…':'Устройство подключено. Возвращаемся в чат…';setTimeout(()=>{location.href='/';},1700);};$('close').onclick=()=>{try{window.close()}catch(e){}setTimeout(()=>{if(!document.hidden)location.href='/';},150);};$('back').onclick=()=>location.href='/';const check=async()=>{if(returning)return;try{const list=await fetch('/api/clients?'+qs,{cache:'no-store'}).then(r=>r.json());if(list.some(x=>!known.has(x.id)&&x.id!==clientId)){goBack();return;}}catch(e){}};setInterval(check,900);})();</script></body></html>`;
      res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store' });
      return res.end(html);
    }

    if (p === '/' || p === '/index.html'){
      if (!INDEX_HTML) { res.writeHead(500); return res.end('index.html not found'); }
      res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store' });
      return res.end(INDEX_HTML);
    }

    res.writeHead(404); res.end('Not found');
  } catch(e){
    console.error('Win-AirLink request failed:', e && e.stack || e);
    if (!res.headersSent && !res.destroyed) { res.writeHead(500); res.end('Error: ' + e.message); }
    else if (!res.destroyed) res.destroy(e);
  }
});

let PORT = Number(process.env.PORT) || 3000;
function tryListen(port){
  return new Promise((resolve, reject) => {
    const onErr = e => { server.removeListener('error', onErr); reject(e); };
    server.once('error', onErr);
    server.listen(port, '0.0.0.0', () => { server.removeListener('error', onErr); resolve(); });
  });
}
(async () => {
  loadState();
  let port = PORT;
  for (let p = PORT; p < PORT + 10; p++){
    try { await tryListen(p); port = p; break; }
    catch(e){ if (e.code !== 'EADDRINUSE') throw e; }
  }
  PORT = port;
  const ips = getLocalIPs();
  console.log('');
  console.log('============================================');
  console.log('  Win-AirLink v1.2.1 — сервер запущен');
  console.log('============================================');
  console.log('  На этом ПК:  http://localhost:' + PORT);
  if (ips.length){
    console.log('  Для телефона (та же Wi-Fi сеть):');
    ips.forEach(ip => console.log('    http://' + ip + ':' + PORT));
  }
  console.log('');
  console.log('  Данные сохраняются в папке data/');
  console.log('============================================');
  if (process.platform === 'win32') exec('start "" http://localhost:' + PORT);
})();

process.on('SIGINT', () => {
  flushState();
  console.log('\nСервер остановлен.');
  process.exit(0);
});
process.on('SIGTERM', () => {
  flushState();
  process.exit(0);
});