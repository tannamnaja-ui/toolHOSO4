'use strict';
/* ============================================================
   สูตรเฉพาะ: patient (ทะเบียนผู้ป่วย - Master Data)
   ต้นทาง: PostgreSQL (t_patient + t_person + ...)
   ปลายทาง: HOSxP (patient) — PostgreSQL หรือ MySQL
   เลือกข้อมูลด้วย "ช่วง HN" (ไม่ใช่ช่วงวันที่) — rangeType: 'hn'
   ============================================================ */

function sourceSql(from, to) {
  const params = [];
  let hnFilter = '';
  if (from && to) {
    params.push(from, to);
    // กรองด้วยช่วง HN (ตัวเลข) — เทียบแบบ bigint กันปัญหา HN ยาวไม่เท่ากัน
    hnFilter = "AND p.patient_hn ~ '^[0-9]+$' AND p.patient_hn::bigint BETWEEN $1::bigint AND $2::bigint";
  }

  const text = `
SELECT
    '{' || UPPER(gen_random_uuid()::TEXT) || '}' AS hos_guid,
    p.patient_hn AS hn,
    f.patient_prefix_description AS pname,
    t.person_firstname AS fname,
    t.person_lastname AS lname,
    t.person_pid AS cid,
    t.f_patient_occupation_id AS occupation,
    r.r_rp1853_nation_id AS citizenship,
    t.person_dob AS birthday,
    ad.house_no AS addrpart,
    ad.village_no AS moopart,
    substr(ad.sub_district_id, 5, 2) AS tmbpart,
    substr(ad.district_id, 3, 2) AS amppart,
    substr(ad.province_id, 1, 2) AS chwpart,
    ad.postal_code AS po_code,
    b.patient_blood_group_description AS bloodgrp,
    (CASE WHEN td.death_active = '1' THEN 'Y' ELSE 'N' END) AS death,
    date(td.death_date_time) AS deathday,
    tf.person_firstname AS fathername,
    tf.person_lastname AS fatherlname,
    tf.person_pid AS father_cid,
    tm.person_firstname AS mathername,
    tm.person_lastname AS motherlname,
    tm.person_pid AS mother_cid,
    m.r_rp1853_marriage_id AS marrystatus,
    n.r_rp1853_nation_id AS nationality,
    rn.f_patient_religion_id AS religion,
    t.f_sex_id AS sex,
    t.f_patient_education_type_id AS educate,
    p.t_patient_id AS oldcode,
    '1' AS hospital_department_id
FROM t_patient p
LEFT OUTER JOIN t_person t ON t.t_person_id = p.t_person_id
LEFT OUTER JOIN t_person_address a ON a.t_person_id = t.t_person_id
LEFT OUTER JOIN t_address ad ON ad.t_address_id = a.t_address_id
LEFT OUTER JOIN f_patient_prefix f ON f.f_patient_prefix_id = t.f_prefix_id
LEFT OUTER JOIN f_patient_occupation c ON c.f_patient_occupation_id = t.f_patient_occupation_id
LEFT OUTER JOIN b_map_rp1853_nation r ON r.f_patient_nation_id = t.f_patient_nation_id
LEFT OUTER JOIN f_patient_blood_group b ON b.f_patient_blood_group_id = t.f_patient_blood_group_id
LEFT OUTER JOIN t_death td ON td.t_patient_id = p.t_patient_id
LEFT OUTER JOIN t_person tf ON tf.t_person_id = t.father_person_id
LEFT OUTER JOIN t_person tm ON tm.t_person_id = t.mother_person_id
LEFT OUTER JOIN f_patient_marriage_status m ON m.f_patient_marriage_status_id = t.f_patient_marriage_status_id
LEFT OUTER JOIN f_patient_nation n ON n.f_patient_nation_id = t.f_patient_nation_id
LEFT OUTER JOIN f_patient_religion rn ON rn.f_patient_religion_id = t.f_patient_religion_id
WHERE t.t_person_id = p.t_person_id
    ${hnFilter}`;

  return { text, params };
}

module.exports = {
  group: 'master',
  table: 'patient',
  label: 'ทะเบียนผู้ป่วย',
  schema: 'public',
  rangeType: 'hn',           // เลือกด้วยช่วง HN
  dateColumn: 'hn',
  targetKey: ['hn'],         // hn — unique ต่อผู้ป่วย (hos_guid ถูก gen ใหม่ทุกครั้ง ใช้เป็นคีย์ไม่ได้)
  keyField: 'hn',

  source: { engine: 'postgres', sql: sourceSql },

  lookups: {},

  columns: [
    { col: 'hos_guid',              field: 'hos_guid' },   // gen ในคิวรี่
    { col: 'hn',                    field: 'hn' },
    { col: 'pname',                 field: 'pname' },
    { col: 'fname',                 field: 'fname' },
    { col: 'lname',                 field: 'lname' },
    { col: 'cid',                   field: 'cid' },
    { col: 'occupation',            field: 'occupation' },
    { col: 'citizenship',           field: 'citizenship' },
    { col: 'birthday',              field: 'birthday' },
    { col: 'addrpart',              field: 'addrpart' },
    { col: 'moopart',               field: 'moopart' },
    { col: 'tmbpart',               field: 'tmbpart' },
    { col: 'amppart',               field: 'amppart' },
    { col: 'chwpart',               field: 'chwpart' },
    { col: 'po_code',               field: 'po_code' },
    { col: 'bloodgrp',              field: 'bloodgrp' },
    { col: 'death',                 field: 'death' },
    { col: 'deathday',              field: 'deathday' },
    { col: 'fathername',            field: 'fathername' },
    { col: 'fatherlname',           field: 'fatherlname' },
    { col: 'father_cid',            field: 'father_cid' },
    { col: 'motherlname',           field: 'motherlname' },
    { col: 'mother_cid',            field: 'mother_cid' },
    { col: 'marrystatus',           field: 'marrystatus' },
    { col: 'nationality',           field: 'nationality' },
    { col: 'religion',              field: 'religion' },
    { col: 'sex',                   field: 'sex' },
    { col: 'educate',               field: 'educate' },
    { col: 'oldcode',               field: 'oldcode' },
    { col: 'hospital_department_id', field: 'hospital_department_id' }
  ]
};
