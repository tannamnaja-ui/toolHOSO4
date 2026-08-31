'use strict';
/* ============================================================
   สูตรเฉพาะ: ovst (ข้อมูลการมารับบริการ OPD)
   ต้นทาง: PostgreSQL (โครงสร้างใหม่ t_visit ...)
   ปลายทาง: HOSxP (ovst) — PostgreSQL หรือ MySQL
   ============================================================ */

/** คิวรี่ต้นทางตามช่วงวันที่ที่เลือก (from..to แบบ 'YYYY-MM-DD') */
function sourceSql(from, to) {
  // เงื่อนไขวันที่: ถ้ามี from/to ใช้ช่วง [from 00:00:00, to+1day) ; ถ้าไม่มี ดึงทั้งหมด (เฉพาะที่ status<>4)
  const params = [];
  let dateWhere = "t.f_visit_status_id <> '4'";
  if (from && to) {
    params.push(from, to);
    dateWhere =
      "t.visit_begin_visit_time >= $1::timestamp\n" +
      "      AND t.visit_begin_visit_time < ($2::date + interval '1 day')\n" +
      "      AND t.f_visit_status_id <> '4'";
  }

  const text = `
WITH filtered_visit AS (
    SELECT
        t.t_visit_id,
        t.visit_vn,
        t.visit_hn,
        t.f_visit_type_id,
        t.visit_begin_visit_time,
        t.visit_dx,
        t.b_visit_office_id_refer_in,
        t.b_visit_office_id_refer_out,
        t.user_record_id,
        t.f_visit_opd_discharge_status_id,
        t.f_visit_service_type_id,
        t.visit_guid
    FROM t_visit t
    WHERE ${dateWhere}
)
SELECT
    t.visit_guid AS hos_guid,

    (SUBSTRING(TO_CHAR(t.visit_begin_visit_time::timestamp, 'YY') FROM 1 FOR 2) ||
     LPAD(t.visit_vn, 10, '0')) AS vn,

    t.visit_hn AS hn,

    CASE
        WHEN t.f_visit_type_id = '1' THEN
            SUBSTRING(t.visit_vn FROM 2 FOR 2) || LPAD(SUBSTRING(t.visit_vn FROM 4), 7, '0')
        ELSE NULL
    END AS an,

    TO_CHAR(t.visit_begin_visit_time::timestamp, 'YYYY-MM-DD') AS vstdate,
    TO_CHAR(t.visit_begin_visit_time::timestamp, 'HH24:MI:SS') AS vsttime,

    diag.diag_icd10_staff_doctor AS doctor,

    vp.visit_payment_main_hospital AS hospmain,
    vp.visit_payment_sub_hospital AS hospsub,

    ROW_NUMBER() OVER (
        PARTITION BY TO_CHAR(t.visit_begin_visit_time::timestamp, 'YYYY-MM-DD')
        ORDER BY t.visit_begin_visit_time ASC
    ) AS oqueue,

    vp.b_contract_plans_id AS pttype,
    vp.visit_payment_card_number AS pttypeno,

    t.b_visit_office_id_refer_in AS rfrin,
    t.b_visit_office_id_refer_out AS rfrout,

    cur_d.b_service_point_id AS spclty,

    cur_d.b_service_point_id AS main_dep,
    last_d.b_service_point_id AS cur_dep,

    '0' AS pt_subtype,

    CASE
        WHEN TO_CHAR(t.visit_begin_visit_time::timestamp, 'HH24:MI:SS') BETWEEN '08:00:00' AND '16:00:00' THEN '1'
        ELSE '2'
    END AS visit_type,

    t.user_record_id AS staff,

    t.t_visit_id AS oldcode,
    t.t_visit_id AS ovst_key,

    t.f_visit_opd_discharge_status_id AS ovstost,
    t.f_visit_service_type_id AS ovstist

FROM filtered_visit t

LEFT JOIN LATERAL (
    SELECT p.visit_payment_main_hospital, p.visit_payment_sub_hospital,
           p.b_contract_plans_id, p.visit_payment_card_number
    FROM t_visit_payment p
    WHERE p.t_visit_id = t.t_visit_id AND p.visit_payment_active = '1'
    ORDER BY p.t_visit_payment_id DESC LIMIT 1
) vp ON true

LEFT JOIN LATERAL (
    SELECT d.diag_icd10_staff_doctor
    FROM t_diag_icd10 d
    WHERE d.diag_icd10_vn = t.t_visit_id AND d.f_diag_icd10_type_id = '1'
    ORDER BY d.t_diag_icd10_id DESC LIMIT 1
) diag ON true

LEFT JOIN LATERAL (
    SELECT qm.visit_queue_map_queue, qm.b_visit_queue_setup_id
    FROM t_visit_queue_map qm
    WHERE qm.t_visit_id = t.t_visit_id AND qm.visit_queue_map_active = '1'
    ORDER BY qm.t_visit_queue_map_id DESC LIMIT 1
) q_map ON true

LEFT JOIN LATERAL (
    SELECT vs.b_service_point_id
    FROM t_visit_service vs
    WHERE vs.t_visit_id = t.t_visit_id
    ORDER BY vs.assign_date_time ASC LIMIT 1
) cur_d ON true

LEFT JOIN LATERAL (
    SELECT vs.b_service_point_id
    FROM t_visit_service vs
    WHERE vs.t_visit_id = t.t_visit_id
    ORDER BY vs.assign_date_time DESC LIMIT 1
) last_d ON true

ORDER BY t.visit_begin_visit_time DESC`;

  return { text, params };
}

module.exports = {
  group: 'visit',
  table: 'ovst',
  label: 'การมารับบริการ OPD (หลัก)',
  schema: 'public',
  dateColumn: 'vstdate',        // ใช้แสดงผล/สื่อความหมาย
  targetDateColumn: 'vstdate',  // ใช้ count แถวปลายทางในช่วงวันที่
  targetKey: ['vn'],            // คีย์ตรวจว่าแถวไหนขาดในปลายทาง
  keyField: 'vn',               // ฟิลด์ในผลคิวรี่ที่ตรงกับคีย์ปลายทาง

  source: { engine: 'postgres', sql: sourceSql },

  // ตารางอ้างอิงในปลายทาง (HOSxP)
  lookups: {
    doctorCode:   { table: 'doctor',        match: 'oldcode',             ret: 'code' },
    pttypeCode:   { table: 'pttype',        match: 'hos_guid',            ret: 'pttype' },
    spcltyCode:   { table: 'kskdepartment', match: 'oldcode',             ret: 'spclty' },
    depCode:      { table: 'kskdepartment', match: 'oldcode',             ret: 'depcode' },
    officerLogin: { table: 'officer',       match: 'officer_doctor_code', ret: 'officer_login_name' },
    ovstostCode:  { table: 'ovstost',       match: 'hos_guid',            ret: 'ovstost' },
    ovstistCode:  { table: 'ovstist',       match: 'hos_guid',            ret: 'ovstist' }
  },

  // แม็ป: คอลัมน์ปลายทาง <- ฟิลด์ query (+ lookup ถ้ามี)
  columns: [
    { col: 'hos_guid',   field: 'hos_guid' },
    { col: 'vn',         field: 'vn' },
    { col: 'hn',         field: 'hn' },
    { col: 'an',         field: 'an' },
    { col: 'vstdate',    field: 'vstdate' },
    { col: 'vsttime',    field: 'vsttime' },
    { col: 'doctor',     field: 'doctor',   lookup: 'doctorCode' },
    { col: 'hospmain',   field: 'hospmain' },
    { col: 'hospsub',    field: 'hospsub' },
    { col: 'oqueue',     field: 'oqueue' },
    { col: 'pttype',     field: 'pttype',   lookup: 'pttypeCode' },
    { col: 'pttypeno',   field: 'pttypeno' },
    { col: 'spclty',     field: 'spclty',   lookup: 'spcltyCode' },
    { col: 'main_dep',   field: 'main_dep', lookup: 'depCode' },
    { col: 'cur_dep',    field: 'cur_dep',  lookup: 'depCode' },
    { col: 'pt_subtype', field: 'pt_subtype' },
    { col: 'visit_type', field: 'visit_type' },
    // staff: doctor.oldcode -> doctor.code -> officer.officer_doctor_code -> officer.officer_login_name
    { col: 'staff',      field: 'staff',    lookupChain: ['doctorCode', 'officerLogin'] },
    { col: 'oldcode',    field: 'oldcode' },
    { col: 'ovst_key',   field: 'ovst_key' },
    { col: 'ovstost',    field: 'ovstost',  lookup: 'ovstostCode' },
    { col: 'ovstist',    field: 'ovstist',  lookup: 'ovstistCode' }
  ]
};
