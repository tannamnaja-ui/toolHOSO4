'use strict';
/* ============================================================
   สูตรเฉพาะ: ovstdiag (การวินิจฉัยโรค OPD)
   ต้นทาง: PostgreSQL (t_diag_icd10 + t_visit)
   ปลายทาง: HOSxP (ovstdiag) — PostgreSQL หรือ MySQL
   ============================================================ */

/** คิวรี่ต้นทางตามช่วงวันที่ที่เลือก — กรองตามวันที่มารับบริการ (visit_begin_visit_time) */
function sourceSql(from, to) {
  const params = [];
  let where = '';
  if (from && to) {
    params.push(from, to);
    where = 'WHERE v.visit_begin_visit_time::date BETWEEN $1::date AND $2::date';
  }

  const text = `
SELECT
    ROW_NUMBER() OVER () AS ovst_diag_id,
    (TO_CHAR(v.visit_begin_visit_time::timestamp, 'YY') || LPAD(v.visit_vn, 10, '0')) AS vn,
    REPLACE(diag.diag_icd10_number, '.', '') AS icd10,
    v.visit_hn AS hn,
    v.visit_begin_visit_time::date AS vstdate,
    v.visit_begin_visit_time::time AS vsttime,
    diag.f_diag_icd10_type_id AS diagtype,
    diag.diag_icd10_staff_doctor AS doctor,
    diag.t_diag_icd10_id AS hos_guid,
    diag.diag_icd10_staff_doctor AS staff
FROM public.t_diag_icd10 diag
LEFT JOIN public.t_visit v
       ON diag.diag_icd10_vn = v.t_visit_id
${where}`;

  return { text, params };
}

module.exports = {
  group: 'visit',
  table: 'ovstdiag',
  label: 'การวินิจฉัยโรค OPD',
  schema: 'public',
  dateColumn: 'vstdate',
  targetDateColumn: 'vstdate',
  targetKey: ['vn', 'icd10'],   // คีย์ประกอบ vn + icd10
  keyFields: ['vn', 'icd10'],

  source: { engine: 'postgres', sql: sourceSql },

  lookups: {
    doctorCode:   { table: 'doctor',  match: 'oldcode',             ret: 'code' },
    officerLogin: { table: 'officer', match: 'officer_doctor_code', ret: 'officer_login_name' }
  },

  columns: [
    { col: 'ovst_diag_id', seqFromMax: true },   // รันเลขต่อจาก MAX(ovst_diag_id) ในตารางปลายทาง
    { col: 'vn',           field: 'vn' },
    { col: 'icd10',        field: 'icd10' },
    { col: 'hn',           field: 'hn' },
    { col: 'vstdate',      field: 'vstdate' },
    { col: 'vsttime',      field: 'vsttime' },
    { col: 'diagtype',     field: 'diagtype' },
    { col: 'doctor',       field: 'doctor', lookup: 'doctorCode' },
    { col: 'hos_guid',     field: 'hos_guid' },
    // staff: doctor.oldcode -> doctor.code -> officer.officer_doctor_code -> officer.officer_login_name
    { col: 'staff',        field: 'staff',  lookupChain: ['doctorCode', 'officerLogin'] }
  ]
};
