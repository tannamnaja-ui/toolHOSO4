'use strict';
/* ============================================================
   สูตรเฉพาะ: ipt_pttype (สิทธิการรักษา IPD)
   ต้นทาง: PostgreSQL (t_visit_payment + t_visit + b_contract)
   ปลายทาง: HOSxP (ipt_pttype) — PostgreSQL หรือ MySQL
   กรองตามวันรับ admit (visit_begin_admit_date_time)
   ============================================================ */

function sourceSql(from, to) {
  const params = [];
  let dateFilter = "t_visit_sub.f_visit_type_id = '1'";
  if (from && to) {
    params.push(from, to);
    // sargable: ใช้ index บน visit_begin_admit_date_time
    dateFilter = "t_visit_sub.visit_begin_admit_date_time >= $1::date AND t_visit_sub.visit_begin_admit_date_time < ($2::date + interval '1 day')\n" +
      "          AND t_visit_sub.f_visit_type_id = '1'";
  }

  const text = `
SELECT
    ROW_NUMBER() OVER (ORDER BY t_visit_payment.t_visit_id, t_visit_payment.visit_payment_priority) AS ipt_pttype_id,
    CASE
        WHEN t_visit.f_visit_type_id = '1' THEN
            SUBSTRING(t_visit.visit_vn FROM 2 FOR 2)
            || LPAD(SUBSTRING(t_visit.visit_vn FROM 4), 7, '0')
        ELSE NULL
    END AS an,
    t_visit_payment.b_contract_plans_id AS pttype,
    t_visit_payment.visit_payment_card_number AS pttypeno,
    t_visit_payment.visit_payment_main_hospital AS hospmain,
    t_visit_payment.visit_payment_sub_hospital AS hospsub,
    CASE
        WHEN NULLIF(TRIM(t_visit_payment.visit_payment_card_issue_date::text), '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
        THEN t_visit_payment.visit_payment_card_issue_date::date
        ELSE NULL
    END AS begindate,
    CASE
        WHEN NULLIF(TRIM(t_visit_payment.visit_payment_card_expire_date::text), '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
        THEN t_visit_payment.visit_payment_card_expire_date::date
        ELSE NULL
    END AS expiredate,
    t_visit_payment.t_visit_payment_id AS hos_guid,
    b_contract.contract_description AS pttype_note,
    CASE
        WHEN NULLIF(TRIM(t_visit_payment.visit_payment_priority::text), '') ~ '^[0-9]+$'
        THEN CAST(TRIM(t_visit_payment.visit_payment_priority::text) AS INTEGER) + 1
        ELSE 1
    END AS pttype_number,
    (TO_CHAR(t_visit.visit_begin_visit_time::timestamp, 'YY') || LPAD(t_visit.visit_vn, 10, '0')) AS vn,
    t_visit.visit_hn AS hn
FROM public.t_visit_payment
INNER JOIN public.t_visit
    ON t_visit.t_visit_id = t_visit_payment.t_visit_id
LEFT JOIN public.b_contract
    ON b_contract.b_contract_id = t_visit_payment.b_contract_id
WHERE
    t_visit_payment.t_visit_id IN (
        SELECT t_visit_sub.t_visit_id
        FROM public.t_visit t_visit_sub
        WHERE ${dateFilter}
    )
    AND t_visit_payment.visit_payment_active = '1'
ORDER BY
    t_visit_payment.t_visit_id,
    pttype_number ASC`;

  return { text, params };
}

module.exports = {
  group: 'visit',
  table: 'ipt_pttype',
  label: 'สิทธิการรักษา IPD',
  schema: 'public',
  dateColumn: 'begindate',
  targetKey: ['hos_guid'],   // t_visit_payment_id — unique ต่อรายการสิทธิ
  keyField: 'hos_guid',

  source: { engine: 'postgres', sql: sourceSql },

  lookups: {
    pttypeCode: { table: 'pttype', match: 'hos_guid', ret: 'pttype' }
  },

  columns: [
    { col: 'ipt_pttype_id', seqFromMax: true },   // รันเลขต่อจาก MAX
    { col: 'an',            field: 'an' },
    { col: 'pttype',        field: 'pttype', lookup: 'pttypeCode' },
    { col: 'pttypeno',      field: 'pttypeno' },
    { col: 'hospmain',      field: 'hospmain' },
    { col: 'hospsub',       field: 'hospsub' },
    { col: 'begin_date',    field: 'begindate' },    // คอลัมน์ปลายทาง = begin_date
    { col: 'expire_date',   field: 'expiredate' },   // คอลัมน์ปลายทาง = expire_date (ตามรูปแบบ underscore)
    { col: 'hos_guid',      field: 'hos_guid' },
    { col: 'pttype_note',   field: 'pttype_note' },
    { col: 'pttype_number', field: 'pttype_number', numeric: true },
    { col: 'hn',            field: 'hn' }
  ]
};
