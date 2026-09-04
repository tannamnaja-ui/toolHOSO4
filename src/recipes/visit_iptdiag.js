'use strict';
/* ============================================================
   สูตรเฉพาะ: iptdiag (การวินิจฉัยโรค IPD)
   ต้นทาง: PostgreSQL (t_diag_icd10 + t_visit)
   ปลายทาง: HOSxP (iptdiag) — PostgreSQL หรือ MySQL
   กรองตามวันรับ admit (visit_begin_admit_date_time)
   ============================================================ */

function sourceSql(from, to) {
  const params = [];
  let dateFilter = "t_visit_sub.f_visit_type_id = '1'";
  if (from && to) {
    params.push(from, to);
    dateFilter = "t_visit_sub.visit_begin_admit_date_time >= $1::date AND t_visit_sub.visit_begin_admit_date_time < ($2::date + interval '1 day')\n" +
      "          AND t_visit_sub.f_visit_type_id = '1'";
  }

  const text = `
SELECT
    ROW_NUMBER() OVER (
        ORDER BY t_diag_icd10.diag_icd10_vn, t_diag_icd10.f_diag_icd10_type_id, t_diag_icd10.t_diag_icd10_id
    ) AS ipt_diag_id,
    CASE
        WHEN t_visit.f_visit_type_id = '1' THEN
            SUBSTRING(t_visit.visit_vn FROM 2 FOR 2)
            || LPAD(SUBSTRING(t_visit.visit_vn FROM 4), 7, '0')
        ELSE NULL
    END AS an,
    t_diag_icd10.f_diag_icd10_type_id AS diagtype,
    t_diag_icd10.diag_icd10_staff_doctor AS doctor,
    CASE
        WHEN t_diag_icd10.diag_icd10_active = '1' THEN REPLACE(TRIM(t_diag_icd10.diag_icd10_number), '.', '')
        ELSE NULL
    END AS icd10,
    t_diag_icd10.t_diag_icd10_id AS hos_guid,
    t_diag_icd10.diag_icd10_staff_doctor AS staff,
    t_visit.visit_hn AS hn,
    (TO_CHAR(t_visit.visit_begin_visit_time::timestamp, 'YY') || LPAD(t_visit.visit_vn, 10, '0')) AS vn
FROM public.t_diag_icd10
INNER JOIN public.t_visit
    ON t_visit.t_visit_id = t_diag_icd10.diag_icd10_vn
WHERE
    t_diag_icd10.diag_icd10_vn IN (
        SELECT t_visit_sub.t_visit_id
        FROM public.t_visit t_visit_sub
        WHERE ${dateFilter}
    )
    AND t_diag_icd10.diag_icd10_active = '1'
ORDER BY
    t_diag_icd10.diag_icd10_vn,
    t_diag_icd10.f_diag_icd10_type_id ASC`;

  return { text, params };
}

module.exports = {
  group: 'visit',
  table: 'iptdiag',
  label: 'การวินิจฉัยโรค IPD',
  schema: 'public',
  dateColumn: '',
  targetKey: ['hos_guid'],   // t_diag_icd10_id — unique ต่อรายการวินิจฉัย
  keyField: 'hos_guid',

  source: { engine: 'postgres', sql: sourceSql },

  lookups: {
    doctorCode:   { table: 'doctor',  match: 'oldcode',             ret: 'code' },
    officerLogin: { table: 'officer', match: 'officer_doctor_code', ret: 'officer_login_name' }
  },

  columns: [
    { col: 'ipt_diag_id', seqFromMax: true },   // รันเลขต่อจาก MAX
    { col: 'an',          field: 'an' },
    { col: 'diagtype',    field: 'diagtype' },
    { col: 'doctor',      field: 'doctor', lookup: 'doctorCode' },
    { col: 'icd10',       field: 'icd10' },
    { col: 'hos_guid',    field: 'hos_guid' },
    // staff: doctor.oldcode -> code -> officer.officer_doctor_code -> officer_login_name
    { col: 'staff',       field: 'staff', lookupChain: ['doctorCode', 'officerLogin'] },
    { col: 'hn',          field: 'hn' }
  ]
};
