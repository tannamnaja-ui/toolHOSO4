'use strict';
/* ============================================================
   สูตรเฉพาะ: visit_pttype (สิทธิการรักษาของแต่ละ visit)
   ต้นทาง: PostgreSQL (t_visit_payment ...)
   ปลายทาง: HOSxP (visit_pttype) — PostgreSQL หรือ MySQL
   ============================================================ */

/** คิวรี่ต้นทางตามช่วงวันที่ที่เลือก (from..to แบบ 'YYYY-MM-DD') — กรองตาม visit_payment_card_issue_date */
function sourceSql(from, to) {
  const params = [];
  let where = '';
  if (from && to) {
    params.push(from, to);
    where = 'WHERE vp.visit_payment_card_issue_date::date BETWEEN $1::date AND $2::date';
  }

  const text = `
SELECT
    (SUBSTRING(TO_CHAR(t.visit_begin_visit_time::timestamp, 'YY') FROM 1 FOR 2) ||
     LPAD(t.visit_vn, 10, '0'))              AS vn,
    vp.b_contract_plans_id                   AS pttype,
    vp.visit_payment_card_issue_date::date   AS begin_date,
    vp.visit_payment_card_expire_date::date  AS expire_date,
    vp.visit_payment_main_hospital           AS hospmain,
    vp.visit_payment_sub_hospital            AS hospsub,
    vp.visit_payment_card_number             AS pttypeno,
    vp.t_visit_payment_id                    AS hos_guid,
    bc.contract_description                  AS pttype_note
FROM public.t_visit_payment vp
INNER JOIN public.t_visit t
    ON t.t_visit_id = vp.t_visit_id
LEFT JOIN public.b_contract bc
    ON vp.b_contract_id = bc.b_contract_id
${where}`;

  return { text, params };
}

module.exports = {
  group: 'visit',
  table: 'visit_pttype',
  label: 'สิทธิการรักษาของ visit',
  schema: 'public',
  dateColumn: 'begin_date',
  targetDateColumn: 'begin_date',
  targetKey: ['hos_guid'],   // t_visit_payment_id — unique ต่อแถวสิทธิ
  keyField: 'hos_guid',

  source: { engine: 'postgres', sql: sourceSql },

  lookups: {
    pttypeCode: { table: 'pttype', match: 'hos_guid', ret: 'pttype' }
  },

  columns: [
    { col: 'vn',          field: 'vn' },
    { col: 'pttype',      field: 'pttype', lookup: 'pttypeCode' },
    { col: 'begin_date',  field: 'begin_date' },
    { col: 'expire_date', field: 'expire_date' },
    { col: 'hospmain',    field: 'hospmain' },
    { col: 'hospsub',     field: 'hospsub' },
    { col: 'pttypeno',    field: 'pttypeno' },
    { col: 'hos_guid',    field: 'hos_guid' },
    { col: 'pttype_note', field: 'pttype_note' }
  ]
};
