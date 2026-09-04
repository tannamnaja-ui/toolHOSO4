'use strict';
/* ============================================================
   สูตรเฉพาะ: lab_head (ใบสั่งตรวจแล็บ - ส่วนหัว)
   ต้นทาง: PostgreSQL (t_order + t_visit + t_result_lab + b_item)
   ปลายทาง: HOSxP (lab_head) — PostgreSQL หรือ MySQL
   กรองตามวันที่สั่ง (order_date_time)
   ============================================================ */

function sourceSql(from, to) {
  const params = [];
  let dateFilter = 'true';
  if (from && to) {
    params.push(from, to);
    // sargable: ใช้ index บน order_date_time (แทน >= .. <= end-of-day)
    dateFilter = "t_order.order_date_time >= $1::date AND t_order.order_date_time < ($2::date + interval '1 day')";
  }

  const text = `
WITH base_query AS (
    SELECT
        t_order.t_visit_id,
        min(t_order.order_verify_date_time) AS order_verify_date_time,
        t_order.t_order_id,
        b_item.f_item_lab_type_id,
        t_visit.f_visit_type_id,
        t_visit.visit_vn,
        t_visit.visit_hn,
        t_visit.visit_begin_visit_time,
        (SELECT lab_number FROM public.t_lis_order WHERE t_order_id = t_order.t_order_id LIMIT 1) AS lab_order_number,
        min(t_order.order_staff_order) AS staff_order,
        min(t_order.order_service_point) AS order_service_point,
        max(t_result_lab.record_date_time) AS record_date_time,
        min(t_result_lab.user_record_id) AS result_lab_staff_record,
        CASE
            WHEN sum(CASE WHEN t_result_lab.result_lab_value <> '' OR t_result_lab.result_lab_value IS NOT NULL THEN 1 ELSE 0 END) = 0
            THEN 'N'
            ELSE 'Y'
        END AS confirm_report
    FROM public.t_order AS t_order
    INNER JOIN public.t_visit AS t_visit
        ON t_visit.t_visit_id = t_order.t_visit_id
    LEFT JOIN public.t_result_lab AS t_result_lab
        ON t_result_lab.t_order_id = t_order.t_order_id
        AND t_result_lab.t_visit_id = t_order.t_visit_id
    LEFT JOIN public.b_item AS b_item
        ON b_item.b_item_id = t_order.b_item_id
    WHERE ${dateFilter}
      AND t_order.b_item_subgroup_id IN (
          SELECT b_item_subgroup_id
          FROM public.b_item_subgroup
          WHERE f_item_group_id = '2'
      )
      AND t_order.f_order_status_id <> '3'
    GROUP BY
        t_order.t_visit_id,
        t_order.t_order_id,
        b_item.f_item_lab_type_id,
        t_visit.f_visit_type_id,
        t_visit.visit_vn,
        t_visit.visit_hn,
        t_visit.visit_begin_visit_time
)
SELECT
    ROW_NUMBER() OVER (ORDER BY order_verify_date_time, t_order_id) AS lab_order_number,
    staff_order AS doctor_code,
    f_item_lab_type_id AS lab_items_group_code,
    CASE
        WHEN f_visit_type_id = '1' THEN
            SUBSTRING(visit_vn FROM 2 FOR 2) || LPAD(SUBSTRING(visit_vn FROM 4), 7, '0')
        ELSE
            SUBSTRING(TO_CHAR(visit_begin_visit_time::timestamp, 'YY') FROM 1 FOR 2) || LPAD(visit_vn, 10, '0')
    END AS vn,
    visit_hn AS hn,
    order_verify_date_time::date AS order_date,
    record_date_time::date AS report_date,
    result_lab_staff_record AS reporter_name,
    TO_CHAR(record_date_time::timestamp, 'HH24:MI:SS') AS report_time,
    'Y' AS confirm_specimen,
    confirm_report AS confirm_report,
    order_service_point AS department,
    'Old Lab' AS form_name,
    TO_CHAR(order_verify_date_time::timestamp, 'HH24:MI:SS') AS order_time,
    order_verify_date_time::date AS receive_date,
    TO_CHAR(order_verify_date_time::timestamp, 'HH24:MI:SS') AS receive_time,
    CASE WHEN f_visit_type_id = '0' THEN NULL ELSE t_visit_id END AS ward,
    result_lab_staff_record AS approve_staff,
    lab_order_number AS lab_order_number_guid,
    t_order_id AS hos_guid,
    order_service_point AS order_department,
    CASE
        WHEN confirm_report = 'Y' THEN '2'
        WHEN confirm_report = 'N' THEN '1'
        ELSE NULL
    END AS lab_perform_status_id,
    '1' AS hospital_department_id,
    staff_order AS order_staff,
    'Y' AS lab_receive,
    result_lab_staff_record AS receive_staff,
    TO_CHAR(order_verify_date_time::timestamp, 'YYYY-MM-DD HH24:MI:SS') AS entry_datetime,
    TO_CHAR(order_verify_date_time::timestamp, 'YYYY-MM-DD HH24:MI:SS') AS update_datetime
FROM base_query`;

  return { text, params };
}

module.exports = {
  group: 'visit',
  table: 'lab_head',
  label: 'ใบสั่งตรวจแล็บ (หัว)',
  schema: 'public',
  dateColumn: 'order_date',
  targetDateColumn: 'order_date',
  targetKey: ['hos_guid'],   // t_order_id — unique ต่อใบสั่ง
  keyField: 'hos_guid',

  source: { engine: 'postgres', sql: sourceSql },

  lookups: {
    doctorCode:   { table: 'doctor',        match: 'oldcode',             ret: 'code' },
    officerLogin: { table: 'officer',       match: 'officer_doctor_code', ret: 'officer_login_name' },
    depCode:      { table: 'kskdepartment', match: 'oldcode',             ret: 'depcode' },
    wardCode:     { table: 'ward',          match: 'hos_guid',            ret: 'ward' }
  },

  columns: [
    { col: 'lab_order_number',      seqFromMax: true },   // รันเลขต่อจาก MAX
    { col: 'doctor_code',           field: 'doctor_code', lookup: 'doctorCode' },
    { col: 'lab_items_group_code',  field: 'lab_items_group_code' },
    { col: 'vn',                    field: 'vn' },
    { col: 'hn',                    field: 'hn' },
    { col: 'order_date',            field: 'order_date' },
    { col: 'report_date',           field: 'report_date' },
    { col: 'reporter_name',         field: 'reporter_name' },
    { col: 'report_time',           field: 'report_time' },
    { col: 'confirm_specimen',      field: 'confirm_specimen' },
    { col: 'confirm_report',        field: 'confirm_report' },
    { col: 'department',            field: 'department', lookup: 'depCode' },
    { col: 'form_name',             field: 'form_name' },
    { col: 'order_time',            field: 'order_time' },
    { col: 'receive_date',          field: 'receive_date' },
    { col: 'receive_time',          field: 'receive_time' },
    { col: 'ward',                  field: 'ward', lookup: 'wardCode' },
    { col: 'approve_staff',         field: 'approve_staff', lookupChain: ['doctorCode', 'officerLogin'] },
    { col: 'lab_order_number_guid', field: 'lab_order_number_guid' },
    { col: 'hos_guid',              field: 'hos_guid' },
    { col: 'order_department',      field: 'order_department', lookup: 'depCode' },
    { col: 'lab_perform_status_id', field: 'lab_perform_status_id' },
    { col: 'hospital_department_id', field: 'hospital_department_id' },
    { col: 'order_staff',           field: 'order_staff', lookupChain: ['doctorCode', 'officerLogin'] },
    { col: 'lab_receive',           field: 'lab_receive' },
    { col: 'receive_staff',         field: 'receive_staff', lookupChain: ['doctorCode', 'officerLogin'] },
    { col: 'entry_datetime',        field: 'entry_datetime' },
    { col: 'update_datetime',       field: 'update_datetime' }
  ]
};
