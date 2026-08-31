/* ============================================================
   หน้าโอนข้อมูล (ใช้ร่วมกันทั้ง 3 เมนู ผ่าน ?g=basic|master|visit)
   ============================================================ */

const GROUP_KEY = new URLSearchParams(location.search).get('g') || 'basic';
const GROUP_META = {
  basic:  { icon: '🗂️',  sub: 'ตารางข้อมูลตั้งต้นที่ใช้อ้างอิงร่วมกัน เช่น รหัสมาตรฐาน สิทธิ์การรักษา แผนก คลินิก' },
  master: { icon: '🧑‍⚕️', sub: 'ทะเบียนผู้ป่วย ข้อมูลบุคคล ที่อยู่ และข้อมูลหลักที่ผูกกับตัวคนไข้' },
  visit:  { icon: '📋',  sub: 'ประวัติการรับบริการ การวินิจฉัย หัตถการ และค่าใช้จ่ายรายครั้ง' }
};
renderTopbar(GROUP_KEY);

const state = {
  group: null,
  plans: {},          // table -> plan
  recipes: {},        // table -> recipe info (สูตรเฉพาะ)
  selected: new Set(LS.get('sel:' + GROUP_KEY, [])),
  running: false,
  jobId: null,
  lastResults: []
};

/* ============================================================
   โหลด / แสดงรายการตาราง
   ============================================================ */
async function loadGroup() {
  const r = await api('/api/groups/' + GROUP_KEY);
  state.group = r.group;
  const meta = GROUP_META[GROUP_KEY] || { icon: '📁', sub: '' };
  document.title = 'toolHOSO4 — ' + state.group.name;
  $('#page-title').textContent = meta.icon + ' ' + state.group.name;
  $('#page-sub').textContent = meta.sub;
  // กันไม่ให้ตารางที่ปิดใช้งาน (placeholder) ค้างอยู่ในรายการที่เลือก
  const sel = new Set(selectableTables().map(t => t.table));
  state.selected = new Set(Array.from(state.selected).filter(n => sel.has(n)));
  LS.set('sel:' + GROUP_KEY, Array.from(state.selected));
  renderTables();
}

function specOf(t) {
  return {
    table: t.table, schema: t.schema || 'public', label: t.label || '',
    keyColumns: t.keyColumns || [], dateColumn: t.dateColumn || ''
  };
}

function renderTables() {
  const body = $('#tables-body');
  body.innerHTML = '';
  const list = (state.group.tables || []);
  if (!list.length) {
    body.appendChild(el('tr', {}, [
      el('td', { colspan: 6 }, [
        el('div', { class: 'empty' }, [
          el('span', { class: 'icon' }, ['🌷']),
          el('div', { style: 'font-weight:600;margin-bottom:6px' }, ['ยังไม่ได้กำหนดตารางในกลุ่มนี้']),
          el('div', { class: 'small' }, ['กด "⚙️ จัดการรายการตาราง" เพื่อเลือกตารางจากฐานข้อมูลต้นทาง'])
        ])
      ])
    ]));
    updatePickCount();
    return;
  }

  list.forEach(t => {
    const plan = state.plans[t.table];
    const disabled = t.enabled === false;
    const checked = !disabled && state.selected.has(t.table);
    const cb = el('input', { type: 'checkbox', style: 'width:17px;height:17px;accent-color:var(--rose)' });
    cb.checked = checked;
    cb.disabled = disabled;
    cb.addEventListener('change', () => {
      if (cb.checked) state.selected.add(t.table); else state.selected.delete(t.table);
      tr.classList.toggle('picked', cb.checked);
      LS.set('sel:' + GROUP_KEY, Array.from(state.selected));
      updatePickCount();
    });

    const rec = state.recipes[t.table];
    let keyCell, dateCell, statusCell;
    if (disabled) {
      keyCell = el('span', { class: 'small muted' }, ['–']);
      dateCell = el('span', { class: 'small muted' }, ['–']);
      statusCell = el('span', { class: 'badge badge-sun', title: 'รายการนี้เป็นขั้นตอน UPDATE — ยังไม่ได้กำหนดคำสั่ง จึงยังโอนไม่ได้' }, ['✎ รอเขียนคำสั่ง (UPDATE)']);
    } else if (plan && plan.recipe) {
      keyCell = el('span', { class: 'chips' }, (plan.keyColumns || []).map(c => el('span', { class: 'chip' }, [c])));
      dateCell = plan.dateColumn ? el('span', { class: 'badge badge-lav' }, [plan.dateColumn]) : el('span', { class: 'badge badge-gray' }, ['ทั้งตาราง']);
      statusCell = plan.error
        ? el('span', { class: 'badge badge-danger', title: plan.error }, ['✕ ' + plan.error.slice(0, 26) + (plan.error.length > 26 ? '…' : '')])
        : el('span', { class: 'badge badge-lav', title: (plan.warnings || []).join('\n') || 'สูตรเฉพาะ' }, ['⚙️ สูตรเฉพาะ · ' + (plan.columns || []).length + ' คอลัมน์' + ((plan.warnings || []).length ? ' · ⚠' + plan.warnings.length : '')]);
    } else if (plan && plan.error) {
      keyCell = el('span', { class: 'small muted' }, ['–']);
      dateCell = el('span', { class: 'small muted' }, ['–']);
      statusCell = el('span', { class: 'badge badge-danger', title: plan.error }, ['✕ ' + plan.error.slice(0, 26) + (plan.error.length > 26 ? '…' : '')]);
    } else if (plan) {
      keyCell = el('span', { class: 'chips' }, (plan.keyColumns || []).map(c => el('span', { class: 'chip' }, [c])));
      dateCell = plan.dateColumn
        ? el('span', { class: 'badge badge-lav' }, [plan.dateColumn])
        : el('span', { class: 'badge badge-gray' }, ['ทั้งตาราง']);
      statusCell = el('span', { class: 'badge badge-mint' }, ['✓ พร้อมโอน · ' + (plan.columns || []).length + ' คอลัมน์']);
    } else if (rec) {
      keyCell = el('span', { class: 'chips' }, (rec.keyColumns || []).map(c => el('span', { class: 'chip' }, [c])));
      dateCell = rec.dateColumn ? el('span', { class: 'badge badge-lav' }, [rec.dateColumn]) : el('span', { class: 'badge badge-gray' }, ['ทั้งตาราง']);
      statusCell = el('span', { class: 'badge badge-lav', title: 'ใช้สูตรเฉพาะ (คิวรี่ + lookup) — กด "ตรวจสอบโครงสร้าง" เพื่อตรวจปลายทาง' }, ['⚙️ สูตรเฉพาะ · ' + rec.columns + ' คอลัมน์']);
    } else {
      keyCell = el('span', { class: 'small muted' }, [(t.keyColumns && t.keyColumns.length) ? t.keyColumns.join(', ') : 'ตรวจอัตโนมัติ']);
      dateCell = t.dateColumn ? el('span', { class: 'badge badge-lav' }, [t.dateColumn]) : el('span', { class: 'badge badge-gray' }, ['ทั้งตาราง']);
      statusCell = el('span', { class: 'badge badge-gray' }, ['ยังไม่ตรวจ']);
    }

    const tr = el('tr', { class: checked ? 'picked' : '', style: disabled ? 'opacity:.62' : '' }, [
      el('td', {}, [cb]),
      el('td', {}, [el('span', { class: 'mono', style: 'font-weight:600;color:' + (disabled ? 'var(--ink-soft)' : 'var(--plum)') }, [t.table])]),
      el('td', {}, [el('span', { class: 'small' }, [t.label || '–'])]),
      el('td', {}, [keyCell]),
      el('td', {}, [dateCell]),
      el('td', {}, [statusCell])
    ]);
    body.appendChild(tr);
  });
  updatePickCount();
}

function selectableTables() {
  return (state.group.tables || []).filter(t => t.enabled !== false);
}

function updatePickCount() {
  const total = selectableTables().length;
  const n = selectableTables().filter(t => state.selected.has(t.table)).length;
  $('#pick-count').textContent = 'เลือก ' + n + ' / ' + total + ' ตาราง';
  $('#check-all').checked = total > 0 && n === total;
  $('#btn-check').disabled = state.running || n === 0;
  $('#btn-transfer').disabled = state.running || n === 0;
}

/* ============================================================
   ตรวจสอบโครงสร้าง (plan)
   ============================================================ */
async function runPlan(tables) {
  const specs = (tables || selectableTables()).map(specOf);
  if (!specs.length) return [];
  const r = await api('/api/plan', { method: 'POST', body: { group: GROUP_KEY, tables: specs } });
  r.plans.forEach(p => { state.plans[p.table] = p; });
  return r.plans;
}

$('#btn-plan').addEventListener('click', async () => {
  const btn = $('#btn-plan');
  const old = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '<span class="spin dark"></span> กำลังตรวจ...';
  try {
    const plans = await runPlan();
    renderTables();
    const bad = plans.filter(p => p.error).length;
    toast(bad ? 'ตรวจเสร็จ — มี ' + bad + ' ตารางที่มีปัญหา' : 'ตรวจโครงสร้างครบทุกตาราง พร้อมโอน ✓', bad ? 'warn' : 'ok');
  } catch (e) {
    toast(e.message, 'err');
  } finally { btn.disabled = false; btn.innerHTML = old; }
});

/* ============================================================
   ช่วงวันที่
   ============================================================ */
function applyPreset(p) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const s = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  let from, to;
  if (p === 'today') { from = to = s(now); }
  else if (p === 'yesterday') { const d = new Date(now); d.setDate(d.getDate() - 1); from = to = s(d); }
  else if (p === '7' || p === '30') { const d = new Date(now); d.setDate(d.getDate() - (Number(p) - 1)); from = s(d); to = s(now); }
  else if (p === 'month') { from = s(new Date(now.getFullYear(), now.getMonth(), 1)); to = s(now); }
  else if (p === 'lastmonth') {
    from = s(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    to = s(new Date(now.getFullYear(), now.getMonth(), 0));
  }
  $('#date-from').value = from;
  $('#date-to').value = to;
  LS.set('date', { from, to });
}

$$('[data-preset]').forEach(b => b.addEventListener('click', e => { e.preventDefault(); applyPreset(b.dataset.preset); }));
$('#date-from').addEventListener('change', () => LS.set('date', { from: $('#date-from').value, to: $('#date-to').value }));
$('#date-to').addEventListener('change', () => LS.set('date', { from: $('#date-from').value, to: $('#date-to').value }));
$('#no-date').addEventListener('change', () => {
  const off = $('#no-date').checked;
  $('#date-from').disabled = off;
  $('#date-to').disabled = off;
  LS.set('nodate:' + GROUP_KEY, off);
});

$('#check-all').addEventListener('change', () => {
  const on = $('#check-all').checked;
  state.selected = new Set(on ? selectableTables().map(t => t.table) : []);
  LS.set('sel:' + GROUP_KEY, Array.from(state.selected));
  renderTables();
});

/* ============================================================
   ทำงาน: ตรวจสอบ / โอน
   ============================================================ */
function logLine(text, kind) {
  const box = $('#run-log');
  const time = new Date().toLocaleTimeString('th-TH', { hour12: false });
  box.appendChild(el('div', { class: 't-' + (kind || 'dim') }, ['[' + time + '] ' + text]));
  box.scrollTop = box.scrollHeight;
}

function setStats(items) {
  const box = $('#run-stats');
  box.innerHTML = '';
  items.forEach(i => box.appendChild(
    el('div', { class: 'stat ' + (i.tone || '') }, [
      el('div', { class: 'k' }, [i.k]),
      el('div', { class: 'v' }, [i.v])
    ])
  ));
}

const STATUS_BADGE = {
  ok:        ['badge-mint',   '✓ สำเร็จ'],
  'dry-run': ['badge-lav',    '👁 ตรวจสอบ'],
  partial:   ['badge-sun',    '⚠ สำเร็จบางส่วน'],
  error:     ['badge-danger', '✕ ผิดพลาด'],
  cancelled: ['badge-gray',   '● ยกเลิก']
};

function addResultRow(r) {
  const [cls, text] = STATUS_BADGE[r.status] || ['badge-gray', r.status || '–'];
  const note = r.error ? r.error
    : (r.errors && r.errors.length ? r.errors[0]
      : ((r.warnings && r.warnings.length) ? r.warnings.join(' · ') : ''));
  $('#result-body').appendChild(el('tr', {}, [
    el('td', {}, [
      el('div', { class: 'mono', style: 'font-weight:600;color:var(--plum)' }, [r.table]),
      r.label && r.label !== r.table ? el('div', { class: 'small muted' }, [r.label]) : null,
      r.keyColumns && r.keyColumns.length ? el('div', { class: 'small muted' }, ['คีย์: ' + r.keyColumns.join(', ')]) : null
    ]),
    el('td', { class: 'num' }, [nf(r.sourceRows)]),
    el('td', { class: 'num' }, [nf(r.targetRows)]),
    el('td', { class: 'num', style: r.missingRows ? 'color:var(--sun-dark);font-weight:700' : '' }, [nf(r.missingRows)]),
    el('td', { class: 'num', style: r.inserted ? 'color:var(--mint-dark);font-weight:700' : '' }, [nf(r.inserted)]),
    el('td', { class: 'num', style: r.failed ? 'color:var(--danger-dark);font-weight:700' : '' }, [nf(r.failed)]),
    el('td', {}, [el('span', { class: 'badge ' + cls }, [text])]),
    el('td', {}, [el('span', { class: 'small muted', title: note }, [note.length > 70 ? note.slice(0, 70) + '…' : note])])
  ]));
}

async function run(dryRun) {
  const picked = (state.group.tables || []).filter(t => state.selected.has(t.table));
  if (!picked.length) { toast('กรุณาเลือกตารางอย่างน้อย 1 ตาราง', 'warn'); return; }

  const noDate = $('#no-date').checked;
  const dateFrom = noDate ? null : $('#date-from').value;
  const dateTo = noDate ? null : $('#date-to').value;
  if (!noDate) {
    if (!dateFrom || !dateTo) { toast('กรุณาเลือกช่วงวันที่ให้ครบ', 'warn'); return; }
    if (dateFrom > dateTo) { toast('วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด', 'warn'); return; }
  }

  if (!dryRun) {
    const msg = 'ยืนยันการโอนข้อมูล ' + picked.length + ' ตาราง\n' +
      (noDate ? 'ช่วงวันที่: ทั้งตาราง' : 'ช่วงวันที่: ' + dateFrom + ' ถึง ' + dateTo) + '\n\n' +
      'ระบบจะเพิ่มเฉพาะแถวที่ปลายทางยังไม่มี (ไม่แก้ไข/ลบข้อมูลเดิม)';
    if (!confirm(msg)) return;
  }

  state.running = true;
  state.jobId = 'job-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  state.lastResults = [];

  $('#run-card').classList.remove('hidden');
  $('#result-card').classList.remove('hidden');
  $('#result-body').innerHTML = '';
  $('#run-log').innerHTML = '';
  $('#run-bar').style.width = '0%';
  $('#run-title').textContent = dryRun ? 'กำลังตรวจสอบข้อมูลที่ขาด' : 'กำลังโอนข้อมูล';
  $('#run-badge').className = 'badge badge-sun';
  $('#run-badge').textContent = 'กำลังทำงาน';
  $('#btn-cancel').classList.remove('hidden');
  $('#btn-check').disabled = true;
  $('#btn-transfer').disabled = true;
  $('#run-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  let done = 0;
  const agg = { source: 0, missing: 0, inserted: 0, failed: 0 };
  const paint = () => setStats([
    { k: 'ตารางที่ทำเสร็จ', v: done + ' / ' + picked.length },
    { k: 'แถวต้นทาง', v: nf(agg.source), tone: 'rose' },
    { k: 'ขาดหาย', v: nf(agg.missing), tone: 'sun' },
    { k: dryRun ? 'รอโอน' : 'โอนสำเร็จ', v: nf(dryRun ? agg.missing : agg.inserted), tone: 'mint' },
    { k: 'ล้มเหลว', v: nf(agg.failed), tone: 'danger' }
  ]);
  paint();

  logLine((dryRun ? 'เริ่มตรวจสอบ' : 'เริ่มโอนข้อมูล') + ' ' + picked.length + ' ตาราง · ' +
    (noDate ? 'ทั้งตาราง' : dateFrom + ' → ' + dateTo), 'info');

  try {
    await streamNdjson('/api/run', {
      jobId: state.jobId,
      group: GROUP_KEY,
      dateFrom, dateTo,
      dryRun: !!dryRun,
      syncSequence: $('#sync-seq').checked,
      tables: picked.map(specOf)
    }, ev => {
      if (ev.type === 'start') {
        const en = e => e === 'mysql' ? 'MySQL' : 'PostgreSQL';
        logLine('ต้นทาง: ' + en(ev.srcEngine) + '  →  ปลายทาง: ' + en(ev.tgtEngine), 'dim');
      } else if (ev.type === 'table-start') {
        $('#run-stage').textContent = '▶ ' + ev.table;
        logLine('── ' + ev.table + ' ──', 'info');
      } else if (ev.type === 'stage') {
        $('#run-stage').textContent = ev.table + ' — ' + ev.stage;
        logLine('   ' + ev.stage);
      } else if (ev.type === 'progress') {
        if (ev.phase === 'check') {
          $('#run-stage').textContent = ev.table + ' — ตรวจแล้ว ' + nf(ev.checked) + '/' + nf(ev.total) + ' · ขาด ' + nf(ev.missing);
        } else {
          $('#run-stage').textContent = ev.table + ' — โอนแล้ว ' + nf(ev.inserted) + '/' + nf(ev.total) +
            (ev.failed ? ' · ล้มเหลว ' + nf(ev.failed) : '');
        }
      } else if (ev.type === 'table-done') {
        const r = ev.result;
        state.lastResults.push(r);
        done++;
        agg.source += r.sourceRows || 0;
        agg.missing += r.missingRows || 0;
        agg.inserted += r.inserted || 0;
        agg.failed += r.failed || 0;
        $('#run-bar').style.width = Math.round(done / picked.length * 100) + '%';
        paint();
        addResultRow(r);
        if (r.status === 'error') logLine('   ✕ ' + r.error, 'err');
        else if (dryRun) logLine('   พบข้อมูลขาด ' + nf(r.missingRows) + ' แถว (จากต้นทาง ' + nf(r.sourceRows) + ')', r.missingRows ? 'warn' : 'ok');
        else logLine('   โอนสำเร็จ ' + nf(r.inserted) + ' แถว' + (r.failed ? ' · ล้มเหลว ' + nf(r.failed) : ''), r.failed ? 'warn' : 'ok');
        if (r.sequences && r.sequences.length) logLine('   ปรับ sequence: ' + r.sequences.join(', '), 'dim');
      } else if (ev.type === 'cancelled') {
        logLine('ผู้ใช้ยกเลิกการทำงาน', 'warn');
      } else if (ev.type === 'done') {
        const s = ev.summary;
        $('#run-bar').style.width = '100%';
        $('#run-stage').textContent = 'เสร็จสิ้น — ใช้เวลา ' + fmtMs(s.elapsedMs);
        const bad = s.failed || s.errors;
        $('#run-badge').className = 'badge ' + (s.cancelled ? 'badge-gray' : bad ? 'badge-sun' : 'badge-mint');
        $('#run-badge').textContent = s.cancelled ? 'ยกเลิกแล้ว' : bad ? 'เสร็จสิ้น (มีข้อผิดพลาด)' : 'เสร็จสมบูรณ์';
        $('#run-title').textContent = dryRun ? 'ผลการตรวจสอบ' : 'ผลการโอนข้อมูล';
        logLine('เสร็จสิ้น · ' + s.tables + ' ตาราง · ขาด ' + nf(s.missingRows) +
          (dryRun ? '' : ' · โอนสำเร็จ ' + nf(s.inserted)) + ' · ใช้เวลา ' + fmtMs(s.elapsedMs),
          bad ? 'warn' : 'ok');
        toast(dryRun
          ? 'ตรวจสอบเสร็จ — พบข้อมูลขาด ' + nf(s.missingRows) + ' แถว'
          : 'โอนข้อมูลเสร็จ — เพิ่ม ' + nf(s.inserted) + ' แถว', bad ? 'warn' : 'ok', 6000);
      }
    });
  } catch (e) {
    logLine('เกิดข้อผิดพลาด: ' + e.message, 'err');
    $('#run-badge').className = 'badge badge-danger';
    $('#run-badge').textContent = 'ผิดพลาด';
    toast(e.message, 'err');
  } finally {
    state.running = false;
    $('#btn-cancel').classList.add('hidden');
    updatePickCount();
  }
}

$('#btn-check').addEventListener('click', () => run(true));
$('#btn-transfer').addEventListener('click', () => run(false));
$('#btn-cancel').addEventListener('click', async () => {
  try { await api('/api/cancel', { method: 'POST', body: { jobId: state.jobId } }); toast('ส่งคำสั่งยกเลิกแล้ว', 'warn'); }
  catch (e) { toast(e.message, 'err'); }
});
$('#btn-clear').addEventListener('click', () => {
  $('#run-card').classList.add('hidden');
  $('#result-card').classList.add('hidden');
  $('#result-body').innerHTML = '';
  $('#run-log').innerHTML = '';
});

$('#btn-export').addEventListener('click', () => {
  if (!state.lastResults.length) { toast('ยังไม่มีผลลัพธ์', 'warn'); return; }
  const head = ['ตาราง', 'คำอธิบาย', 'คีย์', 'คอลัมน์วันที่', 'แถวต้นทาง', 'แถวปลายทาง', 'ขาดหาย', 'โอนสำเร็จ', 'ล้มเหลว', 'สถานะ', 'หมายเหตุ'];
  const rows = state.lastResults.map(r => [
    r.table, r.label || '', (r.keyColumns || []).join(' + '), r.dateColumn || '',
    r.sourceRows || 0, r.targetRows === null || r.targetRows === undefined ? '' : r.targetRows,
    r.missingRows || 0, r.inserted || 0, r.failed || 0, r.status || '',
    r.error || (r.errors && r.errors[0]) || ''
  ]);
  const csv = '﻿' + [head, ...rows]
    .map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = el('a', { href: url, download: 'toolHOSO4-' + GROUP_KEY + '-' + todayStr() + '.csv' });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
});

/* ============================================================
   Modal จัดการรายการตาราง
   ============================================================ */
let draft = [];
let sourceTables = [];

function suggestDateColumn(options) {
  if (!options || !options.length) return '';
  const names = options.map(o => o.name);
  const pref = names.find(n => /^(vstdate|regdate|admitdate|dchdate|opd_date|service_date)$/i.test(n));
  if (pref) return pref;
  const byName = names.find(n => /date$/i.test(n)) || names.find(n => /date/i.test(n));
  return byName || names[0];
}

async function openManager() {
  const bg = el('div', { class: 'modal-bg' });
  const listBox = el('div', { id: 'mg-selected' });
  const availBox = el('div', { id: 'mg-avail', style: 'max-height:280px;overflow:auto;border:1px solid var(--pink-200);border-radius:12px;background:#fff' });
  const search = el('input', { type: 'text', placeholder: 'ค้นหาชื่อตารางในฐานข้อมูลต้นทาง...' });

  draft = (state.group.tables || []).map(t => Object.assign({}, t, { keyColumns: (t.keyColumns || []).slice() }));

  const modal = el('div', { class: 'modal' }, [
    el('div', { class: 'modal-head' }, [
      el('span', { style: 'font-size:20px' }, ['⚙️']),
      el('h3', {}, ['จัดการรายการตาราง — ' + state.group.name]),
      el('button', { class: 'x-btn', onclick: () => bg.remove() }, ['✕'])
    ]),
    el('div', { class: 'modal-body' }, [
      el('div', { class: 'field' }, [
        el('label', {}, ['เพิ่มตารางจากฐานข้อมูลต้นทาง']),
        search
      ]),
      availBox,
      el('div', { class: 'row', style: 'margin:14px 0 4px' }, [
        el('button', { class: 'btn btn-ghost btn-sm', onclick: () => addBulk() }, ['📋 วางรายชื่อตาราง (คั่นด้วย , หรือขึ้นบรรทัดใหม่)']),
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn btn-soft btn-sm', onclick: () => autoDetect() }, ['🧬 ตรวจคีย์/คอลัมน์วันที่อัตโนมัติ'])
      ]),
      el('hr', { class: 'divider' }),
      el('div', { style: 'font-weight:700;color:var(--plum);margin-bottom:10px' }, ['ตารางในกลุ่มนี้']),
      listBox
    ]),
    el('div', { class: 'modal-foot' }, [
      el('button', { class: 'btn btn-soft', onclick: () => bg.remove() }, ['ยกเลิก']),
      el('button', { class: 'btn btn-primary', onclick: () => saveManager(bg) }, ['💾 บันทึกรายการตาราง'])
    ])
  ]);
  bg.appendChild(modal);
  bg.addEventListener('click', e => { if (e.target === bg) bg.remove(); });
  document.body.appendChild(bg);

  renderDraft(listBox);

  // โหลดรายชื่อตารางจากต้นทาง
  availBox.innerHTML = '<div class="small muted" style="padding:14px">กำลังโหลดรายชื่อตาราง...</div>';
  try {
    sourceTables = (await api('/api/db/source/tables')).tables;
    renderAvail(availBox, search.value, listBox);
  } catch (e) {
    availBox.innerHTML = '<div class="alert alert-err" style="margin:10px">โหลดรายชื่อตารางไม่สำเร็จ: ' + esc(e.message) +
      '<br><span class="small">ตรวจสอบการเชื่อมต่อฝั่งต้นทางที่หน้าแรก — หรือพิมพ์ชื่อตารางเองด้วยปุ่ม "วางรายชื่อตาราง"</span></div>';
  }
  search.addEventListener('input', () => renderAvail(availBox, search.value, listBox));

  function addBulk() {
    const text = prompt('วางรายชื่อตาราง (คั่นด้วยเครื่องหมายจุลภาค เว้นวรรค หรือขึ้นบรรทัดใหม่)');
    if (!text) return;
    const names = text.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
    let added = 0;
    names.forEach(n => {
      if (draft.some(d => d.table === n)) return;
      draft.push({ table: n, schema: 'public', label: '', keyColumns: [], dateColumn: '', enabled: true });
      added++;
    });
    renderDraft(listBox);
    renderAvail(availBox, search.value, listBox);
    toast('เพิ่ม ' + added + ' ตาราง', added ? 'ok' : 'warn');
  }

  async function autoDetect() {
    if (!draft.length) { toast('ยังไม่มีตารางในรายการ', 'warn'); return; }
    toast('กำลังตรวจโครงสร้าง ' + draft.length + ' ตาราง...', '', 2500);
    try {
      const r = await api('/api/plan', { method: 'POST', body: { tables: draft.map(specOf) } });
      const byName = {};
      r.plans.forEach(p => { byName[p.table] = p; state.plans[p.table] = p; });
      draft.forEach(d => {
        const p = byName[d.table];
        if (!p || p.error) return;
        if (!d.dateColumn) d.dateColumn = suggestDateColumn(p.dateColumnOptions);
      });
      renderDraft(listBox);
      const bad = r.plans.filter(p => p.error);
      toast(bad.length ? 'ตรวจเสร็จ — มี ' + bad.length + ' ตารางที่มีปัญหา' : 'ตรวจโครงสร้างเสร็จเรียบร้อย ✓', bad.length ? 'warn' : 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  function renderAvail(box, q, lb) {
    const kw = (q || '').trim().toLowerCase();
    const have = new Set(draft.map(d => d.table));
    const items = sourceTables
      .filter(t => !kw || t.table.toLowerCase().includes(kw))
      .slice(0, 400);
    box.innerHTML = '';
    if (!items.length) {
      box.innerHTML = '<div class="small muted" style="padding:14px">ไม่พบตารางที่ตรงกับคำค้น</div>';
      return;
    }
    items.forEach(t => {
      const added = have.has(t.table);
      box.appendChild(el('div', {
        style: 'display:flex;align-items:center;gap:10px;padding:7px 12px;border-bottom:1px solid var(--pink-100)'
      }, [
        el('span', { class: 'mono', style: 'flex:1;color:var(--plum)' }, [t.table]),
        el('span', { class: 'small muted' }, ['~' + nf(t.approxRows) + ' แถว']),
        el('button', {
          class: added ? 'btn btn-ghost btn-xs' : 'btn btn-soft btn-xs',
          disabled: added,
          onclick: () => {
            draft.push({ table: t.table, schema: t.schema, label: '', keyColumns: [], dateColumn: '', enabled: true });
            renderDraft(lb);
            renderAvail(box, q, lb);
          }
        }, [added ? 'เพิ่มแล้ว' : '+ เพิ่ม'])
      ]));
    });
  }

  function renderDraft(box) {
    box.innerHTML = '';
    if (!draft.length) {
      box.innerHTML = '<div class="empty small">ยังไม่มีตารางในกลุ่มนี้</div>';
      return;
    }
    const table = el('table', { class: 'data' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', {}, ['ตาราง']),
        el('th', {}, ['คำอธิบาย']),
        el('th', {}, ['คอลัมน์วันที่']),
        el('th', {}, ['คีย์ (เว้นว่าง = ใช้ PK)']),
        el('th', { style: 'width:52px' }, [''])
      ])]),
      el('tbody', {}, draft.map((d, i) => {
        const plan = state.plans[d.table];
        const opts = (plan && plan.dateColumnOptions) || [];
        const sel = el('select', {}, [el('option', { value: '' }, ['— ไม่กรองวันที่ —'])]
          .concat(opts.map(o => el('option', { value: o.name }, [o.name + ' (' + o.type.replace(' without time zone', '') + ')']))));
        if (d.dateColumn && !opts.some(o => o.name === d.dateColumn)) {
          sel.appendChild(el('option', { value: d.dateColumn }, [d.dateColumn + ' (ยังไม่ตรวจ)']));
        }
        sel.value = d.dateColumn || '';
        sel.addEventListener('change', () => { d.dateColumn = sel.value; });

        const lab = el('input', { type: 'text', value: d.label || '', placeholder: 'เช่น แฟ้มผู้ป่วย' });
        lab.addEventListener('input', () => { d.label = lab.value; });

        const key = el('input', {
          type: 'text',
          value: (d.keyColumns || []).join(', '),
          placeholder: plan && plan.keyColumns ? plan.keyColumns.join(', ') : 'อัตโนมัติ'
        });
        key.addEventListener('input', () => {
          d.keyColumns = key.value.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
        });

        return el('tr', {}, [
          el('td', {}, [
            el('div', { class: 'mono', style: 'font-weight:600;color:var(--plum)' }, [d.table]),
            plan && plan.error ? el('div', { class: 'small', style: 'color:var(--danger-dark)' }, [plan.error]) : null
          ]),
          el('td', {}, [lab]),
          el('td', {}, [sel]),
          el('td', {}, [key]),
          el('td', {}, [el('button', {
            class: 'btn btn-danger btn-xs',
            onclick: () => { draft.splice(i, 1); renderDraft(box); renderAvail(availBox, search.value, box); }
          }, ['ลบ'])])
        ]);
      }))
    ]);
    box.appendChild(el('div', { class: 'table-wrap' }, [table]));
  }
}

async function saveManager(bg) {
  try {
    const r = await api('/api/groups/' + GROUP_KEY + '/tables', { method: 'POST', body: { tables: draft } });
    state.group = r.group;
    const names = new Set(state.group.tables.map(t => t.table));
    state.selected = new Set(Array.from(state.selected).filter(n => names.has(n)));
    LS.set('sel:' + GROUP_KEY, Array.from(state.selected));
    renderTables();
    bg.remove();
    toast(r.message, 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

$('#btn-manage').addEventListener('click', openManager);

/* ============================================================
   เริ่มต้น
   ============================================================ */
(async function init() {
  const d = LS.get('date', null);
  if (d && d.from) { $('#date-from').value = d.from; $('#date-to').value = d.to; }
  else applyPreset('today');

  if (LS.get('nodate:' + GROUP_KEY, GROUP_KEY === 'basic')) {
    $('#no-date').checked = true;
    $('#date-from').disabled = true;
    $('#date-to').disabled = true;
  }

  try {
    const rc = await api('/api/recipes');
    (rc.recipes || []).filter(r => r.group === GROUP_KEY).forEach(r => { state.recipes[r.table] = r; });
  } catch (e) { /* ไม่มี recipe ก็ไม่เป็นไร */ }

  try { await loadGroup(); }
  catch (e) { toast('โหลดข้อมูลกลุ่มไม่สำเร็จ: ' + e.message, 'err'); }
})();
