#!/usr/bin/env node
// aop-server.mjs — AOP Task Design live-reload server
// Zero dependencies. Node.js >= 18.
//
// Usage: node aop-server.mjs [--port 8765] [--dir ./tasks] [--template ./aop.html]
//
// Endpoints:
//   GET  / or /aop.html — Serve template (with SSE injection)
//   GET  /events        — SSE stream (browser auto-updates)
//   POST /push          — Claude pushes data { taskFile, data }
//   GET  /health        — Health check
//   POST /skill-status  — Toggle skill done/pending
//   POST /dataset       — Rewrite ## Datasets section from edited samples
//   POST /upload        — Upload a media file into the task dir (raw body)
//   GET  /*             — Static files from --dir

import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync, watch } from 'node:fs'
import { join, extname, resolve, basename, normalize, sep, dirname } from 'node:path'
import { readdir } from 'node:fs/promises'

// --- Config ---
const args = process.argv.slice(2)
function getArg(flag, fallback) {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}
const PORT = parseInt(getArg('--port', '8765'))
const DIR = resolve(getArg('--dir', './tasks'))
// 目录无效直接致命退出，不带病运行——否则每个路由都 404，比崩溃更迷惑。
// 典型触发: .bat 里 --dir "%~dp0" 尾部反斜杠+引号被 Windows argv 当转义吃掉。
if (!existsSync(DIR)) {
  console.error(`[FATAL] --dir 目录不存在: ${DIR}`)
  console.error('  (bat 脚本请写 --dir "%~dp0." 而非 "%~dp0"——尾部反斜杠+引号会被转义)')
  process.exit(1)
}
const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = resolve(getArg('--template', join(__dirname, 'aop.html')))
const MAX_BODY = 1 << 20 // 1MB
const UPLOAD_MAX = 64 << 20 // 64MB（媒体上传）
const MAX_CLIENTS = 32
const IS_WIN = process.platform === 'win32'

// Pre-read template
let templateHtml = ''
try { templateHtml = await readFile(TEMPLATE, 'utf-8') } catch {}
const SSE_INJECT = `<script>
if(typeof EventSource!=='undefined'){var _es=new EventSource('/events');_es.addEventListener('update',function(e){try{window.__onSSE(JSON.parse(e.data));}catch(ex){}});_es.addEventListener('reload',function(){try{location.reload();}catch(ex){}});_es.onerror=function(){_es.close();};}
</script>`

// --- MIME ---
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
}

// --- Safe path check (case-insensitive on Windows) ---
function isSubPath(base, target) {
  const normBase = normalize(base + sep)
  const normTarget = normalize(target + sep)
  return IS_WIN
    ? normTarget.toLowerCase().startsWith(normBase.toLowerCase())
    : normTarget.startsWith(normBase)
}

// --- SSE clients ---
const clients = new Set()
let keepAliveInterval = null

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of clients) {
    try { res.write(msg) } catch { clients.delete(res) }
  }
}

function startKeepAlive() {
  if (keepAliveInterval) return
  keepAliveInterval = setInterval(() => {
    for (const res of clients) {
      try { res.write(': ping\n\n') } catch { clients.delete(res) }
    }
  }, 30000)
}

// --- task.md parser (lightweight, no external deps) ---
function parseFrontMatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return {}
  const yaml = m[1]
  const result = {}
  for (const line of yaml.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/)
    if (kv) result[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '')
  }
  return result
}

function parseMdSections(body) {
  const sections = { O: [], S: [], A: [], R: [], actors: [], datasets: [] }

  // Limit rosa search to ## 问题空间 section only
  const psMatch = body.match(/^##\s*(?:问题空间|Problem)\s*\n/gm)
  const rosaBody = psMatch ? (() => {
    const i = body.indexOf(psMatch[0]) + psMatch[0].length
    const e = body.indexOf('\n## ', i)
    return e > 0 ? body.slice(i, e) : body.slice(i)
  })() : body

  const sectionRe = /^###\s*([OSARosar])\s*[（(—\-].*\n/gm
  const found = []
  let m
  while ((m = sectionRe.exec(rosaBody)) !== null) {
    found.push({ letter: m[1].toUpperCase(), start: m.index + m[0].length, headingIdx: m.index })
  }
  for (let i = 0; i < found.length; i++) {
    let end = i + 1 < found.length ? found[i + 1].headingIdx : rosaBody.length
    const text = rosaBody.slice(found[i].start, end)
    const letter = found[i].letter
    if ('OSA'.includes(letter)) {
      parseRosaSection(text, sections, letter)
    } else if (letter === 'R') {
      parseRosaSection(text, sections, letter)
    }
  }

  const actorsRe = /^##\s*(?:Actors?|对象)\s*\n/gm
  let am
  while ((am = actorsRe.exec(body)) !== null) {
    const start = am.index + am[0].length
    const nextH2 = body.indexOf('\n## ', start)
    const actorText = nextH2 > 0 ? body.slice(start, nextH2) : body.slice(start)
    parseActors(actorText, sections)
  }

  // Parse ## Datasets section
  const dsRe = /^##\s*Datasets?\s*\n/gm
  let dm
  while ((dm = dsRe.exec(body)) !== null) {
    const start = dm.index + dm[0].length
    const nextH2 = body.indexOf('\n## ', start)
    const dsText = nextH2 > 0 ? body.slice(start, nextH2) : body.slice(start)
    sections.datasets.push(...parseDatasetsSection(dsText))
  }

  // Parse ## 解空间 or ## PCDATR section
  const pcdRe = /^##\s*(?:解空间|PCDATR)\s*\n/gm
  let pm
  while ((pm = pcdRe.exec(body)) !== null) {
    const start = pm.index + pm[0].length
    const nextH2 = body.indexOf('\n## ', start)
    const pcdText = nextH2 > 0 ? body.slice(start, nextH2) : body.slice(start)
    const parsed = parsePcdatrSkills(pcdText)
    if (Object.keys(parsed).length) sections.agents = parsed
  }

  return sections
}

function parseRosaSection(text, sections, letter) {
  if (text.includes('|') && !text.match(/^-\s+[\w\u4e00-\u9fff]+:\s/m)) {
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (t.startsWith('|') && !t.includes('---')) {
        const cells = t.split('|').map(c => c.trim()).filter(Boolean)
        if (cells.length >= 1 && cells[0].toLowerCase() !== 'key') {
          sections[letter].push({ key: cells[0], label: cells.slice(2).join(' · ') || cells[0], type: cells[1] || '', source: letter === 'O' ? cells[2] : undefined, range: letter === 'S' ? cells[2] : undefined, effect: letter === 'A' ? cells[2] : undefined })
        }
      }
    }
    return
  }
  const lines = text.split('\n')
  let cur = null
  for (const raw of lines) {
    const t = raw.trim()
    if (!t) continue
    const itemM = t.match(/^-\s+([\w\u4e00-\u9fff]+):\s*(.*)/)
    if (itemM) {
      if (cur) sections[letter].push(cur)
      cur = { key: itemM[1], label: itemM[2] || itemM[1] }
      continue
    }
    if (cur) {
      const propM = t.match(/^([\w\u4e00-\u9fff]+):\s*(.*)/)
      if (propM) {
        const pk = propM[1], pv = propM[2]
        if (pk === 'weight') { cur.weight = parseFloat(pv) || 0 }
        else if (letter === 'R') { cur[pk] = pv }
        else if (letter === 'O') {
          if (pk === 'type') cur.type = pv
          else if (pk === 'source') cur.source = pv
          else cur[pk] = pv
        } else if (letter === 'S') {
          if (pk === 'type') cur.type = pv
          else if (pk === 'range') cur.range = pv
          else cur[pk] = pv
        } else if (letter === 'A') {
          if (pk === 'type') cur.type = pv
          else if (pk === 'effect') cur.effect = pv
          else cur[pk] = pv
        }
      }
    }
  }
  if (cur) sections[letter].push(cur)
}

function parseActors(text, sections) {
  const actorRe = /^###\s+(\S+)\s*$/gm
  const found = []
  let m
  while ((m = actorRe.exec(text)) !== null) {
    found.push({ id: m[1], start: m.index + m[0].length })
  }
  for (let i = 0; i < found.length; i++) {
    const end = i + 1 < found.length ? found[i + 1].start - 1 : text.length
    const actorText = text.slice(found[i].start, end)
    const fields = []
    for (const line of actorText.split('\n')) {
      const t = line.trim()
      if (!t.startsWith('- ')) continue
      const content = t.slice(2).trim()
      const colonIdx = content.indexOf(':')
      if (colonIdx > 0) {
        fields.push({
          key: content.slice(0, colonIdx).trim(),
          type: content.slice(colonIdx + 1).trim(),
        })
      }
    }
    sections.actors.push({ id: found[i].id, fields })
  }
}

function parseTaskMd(text) {
  const fm = parseFrontMatter(text)
  const bodyStart = text.indexOf('---', 4)
  const body = bodyStart > 0 ? text.slice(bodyStart + 3) : text
  const sections = parseMdSections(body)
  const meta = { id: fm.id || '', title: fm.title || '', version: '0.1', created: new Date().toISOString().slice(0, 10) }
  const agents = sections.agents && Object.keys(sections.agents).length ? sections.agents : autoGenAgents(sections)
  return { meta, ...sections, agents }
}

function parsePcdatrSkills(text) {
  const agents = {}
  const layerRe = /^###\s*([PCDATRpcdatr])\s*[（(—\-\s]?\s*/gm
  const layers = []
  let lm
  while ((lm = layerRe.exec(text)) !== null) {
    const layerEnd = text.indexOf('\n### ', lm.index + 1)
    layers.push({ layer: lm[1].toUpperCase(), start: lm.index + lm[0].length, end: layerEnd > 0 ? layerEnd : text.length })
  }
  for (const l of layers) {
    const lText = text.slice(l.start, l.end)
    const skRe = /^####\s*([PCDATRpcdatr]\d*)\s*[·.]*\s*(.+?)(?:\s*\[([ xX])\])?\s*$/gm
    const skills = []
    let sm
    while ((sm = skRe.exec(lText)) !== null) {
      const skStart = sm.index + sm[0].length
      const skEnd = lText.indexOf('\n#### ', skStart)
      const skText = lText.slice(skStart, skEnd > 0 ? skEnd : lText.length)
      const sk = { id: sm[2].trim(), title: l.layer + '层技能', goal: '', status: sm[3] && sm[3].toLowerCase() === 'x' ? 'done' : 'pending', in: [], out: [] }
      const goalM = skText.match(/^>\s*(?:goal[:：]\s*)?(.+)$/m)
      if (goalM) sk.goal = goalM[1].trim()
      const inM = skText.match(/^-?\s*in:\s*(.+)$/m)
      if (inM) {
        const v = inM[1].trim()
        if (v === '(无)' || v === '无' || v === 'none') sk.in = []
        else sk.in = v.split(/[,，]\s*/).map(s => s.trim()).filter(Boolean)
      }
      const outM = skText.match(/^-?\s*out:\s*(.+)$/m)
      if (outM) {
        const v = outM[1].trim()
        if (v === '(无)' || v === '无' || v === 'none') sk.out = []
        else sk.out = v.split(/[,，]\s*/).map(s => s.trim()).filter(Boolean)
      }
      skills.push(sk)
    }
    if (skills.length) agents[l.layer] = skills
  }
  return agents
}

function autoGenAgents(sections) {
  const oKeys = (sections.O || []).map(f => f.key)
  const sKeys = (sections.S || []).map(f => f.key)
  const aKeys = (sections.A || []).map(f => f.key)
  const rKeys = (sections.R || []).map(f => f.key)
  const ag = {}
  // Default skill ids mirror the PCDATR layer names (aop.md convention)
  if (oKeys.length) ag.P = [{ id: 'perception', title: '感知', goal: '采集所有观察数据', status: 'pending', in: [], out: oKeys }]
  if (sKeys.length) ag.C = [{ id: 'cognition', title: '认知', goal: '从观察推断状态', status: 'pending', in: oKeys, out: sKeys }]
  if (aKeys.length) {
    ag.D = [{ id: 'decision', title: '决策', goal: '根据状态选择动作', status: 'pending', in: sKeys, out: aKeys }]
    ag.A = [{ id: 'action', title: '执行', goal: '执行决策动作', status: 'pending', in: aKeys, out: [] }]
  }
  if (rKeys.length) ag.R = [{ id: 'reward', title: '评价', goal: '评估任务质量', status: 'pending', in: sKeys, out: rKeys }]
  return ag
}

// --- Read and parse file for SSE push (validated path) ---
async function readAndPush(filePath, taskName) {
  const resolved = resolve(filePath)
  if (!isSubPath(DIR, resolved)) return
  try {
    const content = await readFile(resolved, 'utf-8')
    const ext = extname(resolved)
    let data
    if (ext === '.md') {
      data = parseTaskMd(content)
    } else if (ext === '.json') {
      data = JSON.parse(content)
    } else {
      return
    }
    broadcast('update', { file: basename(resolved), task: taskName || null, state: data })
  } catch (err) {
    console.error(`Error reading ${basename(resolved)}:`, err.message)
  }
}

// --- HTTP Server ---
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  // CORS (localhost only)
  res.setHeader('Access-Control-Allow-Origin', '*')

  // Health check
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ status: 'ok', clients: clients.size }))
  }

  // List task directories (each containing a task.md). Used by the client to
  // validate subtask references and future task pickers. Subtasks live as flat
  // sibling dirs (SSE watcher assumes a single path segment) — naming: <parent>-<scope>.
  if (url.pathname === '/tasks') {
    try {
      const entries = await readdir(DIR, { withFileTypes: true })
      const tasks = []
      for (const ent of entries) {
        if (!ent.isDirectory()) continue
        try {
          await readFile(join(DIR, ent.name, 'task.md'))
          tasks.push(ent.name)
        } catch {}
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ tasks }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: String(err && err.message || err) }))
    }
  }

  // SSE endpoint
  if (url.pathname === '/events') {
    if (clients.size >= MAX_CLIENTS) {
      res.writeHead(503, { 'Content-Type': 'text/plain' })
      return res.end('Too many connections')
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write(': connected\n\n')
    clients.add(res)
    startKeepAlive()
    req.on('close', () => clients.delete(res))
    return
  }

  // POST /push — Claude pushes data directly
  if (req.method === 'POST' && url.pathname === '/push') {
    const contentLength = parseInt(req.headers['content-length'] || '0')
    if (contentLength > MAX_BODY) {
      res.writeHead(413, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'Payload too large' }))
    }
    const chunks = []
    let received = 0
    for await (const chunk of req) {
      received += chunk.length
      if (received > MAX_BODY) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: 'Payload too large' }))
      }
      chunks.push(chunk)
    }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString())
      broadcast('update', { file: body.taskFile || 'task', state: body.data })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, clients: clients.size }))
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid JSON' }))
    }
    return
  }

  // POST /skill-status — toggle skill done/pending, persists to task.md
  if (req.method === 'POST' && url.pathname === '/skill-status') {
    const chunks = []
    let received = 0
    for await (const chunk of req) {
      received += chunk.length
      if (received > MAX_BODY) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: 'Payload too large' }))
      }
      chunks.push(chunk)
    }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString())
      const { layer, skillId, status, task } = body
      if (!layer || !skillId || !status) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: 'Missing layer, skillId, or status' }))
      }
      // Find the correct task.md based on task name (guard against path traversal)
      if (task && !isSubPath(DIR, join(DIR, task))) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: 'Forbidden' }))
      }
      const taskFile = task ? join(DIR, task, 'task.md') : await findTaskMd(DIR)
      if (!taskFile || !existsSync(taskFile)) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: 'No task.md found' }))
      }
      const content = await readFile(taskFile, 'utf-8')
      const updated = updateSkillStatus(content, layer, skillId, status)
      await writeFile(taskFile, updated, 'utf-8')
      broadcast('update', { file: basename(taskFile), state: parseTaskMd(updated) })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid request' }))
    }
    return
  }

  // POST /dataset — rewrite ## Datasets section from edited samples, persist to task.md
  if (req.method === 'POST' && url.pathname === '/dataset') {
    const chunks = []
    let received = 0
    for await (const chunk of req) {
      received += chunk.length
      if (received > MAX_BODY) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: 'Payload too large' }))
      }
      chunks.push(chunk)
    }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString())
      if (body.task && !isSubPath(DIR, join(DIR, body.task))) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: 'Forbidden' }))
      }
      const taskFile = body.task ? join(DIR, body.task, 'task.md') : await findTaskMd(DIR)
      if (!taskFile || !existsSync(taskFile)) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: 'No task.md found' }))
      }
      const content = await readFile(taskFile, 'utf-8')
      const incoming = Array.isArray(body.datasets) ? body.datasets : []
      // Guard against accidental wipe: refuse an empty payload when the file
      // already has dataset samples, unless caller explicitly confirms.
      const dsHead = content.match(/^##\s*Datasets?\s*$/m)
      let existingSamples = 0
      if (dsHead) {
        const after = content.slice(dsHead.index + dsHead[0].length)
        const nextH2 = after.indexOf('\n## ')
        const section = nextH2 >= 0 ? after.slice(0, nextH2) : after
        existingSamples = (section.match(/^###[ \t]/gm) || []).length
      }
      if (incoming.length === 0 && existingSamples > 0 && body.confirmWipe !== true) {
        res.writeHead(409, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: `Refusing to overwrite ${existingSamples} existing dataset(s) with an empty payload`, existing: existingSamples }))
      }
      const updated = replaceDatasetsSection(content, incoming)
      await writeFile(taskFile, updated, 'utf-8')
      broadcast('update', { file: basename(taskFile), task: body.task || null, state: parseTaskMd(updated) })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: true }))
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'Invalid request' }))
    }
  }

  // POST /upload?task=<name>&name=<filename> — raw binary body → tasks/<task>/<filename>
  if (req.method === 'POST' && url.pathname === '/upload') {
    const task = url.searchParams.get('task')
    let name = url.searchParams.get('name') || ''
    if (!task || !name) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'Missing task or name' }))
    }
    const taskDir = join(DIR, task)
    if (!isSubPath(DIR, taskDir)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'Forbidden' }))
    }
    // Sanitize filename: drop path separators & unsafe chars, keep CJK/word/dot/dash/space
    name = name.replace(/[\\/]/g, '_').replace(/[^\w.\-一-龥 ]/g, '').trim().slice(0, 120)
    if (!name) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'Invalid filename' }))
    }
    const chunks = []
    let received = 0
    let tooBig = false
    for await (const chunk of req) {
      received += chunk.length
      if (received > UPLOAD_MAX) { tooBig = true; break }
      chunks.push(chunk)
    }
    if (tooBig) {
      res.writeHead(413, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'File too large (max 64MB)' }))
    }
    // Unique filename if it already exists (append _n before extension)
    let fname = name
    let n = 1
    while (existsSync(join(taskDir, fname))) {
      const e = extname(name)
      fname = e ? name.slice(0, -e.length) + `_${n}` + e : `${name}_${n}`
      n++
    }
    try {
      await writeFile(join(taskDir, fname), Buffer.concat(chunks))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, path: `${task}/${fname}` }))
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: e.message || 'Write failed' }))
    }
  }

  // Template route: / or /aop.html → serve template with SSE injection
  // Also: /{task-name} → if tasks/{name}/task.md exists, serve template
  const isTemplateRoute = url.pathname === '/' || url.pathname === '/aop.html'
  const pathParts = url.pathname.replace(/^\/|\/$/g, '').split('/')
  const maybeTask = pathParts.length === 1 && pathParts[0] && !pathParts[0].includes('.')
  const taskDir = maybeTask ? join(DIR, pathParts[0]) : null
  const isTaskRoute = taskDir && existsSync(join(taskDir, 'task.md'))

  if (isTemplateRoute || isTaskRoute) {
    if (!templateHtml) {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      return res.end('Template not found: ' + TEMPLATE)
    }
    // Inject task name for task routes so frontend knows what to load
    let html = templateHtml
    if (isTaskRoute) {
      html = html.replace('const __TASK_DATA__ = null;', `const __TASK_PATH__ = '${pathParts[0]}'; const __TASK_DATA__ = null;`)
    }
    const injected = html.replace('</head>', SSE_INJECT + '</head>')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    return res.end(injected)
  }

  // Static file serving from --dir
  let filePath = join(DIR, url.pathname)
  filePath = resolve(filePath)

  // Security: prevent directory traversal (case-insensitive on Windows)
  if (!isSubPath(DIR, filePath)) {
    res.writeHead(403)
    return res.end('Forbidden')
  }

  if (!existsSync(filePath)) {
    res.writeHead(404)
    return res.end('Not found')
  }

  try {
    const data = await readFile(filePath)
    const ct = MIME[extname(filePath)] || 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': ct })
    res.end(data)
  } catch {
    res.writeHead(500)
    res.end('Internal error')
  }
})

// --- Find task.md in directory ---
async function findTaskMd(dir) {
  // Check root first
  const rootPath = join(dir, 'task.md')
  if (existsSync(rootPath)) return rootPath
  // Check subdirectories (one level)
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subPath = join(dir, entry.name, 'task.md')
        if (existsSync(subPath)) return subPath
      }
    }
  } catch {}
  return null
}

// --- YAML scalar coercion helpers (mirror aop.html coerceDsVal) ---
function stripYamlComment(v){let d=0,q=null;for(let i=0;i<v.length;i++){const c=v[i];if(q){if(c===q)q=null;continue;}if(c==='"'||c==="'")q=c;else if(c==='{'||c==='[')d++;else if(c==='}'||c===']')d--;else if(c==='#'&&d===0&&i>0&&/\s/.test(v[i-1]))return v.slice(0,i);}return v;}
function splitYamlComment(v){v=String(v==null?'':v);const val=stripYamlComment(v);if(val.length>=v.length)return{val,cmt:''};const cmt=v.slice(val.length).replace(/^[\s#]+/,'').replace(/[\r\n]/g,' ').trim();return{val,cmt};}
function coerceDsVal(v){if(v===null||v===undefined)return '';v=stripYamlComment(String(v)).trim();if(v==='{}')return {};if(v==='')return '';if(v==='null')return null;if(v.startsWith('{')){try{return JSON.parse(v);}catch{return v;}}if(v.startsWith('[')){try{return JSON.parse(v);}catch{return v;}}if(v.length>=2&&((v[0]==='"'&&v[v.length-1]==='"')||(v[0]==="'"&&v[v.length-1]==="'")))return v.slice(1,-1);if(/^-?(0|[1-9]\d*)$/.test(v))return Number(v);return v;}

// Parse a `trajectory:` block-YAML body into ordered frames [{label,o,s,a,r}].
// Returns null when no trajectory block is present. Mirrors aop.html.
function parseTrajectoryBlock(text){
  const lines=text.split('\n');
  let s=-1;
  for(let i=0;i<lines.length;i++){if(/^\s*trajectory\s*:\s*$/.test(lines[i])){s=i+1;break;}}
  if(s<0)return null;
  const steps=[];let cur=null,cl=null;
  for(let i=s;i<lines.length;i++){
    const line=lines[i];
    if(!line.trim())continue;
    if(/^#{2,4}\s/.test(line))break;
    if(line.trim().startsWith('#'))continue;
    const ind=line.length-line.trimStart().length;
    const t=line.trim();
    if(/^-\s/.test(t)||t==='-'){
      cur={label:'',o:{},s:{},a:{},r:{}};
      steps.push(cur);cl=null;
      const a=t.replace(/^-\s*/,'');
      const ci=a.indexOf(':');
      if(ci>0){const k=a.slice(0,ci).trim();const raw=a.slice(ci+1);if(k==='label'){const sc=splitYamlComment(raw);cur.label=coerceDsVal(sc.val);if(sc.cmt)cur._lc=sc.cmt;}else if('osar'.includes(k))cur[k]=raw.trim()===''?{}:coerceDsVal(raw);}
      continue;
    }
    const lm=t.match(/^([osar])\s*:\s*(.*)$/);
    if(lm&&ind>=2){
      cl=lm[1];const raw=lm[2];
      if(raw.trim()!==''){cur[cl]=coerceDsVal(raw);cl=null;}
      continue;
    }
    if(cl&&cur){const ci=t.indexOf(':');if(ci>0)cur[cl][t.slice(0,ci).trim()]=coerceDsVal(t.slice(ci+1));}
  }
  return steps;
}

// --- Parse ## Datasets section ---
// Each `### ` entry normalizes to {id,label,scenario,steps:[{label,o,s,a,r}]}.
// trajectory: block → multi-frame; legacy `#### o/s/a/r` → single frame.
function parseDatasetsSection(text) {
  const datasets = []
  const dsRe = /^###[ \t]+#?(\d*)[ \t]*[·.]*[ \t]*(.+?)$/gm
  const found = []
  let m
  while ((m = dsRe.exec(text)) !== null) found.push({ num: m[1], label: m[2].trim(), start: m.index + m[0].length, headingIdx: m.index })
  for (let i = 0; i < found.length; i++) {
    const end = i + 1 < found.length ? found[i + 1].headingIdx : text.length
    const dsText = text.slice(found[i].start, end)
    const ds = { id: found[i].num || String(i + 1), label: found[i].label, scenario: '', steps: [{ label: '', o: {}, s: {}, a: {}, r: {} }] }
    const scMatch = dsText.match(/^[>\s]*(?:scenario[:：]\s*)(.+)$/m)
    if (scMatch) ds.scenario = scMatch[1].trim()
    const trj = parseTrajectoryBlock(dsText)
    if (trj && trj.length) { ds.steps = trj }
    else {
      const subRe = /^####\s*([osar])\s*$/gim
      const subs = []
      let sm
      while ((sm = subRe.exec(dsText)) !== null) subs.push({ letter: sm[1].toLowerCase(), start: sm.index + sm[0].length, headingIdx: sm.index })
      for (let j = 0; j < subs.length; j++) {
        const sEnd = j + 1 < subs.length ? subs[j + 1].headingIdx : dsText.length
        const sText = dsText.slice(subs[j].start, sEnd)
        for (const line of sText.split('\n')) {
          const t = line.trim()
          if (!t.startsWith('- ')) continue
          const content = t.slice(2).trim()
          const ci = content.indexOf(':')
          if (ci <= 0) continue
          const k = content.slice(0, ci).trim()
          const v = coerceDsVal(content.slice(ci + 1).trim())
          ds.steps[0][subs[j].letter][k] = v
        }
      }
    }
    datasets.push(ds)
  }
  return datasets
}

// --- Serialize a dataset value back to YAML scalar form ---
function serDsVal(v) {
  if (v === null) return 'null'
  if (v === undefined) return ''
  if (typeof v === 'number') return String(v)
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

// --- Regenerate the whole ## Datasets section as trajectory block-YAML ---
function genDatasetsMd(datasets) {
  let out = '## Datasets\n'
  if (!datasets || !datasets.length) return out
  datasets.forEach((raw, i) => {
    let steps
    if (raw && Array.isArray(raw.steps)) {
      steps = raw.steps.map(st => ({ label: st.label || '', _lc: st._lc || '', o: st.o || {}, s: st.s || {}, a: st.a || {}, r: st.r || {} }))
    } else if (raw && (raw.o || raw.s || raw.a || raw.r)) {
      steps = [{ label: '', o: raw.o || {}, s: raw.s || {}, a: raw.a || {}, r: raw.r || {} }]
    } else {
      steps = [{ label: '', o: {}, s: {}, a: {}, r: {} }]
    }
    const label = (raw && (raw.label || raw.id)) || ('样本' + (i + 1))
    out += `\n### #${i + 1} · ${String(label).trim()}\n`
    if (raw && raw.scenario) out += `> scenario: ${String(raw.scenario).trim()}\n`
    out += `trajectory:\n`
    steps.forEach(st => {
      out += `  -`
      if (st.label) {
        out += ` label: ${serDsVal(st.label)}`
        if (st._lc) out += ` # ${String(st._lc).replace(/[\r\n]/g, ' ')}`
      }
      out += `\n`
      for (const letter of ['o', 's', 'a', 'r']) {
        const data = st[letter] || {}
        if (!Object.keys(data).length) { out += `    ${letter}: {}\n`; continue }
        out += `    ${letter}:\n`
        for (const [k, v] of Object.entries(data)) out += `      ${k}: ${serDsVal(v)}\n`
      }
    })
  })
  return out
}

// --- Splice a freshly generated ## Datasets section into task.md content ---
function replaceDatasetsSection(content, datasets) {
  const gen = genDatasetsMd(datasets)
  const re = /^##\s*Datasets?\s*$/m
  const m = re.exec(content)
  if (!m) {
    const sep = content.endsWith('\n') ? '\n' : '\n\n'
    return content + sep + gen
  }
  const start = m.index
  const lineEnd = content.indexOf('\n', start)
  const nextH2 = content.indexOf('\n## ', lineEnd + 1)
  const sectionEnd = nextH2 === -1 ? content.length : nextH2
  return content.slice(0, start) + gen + content.slice(sectionEnd)
}

// --- Update skill checkbox status in task.md content ---
function updateSkillStatus(content, layer, skillId, status) {
  const check = status === 'done' ? 'x' : ' '
  const escaped = skillId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  // Pattern 0: ## 解空间 format — #### P1 · skill_id [x] or #### P1 · skill_id
  const pcdatrRe = new RegExp(`^(####\\s*${layer}\\d*\\s*[·.]*\\s*${escaped})(?:\\s*\\[[ xX]\\])?\\s*$`, 'm')
  if (pcdatrRe.test(content)) {
    if (status === 'done') return content.replace(pcdatrRe, `$1 [x]`)
    return content.replace(pcdatrRe, '$1')
  }

  // Pattern 1: already has checkbox - replace it
  const chkRe = new RegExp(`^(-\\s*\\[)[ xX](\\]\\s*\`${escaped}[\\/]?\\s*\`)`, 'm')
  if (chkRe.test(content)) {
    return content.replace(chkRe, `$1${check}$2`)
  }

  // Pattern 2: no checkbox yet - add one
  const plainRe = new RegExp(`^(-\\s*)\`${escaped}[\\/]?\\s*\``, 'm')
  if (plainRe.test(content)) {
    return content.replace(plainRe, `$1[${check}] \`${escaped}/\``)
  }

  return content
}

// --- File watcher ---
let debounceTimer = null
function setupWatcher() {
  if (!existsSync(DIR)) {
    console.warn(`Watch directory not found: ${DIR}`)
    return
  }
  try {
    watch(DIR, { recursive: true }, (eventType, filename) => {
      if (!filename) return
      const ext = extname(filename)
      if (!['.md', '.json'].includes(ext)) return
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        console.log(`File changed: ${filename}`)
        // Extract task name from path: "smart-drone/task.md" → "smart-drone"
        const parts = filename.replace(/\\/g, '/').split('/')
        const taskName = parts.length > 1 ? parts[0] : null
        readAndPush(join(DIR, filename), taskName)
      }, 300)
    })
    console.log(`Watching: ${DIR}`)
  } catch (err) {
    console.warn(`File watch failed:`, err.message)
  }
}

// Watch template file for changes
function watchTemplate() {
  if (!existsSync(TEMPLATE)) return
  try {
    let debounce = null
    watch(TEMPLATE, () => {
      clearTimeout(debounce)
      debounce = setTimeout(async () => {
        try {
          templateHtml = await readFile(TEMPLATE, 'utf-8')
          console.log('Template reloaded')
          broadcast('reload', { reason: 'template changed' })
        } catch (err) {
          console.warn('Template reload failed:', err.message)
        }
      }, 300)
    })
  } catch {}
}

// --- Start ---
server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[FATAL] 端口 ${PORT} 已被占用。先停掉旧实例: netstat -ano | findstr :${PORT} 然后 taskkill /PID <pid> /F`)
  } else {
    console.error('[FATAL] 监听失败:', err.message)
  }
  process.exit(1)
})
server.listen(PORT, () => {
  console.log(`AOP server: http://localhost:${PORT}`)
  console.log(`SSE endpoint: http://localhost:${PORT}/events`)
  console.log(`Serving from: ${DIR}`)
  setupWatcher()
  watchTemplate()
})
