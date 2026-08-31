'use strict';
/* ============================================================
   Engine: MySQL / MariaDB
   interface เดียวกับ postgres.js
   หมายเหตุ: MySQL ใช้ "database" เป็น schema — ถ้า schema = 'public'
   หรือว่าง จะหมายถึงฐานข้อมูลปัจจุบันของ connection
   ============================================================ */
const mysql = require('mysql2/promise');

const name = 'mysql';
const label = 'MySQL / MariaDB';
const defaultPort = 3306;

function quote(id) {
  return '`' + String(id).replace(/`/g, '``') + '`';
}
/** schema ที่ใช้จริง: 'public'/ว่าง = ใช้ current database */
function realSchema(schema) {
  return (schema && schema !== 'public') ? schema : null;
}
function qname(schema, table) {
  const s = realSchema(schema);
  return s ? quote(s) + '.' + quote(table) : quote(table);
}
/** MySQL ใช้ ? ทุกตำแหน่ง (ลำดับใน params สำคัญ) */
function ph() { return '?'; }

function poolConfig(cfg, max) {
  return {
    host: cfg.host,
    port: Number(cfg.port) || defaultPort,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
    connectionLimit: max || 6,
    waitForConnections: true,
    connectTimeout: 15000,
    dateStrings: false,
    supportBigNumbers: true,
    bigNumberStrings: true,   // BIGINT เป็น string กันค่าเพี้ยน (สอดคล้องกับ pg)
    decimalNumbers: false,    // DECIMAL เป็น string
    namedPlaceholders: false
  };
}

function createPool(cfg, max) {
  return mysql.createPool(poolConfig(cfg, max));
}
function endPool(pool) { return pool.end(); }

/** query แบบรวม: คืน { rows, rowCount } เสมอ */
async function query(pool, sql, params, opts) {
  const [res] = await pool.query({ sql, values: params || [], rowsAsArray: !!(opts && opts.array) });
  if (Array.isArray(res)) return { rows: res, rowCount: res.length };
  // INSERT/UPDATE → ResultSetHeader
  return { rows: [], rowCount: (res && res.affectedRows) || 0 };
}

async function testConnection(cfg) {
  const pool = createPool(cfg, 1);
  const started = Date.now();
  try {
    const [[info]] = await pool.query(
      'select version() as version, database() as db, current_user() as usr, now() as server_time');
    const [[sz]] = await pool.query(
      `select coalesce(sum(data_length+index_length),0) as bytes, count(*) as n
       from information_schema.tables where table_schema = database()`);
    return {
      ok: true, engine: name, elapsedMs: Date.now() - started,
      version: 'MySQL ' + info.version,
      database: info.db, user: info.usr, size: prettyBytes(Number(sz.bytes)),
      serverTime: info.server_time, tableCount: Number(sz.n)
    };
  } finally { pool.end().catch(() => {}); }
}

function prettyBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'kB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
}

async function listTables(pool) {
  const [rows] = await pool.query(
    `select table_name, table_schema, coalesce(table_rows,0) as approx_rows
     from information_schema.tables
     where table_schema = database() and table_type='BASE TABLE'
     order by table_name`);
  return rows.map(x => ({
    schema: x.table_schema || x.TABLE_SCHEMA,
    table: x.table_name || x.TABLE_NAME,
    approxRows: Number(x.approx_rows || x.APPROX_ROWS || 0)
  }));
}

const DATE_TYPES = new Set(['date', 'datetime', 'timestamp', 'time', 'year']);

async function describeTable(pool, schema, table) {
  const s = realSchema(schema);
  const [[ex]] = await pool.query(
    `select count(*) as n from information_schema.tables
     where table_schema = coalesce(?, database()) and table_name = ?`, [s, table]);
  if (!Number(ex.n)) return { exists: false, columns: [], primaryKey: [], uniqueKey: [], dateColumns: [] };

  const [colRows] = await pool.query(
    `select column_name, data_type, column_type, is_nullable, extra, column_key
     from information_schema.columns
     where table_schema = coalesce(?, database()) and table_name = ?
     order by ordinal_position`, [s, table]);
  const columns = colRows.map(x => {
    const extra = String(x.extra || x.EXTRA || '').toLowerCase();
    return {
      name: x.column_name || x.COLUMN_NAME,
      type: x.data_type || x.DATA_TYPE,
      udt: x.column_type || x.COLUMN_TYPE,
      nullable: (x.is_nullable || x.IS_NULLABLE) === 'YES',
      identity: extra.includes('auto_increment') ? 'BY DEFAULT' : null,
      generated: extra.includes('generated')
    };
  });

  const [pkRows] = await pool.query(
    `select column_name from information_schema.key_column_usage
     where table_schema = coalesce(?, database()) and table_name = ? and constraint_name = 'PRIMARY'
     order by ordinal_position`, [s, table]);
  const primaryKey = pkRows.map(x => x.column_name || x.COLUMN_NAME);

  // unique index ตัวแรก (ที่ไม่ใช่ PRIMARY) เรียงตามจำนวนคอลัมน์น้อยสุด
  const [uqRows] = await pool.query(
    `select index_name, column_name, seq_in_index
     from information_schema.statistics
     where table_schema = coalesce(?, database()) and table_name = ? and non_unique = 0 and index_name <> 'PRIMARY'
     order by index_name, seq_in_index`, [s, table]);
  let uniqueKey = [];
  if (uqRows.length) {
    const byIdx = new Map();
    uqRows.forEach(r => {
      const k = r.index_name || r.INDEX_NAME;
      if (!byIdx.has(k)) byIdx.set(k, []);
      byIdx.get(k).push(r.column_name || r.COLUMN_NAME);
    });
    uniqueKey = [...byIdx.values()].sort((a, b) => a.length - b.length)[0] || [];
  }

  return {
    exists: true, columns, primaryKey, uniqueKey,
    dateColumns: columns.filter(c => DATE_TYPES.has(c.type)).map(c => ({ name: c.name, type: c.type }))
  };
}

function dateFilter(col, dateType, from, to, startIdx) {
  if (!col || !from || !to) return { sql: '', params: [] };
  if (dateType === 'date') {
    return { sql: `${quote(col)} >= ? AND ${quote(col)} <= ?`, params: [from, to] };
  }
  return { sql: `${quote(col)} >= ? AND ${quote(col)} < date_add(?, interval 1 day)`, params: [from, to] };
}

/** INSERT IGNORE สำหรับ nRows แถว */
function buildInsertIgnore(schema, table, cols, nRows /*, opt */) {
  const colList = cols.map(quote).join(', ');
  const one = '(' + cols.map(() => '?').join(', ') + ')';
  const tuples = new Array(nRows).fill(one).join(', ');
  return `insert ignore into ${qname(schema, table)} (${colList}) values ${tuples}`;
}

/** INSERT ธรรมดา (ไม่มี ignore) — ใช้สำหรับ "วินิจฉัย" หาสาเหตุที่แถวไม่ถูกโอน */
function buildInsertPlain(schema, table, cols, nRows /*, opt */) {
  const colList = cols.map(quote).join(', ');
  const one = '(' + cols.map(() => '?').join(', ') + ')';
  return `insert into ${qname(schema, table)} (${colList}) values ${new Array(nRows).fill(one).join(', ')}`;
}

/** ลอง insert ใน transaction แล้ว rollback เสมอ — คืน { ok } หรือ { ok:false, error } */
async function diagnoseInsert(pool, sql, params) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query({ sql, values: params });
    await conn.rollback();
    return { ok: true };
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    return { ok: false, error: e };
  } finally {
    conn.release();
  }
}

/** MySQL จัดการ auto_increment เองเมื่อ insert ค่า id ตรง ๆ — ไม่ต้องปรับ */
async function syncSequences() { return []; }

module.exports = {
  name, label, defaultPort,
  quote, qname, ph, realSchema,
  createPool, endPool, query,
  testConnection, listTables, describeTable,
  dateFilter, buildInsertIgnore, buildInsertPlain, diagnoseInsert, syncSequences
};
