'use strict';
/* ============================================================
   สูตรเฉพาะ: opdscreen_cc_list (อาการสำคัญ CC รายการ)
   ต้นทาง: PostgreSQL (t_visit_primary_symptom + t_visit + t_diag_icd10)
   ปลายทาง: HOSxP (opdscreen_cc_list) — PostgreSQL หรือ MySQL
   ============================================================ */

function sourceSql(from, to) {
  const params = [];
  let dateFilter = 'true';
  if (from && to) {
    params.push(from, to);
    // sargable: ใช้ index บน visit_begin_visit_time
    dateFilter = "t.visit_begin_visit_time >= $1::date AND t.visit_begin_visit_time < ($2::date + interval '1 day')";
  }

  const text = `
SELECT
    ROW_NUMBER() OVER () AS opdscreen_cc_list_id,
    (TO_CHAR(v.visit_begin_visit_time::timestamp, 'YY') || LPAD(v.visit_vn, 10, '0')) AS vn,
    ps.visit_primary_symptom_main_symptom AS cc,
    ps.user_record_id AS staff,
    ps.record_date_time::timestamp AS update_datetime,
    diag.diag_icd10_staff_doctor AS doctor_code,
    ps.record_date_time::timestamp AS entry_datetime,
    ps.t_visit_primary_symptom_id AS hos_guid
FROM public.t_visit_primary_symptom ps
LEFT JOIN public.t_visit v
       ON ps.t_visit_id = v.t_visit_id
LEFT JOIN LATERAL (
    SELECT d.diag_icd10_staff_doctor
    FROM t_diag_icd10 d
    WHERE d.diag_icd10_vn = v.t_visit_id
      AND d.f_diag_icd10_type_id = '1'
    ORDER BY d.t_diag_icd10_id DESC
    LIMIT 1
) diag ON true
WHERE ps.t_visit_id IN (
    SELECT t.t_visit_id
    FROM public.t_visit t
    WHERE ${dateFilter}
)`;

  return { text, params };
}

module.exports = {
  group: 'visit',
  table: 'opdscreen_cc_list',
  label: 'อาการสำคัญ (CC) รายการ',
  schema: 'public',
  dateColumn: 'update_datetime',
  targetKey: ['hos_guid'],   // t_visit_primary_symptom_id — unique ต่อรายการ
  keyField: 'hos_guid',

  source: { engine: 'postgres', sql: sourceSql },

  lookups: {
    doctorCode:   { table: 'doctor',  match: 'oldcode',             ret: 'code' },
    officerLogin: { table: 'officer', match: 'officer_doctor_code', ret: 'officer_login_name' }
  },

  columns: [
    { col: 'opdscreen_cc_list_id', seqFromMax: true },   // รันเลขต่อจาก MAX ในปลายทาง
    { col: 'vn',              field: 'vn' },
    { col: 'cc',              field: 'cc' },
    // staff: doctor.oldcode -> code -> officer.officer_doctor_code -> officer_login_name
    { col: 'staff',           field: 'staff', lookupChain: ['doctorCode', 'officerLogin'] },
    { col: 'update_datetime', field: 'update_datetime' },
    { col: 'doctor_code',     field: 'doctor_code', lookup: 'doctorCode' },
    { col: 'entry_datetime',  field: 'entry_datetime' },
    { col: 'hos_guid',        field: 'hos_guid' }
  ]
};
