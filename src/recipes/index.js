'use strict';
/* ============================================================
   ทะเบียนสูตรเฉพาะตาราง (recipe registry)
   key = "<group>:<table>"
   ============================================================ */
const registry = {};

function register(recipe) {
  registry[recipe.group + ':' + recipe.table] = recipe;
}

register(require('./visit_ovst'));
register(require('./visit_visit_pttype'));
register(require('./visit_ovstdiag'));
register(require('./visit_opdscreen'));
register(require('./visit_opdscreen_cc_list'));
register(require('./visit_oapp'));
register(require('./visit_ipt'));
register(require('./visit_drugusage'));
register(require('./visit_ipt_order_no'));
register(require('./visit_opitemrece'));
register(require('./visit_patient_history_hpi'));
register(require('./visit_ipt_pttype'));
register(require('./visit_iptdiag'));
register(require('./visit_rcpt_debt'));
register(require('./visit_rcpt_print'));
register(require('./visit_lab_head'));
register(require('./master_patient'));

function getRecipe(group, table) {
  return registry[group + ':' + table] || null;
}

/** รายชื่อ recipe ทั้งหมด (ไว้แสดง/ตรวจสอบ) */
function listRecipes() {
  return Object.values(registry).map(r => ({
    group: r.group, table: r.table, label: r.label,
    keyColumns: r.targetKey, dateColumn: r.dateColumn || '',
    rangeType: r.rangeType || 'date',
    columns: r.columns.length, lookups: Object.keys(r.lookups || {}).length
  }));
}

module.exports = { getRecipe, listRecipes, registry };
