'use strict';
/* ============================================================
   สูตรเฉพาะ: patient_history_hpi (ประวัติการเจ็บป่วยปัจจุบัน HPI)
   ต้นทาง: PostgreSQL (t_visit_primary_symptom + t_visit + ...)
   ปลายทาง: HOSxP (patient_history_hpi) — PostgreSQL หรือ MySQL
   ============================================================ */

function sourceSql(from, to) {
  const params = [];
  let dateFilter = 'true';
  if (from && to) {
    params.push(from, to);
    // sargable: ใช้ index บน visit_begin_visit_time
    dateFilter = "public.t_visit.visit_begin_visit_time >= $1::date AND public.t_visit.visit_begin_visit_time < ($2::date + interval '1 day')";
  }

  const text = `
SELECT
    ROW_NUMBER() OVER () AS patient_history_hpi_id,
    v.visit_hn AS hn,
    ps.record_date_time::date AS entry_date,
    ps.record_date_time::time AS entry_time,
    diag.diag_icd10_staff_doctor AS doctor_code,
    (TO_CHAR(v.visit_begin_visit_time::timestamp, 'YY') || LPAD(v.visit_vn, 10, '0')) AS vn,
    REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
        ps.visit_primary_symptom_current_illness,
        chr(39), ' '),
        chr(34), ' '),
        chr(38), ' and '),
        chr(60), 'น้อยกว่า'),
        chr(62), 'มากกว่า') AS hpi_text,
    q_map.b_visit_queue_setup_id AS depcode
FROM public.t_visit_primary_symptom ps
LEFT JOIN public.t_visit v
       ON ps.t_visit_id = v.t_visit_id
LEFT JOIN LATERAL (
    SELECT d.diag_icd10_staff_doctor
    FROM public.t_diag_icd10 d
    WHERE d.diag_icd10_vn = v.t_visit_id
      AND d.f_diag_icd10_type_id = '1'
    ORDER BY d.t_diag_icd10_id DESC
    LIMIT 1
) diag ON true
LEFT JOIN LATERAL (
    SELECT qm.visit_queue_map_queue, qm.b_visit_queue_setup_id
    FROM public.t_visit_queue_map qm
    WHERE qm.t_visit_id = v.t_visit_id
      AND qm.visit_queue_map_active = '1'
    ORDER BY qm.t_visit_queue_map_id DESC
    LIMIT 1
) q_map ON true
WHERE ps.t_visit_id IN (
    SELECT public.t_visit.t_visit_id
    FROM public.t_visit
    WHERE ${dateFilter}
)`;

  return { text, params };
}

module.exports = {
  group: 'visit',
  table: 'patient_history_hpi',
  label: 'ประวัติการเจ็บป่วยปัจจุบัน (HPI)',
  schema: 'public',
  dateColumn: 'entry_date',
  targetDateColumn: 'entry_date',
  targetKey: ['vn'],   // 1 HPI ต่อ visit (คิวรี่ไม่มี hos_guid — ใช้ vn เป็นคีย์เช็กซ้ำ)
  keyField: 'vn',

  source: { engine: 'postgres', sql: sourceSql },

  lookups: {
    doctorCode: { table: 'doctor',        match: 'oldcode', ret: 'code' },
    depCode:    { table: 'kskdepartment', match: 'oldcode', ret: 'depcode' }
  },

  columns: [
    { col: 'patient_history_hpi_id', seqFromMax: true },   // รันเลขต่อจาก MAX
    { col: 'entry_date',  field: 'entry_date' },
    { col: 'entry_time',  field: 'entry_time' },
    { col: 'doctor_code', field: 'doctor_code', lookup: 'doctorCode' },
    { col: 'vn',          field: 'vn' },
    { col: 'hpi_text',    field: 'hpi_text' },
    { col: 'depcode',     field: 'depcode', lookup: 'depCode' }
  ]
};
