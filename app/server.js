'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec, spawn, execSync } = require('child_process');
const { URL } = require('url');
const QRCode = require('./qr');
const QRErrorCorrectLevel = require('./qr/QRErrorCorrectLevel');

const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const FILES_FILE    = path.join(DATA_DIR, 'files.json');

const messages = [];
let seq = 0;
const files = new Map(); 
const clients = new Map();

function getDiskSpace() {
  try {
    if (typeof fs.statfsSync === 'function') {
      const stats = fs.statfsSync(ROOT);
      const totalBytes = stats.blocks * stats.bsize;
      const freeBytes = stats.bfree * stats.bsize;
      const usedBytes = totalBytes - freeBytes;
      
      const freeGB = (freeBytes / 1073741824).toFixed(1);
      const freeMB = (freeBytes / 1048576).toFixed(0);
      
      return {
        total: (totalBytes / 1073741824).toFixed(1),
        used: (usedBytes / 1073741824).toFixed(1),
        freeGB,
        freeMB,
        percent: Math.round((usedBytes / totalBytes) * 100)
      };
    }
  } catch (e) {}

  try {
    if (process.platform === 'win32') {
      const drive = path.parse(ROOT).root.replace('\\', '');
      const cmd = `powershell -command "Get-PSDrive ${drive.replace(':', '')} | Select-Object -Property Used,Free | ConvertTo-Json"`;
      const stdout = execSync(cmd, { encoding: 'utf8', windowsHide: true });
      const data = JSON.parse(stdout);
      if (data.Used !== undefined && data.Free !== undefined) {
        const totalBytes = data.Used + data.Free;
        const usedBytes = data.Used;
        const freeBytes = data.Free;
        return {
          total: (totalBytes / 1073741824).toFixed(1),
          used: (usedBytes / 1073741824).toFixed(1),
          freeGB: (freeBytes / 1073741824).toFixed(1),
          freeMB: (freeBytes / 1048576).toFixed(0),
          percent: Math.round((usedBytes / totalBytes) * 100)
        };
      }
    }
  } catch(e) {}
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
  mp3:'audio/mpeg', wav:'audio/wav', ogg:'audio/ogg', flac:'audio/flac',
  m4a:'audio/mp4', aac:'audio/aac', opus:'audio/opus',
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
  received: f.status === 'uploading' ? (f.received || 0) : f.size
});
function contentDisposition(name, attachment = true){
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '\\"');
  const star = encodeURIComponent(name).replace(/[!'()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
  return `${attachment ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${star}`;
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
          files.set(f.id, { ...f, path: fpath, status: 'ready', received: f.size });
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
      .map(f => ({ id: f.id, name: f.name, relativePath:f.relativePath||'', size: f.size, mime: f.mime, time: f.time, path: path.relative(ROOT, f.path) }));
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
      return json(res, getDiskSpace());
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
      const removed = messages.length;
      messages.length = 0;
      saveState();
      return json(res, { ok:true, removed });
    }
    const mMessage = p.match(/^\/api\/messages\/(\d+)$/);
    if (mMessage && req.method === 'DELETE'){
      const messageSeq = Number(mMessage[1]);
      const index = messages.findIndex(m => m.seq === messageSeq);
      if (index < 0) return json(res, { ok:false, error:'not found' }, 404);
      messages.splice(index, 1);
      saveState();
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
      let removed = 0;
      for (const [, f] of files){
        try { if (fs.existsSync(f.path)) removeStoredFile(f.path); removed++; } catch(e){}
      }
      files.clear();
      saveState();
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
      const extensionMime = getMimeByName(originalName);
      const declaredSize = Number(req.headers['content-length'] || 0);
      let id = String(req.headers['x-file-id'] || '').trim();
      if (!/^[a-zA-Z0-9_-]{8,64}$/.test(id) || files.has(id)) id = crypto.randomBytes(8).toString('hex');
      const fileDir = path.join(UPLOAD_DIR, id);
      fs.mkdirSync(fileDir, { recursive:true });
      const fpath = path.join(fileDir, diskName);
      const mime = extensionMime || (clientMime && clientMime !== 'application/octet-stream' ? clientMime : 'application/octet-stream');
      let rawRel=''; try { rawRel=Buffer.from(String(req.headers['x-relative-path']||''),'base64').toString('utf8'); } catch(e){} rawRel=rawRel.replace(/\\/g,'/').split('/').filter(Boolean).map(safeDiskName).join('/').slice(0,700);
      const entry = { id, name:originalName, relativePath:rawRel, diskName, size:declaredSize, mime, time:Date.now(), path:fpath, status:'uploading', received:0 };
      files.set(id, entry);
      const ws = fs.createWriteStream(fpath);
      req.on('data', c => { entry.received += c.length; });
      req.on('error', () => ws.destroy());
      ws.on('error', () => { try { res.writeHead(500); res.end('write error'); } catch(e){} });
      ws.on('finish', () => {
        entry.status = 'ready'; entry.size = entry.received; saveState();
        try { json(res, { ok:true, file:publicFile(entry) }); } catch(e){}
      });
      return req.pipe(ws);
    }

    if (p === '/api/folder-download' && req.method === 'GET'){
      const folderName = String(u.searchParams.get('folder') || '').replace(/\\/g,'/').split('/').filter(Boolean).map(safeDiskName).join('/');
      if (!folderName) { res.writeHead(400); return res.end('folder required'); }
      const matches = Array.from(files.values()).filter(f => f.status === 'ready' && f.relativePath && f.relativePath.replace(/\\/g,'/').startsWith(folderName + '/'));
      if (!matches.length) { res.writeHead(404); return res.end('folder empty'); }
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'win-airlink-folder-'));
      const stage = path.join(tempRoot, 'content'); fs.mkdirSync(stage, {recursive:true});
      try {
        for (const f of matches) {
          const rel = f.relativePath.replace(/\\/g,'/').split('/').map(safeDiskName);
          const dest = path.join(stage, ...rel);
          fs.mkdirSync(path.dirname(dest), {recursive:true});
          fs.copyFileSync(f.path, dest);
        }
      } catch (e) { try{fs.rmSync(tempRoot,{recursive:true,force:true});}catch(_){} res.writeHead(500); return res.end('folder staging failed'); }
      const zipPath = path.join(tempRoot, 'folder.zip');
      const psQuote = value => "'" + String(value).replace(/'/g, "''") + "'";
      const command = `Compress-Archive -Path ${psQuote(path.join(stage,'*'))} -DestinationPath ${psQuote(zipPath)} -Force`;
      const child = spawn('powershell.exe', ['-NoProfile','-NonInteractive','-Command',command], {windowsHide:true});
      let stderr=''; child.stderr.on('data',d=>stderr+=d.toString());
      child.on('error',()=>{try{fs.rmSync(tempRoot,{recursive:true,force:true});}catch(_){} if(!res.headersSent){res.writeHead(501);res.end('folder archive requires Windows PowerShell');}});
      child.on('close',code=>{
        if (code !== 0 || !fs.existsSync(zipPath)) { try{fs.rmSync(tempRoot,{recursive:true,force:true});}catch(_){} if(!res.headersSent){res.writeHead(500);res.end('could not create folder archive');} return; }
        res.writeHead(200, {'Content-Type':'application/zip','Content-Disposition':`attachment; filename="${(folderName.split('/').pop()||'folder').replace(/[^a-zA-Z0-9._-]/g,'_')}.zip"`});
        const stream=fs.createReadStream(zipPath); stream.pipe(res); stream.on('close',()=>{try{fs.rmSync(tempRoot,{recursive:true,force:true});}catch(_){}}); stream.on('error',()=>{try{fs.rmSync(tempRoot,{recursive:true,force:true});}catch(_){}});
      });
      return;
    }

    const mFile = p.match(/^\/api\/file\/([a-z0-9_-]{8,64})$/i);
    if (mFile){
      const f = files.get(mFile[1]);
      if (!f) { res.writeHead(404); return res.end('not found'); }
      if (req.method === 'DELETE'){
        files.delete(f.id);
        removeStoredFile(f.path);
        saveState();
        return json(res, { ok:true });
      }
      if (req.method === 'GET' || req.method === 'HEAD'){
        if (f.status !== 'ready'){ res.writeHead(409); return res.end('still uploading'); }
        return streamStoredFile(req, res, f, true);
      }
    }

    const mPreview = p.match(/^\/api\/preview\/([a-z0-9_-]{8,64})$/i);
    if (mPreview && req.method === 'POST'){
      const f = files.get(mPreview[1]);
      if (!f || f.status !== 'ready') return json(res, {ok:false,error:'file not ready'}, 404);
      if (path.extname(f.name).toLowerCase() !== '.gif' && f.mime !== 'image/gif') return json(res, {ok:false,error:'GIF only'}, 415);
      let total=0, chunks=[], tooLarge=false;
      req.on('data', chunk => { total += chunk.length; if(total > 180*1024){tooLarge=true;chunks=[];} else if(!tooLarge) chunks.push(chunk); });
      req.on('end', () => {
        if(tooLarge) return json(res,{ok:false,error:'preview too large'},413);
        const b=Buffer.concat(chunks);
        if(b.length<4 || b[0]!==0xff || b[1]!==0xd8) return json(res,{ok:false,error:'JPEG required'},415);
        try { fs.writeFileSync(path.join(path.dirname(f.path),'preview.jpg'),b); return json(res,{ok:true}); }
        catch(e){ return json(res,{ok:false,error:'preview save failed'},500); }
      });
      req.on('error',()=>{if(!res.destroyed&&!res.writableEnded)json(res,{ok:false,error:'request failed'},400);});
      return;
    }
    if (mPreview && (req.method === 'GET' || req.method === 'HEAD')){
      const f = files.get(mPreview[1]);
      if (!f) { res.writeHead(404); return res.end('not found'); }
      if (f.status !== 'ready' && f.status !== 'uploading') { res.writeHead(409); return res.end('not available'); }
      const isGif = path.extname(f.name).toLowerCase()==='.gif' || f.mime==='image/gif';
      const still = isGif ? path.join(path.dirname(f.path),'preview.jpg') : null;
      if(still && fs.existsSync(still)){
        let st; try{st=fs.statSync(still)}catch(e){}
        if(st && st.isFile()){res.writeHead(200,{'Content-Type':'image/jpeg','Content-Length':st.size,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});if(req.method==='HEAD')return res.end();return fs.createReadStream(still).pipe(res);}
      }
      if(isGif){res.writeHead(404);return res.end('GIF still preview pending');}
      return streamStoredFile(req, res, f, false);
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
      const html = fs.readFileSync(path.join(ROOT, 'index.html'));
      res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store' });
      return res.end(html);
    }

    res.writeHead(404); res.end('Not found');
  } catch(e){
    res.writeHead(500); res.end('Error: ' + e.message);
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
  console.log('  Win-AirLink v1.2.3 — сервер запущен');
  console.log('============================================');
  console.log('  На этом ПК:  http://localhost:' + PORT);
  if (ips.length){
    console.log('  Для телефона (та же Wi-Fi сеть):');
    ips.forEach(ip => console.log('    http://' + ip + ':' + PORT));
  }
  console.log('');
  console.log('  Данные сохраняются в папке data/');
  console.log('============================================');
  exec('start "" http://localhost:' + PORT);
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