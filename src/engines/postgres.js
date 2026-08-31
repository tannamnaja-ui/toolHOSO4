'use strict';
/* ============================================================
   Engine: PostgreSQL
   ทุก engine มี interface เดียวกัน (ดู engines/index.js)
   ============================================================ */
const { Pool } = require('pg');

const name = 'postgres';
const label = 'PostgreSQL';
const defaultPort = 5432;

function quote(id) {
  return '"' + String(id).replace(/"/g, '""') + '"';
}
function qname(schema, table) {
  return quote(schema || 'public') + '.' + quote(table);
}
/** placeholder ตำแหน่งที่ i (1-based) */
function ph(i) {
  return '$' + i;
}

function poolConfig(cfg, max) {
  return {
    host: cfg.host,
    port: Number(cfg.port) || defaultPort,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
    max: max || 6,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
    application_name: 'toolHOSO4'
  };
}

function createPool(cfg, max) {
  const pool = new Pool(poolConfig(cfg, max));
  pool.on('error', () => {});
  return pool;
}
function endPool(pool) { return pool.end(); }

/** query แบบรวม: คืน { rows, rowCount } เสมอ; opts.array = คืนแถวเป็น array */
async function query(pool, sql, params, opts) {
  const q = { text: sql, values: params || [] };
  if (opts && opts.array) q.rowMode = 'array';
  const r = await pool.query(q);
  return { rows: r.rows, rowCount: r.rowCount };
}

async function testConnection(cfg) {
  const pool = createPool(cfg, 1);
  const started = Date.now();
  try {
    const r = await pool.query(
      "select version() as version, current_database() as db, current_user as usr, " +
      "pg_size_pretty(pg_database_size(current_database())) as size, now() as server_time"
    );
    const c = await pool.query(
      "select count(*)::int as n from information_schema.tables " +
      "where table_schema not in ('pg_catalog','information_schema')"
    );
    const row = r.rows[0];
    return {
      ok: true, engine: name, elapsedMs: Date.now() - started,
      version: String(row.version).split(',')[0],
      database: row.db, user: row.usr, size: row.size,
      serverTime: row.server_time, tableCount: c.rows[0].n
    };
  } finally { pool.end().catch(() => {}); }
}

async function listTables(pool) {
  const sql = `
    select c.relname as table_name, n.nspname as table_schema,
           coalesce(c.reltuples, 0)::bigint as approx_rows
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r','p')
      and n.nspname not in ('pg_catalog','information_schema','pg_toast')
    order by n.nspname, c.relname`;
  const r = await pool.query(sql);
  return r.rows.map(x => ({ schema: x.table_schema, table: x.table_name, approxRows: Number(x.approx_rows) }));
}

const DATE_TYPES = new Set(['date', 'timestamp without time zone', 'timestamp with time zone', 'time without time zone']);

async function describeTable(pool, schema, table) {
  schema = schema || 'public';
  const ex = await pool.query(
    `select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname=$1 and c.relname=$2 and c.relkind in ('r','p') limit 1`, [schema, table]);
  if (!ex.rowCount) return { exists: false, columns: [], primaryKey: [], uniqueKey: [], dateColumns: [] };

  const colsQ = await pool.query(
    `select column_name, data_type, udt_name, is_nullable, is_identity, identity_generation, is_generated
     from information_schema.columns where table_schema=$1 and table_name=$2 order by ordinal_position`,
    [schema, table]);
  const columns = colsQ.rows.map(x => ({
    name: x.column_name, type: x.data_type, udt: x.udt_name,
    nullable: x.is_nullable === 'YES',
    identity: x.is_identity === 'YES' ? (x.identity_generation || 'BY DEFAULT') : null,
    generated: x.is_generated === 'ALWAYS'
  }));

  const pkQ = await pool.query(
    `select a.attname as col from pg_index i
     join pg_class c on c.oid=i.indrelid join pg_namespace n on n.oid=c.relnamespace
     join pg_attribute a on a.attrelid=i.indrelid and a.attnum=any(i.indkey)
     where n.nspname=$1 and c.relname=$2 and i.indisprimary
     order by array_position(i.indkey, a.attnum)`, [schema, table]);
  const primaryKey = pkQ.rows.map(x => x.col);

  const uqQ = await pool.query(
    `select array_agg(a.attname order by array_position(i.indkey, a.attnum)) as cols
     from pg_index i join pg_class c on c.oid=i.indrelid
     join pg_namespace n on n.oid=c.relnamespace
     join pg_attribute a on a.attrelid=i.indrelid and a.attnum=any(i.indkey)
     where n.nspname=$1 and c.relname=$2 and i.indisunique and not i.indisprimary and i.indpred is null
     group by i.indexrelid order by count(*) asc limit 1`, [schema, table]);
  const uniqueKey = uqQ.rowCount ? uqQ.rows[0].cols : [];

  return {
    exists: true, columns, primaryKey, uniqueKey,
    dateColumns: columns.filter(c => DATE_TYPES.has(c.type)).map(c => ({ name: c.name, type: c.type }))
  };
}

/** สร้างเงื่อนไขช่วงวันที่ เริ่มที่ param index = startIdx */
function dateFilter(col, dateType, from, to, startIdx) {
  if (!col || !from || !to) return { sql: '', params: [] };
  const a = ph(startIdx), b = ph(startIdx + 1);
  if (dateType === 'date') {
    return { sql: `${quote(col)} >= ${a}::date AND ${quote(col)} <= ${b}::date`, params: [from, to] };
  }
  return { sql: `${quote(col)} >= ${a}::date AND ${quote(col)} < (${b}::date + interval '1 day')`, params: [from, to] };
}

/** INSERT ... ON CONFLICT DO NOTHING สำหรับ nRows แถว เริ่ม param ที่ 1 */
function buildInsertIgnore(schema, table, cols, nRows, opt) {
  const colList = cols.map(quote).join(', ');
  const over = (opt && opt.overriding) ? ' overriding system value' : '';
  let p = 1;
  const tuples = [];
  for (let r = 0; r < nRows; r++) {
    tuples.push('(' + cols.map(() => ph(p++)).join(', ') + ')');
  }
  return `insert into ${qname(schema, table)} (${colList})${over} values ${tuples.join(', ')} on conflict do nothing`;
}

/** INSERT ธรรมดา (ไม่มี on conflict) — ใช้สำหรับ "วินิจฉัย" หาสาเหตุที่แถวไม่ถูกโอน */
function buildInsertPlain(schema, table, cols, nRows, opt) {
  const colList = cols.map(quote).join(', ');
  const over = (opt && opt.overriding) ? ' overriding system value' : '';
  let p = 1;
  const tuples = [];
  for (let r = 0; r < nRows; r++) tuples.push('(' + cols.map(() => ph(p++)).join(', ') + ')');
  return `insert into ${qname(schema, table)} (${colList})${over} values ${tuples.join(', ')}`;
}

/** ลอง insert ใน transaction แล้ว ROLLBACK เสมอ — คืน { ok } หรือ { ok:false, error } */
async function diagnoseInsert(pool, sql, params) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query({ text: sql, values: params });
    await client.query('ROLLBACK');
    return { ok: true };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    return { ok: false, error: e };
  } finally {
    client.release();
  }
}

/** ปรับ sequence ให้ตามค่าสูงสุดของคีย์ (PostgreSQL เท่านั้น) */
async function syncSequences(pool, schema, table, keyColumns) {
  const fixed = [];
  for (const col of keyColumns) {
    try {
      const q = await pool.query('select pg_get_serial_sequence($1,$2) as seq', [schema + '.' + table, col]);
      const seq = q.rows[0] && q.rows[0].seq;
      if (!seq) continue;
      await pool.query(
        `select setval($1, coalesce((select max(${quote(col)}) from ${qname(schema, table)}),0)+1, false)`, [seq]);
      fixed.push(col + ' → ' + seq);
    } catch (e) { /* ข้าม */ }
  }
  return fixed;
}

module.exports = {
  name, label, defaultPort,
  quote, qname, ph,
  createPool, endPool, query,
  testConnection, listTables, describeTable,
  dateFilter, buildInsertIgnore, buildInsertPlain, diagnoseInsert, syncSequences
};
