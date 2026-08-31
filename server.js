'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const store = require('./src/store');
const db = require('./src/db');
const transfer = require('./src/transfer');
const recipeRunner = require('./src/recipe-runner');
const { getRecipe, listRecipes } = require('./src/recipes');
const { listEngines } = require('./src/engines');

const PORT = process.env.PORT || 3007;
const app = express();

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const HISTORY_FILE = path.join(store.CONFIG_DIR, 'history.json');
const jobs = new Map(); // jobId -> { cancelled }

function wrap(fn) {
  return (req, res) => Promise.resolve(fn(req, res)).catch(err => {
    console.error('[error]', err.message);
    if (!res.headersSent) res.status(400).json({ ok: false, error: transfer.shortErr(err) });
    else { try { res.end(); } catch (e) {} }
  });
}

function sideName(side) {
  return side === 'source' ? 'ต้นทาง' : 'ปลายทาง';
}

/* ------------------------- Connections ------------------------- */

app.get('/api/engines', wrap(async (req, res) => {
  res.json({ ok: true, engines: listEngines() });
}));

app.get('/api/recipes', wrap(async (req, res) => {
  res.json({ ok: true, recipes: listRecipes() });
}));

app.get('/api/connections', wrap(async (req, res) => {
  res.json({ ok: true, connections: store.getConnections(), engines: listEngines() });
}));

app.post('/api/connections', wrap(async (req, res) => {
  const saved = store.saveConnections(req.body || {});
  db.resetPools();
  res.json({ ok: true, connections: saved, message: 'บันทึกการเชื่อมต่อเรียบร้อยแล้ว' });
}));

app.post('/api/connections/test', wrap(async (req, res) => {
  const { side, config } = req.body || {};
  const cfg = Object.assign({}, config);
  if (!cfg.password || cfg.password === '********') {
    const saved = store.getConnection(side);
    cfg.password = saved ? saved.password : '';
  }
  if (!cfg.host) throw new Error('กรุณาระบุ IP Server');
  if (!cfg.database) throw new Error('กรุณาระบุชื่อ Database');
  try {
    const info = await db.testConnection(cfg);
    res.json({ ok: true, side, info, message: 'เชื่อมต่อฐานข้อมูล' + sideName(side) + 'สำเร็จ' });
  } catch (e) {
    res.json({ ok: false, side, error: transfer.shortErr(e) });
  }
}));

/* ------------------------- Schema browsing ------------------------- */

app.get('/api/db/:side/tables', wrap(async (req, res) => {
  res.json({ ok: true, tables: await db.listTables(req.params.side) });
}));

app.get('/api/db/:side/describe', wrap(async (req, res) => {
  const schema = req.query.schema || 'public';
  const table = req.query.table;
  if (!table) throw new Error('ต้องระบุชื่อตาราง');
  res.json({ ok: true, info: await db.describeTable(req.params.side, schema, table) });
}));

/* ------------------------- Table groups ------------------------- */

app.get('/api/groups', wrap(async (req, res) => {
  res.json({ ok: true, groups: store.getGroups() });
}));

app.get('/api/groups/:key', wrap(async (req, res) => {
  const g = store.getGroup(req.params.key);
  if (!g) throw new Error('ไม่พบกลุ่มข้อมูล');
  res.json({ ok: true, group: g });
}));

app.post('/api/groups/:key/tables', wrap(async (req, res) => {
  const g = store.saveGroupTables(req.params.key, (req.body || {}).tables || []);
  res.json({ ok: true, group: g, message: 'บันทึกรายการตารางเรียบร้อยแล้ว' });
}));

/** วิเคราะห์ตารางทีละหลายตัว: คีย์ / คอลัมน์วันที่ / ความเข้ากันได้ */
app.post('/api/plan', wrap(async (req, res) => {
  const srcCtx = db.getContext('source');
  const tgtCtx = db.getContext('target');
  const body = req.body || {};
  const group = body.group || '';
  const tables = body.tables || [];
  const out = [];
  for (const spec of tables) {
    try {
      const recipe = getRecipe(group, spec.table);
      if (recipe) out.push(await recipeRunner.planRecipe(recipe, srcCtx, tgtCtx));
      else out.push(await transfer.planTable(srcCtx, tgtCtx, spec));
    } catch (e) {
      out.push({ table: spec.table, schema: spec.schema || 'public', error: transfer.shortErr(e) });
    }
  }
  res.json({ ok: true, plans: out });
}));

/* ------------------------- Run (compare / transfer) ------------------------- */

function readHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (e) { return []; }
}
function pushHistory(entry) {
  const h = readHistory();
  h.unshift(entry);
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(h.slice(0, 100), null, 2), 'utf8'); } catch (e) {}
}

app.get('/api/history', wrap(async (req, res) => {
  res.json({ ok: true, history: readHistory().slice(0, 50) });
}));

app.post('/api/cancel', wrap(async (req, res) => {
  const id = (req.body || {}).jobId;
  const job = jobs.get(id);
  if (job) job.cancelled = true;
  res.json({ ok: true, cancelled: !!job });
}));

app.post('/api/run', wrap(async (req, res) => {
  const body = req.body || {};
  const { group, dateFrom, dateTo, dryRun } = body;
  const tables = body.tables || [];
  const jobId = body.jobId || ('job-' + Date.now());
  if (!tables.length) throw new Error('กรุณาเลือกตารางอย่างน้อย 1 ตาราง');

  const srcCtx = db.getContext('source');
  const tgtCtx = db.getContext('target');

  const job = { cancelled: false };
  jobs.set(jobId, job);

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders && res.flushHeaders();

  const send = obj => { try { res.write(JSON.stringify(obj) + '\n'); } catch (e) {} };
  const startedAt = Date.now();

  send({ type: 'start', jobId, total: tables.length, dryRun: !!dryRun, dateFrom, dateTo,
    srcEngine: srcCtx.eng.name, tgtEngine: tgtCtx.eng.name });

  const results = [];
  for (let i = 0; i < tables.length; i++) {
    if (job.cancelled) { send({ type: 'cancelled' }); break; }
    const spec = tables[i];
    send({ type: 'table-start', index: i, table: spec.table, label: spec.label || spec.table });
    let result;
    try {
      const recipe = getRecipe(group, spec.table);
      if (recipe) {
        result = await recipeRunner.transferRecipe(recipe, srcCtx, tgtCtx, dateFrom, dateTo, send, {
          dryRun: !!dryRun,
          isCancelled: () => job.cancelled
        });
      } else {
        result = await transfer.transferTable(srcCtx, tgtCtx, spec, dateFrom, dateTo, send, {
          dryRun: !!dryRun,
          syncSequence: body.syncSequence !== false,
          isCancelled: () => job.cancelled
        });
      }
    } catch (e) {
      result = {
        table: spec.table, schema: spec.schema || 'public', label: spec.label || spec.table,
        status: 'error', error: transfer.shortErr(e)
      };
    }
    results.push(result);
    send({ type: 'table-done', index: i, result });
  }

  const summary = {
    group,
    dateFrom, dateTo,
    dryRun: !!dryRun,
    at: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    tables: results.length,
    sourceRows: results.reduce((a, r) => a + (r.sourceRows || 0), 0),
    missingRows: results.reduce((a, r) => a + (r.missingRows || 0), 0),
    inserted: results.reduce((a, r) => a + (r.inserted || 0), 0),
    failed: results.reduce((a, r) => a + (r.failed || 0), 0),
    errors: results.filter(r => r.status === 'error').length,
    cancelled: job.cancelled,
    results
  };
  pushHistory(summary);
  send({ type: 'done', summary });
  jobs.delete(jobId);
  res.end();
}));

app.get('/api/health', (req, res) => res.json({ ok: true, port: PORT, time: new Date().toISOString() }));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, error: 'ไม่พบ endpoint นี้' });
  res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('');
  console.log('  \x1b[35m╭──────────────────────────────────────────────╮\x1b[0m');
  console.log('  \x1b[35m│\x1b[0m  \x1b[95mtoolHOSO4\x1b[0m — ระบบโอนข้อมูล PostgreSQL       \x1b[35m│\x1b[0m');
  console.log('  \x1b[35m│\x1b[0m  http://localhost:' + PORT + '                     \x1b[35m│\x1b[0m');
  console.log('  \x1b[35m╰──────────────────────────────────────────────╯\x1b[0m');
  console.log('');
});
