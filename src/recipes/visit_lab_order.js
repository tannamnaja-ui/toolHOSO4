'use strict';
/* ============================================================
   สูตรเฉพาะ: lab_order (ผลตรวจแล็บรายรายการ)
   ต้นทาง: PostgreSQL (t_order + t_visit + t_result_lab + b_item*)
   ปลายทาง: HOSxP (lab_order) — PostgreSQL หรือ MySQL
   กรองตามวันที่สั่ง (order_date_time)
   ============================================================ */

function sourceSql(from, to) {
  const params = [];
  let dateFilter = 'true';
  if (from && to) {
    params.push(from, to);
    dateFilter = "t_order.order_date_time >= $1::date AND t_order.order_date_time < ($2::date + interval '1 day')";
  }

  const text = `
WITH lh AS (
    SELECT
        t_order.t_order_id,
        t_order.t_visit_id,
        t_visit.f_visit_type_id,
        t_visit.visit_vn,
        t_visit.visit_hn,
        t_visit.visit_begin_visit_time,
        t_order.order_verify_date_time,
        t_result_lab.record_date_time,
        t_result_lab.result_lab_value,
        t_result_lab.default_values,
        t_result_lab.result_lab_normal_flag,
        t_result_lab.user_record_id AS result_lab_staff_record,
        t_result_lab.result_lab_active,
        COALESCE(NULLIF(bilr.b_item_id, ''), NULLIF(t_result_lab.b_item_id, '')) AS lab_items_code,
        COALESCE(NULLIF(bilr.item_lab_result_name, ''), NULLIF(b1.item_common_name, '')) AS lab_items_name,
        CASE WHEN t_order.b_item_id = t_result_lab.b_item_id THEN NULL ELSE bils.b_item_lab_set_id END AS lab_items_sub_group_code,
        CASE WHEN t_result_lab.result_lab_value <> '' AND t_result_lab.result_lab_value IS NOT NULL THEN 'Y' ELSE 'N' END AS confirm_report
    FROM public.t_order AS t_order
    INNER JOIN public.t_visit AS t_visit
        ON t_visit.t_visit_id = t_order.t_visit_id
    INNER JOIN public.t_result_lab AS t_result_lab
        ON t_result_lab.t_order_id = t_order.t_order_id
        AND t_result_lab.t_visit_id = t_order.t_visit_id
    LEFT JOIN public.b_item AS b1
        ON b1.b_item_id = t_result_lab.b_item_id
    LEFT JOIN public.b_item_lab_result AS bilr
        ON bilr.b_item_lab_result_id = t_result_lab.b_item_lab_result_id
    LEFT JOIN public.b_item_lab_set AS bils
        ON bils.b_item_id = t_order.b_item_id
    WHERE ${dateFilter}
      AND t_order.f_order_status_id <> '3'
)
SELECT
    lh.t_order_id AS lab_order_number,
    lh.lab_items_code AS lab_items_code,
    lh.result_lab_value AS lab_order_result,
    lh.result_lab_staff_record AS staff,
    lh.confirm_report AS confirm,
    lh.lab_items_name AS lab_items_name_ref,
    lh.default_values AS lab_items_normal_value_ref,
    lh.lab_items_code AS specimen_code,
    lh.lab_items_sub_group_code AS lab_items_sub_group_code,
    'A' AS order_type,
    lh.t_order_id AS hos_guid,
    lh.order_verify_date_time::date AS laborder_date,
    CASE WHEN lh.result_lab_normal_flag IN ('L', 'H') THEN 'Y' ELSE NULL END AS abnormal_result,
    NULL AS check_key,
    CASE
        WHEN lh.result_lab_normal_flag IS NULL OR lh.result_lab_normal_flag = '' THEN '1'
        WHEN lh.result_lab_normal_flag = 'L' THEN '2'
        WHEN lh.result_lab_normal_flag = 'H' THEN '3'
        WHEN lh.result_lab_normal_flag = 'LL' THEN '4'
        WHEN lh.result_lab_normal_flag = 'HH' THEN '5'
        ELSE '1'
    END AS lab_result_status,
    TO_CHAR(lh.order_verify_date_time::timestamp, 'YYYY-MM-DD HH24:MI:SS') AS entry_datetime,
    TO_CHAR(lh.record_date_time::timestamp, 'YYYY-MM-DD HH24:MI:SS') AS update_datetime,
    CASE WHEN lh.result_lab_normal_flag IN ('LL', 'HH') THEN 'Y' ELSE NULL END AS critical_result,
    lh.result_lab_active AS hos_guid_ext,
    lh.visit_hn AS hn,
    CASE
        WHEN lh.f_visit_type_id = '1' THEN
            SUBSTRING(lh.visit_vn FROM 2 FOR 2) || LPAD(SUBSTRING(lh.visit_vn FROM 4), 7, '0')
        ELSE
            SUBSTRING(TO_CHAR(lh.visit_begin_visit_time::timestamp, 'YY') FROM 1 FOR 2) || LPAD(lh.visit_vn, 10, '0')
    END AS vn
FROM lh`;

  return { text, params };
}

module.exports = {
  group: 'visit',
  table: 'lab_order',
  label: 'ผลตรวจแล็บ (รายการ)',
  schema: 'public',
  dateColumn: 'laborder_date',
  targetDateColumn: 'laborder_date',
  // 1 order มีได้หลายรายการแล็บ -> คีย์ประกอบ (hos_guid=t_order_id, lab_items_code)
  // lab_items_code เป็นค่าหลัง lookup (lab_items.hos_guid -> lab_items_code) => keyAfterLookup
  targetKey: ['hos_guid', 'lab_items_code'],
  keyFields: ['hos_guid', 'lab_items_code'],
  keyAfterLookup: true,

  source: { engine: 'postgres', sql: sourceSql },

  lookups: {
    labHeadNo:    { table: 'lab_head',  match: 'hos_guid',            ret: 'lab_order_number' },
    labItemsCode: { table: 'lab_items', match: 'hos_guid',            ret: 'lab_items_code' },
    doctorCode:   { table: 'doctor',    match: 'oldcode',             ret: 'code' },
    officerLogin: { table: 'officer',   match: 'officer_doctor_code', ret: 'officer_login_name' }
  },

  columns: [
    { col: 'lab_order_number',          field: 'lab_order_number', lookup: 'labHeadNo' },     // t_order_id -> lab_head.hos_guid -> lab_order_number
    { col: 'lab_items_code',            field: 'lab_items_code', lookup: 'labItemsCode' },     // -> lab_items.hos_guid -> lab_items_code
    { col: 'lab_order_result',          field: 'lab_order_result' },
    { col: 'staff',                     field: 'staff', lookupChain: ['doctorCode', 'officerLogin'] },
    { col: 'confirm',                   field: 'confirm' },
    { col: 'lab_items_name_ref',        field: 'lab_items_name_ref' },
    { col: 'specimen_code',             field: 'specimen_code' },
    { col: 'lab_items_sub_group_code',  field: 'lab_items_sub_group_code' },
    { col: 'order_type',                field: 'order_type' },
    { col: 'hos_guid',                  field: 'hos_guid' },
    { col: 'laborder_date',             field: 'laborder_date' },
    { col: 'abnormal_result',           field: 'abnormal_result' },
    { col: 'check_key',                 field: 'check_key' },
    { col: 'lab_result_status',         field: 'lab_result_status' },
    { col: 'entry_datetime',            field: 'entry_datetime' },
    { col: 'update_datetime',           field: 'update_datetime' },
    { col: 'critical_result',           field: 'critical_result' },
    { col: 'hos_guid_ext',              field: 'hos_guid_ext' },
    { col: 'hn',                        field: 'hn' },
    { col: 'vn',                        field: 'vn' }
  ]
};
