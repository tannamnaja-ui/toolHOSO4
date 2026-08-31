'use strict';
/* ============================================================
   ตรรกะเทียบคีย์และโอนข้อมูล — รองรับหลาย engine
   ต้นทางและปลายทางอาจเป็นคนละชนิดฐานข้อมูล (เช่น PG → MySQL)
   ctx = { pool, eng }  โดย eng คือ module ใน src/engines
   ============================================================ */

const MAX_PARAMS = 30000;

/** เงื่อนไขคีย์: (k1,k2) IN ((..),(..)) โดยใช้ placeholder ของ engine นั้น */
function buildKeyPredicate(eng, keyColumns, keyRows, startIdx) {
  const cols = keyColumns.map(eng.quote).join(', ');
  const params = [];
  let p = startIdx;
  const tuples = keyRows.map(row => {
    const ph = keyColumns.map(() => eng.ph(p++)).join(', ');
    keyColumns.forEach(c => params.push(row[c]));
    return keyColumns.length > 1 ? '(' + ph + ')' : ph;
  });
  const left = keyColumns.length > 1 ? '(' + cols + ')' : cols;
  return { sql: left + ' IN (' + tuples.join(', ') + ')', params };
}

/** แปลงค่าคีย์เป็นสตริงเปรียบเทียบ (normalize ข้ามชนิด DB) */
function keyOf(row, keyColumns) {
  return JSON.stringify(keyColumns.map(c => {
    const v = row[c];
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return 'D:' + v.toISOString();
    if (Buffer.isBuffer(v)) return 'B:' + v.toString('base64');
    if (typeof v === 'object') return 'J:' + JSON.stringify(v);
    return 'S:' + String(v);
  }));
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function fmt(v) {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) return v.toISOString().slice(0, 19).replace('T', ' ');
  return String(v);
}

function shortErr(e) {
  let m = e && e.message ? e.message : String(e);
  if (e && e.detail) m += ' | ' + e.detail;
  if (e && e.sqlMessage && !m.includes(e.sqlMessage)) m += ' | ' + e.sqlMessage;
  return m.length > 300 ? m.slice(0, 300) + '...' : m;
}

/* ============================================================
   วิเคราะห์ตาราง (plan)
   ============================================================ */
async function planTable(srcCtx, tgtCtx, spec) {
  const schema = spec.schema || 'public';
  const table = spec.table;
  const [src, tgt] = await Promise.all([
    srcCtx.eng.describeTable(srcCtx.pool, schema, table),
    tgtCtx.eng.describeTable(tgtCtx.pool, schema, table)
  ]);

  const plan = {
    schema, table, label: spec.label || table,
    srcEngine: srcCtx.eng.name, tgtEngine: tgtCtx.eng.name,
    srcExists: src.exists, tgtExists: tgt.exists,
    warnings: [], error: null
  };

  if (!src.exists) { plan.error = 'ไม่พบตารางนี้ในฐานข้อมูลต้นทาง'; return plan; }
  if (!tgt.exists) { plan.error = 'ไม่พบตารางนี้ในฐานข้อมูลปลายทาง'; return plan; }

  const keyColumns = (spec.keyColumns && spec.keyColumns.length) ? spec.keyColumns.slice()
    : (tgt.primaryKey.length ? tgt.primaryKey
      : (src.primaryKey.length ? src.primaryKey
        : (tgt.uniqueKey.length ? tgt.uniqueKey : src.uniqueKey)));
  plan.keySource = (spec.keyColumns && spec.keyColumns.length) ? 'กำหนดเอง'
    : (tgt.primaryKey.length || src.primaryKey.length ? 'Primary Key' : 'Unique Index');

  if (!keyColumns || !keyColumns.length) {
    plan.error = 'ตารางนี้ไม่มี Primary Key / Unique Index — กรุณากำหนดคอลัมน์คีย์เองในหน้าตั้งค่าตาราง';
    return plan;
  }

  const srcNames = new Set(src.columns.map(c => c.name));
  const tgtNames = new Set(tgt.columns.map(c => c.name));
  const missingKey = keyColumns.filter(c => !srcNames.has(c) || !tgtNames.has(c));
  if (missingKey.length) {
    plan.error = 'ไม่พบคอลัมน์คีย์ในบางฝั่ง: ' + missingKey.join(', ');
    return plan;
  }

  const tgtByName = new Map(tgt.columns.map(c => [c.name, c]));
  const common = src.columns
    .filter(c => tgtNames.has(c.name))
    .filter(c => !tgtByName.get(c.name).generated)
    .map(c => c.name);

  plan.keyColumns = keyColumns;
  plan.columns = common;
  plan.srcOnly = src.columns.map(c => c.name).filter(n => !tgtNames.has(n));
  plan.tgtOnly = tgt.columns.map(c => c.name).filter(n => !srcNames.has(n));
  plan.overriding = common.some(n => (tgtByName.get(n) || {}).identity === 'ALWAYS');

  if (plan.srcOnly.length) plan.warnings.push('คอลัมน์ที่มีเฉพาะต้นทาง (จะไม่ถูกโอน): ' + plan.srcOnly.join(', '));
  if (plan.tgtOnly.length) plan.warnings.push('คอลัมน์ที่มีเฉพาะปลายทาง (จะใช้ค่า default): ' + plan.tgtOnly.join(', '));

  const srcDateCols = src.dateColumns.map(d => d.name);
  let dateColumn = spec.dateColumn || '';
  if (dateColumn && !srcDateCols.includes(dateColumn)) {
    plan.warnings.push('ไม่พบคอลัมน์วันที่ "' + dateColumn + '" ในต้นทาง — จะเทียบข้อมูลทั้งตาราง');
    dateColumn = '';
  }
  plan.dateColumn = dateColumn;
  plan.dateType = dateColumn ? (src.dateColumns.find(d => d.name === dateColumn) || {}).type : null;
  plan.dateColumnOptions = src.dateColumns;
  if (!dateColumn) plan.warnings.push('ไม่ได้เลือกคอลัมน์วันที่ — จะเทียบข้อมูลทั้งตาราง');

  return plan;
}

/* ============================================================
   query helpers (ใช้ engine ของแต่ละฝั่ง)
   ============================================================ */
async function fetchSourceKeys(srcCtx, plan, from, to) {
  const eng = srcCtx.eng;
  const f = eng.dateFilter(plan.dateColumn, plan.dateType, from, to, 1);
  const where = f.sql ? ' where ' + f.sql : '';
  const cols = plan.keyColumns.map(eng.quote).join(', ');
  const sql = 'select ' + cols + ' from ' + eng.qname(plan.schema, plan.table) + where;
  const r = await eng.query(srcCtx.pool, sql, f.params, { array: true });
  return r.rows.map(arr => {
    const o = {};
    plan.keyColumns.forEach((c, i) => { o[c] = arr[i]; });
    return o;
  });
}

async function countTarget(tgtCtx, plan, from, to) {
  const eng = tgtCtx.eng;
  try {
    const f = eng.dateFilter(plan.dateColumn, plan.dateType, from, to, 1);
    const where = f.sql ? ' where ' + f.sql : '';
    const r = await eng.query(tgtCtx.pool, 'select count(*) as n from ' + eng.qname(plan.schema, plan.table) + where, f.params);
    return Number(r.rows[0].n);
  } catch (e) { return null; }
}

async function findMissingKeys(tgtCtx, plan, srcKeys, onProgress) {
  const eng = tgtCtx.eng;
  const size = Math.max(200, Math.min(2000, Math.floor(MAX_PARAMS / plan.keyColumns.length)));
  const missing = [];
  let done = 0;
  const cols = plan.keyColumns.map(eng.quote).join(', ');
  for (const batch of chunk(srcKeys, size)) {
    const pred = buildKeyPredicate(eng, plan.keyColumns, batch, 1);
    const sql = 'select ' + cols + ' from ' + eng.qname(plan.schema, plan.table) + ' where ' + pred.sql;
    const r = await eng.query(tgtCtx.pool, sql, pred.params, { array: true });
    const exist = new Set(r.rows.map(arr => {
      const o = {};
      plan.keyColumns.forEach((c, i) => { o[c] = arr[i]; });
      return keyOf(o, plan.keyColumns);
    }));
    for (const k of batch) if (!exist.has(keyOf(k, plan.keyColumns))) missing.push(k);
    done += batch.length;
    if (onProgress) onProgress({ checked: done, total: srcKeys.length, missing: missing.length });
  }
  return missing;
}

/* ============================================================
   เทียบข้อมูล (dry) — ไม่เขียนปลายทาง
   ============================================================ */
async function compareTable(srcCtx, tgtCtx, spec, from, to, onProgress) {
  const plan = await planTable(srcCtx, tgtCtx, spec);
  if (plan.error) return Object.assign({}, plan, { status: 'error' });
  const srcKeys = await fetchSourceKeys(srcCtx, plan, from, to);
  const tgtCount = await countTarget(tgtCtx, plan, from, to);
  const missing = await findMissingKeys(tgtCtx, plan, srcKeys, onProgress);
  return Object.assign({}, plan, {
    status: 'ok', sourceRows: srcKeys.length, targetRows: tgtCount, missingRows: missing.length,
    sampleMissing: missing.slice(0, 10).map(k => plan.keyColumns.map(c => c + '=' + fmt(k[c])).join(', '))
  });
}

/* ============================================================
   โอนข้อมูลตารางเดียว
   ============================================================ */
async function transferTable(srcCtx, tgtCtx, spec, from, to, emit, options) {
  options = options || {};
  const result = { table: spec.table, schema: spec.schema || 'public', label: spec.label || spec.table };
  const plan = await planTable(srcCtx, tgtCtx, spec);
  Object.assign(result, {
    keyColumns: plan.keyColumns, dateColumn: plan.dateColumn,
    warnings: plan.warnings, columnCount: plan.columns ? plan.columns.length : 0,
    srcEngine: plan.srcEngine, tgtEngine: plan.tgtEngine
  });
  if (plan.error) { result.status = 'error'; result.error = plan.error; return result; }

  emit({ type: 'stage', table: plan.table, stage: 'อ่านคีย์จากต้นทาง...' });
  const srcKeys = await fetchSourceKeys(srcCtx, plan, from, to);
  result.sourceRows = srcKeys.length;
  result.targetRows = await countTarget(tgtCtx, plan, from, to);

  if (!srcKeys.length) {
    result.status = 'ok'; result.missingRows = 0; result.inserted = 0; result.failed = 0;
    emit({ type: 'stage', table: plan.table, stage: 'ไม่มีข้อมูลในช่วงวันที่ที่เลือก' });
    return result;
  }

  emit({ type: 'stage', table: plan.table, stage: 'ตรวจหาคีย์ที่ขาดในปลายทาง...' });
  const missing = await findMissingKeys(tgtCtx, plan, srcKeys, p =>
    emit(Object.assign({ type: 'progress', table: plan.table, phase: 'check' }, p)));
  result.missingRows = missing.length;

  if (!missing.length) {
    result.status = 'ok'; result.inserted = 0; result.failed = 0;
    emit({ type: 'stage', table: plan.table, stage: 'ข้อมูลครบแล้ว ไม่ต้องโอน' });
    return result;
  }

  if (options.dryRun) {
    result.status = 'dry-run'; result.inserted = 0; result.failed = 0;
    emit({ type: 'stage', table: plan.table, stage: 'พบข้อมูลขาด ' + missing.length + ' แถว (โหมดตรวจสอบเท่านั้น)' });
    return result;
  }

  const srcEng = srcCtx.eng, tgtEng = tgtCtx.eng;
  const cols = plan.columns;
  const srcColList = cols.map(srcEng.quote).join(', ');
  const readSize = Math.max(100, Math.min(1000, Math.floor(MAX_PARAMS / plan.keyColumns.length)));
  const writeSize = Math.max(50, Math.min(500, Math.floor(MAX_PARAMS / Math.max(1, cols.length))));

  let inserted = 0, failed = 0;
  const errors = [];
  emit({ type: 'stage', table: plan.table, stage: 'กำลังโอน ' + missing.length.toLocaleString() + ' แถว...' });

  for (const keyBatch of chunk(missing, readSize)) {
    if (options.isCancelled && options.isCancelled()) { result.cancelled = true; break; }
    const pred = buildKeyPredicate(srcEng, plan.keyColumns, keyBatch, 1);
    const sel = 'select ' + srcColList + ' from ' + srcEng.qname(plan.schema, plan.table) + ' where ' + pred.sql;
    const rows = (await srcEng.query(srcCtx.pool, sel, pred.params, { array: true })).rows;

    for (const rowBatch of chunk(rows, writeSize)) {
      if (options.isCancelled && options.isCancelled()) { result.cancelled = true; break; }
      const insSql = tgtEng.buildInsertIgnore(plan.schema, plan.table, cols, rowBatch.length, { overriding: plan.overriding });
      const values = [];
      rowBatch.forEach(r => r.forEach(v => values.push(v)));
      try {
        const rr = await tgtEng.query(tgtCtx.pool, insSql, values);
        inserted += rr.rowCount;
      } catch (e) {
        // ถ้าทั้งชุดพัง ลองทีละแถวเพื่อข้ามเฉพาะแถวที่มีปัญหา
        for (const row of rowBatch) {
          const one = tgtEng.buildInsertIgnore(plan.schema, plan.table, cols, 1, { overriding: plan.overriding });
          try {
            const r1 = await tgtEng.query(tgtCtx.pool, one, row);
            inserted += r1.rowCount;
          } catch (err) {
            failed++;
            if (errors.length < 20) errors.push(shortErr(err));
          }
        }
      }
      emit({ type: 'progress', table: plan.table, phase: 'insert', inserted, failed, total: missing.length });
    }
  }

  if (options.syncSequence !== false && !result.cancelled) {
    result.sequences = await tgtEng.syncSequences(tgtCtx.pool, plan.schema, plan.table, plan.keyColumns);
  }

  result.status = result.cancelled ? 'cancelled' : (failed ? 'partial' : 'ok');
  result.inserted = inserted;
  result.failed = failed;
  result.errors = errors;
  return result;
}

/* ============================================================
   วินิจฉัยแถวที่ "ขาดหาย" แต่ไม่ถูกโอน (ตารางปกติ)
   ============================================================ */
function reasonKey(msg) {
  return String(msg)
    .replace(/\([^)]*\)=\([^)]*\)/g, '(…)=(…)')
    .replace(/'[^']*'/g, "'…'")
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\d+/g, 'N')
    .slice(0, 200);
}

async function diagnoseTable(srcCtx, tgtCtx, spec, from, to, limit) {
  limit = limit || 200;
  const plan = await planTable(srcCtx, tgtCtx, spec);
  if (plan.error) return { table: spec.table, error: plan.error, groups: [] };

  const srcKeys = await fetchSourceKeys(srcCtx, plan, from, to);
  const missing = await findMissingKeys(tgtCtx, plan, srcKeys);
  const sample = missing.slice(0, limit);

  const srcEng = srcCtx.eng, tgtEng = tgtCtx.eng;
  const cols = plan.columns;
  const colList = cols.map(srcEng.quote).join(', ');
  const keyIdx = plan.keyColumns.map(k => cols.indexOf(k)); // ตำแหน่งคีย์ในชุดคอลัมน์
  const groups = new Map();
  let okInsert = 0;

  const readSize = Math.max(50, Math.min(500, Math.floor(30000 / plan.keyColumns.length)));
  for (const batch of chunk(sample, readSize)) {
    const pred = buildKeyPredicate(srcEng, plan.keyColumns, batch, 1);
    const sel = 'select ' + colList + ' from ' + qname(plan.schema, plan.table) + ' where ' + pred.sql;
    const rows = (await srcEng.query(srcCtx.pool, sel, pred.params, { array: true })).rows;
    for (const r of rows) {
      const sql = tgtEng.buildInsertPlain(plan.schema, plan.table, cols, 1, { overriding: plan.overriding });
      const disp = plan.keyColumns.map((k, i) => k + '=' + fmt(r[keyIdx[i]])).join(', ');
      const res = await tgtEng.diagnoseInsert(tgtCtx.pool, sql, r);
      const key = res.ok ? '__OK__' : reasonKey(shortErr(res.error));
      const g = groups.get(key) || { reason: res.ok ? '__OK__' : shortErr(res.error), count: 0, samples: [] };
      g.count++; if (g.samples.length < 5) g.samples.push(disp);
      groups.set(key, g);
      if (res.ok) okInsert++;
    }
  }

  const list = [...groups.values()].map(g => ({
    reason: g.reason === '__OK__'
      ? 'ลอง insert เดี่ยวได้ปกติ — แถวถูกข้ามตอนโอนเพราะชนคีย์ภายในชุดเดียวกัน หรือมี unique/PK อื่นในตารางปลายทาง'
      : g.reason,
    count: g.count, samples: g.samples
  })).sort((a, b) => b.count - a.count);

  return { table: plan.table, stillMissing: missing.length, sampled: sample.length, okInsert, groups: list };
}

module.exports = { planTable, compareTable, transferTable, diagnoseTable, shortErr, buildKeyPredicate, keyOf };
