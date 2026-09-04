/* ============================================================
   toolHOSO4 — ฟังก์ชันร่วมของทุกหน้า
   ============================================================ */

/* เวอร์ชันแอป — อัปเดตค่านี้เมื่อมีการแก้ไข (แสดงมุมซ้ายบนต่อจากชื่อ) */
const APP_VERSION = 'v1.9.2';
const APP_VERSION_DATE = '2026-08-31';

const $  = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') node.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) node.setAttribute(k, attrs[k]);
    }
  }
  (children || []).forEach(c => {
    if (c === null || c === undefined || c === false) return;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return node;
}

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const nf = n => (n === null || n === undefined) ? '–' : Number(n).toLocaleString('th-TH');

function fmtMs(ms) {
  if (ms < 1000) return ms + ' มิลลิวินาที';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + ' วินาที';
  const m = Math.floor(s / 60);
  return m + ' นาที ' + Math.round(s % 60) + ' วินาที';
}

/* ---------------- Toast ---------------- */
function toast(message, kind, ms) {
  let box = $('#toasts');
  if (!box) { box = el('div', { id: 'toasts' }); document.body.appendChild(box); }
  const t = el('div', { class: 'toast ' + (kind || ''), text: message });
  box.appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity .3s, transform .3s';
    t.style.opacity = '0';
    t.style.transform = 'translateX(24px)';
    setTimeout(() => t.remove(), 320);
  }, ms || 3600);
}

/* ---------------- API ---------------- */
async function api(url, options) {
  const opt = Object.assign({ headers: { 'Content-Type': 'application/json' } }, options || {});
  if (opt.body && typeof opt.body !== 'string') opt.body = JSON.stringify(opt.body);
  const res = await fetch(url, opt);
  let data;
  try { data = await res.json(); }
  catch (e) { throw new Error('เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง (HTTP ' + res.status + ')'); }
  if (!res.ok || data.ok === false) throw new Error(data.error || ('เกิดข้อผิดพลาด (HTTP ' + res.status + ')'));
  return data;
}

/** อ่านสตรีม NDJSON ทีละบรรทัด */
async function streamNdjson(url, body, onEvent) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    let msg = 'เกิดข้อผิดพลาด (HTTP ' + res.status + ')';
    try { const j = await res.json(); if (j.error) msg = j.error; } catch (e) {}
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try { onEvent(JSON.parse(line)); } catch (e) { /* ข้ามบรรทัดที่อ่านไม่ได้ */ }
    }
  }
  if (buf.trim()) { try { onEvent(JSON.parse(buf.trim())); } catch (e) {} }
}

/* ---------------- Navbar ---------------- */
const MENUS = [
  { key: 'home',   href: 'index.html',        icon: '🔗', name: 'ตั้งค่าการเชื่อมต่อ' },
  { key: 'basic',  href: 'data.html?g=basic', icon: '🗂️', name: 'ข้อมูลพื้นฐาน' },
  { key: 'master', href: 'data.html?g=master',icon: '🧑‍⚕️', name: 'ข้อมูลคนไข้' },
  { key: 'visit',  href: 'data.html?g=visit', icon: '📋', name: 'ข้อมูลประวัติ' },
  { key: 'history',href: 'history.html',      icon: '🕘', name: 'ประวัติการโอน' }
];

function renderTopbar(activeKey) {
  const bar = el('div', { class: 'topbar' }, [
    el('div', { class: 'topbar-inner' }, [
      el('a', { class: 'brand', href: 'index.html' }, [
        el('div', { class: 'brand-logo', text: '🌸' }),
        el('div', { class: 'brand-text' }, [
          el('h1', {}, [
            'toolHOSO4 ',
            el('span', { class: 'ver', title: 'เวอร์ชัน ' + APP_VERSION + ' · ' + APP_VERSION_DATE }, [APP_VERSION])
          ]),
          el('p', { text: 'ระบบโอนข้อมูลระหว่างฐานข้อมูล PostgreSQL / MySQL' })
        ])
      ]),
      el('nav', { class: 'nav' }, MENUS.map(m =>
        el('a', { href: m.href, class: m.key === activeKey ? 'active' : '' }, [m.icon + ' ' + m.name])
      ))
    ])
  ]);
  document.body.insertBefore(bar, document.body.firstChild);
}

/* ---------------- วันที่ ---------------- */
function todayStr(offsetDays) {
  const d = new Date();
  if (offsetDays) d.setDate(d.getDate() + offsetDays);
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function thaiDate(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
}

/* ---------------- localStorage ---------------- */
const LS = {
  get(key, fallback) {
    try { const v = localStorage.getItem('toolhoso4:' + key); return v === null ? fallback : JSON.parse(v); }
    catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('toolhoso4:' + key, JSON.stringify(value)); } catch (e) {}
  }
};
