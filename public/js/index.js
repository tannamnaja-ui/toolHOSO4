/* ============================================================
   หน้า index — ตั้งค่าการเชื่อมต่อฐานข้อมูลทั้ง 2 ฝั่ง
   ============================================================ */
renderTopbar('home');

const SIDES = ['src', 'tgt'];
const SIDE_KEY = { src: 'source', tgt: 'target' };
const FIELDS = ['engine', 'label', 'host', 'port', 'database', 'user', 'password', 'encoding'];
const DEFAULT_PORT = { postgres: 5432, mysql: 3306 };

function readSide(prefix) {
  const cfg = {};
  FIELDS.forEach(f => { cfg[f] = $('#' + prefix + '-' + f).value.trim(); });
  cfg.engine = cfg.engine || 'postgres';
  cfg.port = Number(cfg.port) || DEFAULT_PORT[cfg.engine] || 5432;
  cfg.ssl = $('#' + prefix + '-ssl').checked;
  return cfg;
}

function fillSide(prefix, cfg) {
  FIELDS.forEach(f => { $('#' + prefix + '-' + f).value = cfg[f] === undefined || cfg[f] === null ? '' : cfg[f]; });
  $('#' + prefix + '-ssl').checked = !!cfg.ssl;
  reflectEngine(prefix);
}

/** ปรับหน้าตาการ์ดตาม engine ที่เลือก (สี + placeholder port) */
function reflectEngine(prefix) {
  const eng = $('#' + prefix + '-engine').value || 'postgres';
  $('#' + prefix + '-port').placeholder = DEFAULT_PORT[eng] || 5432;
  const badge = $('#' + prefix + '-engine-tag');
  if (badge) {
    badge.textContent = eng === 'mysql' ? '🐬 MySQL' : '🐘 PostgreSQL';
    badge.className = 'badge ' + (eng === 'mysql' ? 'badge-lav' : 'badge-mint');
  }
}

function setStatus(prefix, kind, text) {
  const badge = $('#' + prefix + '-status');
  badge.className = 'badge ' + ({ ok: 'badge-mint', err: 'badge-danger', idle: 'badge-gray', busy: 'badge-sun' }[kind] || 'badge-gray');
  badge.innerHTML = '<span class="dot ' + ({ ok: 'on', err: 'err' }[kind] || 'off') + '"></span> ' + esc(text);
}

function showAlert(prefix, kind, html) {
  const a = $('#' + prefix + '-alert');
  a.className = 'alert alert-' + kind;
  a.innerHTML = html;
}

/* ---------------- ทดสอบการเชื่อมต่อ ---------------- */
async function testSide(prefix, silent) {
  const side = SIDE_KEY[prefix];
  const cfg = readSide(prefix);
  if (!cfg.host || !cfg.database || !cfg.user) {
    showAlert(prefix, 'warn', '⚠️ กรุณากรอก IP Server, Database และ Username ให้ครบก่อนทดสอบ');
    setStatus(prefix, 'idle', 'ข้อมูลไม่ครบ');
    return false;
  }
  const btn = $('#' + prefix + '-test');
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin dark"></span> กำลังทดสอบ...';
  setStatus(prefix, 'busy', 'กำลังทดสอบ...');
  try {
    const r = await api('/api/connections/test', { method: 'POST', body: { side, config: cfg } });
    if (r.ok && r.info) {
      setStatus(prefix, 'ok', 'เชื่อมต่อได้');
      showAlert(prefix, 'ok',
        '✅ <b>' + esc(r.message) + '</b><br>' +
        '<span class="small mono">' + esc(r.info.version) + '</span><br>' +
        '<span class="small">ฐานข้อมูล: <b>' + esc(r.info.database) + '</b> · ผู้ใช้: <b>' + esc(r.info.user) + '</b> · ' +
        'ขนาด: <b>' + esc(r.info.size) + '</b> · ตาราง: <b>' + nf(r.info.tableCount) + '</b> · ' +
        'ใช้เวลา ' + fmtMs(r.info.elapsedMs) + '</span>');
      if (!silent) toast('เชื่อมต่อฐานข้อมูล' + (side === 'source' ? 'ต้นทาง' : 'ปลายทาง') + 'สำเร็จ', 'ok');
      return true;
    }
    setStatus(prefix, 'err', 'เชื่อมต่อไม่ได้');
    showAlert(prefix, 'err', '❌ <b>เชื่อมต่อไม่สำเร็จ</b><br><span class="small mono">' + esc(r.error) + '</span>');
    if (!silent) toast('เชื่อมต่อไม่สำเร็จ', 'err');
    return false;
  } catch (e) {
    setStatus(prefix, 'err', 'เชื่อมต่อไม่ได้');
    showAlert(prefix, 'err', '❌ <b>เชื่อมต่อไม่สำเร็จ</b><br><span class="small mono">' + esc(e.message) + '</span>');
    if (!silent) toast(e.message, 'err');
    return false;
  } finally {
    btn.disabled = false;
    btn.innerHTML = old;
  }
}

/* ---------------- บันทึก ---------------- */
async function saveAll() {
  const btn = $('#btn-save');
  const old = btn.innerHTML;
  const src = readSide('src');
  const tgt = readSide('tgt');
  if (!src.host || !src.database) { toast('กรุณากรอกข้อมูลฝั่งต้นทางให้ครบ', 'warn'); return; }
  if (!tgt.host || !tgt.database) { toast('กรุณากรอกข้อมูลฝั่งปลายทางให้ครบ', 'warn'); return; }
  if (src.host === tgt.host && Number(src.port) === Number(tgt.port) && src.database === tgt.database) {
    if (!confirm('ต้นทางและปลายทางเป็นฐานข้อมูลเดียวกัน — ต้องการบันทึกต่อหรือไม่?')) return;
  }
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> กำลังบันทึก...';
  try {
    const r = await api('/api/connections', { method: 'POST', body: { source: src, target: tgt } });
    fillSide('src', r.connections.source);
    fillSide('tgt', r.connections.target);
    toast(r.message, 'ok');
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = old;
  }
}

/* ---------------- Events ---------------- */
$$('.pwd-toggle').forEach(b => b.addEventListener('click', () => {
  const input = $('#' + b.dataset.target);
  input.type = input.type === 'password' ? 'text' : 'password';
  b.textContent = input.type === 'password' ? '👁️' : '🙈';
}));

// เปลี่ยน engine → ปรับ port ให้เป็นค่า default ของชนิดนั้น (ถ้าค่าเดิมเป็น default ของอีกชนิด)
SIDES.forEach(p => {
  $('#' + p + '-engine').addEventListener('change', () => {
    const eng = $('#' + p + '-engine').value;
    const portEl = $('#' + p + '-port');
    const cur = Number(portEl.value);
    if (!portEl.value || cur === 5432 || cur === 3306) portEl.value = DEFAULT_PORT[eng] || 5432;
    reflectEngine(p);
    const badge = $('#' + p + '-status');
    if (badge) { badge.className = 'badge badge-gray'; badge.innerHTML = '<span class="dot off"></span> ยังไม่ทดสอบ'; }
  });
});

$('#src-test').addEventListener('click', () => testSide('src'));
$('#tgt-test').addEventListener('click', () => testSide('tgt'));
$('#btn-save').addEventListener('click', saveAll);
$('#btn-test-both').addEventListener('click', async () => {
  const a = await testSide('src', true);
  const b = await testSide('tgt', true);
  toast(a && b ? 'เชื่อมต่อได้ทั้ง 2 ฝั่ง ✓' : 'มีบางฝั่งเชื่อมต่อไม่สำเร็จ', a && b ? 'ok' : 'err');
});

$('#src-copy').addEventListener('click', () => {
  const src = readSide('src');
  fillSide('tgt', Object.assign({}, src, { label: src.label ? src.label + ' (ปลายทาง)' : '' }));
  $('#tgt-ssl').checked = src.ssl;
  toast('คัดลอกค่าไปฝั่งปลายทางแล้ว — อย่าลืมแก้ IP/Database', 'warn');
});

// Enter = ทดสอบการเชื่อมต่อฝั่งนั้น
SIDES.forEach(p => {
  $$('#' + p + '-host, #' + p + '-port, #' + p + '-database, #' + p + '-user, #' + p + '-password')
    .forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') testSide(p); }));
});

/* ---------------- เมนูลัด ---------------- */
async function renderMenuCards() {
  const box = $('#menu-cards');
  let groups = {};
  try { groups = (await api('/api/groups')).groups; } catch (e) {}
  const meta = [
    { key: 'basic',  icon: '🗂️',  desc: 'ตารางข้อมูลตั้งต้น เช่น รหัสมาตรฐาน สิทธิ์ แผนก คลินิก' },
    { key: 'master', icon: '🧑‍⚕️', desc: 'ทะเบียนผู้ป่วย ที่อยู่ ข้อมูลบุคคล' },
    { key: 'visit',  icon: '📋',  desc: 'ประวัติการรับบริการ การวินิจฉัย ค่าใช้จ่าย' }
  ];
  box.innerHTML = '';
  meta.forEach(m => {
    const g = groups[m.key] || { name: m.key, tables: [] };
    const n = (g.tables || []).length;
    box.appendChild(el('a', { href: 'data.html?g=' + m.key, style: 'text-decoration:none;color:inherit' }, [
      el('div', { class: 'card', style: 'margin:0;height:100%' }, [
        el('div', { class: 'card-body' }, [
          el('div', { style: 'font-size:34px;margin-bottom:8px' }, [m.icon]),
          el('div', { style: 'font-size:17px;font-weight:700;color:var(--plum);margin-bottom:5px' }, [g.name]),
          el('div', { class: 'small muted', style: 'margin-bottom:12px;min-height:36px' }, [m.desc]),
          el('span', { class: n ? 'badge badge-mint' : 'badge badge-gray' }, [n ? 'กำหนดไว้ ' + n + ' ตาราง' : 'ยังไม่ได้กำหนดตาราง'])
        ])
      ])
    ]));
  });
}

/* ---------------- โหลดค่าเดิม ---------------- */
(async function init() {
  try {
    const r = await api('/api/connections');
    fillSide('src', r.connections.source);
    fillSide('tgt', r.connections.target);
    if (r.connections.source.host) setStatus('src', 'idle', 'มีค่าที่บันทึกไว้');
    if (r.connections.target.host) setStatus('tgt', 'idle', 'มีค่าที่บันทึกไว้');
  } catch (e) {
    toast('โหลดค่าการเชื่อมต่อไม่สำเร็จ: ' + e.message, 'err');
  }
  renderMenuCards();
})();
