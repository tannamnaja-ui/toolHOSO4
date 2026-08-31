/* ============================================================
   หน้าประวัติการโอนข้อมูล
   ============================================================ */
renderTopbar('history');

const GROUP_NAME = {
  basic: 'ข้อมูลพื้นฐาน',
  master: 'ข้อมูลคนไข้',
  visit: 'ข้อมูลประวัติ'
};

function detailModal(entry) {
  const bg = el('div', { class: 'modal-bg' });
  bg.appendChild(el('div', { class: 'modal' }, [
    el('div', { class: 'modal-head' }, [
      el('span', { style: 'font-size:20px' }, ['📄']),
      el('h3', {}, ['รายละเอียด — ' + thaiDate(entry.at)]),
      el('button', { class: 'x-btn', onclick: () => bg.remove() }, ['✕'])
    ]),
    el('div', { class: 'modal-body' }, [
      el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data' }, [
          el('thead', {}, [el('tr', {}, [
            el('th', {}, ['ตาราง']), el('th', { class: 'num' }, ['ต้นทาง']),
            el('th', { class: 'num' }, ['ขาดหาย']), el('th', { class: 'num' }, ['โอนสำเร็จ']),
            el('th', { class: 'num' }, ['ล้มเหลว']), el('th', {}, ['สถานะ']), el('th', {}, ['หมายเหตุ'])
          ])]),
          el('tbody', {}, (entry.results || []).map(r => el('tr', {}, [
            el('td', { class: 'mono' }, [r.table]),
            el('td', { class: 'num' }, [nf(r.sourceRows)]),
            el('td', { class: 'num' }, [nf(r.missingRows)]),
            el('td', { class: 'num' }, [nf(r.inserted)]),
            el('td', { class: 'num' }, [nf(r.failed)]),
            el('td', {}, [el('span', { class: 'badge ' + (r.status === 'ok' ? 'badge-mint' : r.status === 'error' ? 'badge-danger' : 'badge-sun') }, [r.status || '–'])]),
            el('td', { class: 'small muted' }, [r.error || (r.errors && r.errors[0]) || ''])
          ])))
        ])
      ])
    ]),
    el('div', { class: 'modal-foot' }, [
      el('button', { class: 'btn btn-soft', onclick: () => bg.remove() }, ['ปิด'])
    ])
  ]));
  bg.addEventListener('click', e => { if (e.target === bg) bg.remove(); });
  document.body.appendChild(bg);
}

(async function init() {
  const body = $('#hist-body');
  try {
    const { history } = await api('/api/history');
    if (!history.length) {
      body.appendChild(el('tr', {}, [el('td', { colspan: 11 }, [
        el('div', { class: 'empty' }, [
          el('span', { class: 'icon' }, ['🌷']),
          el('div', {}, ['ยังไม่มีประวัติการโอนข้อมูล'])
        ])
      ])]));
      return;
    }
    history.forEach(h => {
      const bad = h.failed || h.errors;
      body.appendChild(el('tr', {}, [
        el('td', { class: 'small' }, [thaiDate(h.at)]),
        el('td', {}, [el('span', { class: 'badge badge-pink' }, [GROUP_NAME[h.group] || h.group || '–'])]),
        el('td', { class: 'small mono' }, [h.dateFrom ? h.dateFrom + ' → ' + h.dateTo : 'ทั้งตาราง']),
        el('td', {}, [el('span', { class: 'badge ' + (h.dryRun ? 'badge-lav' : 'badge-mint') }, [h.dryRun ? 'ตรวจสอบ' : 'โอนจริง'])]),
        el('td', { class: 'num' }, [nf(h.tables)]),
        el('td', { class: 'num' }, [nf(h.sourceRows)]),
        el('td', { class: 'num' }, [nf(h.missingRows)]),
        el('td', { class: 'num', style: h.inserted ? 'color:var(--mint-dark);font-weight:700' : '' }, [nf(h.inserted)]),
        el('td', { class: 'num', style: bad ? 'color:var(--danger-dark);font-weight:700' : '' }, [nf(h.failed)]),
        el('td', { class: 'small muted' }, [fmtMs(h.elapsedMs || 0)]),
        el('td', {}, [el('button', { class: 'btn btn-soft btn-xs', onclick: () => detailModal(h) }, ['ดูรายละเอียด'])])
      ]));
    });
  } catch (e) {
    toast('โหลดประวัติไม่สำเร็จ: ' + e.message, 'err');
  }
})();
