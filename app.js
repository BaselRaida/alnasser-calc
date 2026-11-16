(() => {
  'use strict';

  const APP_VERSION = '1.2'; // يظهر في الإعدادات للتأكد من أن الهاتف يعمل بآخر نسخة
  const CFG = window.APP_CONFIG || {};
  // على الجهاز المحلي يُستخدم خادم التجربة، إلا إذا أُضيف ‎?live=1 للاتصال بالملف الحقيقي
  const DEV = ['localhost', '127.0.0.1'].includes(location.hostname) && !/[?&]live=1/.test(location.search);
  // النسخة التجريبية: بيانات افتراضية تُحفظ على جهاز المتصفح فقط، بلا أي اتصال بملف الجمعية
  const DEMO = !!CFG.DEMO;
  const NS = DEMO ? 'nasserdemo.' : 'nasser.';
  const API = DEMO ? 'demo' : DEV ? '/api' : CFG.API_URL;
  const T_IN = 'استلام من الجمعية', T_OUT = 'تحويل بنكي للجمعية';
  const POLL_MS = 20000;

  const LS = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* تخزين غير متاح */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* تخزين غير متاح */ } }
  };

  const S = {
    key: null, role: null, viewKey: null,
    rows: [], settings: { entity: 'جمعية الناصر', opening: 0, owner: '' },
    calc: null, raw: '', tab: 'home',
    filter: { type: 'all', cur: 'all', q: '' },
    lastSync: 0, error: '', busy: false
  };

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const n2 = n => Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const usd = n => `<span class="num">${n < -0.004 ? '-' : ''}$${n2(n)}</span>`;
  const ils = n => `<span class="num">₪${n2(n)}</span>`;
  const money = (n, cur) => (cur === 'ILS' ? ils(n) : usd(n));
  const pct = c => (Math.round(c * 1e6) / 1e4) + '%';
  const dFmt = new Intl.DateTimeFormat('ar-EG-u-nu-latn', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const mFmt = new Intl.DateTimeFormat('ar-EG-u-nu-latn', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const fmtDate = d => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? dFmt.format(new Date(d + 'T00:00:00Z')) : d || '—');
  // إذا كان التاريخ في الملف نصًا غير صالح نعرضه كما هو بدل أن تتعطل شاشة التقارير
  const fmtMonth = ym => (/^\d{4}-\d{2}$/.test(ym) ? mFmt.format(new Date(ym + '-01T00:00:00Z')) : ym || 'بدون تاريخ');
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

  /* ================= الحسابات — مطابقة لمعادلات ملف الشيت ================= */
  function calcRow(r) {
    const isIn = r.type === T_IN;
    const okRate = r.cur === 'ILS' && r.rate > 0;
    // H: الإجمالي (USD)
    const h = r.cur === 'USD' ? r.amount : okRate ? r.amount / r.rate : null;
    // I: العمولة (USD) — أقل من 1 تعني نسبة، وغير ذلك مبلغ ثابت
    let i = 0;
    if (r.comm !== null && r.comm !== undefined && r.comm !== '') {
      const c = r.comm < 1 ? r.amount * r.comm : r.comm;
      i = r.cur === 'USD' ? c : okRate ? c / r.rate : 0;
    }
    const j = h === null ? 0 : isIn ? h - i : h; // J: المبلغ المُرصّد
    let check = 'سليم';
    if (!r.cur) check = '⚠ اختر العملة';
    else if (!(r.amount > 0)) check = '⚠ أدخل المبلغ';
    else if (r.cur === 'ILS' && !(r.rate > 0)) check = '⚠ أدخل سعر الصرف';
    else if (isIn && r.comm !== null && r.comm >= 1 && r.comm > r.amount) check = '⚠ العمولة أكبر من المبلغ';
    return { isIn, h: h === null ? 0 : h, i, j, k: isIn ? j : 0, l: isIn ? 0 : j, check };
  }

  function compute() {
    const opening = Number(S.settings.opening) || 0;
    let bal = opening;
    const t = { netIn: 0, comm: 0, paid: 0, paidIlsUsd: 0, ilsPaid: 0, opening, nIn: 0, nOut: 0, gross: 0 };
    const list = S.rows.map((r, idx) => {
      const c = calcRow(r);
      bal += c.k - c.l;
      t.netIn += c.k; t.paid += c.l;
      if (c.isIn) { t.comm += c.i; t.nIn++; t.gross += c.h; } else {
        t.nOut++;
        if (r.cur === 'ILS') { t.paidIlsUsd += c.l; t.ilsPaid += r.amount; }
      }
      return Object.assign({}, r, c, { no: idx + 1, bal });
    });
    t.balance = opening + t.netIn - t.paid;
    S.calc = { list, t };
  }

  /* ================= الاتصال والمزامنة ================= */
  /* يحاكي الخادم في النسخة التجريبية بنفس القواعد: المشاهد لا يكتب، والحركات تُحفظ محليًا */
  async function demoApi(action, payload) {
    await new Promise(r => setTimeout(r, 250));
    const role = S.key === 'view' ? 'viewer' : 'admin';
    let rows;
    try { rows = JSON.parse(LS.get(NS + 'rows')); } catch (e) { rows = null; }
    if (!Array.isArray(rows)) rows = JSON.parse(JSON.stringify(CFG.DEMO_ROWS || []));
    if (action !== 'list') {
      if (role !== 'admin') throw new Error('FORBIDDEN');
      const i = payload.r ? payload.r - 10 : -1;
      if (action === 'add') rows.push(payload.row);
      else if (action === 'update' && rows[i]) rows[i] = payload.row;
      else if (action === 'delete' && rows[i]) rows.splice(i, 1);
      LS.set(NS + 'rows', JSON.stringify(rows));
    }
    return {
      ok: true, role, viewKey: role === 'admin' ? 'view' : null,
      settings: { entity: 'جمعية الناصر', opening: 0, owner: 'مدير الجمعية' },
      rows: rows.map((d, idx) => Object.assign({}, d, { r: 10 + idx }))
    };
  }

  async function api(action, payload) {
    if (DEMO) return demoApi(action, payload);
    // مهلة قصوى حتى لا يتوقف التحديث التلقائي إذا علق طلب بسبب ضعف الاتصال
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), payload && payload.receipt ? 180000 : 60000);
    const res = await fetch(API, {
      signal: ctl.signal,
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ key: S.key, action }, payload || {})),
      redirect: 'follow'
    }).finally(() => clearTimeout(timer));
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'خطأ غير معروف');
    return data;
  }

  function apply(data, fromCache) {
    const raw = JSON.stringify({ r: data.rows, s: data.settings });
    const prevCount = S.rows.length, hadData = !!S.raw;
    S.role = data.role; S.viewKey = data.viewKey || null;
    if (!fromCache) { S.lastSync = Date.now(); S.error = ''; }
    const changed = raw !== S.raw;
    if (changed) {
      S.raw = raw; S.rows = data.rows; S.settings = data.settings;
      compute();
      if (!fromCache) LS.set(NS + 'cache', JSON.stringify({ role: data.role, rows: data.rows, settings: data.settings, at: S.lastSync }));
      if (hadData && !fromCache && S.role === 'viewer') {
        toast(data.rows.length > prevCount ? 'وصلت حركة جديدة' : 'تم تحديث البيانات');
      }
    }
    chrome();
    if (changed || fromCache) render();
  }

  async function sync(manual) {
    if (S.busy || !S.key || !API) return;
    S.busy = true; $('syncBtn').classList.add('spin');
    try {
      apply(await api('list'));
      if (manual) toast('البيانات محدّثة');
    } catch (e) {
      if (e.message === 'UNAUTHORIZED') { LS.del(NS + 'key'); LS.del(NS + 'cache'); S.key = null; S.raw = ''; return gate('رمز الدخول غير صحيح'); }
      S.error = navigator.onLine === false ? 'لا يوجد اتصال بالإنترنت — تُعرض آخر بيانات محفوظة' : 'تعذّر الاتصال بالملف — تُعرض آخر بيانات محفوظة';
      chrome();
    } finally {
      S.busy = false; $('syncBtn').classList.remove('spin');
    }
  }

  /* ================= عناصر الواجهة الثابتة ================= */
  function chrome() {
    const admin = S.role === 'admin';
    $('entity').textContent = S.settings.entity || 'جمعية الناصر';
    const chip = $('roleChip');
    chip.hidden = !S.role;
    chip.textContent = admin ? 'مدير الحساب' : 'عرض فقط';
    $('fab').hidden = !admin;
    document.body.classList.toggle('has-fab', admin);
    if (DEMO) {
      $('demobar').hidden = false;
      $('demoRole').textContent = admin ? 'جرّب وضع «عرض فقط»' : 'جرّب وضع «مدير الحساب»';
    }
    const sl = $('syncline');
    sl.classList.toggle('err', !!S.error);
    sl.textContent = S.error || (S.lastSync ? 'آخر مزامنة ' + new Date(S.lastSync).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' • تحديث تلقائي' : '');
  }

  let toastT;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 2600);
  }

  /* ================= الشاشات ================= */
  const ICON_IN = '<svg viewBox="0 0 24 24"><path d="M12 4v14M6 12l6 6 6-6"/></svg>';
  const ICON_OUT = '<svg viewBox="0 0 24 24"><path d="M12 20V6M6 12l6-6 6 6"/></svg>';

  function mvTitle(m) {
    // نفس صيغة اسم ملف الإيصال في مجلد Drive (يُضاف له التاريخ هناك)
    if (m.isIn) return 'استلام من ' + (m.sender || 'الجمعية');
    return 'تحويل ل ' + (m.to || m.recipient || 'الجمعية');
  }
  function mvCard(m) {
    const sub = m.isIn
      ? [m.from, m.comm !== null ? 'عمولة ' + (m.comm < 1 ? pct(m.comm) : n2(m.comm)) : ''].filter(Boolean).join(' • ')
      : [m.from ? 'من ' + m.from : '', m.cur === 'ILS' && m.rate ? 'سعر ' + m.rate : ''].filter(Boolean).join(' • ');
    return `<button class="mv ${m.isIn ? 'in' : 'out'}" data-act="detail" data-r="${m.r}">
      <span class="mv-ic">${m.isIn ? ICON_IN : ICON_OUT}</span>
      <span class="mv-main">
        <span class="mv-title">${esc(mvTitle(m))}</span>
        <span class="mv-sub">${m.receipt ? '<span class="clip" title="إيصال مرفق">📎</span> ' : ''}${m.check !== 'سليم' ? `<span class="warn">${esc(m.check)}</span>` : esc(sub || fmtDate(m.date))}</span>
      </span>
      <span class="mv-amt"><b>${m.isIn ? '+' : '−'}${money(m.amount, m.cur)}</b>
        <small>${m.cur === 'ILS' || m.isIn ? (m.isIn ? 'صافي ' : '≈ ') + usd(m.j) : 'الرصيد ' + usd(m.bal)}</small></span>
    </button>`;
  }

  function chartSvg(list, opening) {
    if (list.length < 2) return '';
    const pts = [opening].concat(list.map(m => m.bal));
    const W = 320, H = 110, P = 6;
    const max = Math.max.apply(null, pts.concat([0])), min = Math.min.apply(null, pts.concat([0]));
    const x = i => P + (i * (W - 2 * P)) / (pts.length - 1);
    const y = v => H - P - ((v - min) * (H - 2 * P)) / (max - min || 1);
    const line = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="تطور الرصيد">
      <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d4902f" stop-opacity=".35"/><stop offset="1" stop-color="#d4902f" stop-opacity="0"/></linearGradient></defs>
      <path d="${line} L${x(pts.length - 1).toFixed(1)} ${y(0).toFixed(1)} L${x(0).toFixed(1)} ${y(0).toFixed(1)} Z" fill="url(#g)"/>
      <line x1="${P}" x2="${W - P}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="#cfc8b9" stroke-dasharray="3 4"/>
      <path d="${line}" fill="none" stroke="#d4902f" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${x(pts.length - 1).toFixed(1)}" cy="${y(pts[pts.length - 1]).toFixed(1)}" r="4" fill="#1f2530" stroke="#d4902f" stroke-width="2"/>
    </svg>`;
  }

  const views = {
    home() {
      const { list, t } = S.calc;
      const neg = t.balance < -0.004;
      const recent = list.slice(-5).reverse();
      return `
      <section class="hero">
        <div class="hero-label">الرصيد الحالي (USD)</div>
        <div class="hero-val ${neg ? 'neg' : ''}">${usd(t.balance)}</div>
        <div class="hero-note">${neg ? 'مدفوع زيادة عن المستحق للجمعية' : 'مبلغ متبقٍ ومستحق للجمعية بالدولار'}</div>
        <div class="hero-row">
          <div><small>عدد الحركات</small><b class="num">${list.length}</b></div>
          <div><small>استلام</small><b class="num">${t.nIn}</b></div>
          <div><small>تحويل</small><b class="num">${t.nOut}</b></div>
        </div>
      </section>
      <div class="kpis">
        <div class="kpi in"><small>إجمالي الوارد الصافي (USD)</small><b>${usd(t.netIn)}</b></div>
        <div class="kpi out"><small>إجمالي المسدد — مكافئ (USD)</small><b>${usd(t.paid)}</b></div>
        <div class="kpi gold"><small>إجمالي العمولة المخصومة (USD)</small><b>${usd(t.comm)}</b></div>
        <div class="kpi"><small>الرصيد الافتتاحي (USD)</small><b>${usd(t.opening)}</b></div>
        <div class="kpi out"><small>مسدد بالشيكل — مكافئ (USD)</small><b>${usd(t.paidIlsUsd)}</b></div>
        <div class="kpi out"><small>إجمالي الشيكل المدفوع (ILS)</small><b>${ils(t.ilsPaid)}</b></div>
      </div>
      ${list.length > 1 ? `<h2 class="sec">تطور الرصيد</h2>
      <div class="card chart">${chartSvg(list, t.opening)}
        <div class="chart-legend"><span>${fmtDate(list[0].date)}</span><span>${fmtDate(list[list.length - 1].date)}</span></div>
      </div>` : ''}
      <h2 class="sec">آخر الحركات <button data-tab="list">عرض الكل</button></h2>
      ${recent.map(mvCard).join('') || '<div class="empty">لا توجد حركات بعد</div>'}`;
    },

    list() {
      const f = S.filter;
      const chip = (grp, v, label) => `<button data-act="filter" data-g="${grp}" data-v="${v}" class="${f[grp] === v ? 'on' : ''}">${label}</button>`;
      return `
      <input class="search" id="q" type="search" placeholder="بحث بالاسم أو الحساب أو المبلغ…" value="${esc(f.q)}">
      <div class="chips">
        ${chip('type', 'all', 'الكل')}${chip('type', 'in', 'استلام')}${chip('type', 'out', 'تحويل')}
        ${chip('cur', 'USD', 'دولار')}${chip('cur', 'ILS', 'شيكل')}
      </div>
      <div id="listBody">${listBody()}</div>`;
    },

    reports() {
      const { list, t } = S.calc;
      if (!list.length) return '<div class="empty">لا توجد بيانات</div>';
      const months = {};
      const dest = {}, src = {};
      list.forEach(m => {
        const ym = (m.date || '').slice(0, 7);
        const o = months[ym] || (months[ym] = { in: 0, out: 0, comm: 0, n: 0 });
        o.in += m.k; o.out += m.l; o.n++;
        if (m.isIn) {
          o.comm += m.i;
          const s = m.sender || 'غير محدد';
          (src[s] || (src[s] = { v: 0, n: 0 })).v += m.h; src[s].n++;
        } else {
          const d = m.to || 'غير محدد';
          (dest[d] || (dest[d] = { v: 0, n: 0 })).v += m.l; dest[d].n++;
        }
      });
      const bars = (obj, cls) => {
        const arr = Object.entries(obj).sort((a, b) => b[1].v - a[1].v);
        const max = arr.length ? arr[0][1].v : 1;
        return arr.map(([name, o]) => `<div class="bar-row">
          <div class="bar-head"><span>${esc(name)} <small>(${o.n})</small></span><b>${usd(o.v)}</b></div>
          <div class="bar ${cls}"><i style="width:${Math.max(2, (o.v / max) * 100).toFixed(1)}%"></i></div></div>`).join('');
      };
      const avgRate = t.paidIlsUsd > 0 ? t.ilsPaid / t.paidIlsUsd : 0;
      const avgComm = t.gross > 0 ? t.comm / t.gross : 0;
      return `
      <div class="kpis" style="margin-top:6px">
        <div class="kpi gold"><small>متوسط سعر الصرف المرجّح (₪ لكل $)</small><b class="num">${avgRate ? avgRate.toFixed(4) : '—'}</b></div>
        <div class="kpi gold"><small>متوسط نسبة العمولة على الوارد</small><b class="num">${(avgComm * 100).toFixed(2)}%</b></div>
        <div class="kpi in"><small>إجمالي المستلم قبل العمولة (USD)</small><b>${usd(t.gross)}</b></div>
        <div class="kpi out"><small>المسدد بالدولار مباشرة (USD)</small><b>${usd(t.paid - t.paidIlsUsd)}</b></div>
      </div>
      <h2 class="sec">الملخص الشهري (USD)</h2>
      <div class="card"><table class="tbl">
        <tr><th>الشهر</th><th>وارد صافي</th><th>مسدد</th><th>عمولة</th></tr>
        ${Object.keys(months).sort().reverse().map(ym => `<tr><td>${fmtMonth(ym)}</td><td>${usd(months[ym].in)}</td><td>${usd(months[ym].out)}</td><td>${usd(months[ym].comm)}</td></tr>`).join('')}
        <tr><td><b>الإجمالي</b></td><td><b>${usd(t.netIn)}</b></td><td><b>${usd(t.paid)}</b></td><td><b>${usd(t.comm)}</b></td></tr>
      </table></div>
      <h2 class="sec">الوارد حسب المرسل (قبل العمولة)</h2>
      <div class="card">${bars(src, 'in')}</div>
      <h2 class="sec">المسدد حسب الحساب المحول إليه</h2>
      <div class="card">${bars(dest, '')}</div>`;
    },

    more() {
      const s = S.settings, admin = S.role === 'admin';
      return `
      <h2 class="sec">بيانات الحساب</h2>
      <div class="card">
        <div class="kv"><span>اسم الجهة</span><span>${esc(s.entity)}</span></div>
        <div class="kv"><span>اسم صاحب الحساب</span><span>${esc(s.owner)}</span></div>
        <div class="kv"><span>الرصيد الافتتاحي</span><span>${usd(Number(s.opening) || 0)}</span></div>
        <div class="kv"><span>العملة الأساسية</span><span>USD ($)</span></div>
        <div class="kv"><span>تعريف سعر الصرف</span><span>عدد الشواكل مقابل دولار واحد (₪ لكل $)</span></div>
        <div class="kv"><span>معنى الرصيد الموجب</span><span>مبلغ متبقٍ ومستحق للجمعية بالدولار</span></div>
        <div class="kv"><span>صلاحيتك</span><span>${admin ? 'مدير الحساب — إضافة وتعديل' : 'عرض فقط'}</span></div>
      </div>
      <h2 class="sec">حاسبة تسوية تحويل بالشيكل</h2>
      <div class="card calc">
        <div class="f" style="margin:0"><label>المبلغ بالشيكل</label><input id="cA" type="number" inputmode="decimal" value="3700"></div>
        <div class="f" style="margin:0"><label>سعر الصرف (₪/$)</label><input id="cR" type="number" inputmode="decimal" value="2.95"></div>
        <div class="calc-out"><span class="muted">المُرصّد بالدولار</span><b id="cO">${usd(3700 / 2.95)}</b></div>
      </div>
      <h2 class="sec">قواعد النظام</h2>
      <div class="card"><ol class="rules">
        <li>الرصيد الأساسي والنهائي دائمًا بالدولار.</li>
        <li>الاستلام من الجمعية يُسجَّل بالدولار، وتُخصم منه العمولة (نسبة مئوية أو مبلغ ثابت).</li>
        <li>عمولة الوارد فقط هي التي تخفض المبلغ المستحق للجمعية.</li>
        <li>التحويل بالدولار للجمعية يُخصم من الرصيد كما هو بدون عمولة.</li>
        <li>التحويل بالشيكل: المُرصّد بالدولار = مبلغ الشيكل ÷ سعر الصرف، ثم يُخصم من رصيد الدولار.</li>
        <li>الرصيد الموجب مبلغ متبقٍ للجمعية، والسالب يعني أن الوسيط دفع زيادة.</li>
        <li>أي حركة عليها تنبيه في «فحص الحركة» يجب تصحيحها قبل اعتمادها.</li>
      </ol></div>
      ${admin && S.viewKey ? `<h2 class="sec">مشاركة التطبيق</h2>
      <div class="card"><p class="muted" style="margin:0 0 10px;font-size:13.5px">رابط العرض فقط لمدير الجمعية — يرى كل الحركات والمؤشرات دون إمكانية الإضافة أو التعديل.</p>
        <button class="btn gold" data-act="share">مشاركة رابط العرض</button></div>` : ''}
      <div class="btn-row"><button class="btn ghost" data-act="refresh">تحديث البيانات الآن</button></div>
      <div class="btn-row"><button class="btn ghost" data-act="update-app">تحديث التطبيق لآخر نسخة</button></div>
      <p class="muted" style="text-align:center;font-size:12px;margin:14px 0 0">إصدار التطبيق <span class="num">${APP_VERSION}</span></p>`;
    }
  };

  function listBody() {
    const f = S.filter, q = f.q.trim().toLowerCase();
    const items = S.calc.list.filter(m => {
      if (f.type === 'in' && !m.isIn) return false;
      if (f.type === 'out' && m.isIn) return false;
      if (f.cur !== 'all' && m.cur !== f.cur) return false;
      if (q) {
        const hay = [m.sender, m.from, m.recipient, m.to, m.ref, m.by, m.notes, m.date, m.amount, m.type, m.no].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).reverse();
    if (!items.length) return '<div class="empty">لا توجد حركات مطابقة</div>';
    const tin = items.reduce((a, m) => a + m.k, 0), tout = items.reduce((a, m) => a + m.l, 0);
    let html = `<div class="summary-bar"><span>${items.length} حركة</span><span>وارد ${usd(tin)} • مسدد ${usd(tout)}</span></div>`;
    let last = '';
    items.forEach(m => {
      if (m.date !== last) { html += `<div class="day">${fmtDate(m.date)}</div>`; last = m.date; }
      html += mvCard(m);
    });
    return html;
  }

  function render() {
    if (!S.calc) return;
    $('view').innerHTML = views[S.tab]();
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
  }

  /* ================= النوافذ ================= */
  function openSheet(title, body) {
    $('overlay').innerHTML = `<div class="backdrop" data-act="backdrop"><div class="sheet">
      <div class="sheet-head"><h3>${title}</h3><button class="x" data-act="close" aria-label="إغلاق">✕</button></div>${body}</div></div>`;
    document.body.style.overflow = 'hidden';
  }
  function closeSheet() { $('overlay').innerHTML = ''; document.body.style.overflow = ''; form = null; }

  function detail(r) {
    const m = S.calc.list.find(x => x.r === r);
    if (!m) return;
    const kv = (k, v) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`;
    const txt = v => (v ? esc(v) : '<span class="muted">—</span>');
    openSheet('حركة رقم ' + m.no, `
      <div class="d-amt">
        <span class="badge ${m.isIn ? 'in' : 'out'}">${esc(m.type)}</span>
        <b>${money(m.amount, m.cur)}</b>
        <span>${fmtDate(m.date)}</span>
      </div>
      <div class="card">
        ${kv('عملة الحركة', m.cur)}
        ${kv('المبلغ بعملة الحركة', money(m.amount, m.cur))}
        ${kv('العمولة (% أو مبلغ)', m.comm === null ? '—' : m.comm < 1 ? `<span class="num">${pct(m.comm)}</span>` : `<span class="num">${n2(m.comm)}</span>`)}
        ${kv('سعر الصرف (₪ لكل $)', m.rate ? `<span class="num">${m.rate}</span>` : '—')}
        ${kv('الإجمالي (USD)', usd(m.h))}
        ${kv('العمولة (USD)', usd(m.i))}
        ${kv('المبلغ المُرصّد (USD)', `<b>${usd(m.j)}</b>`)}
        ${kv('وارد مستحق (+USD)', usd(m.k))}
        ${kv('مسدد للجمعية (-USD)', usd(m.l))}
        ${kv('الرصيد الجاري (USD)', `<b>${usd(m.bal)}</b>`)}
      </div>
      <div class="card" style="margin-top:10px">
        ${kv('اسم المرسل', txt(m.sender))}
        ${kv('الحساب المحول منه', txt(m.from))}
        ${kv('اسم المستلم', txt(m.recipient))}
        ${kv('الحساب المحول إليه', txt(m.to))}
        ${kv('رقم المرجع', txt(m.ref))}
        ${kv('مُدخل الحركة', txt(m.by))}
        ${kv('فحص الحركة', `<span class="badge ${m.check === 'سليم' ? 'ok' : 'bad'}">${esc(m.check)}</span>`)}
        ${kv('ملاحظات', txt(m.notes))}
        ${kv('الإيصال', m.receipt ? '<span class="badge ok">مرفق</span>' : '<span class="muted">غير مرفق</span>')}
      </div>
      ${m.receipt ? `<div class="btn-row"><button class="btn ghost" data-act="receipt" data-r="${m.r}">عرض الإيصال</button></div>` : ''}
      ${S.role === 'admin' ? `<div class="btn-row">
        <button class="btn" data-act="edit" data-r="${m.r}">تعديل</button>
        <button class="btn danger" data-act="del" data-r="${m.r}">حذف</button></div>` : ''}`);
  }

  /* ================= نموذج الإضافة والتعديل (للمدير فقط) ================= */
  let form = null;

  function openForm(r) {
    const m = r ? S.rows.find(x => x.r === r) : null;
    form = {
      r: m ? m.r : null,
      opId: Date.now().toString(36) + Math.random().toString(36).slice(2, 10),
      receipt: null, hasReceipt: !!(m && m.receipt), removeReceipt: false,
      expect: m ? { date: m.date, type: m.type, amount: m.amount } : null,
      type: m ? (m.type === T_IN ? 'in' : 'out') : 'out',
      cur: m ? m.cur : 'ILS',
      cmode: m && m.comm !== null && m.comm >= 1 ? 'fix' : 'pct'
    };
    const v = k => esc(m && m[k] !== null && m[k] !== undefined ? m[k] : '');
    const commVal = m && m.comm !== null ? (m.comm < 1 ? Math.round(m.comm * 1e6) / 1e4 : m.comm) : '';
    const uniq = k => Array.from(new Set(S.rows.map(x => (x[k] || '').trim()).filter(Boolean)));
    const dl = (id, k) => `<datalist id="${id}">${uniq(k).map(x => `<option value="${esc(x)}">`).join('')}</datalist>`;
    const lastRate = (S.rows.slice().reverse().find(x => x.rate) || {}).rate || '';
    openSheet(m ? 'تعديل الحركة' : 'حركة جديدة', `
      <form id="mvForm" autocomplete="off">
        <div class="f"><label>نوع الحركة</label>
          <div class="seg type" data-seg="type"><button type="button" data-v="in">استلام من الجمعية</button><button type="button" data-v="out">تحويل بنكي للجمعية</button></div></div>
        <div class="f2">
          <div class="f"><label>التاريخ</label><input name="date" type="date" required value="${m ? v('date') : today()}"></div>
          <div class="f"><label>عملة الحركة</label>
            <div class="seg" data-seg="cur"><button type="button" data-v="USD">USD $</button><button type="button" data-v="ILS">ILS ₪</button></div></div>
        </div>
        <div class="f2">
          <div class="f"><label>المبلغ بعملة الحركة</label><input name="amount" type="number" inputmode="decimal" step="any" min="0" required value="${v('amount')}" placeholder="0.00"></div>
          <div class="f" id="fRate"><label>سعر الصرف (₪ لكل $)</label><input name="rate" type="number" inputmode="decimal" step="any" min="0" value="${m ? v('rate') : lastRate}" placeholder="3.20"></div>
        </div>
        <div class="f" id="fComm"><label>العمولة (نسبة أو مبلغ ثابت)</label>
          <div class="inline"><input name="comm" type="number" inputmode="decimal" step="any" min="0" value="${commVal}" placeholder="مثال: 4">
            <div class="seg" data-seg="cmode"><button type="button" data-v="pct">%</button><button type="button" data-v="fix">مبلغ</button></div></div></div>
        <div class="preview" id="preview"></div>
        <div class="f2" style="margin-top:12px">
          <div class="f"><label>اسم المرسل</label><input name="sender" list="dlS" value="${v('sender')}"></div>
          <div class="f"><label>الحساب المحول منه</label><input name="from" list="dlF" value="${v('from')}"></div>
        </div>
        <div class="f2">
          <div class="f"><label>اسم المستلم</label><input name="recipient" list="dlR" value="${m ? v('recipient') : 'ابراهيم جمال'}"></div>
          <div class="f"><label>الحساب المحول إليه</label><input name="to" list="dlT" value="${v('to')}"></div>
        </div>
        <div class="f2">
          <div class="f"><label>رقم المرجع</label><input name="ref" value="${v('ref')}"></div>
          <div class="f"><label>مُدخل الحركة</label><input name="by" value="${m ? v('by') : 'باسل'}"></div>
        </div>
        <div class="f"><label>ملاحظات</label><textarea name="notes" rows="2">${v('notes')}</textarea></div>
        ${DEMO ? '' : `<div class="f"><label>إيصال التحويل (صورة)</label>
          <input type="file" id="rcFile" accept="image/*" hidden>
          <div class="rc" id="rcBox"></div></div>`}
        ${dl('dlS', 'sender')}${dl('dlF', 'from')}${dl('dlR', 'recipient')}${dl('dlT', 'to')}
        <button class="btn gold" id="saveBtn" type="submit">${m ? 'حفظ التعديل' : 'حفظ الحركة'}</button>
      </form>`);
    rcRender();
    formSync();
  }

  function formRow() {
    const fd = new FormData($('mvForm'));
    const num = k => { const s = String(fd.get(k) || '').trim(); return s === '' ? null : Number(s); };
    const isIn = form.type === 'in';
    let comm = isIn ? num('comm') : null, commErr = '';
    if (comm !== null) {
      if (form.cmode === 'pct') { if (comm >= 100) commErr = 'النسبة يجب أن تكون أقل من 100%'; comm = comm / 100; }
      else if (comm > 0 && comm < 1) commErr = 'المبلغ الثابت يجب أن يكون 1 أو أكثر (أو استخدم النسبة)';
      if (comm === 0) comm = null;
    }
    const t = k => String(fd.get(k) || '').trim();
    return {
      row: {
        date: t('date'), type: isIn ? T_IN : T_OUT, cur: form.cur, amount: num('amount') || 0,
        comm, rate: form.cur === 'ILS' ? num('rate') : null,
        sender: t('sender'), from: t('from'), recipient: t('recipient'), to: t('to'), ref: t('ref'), by: t('by'), notes: t('notes')
      }, commErr
    };
  }

  /* ---------- إيصال الحركة ---------- */
  // تُصغَّر الصورة وتُضغط على الهاتف قبل الرفع لتناسب الاتصال الضعيف
  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        const k = Math.min(1, 1500 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        const d = c.toDataURL('image/jpeg', 0.72);
        resolve({ mime: 'image/jpeg', data: d.split(',')[1], preview: d });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('تعذّرت قراءة الصورة')); };
      img.src = url;
    });
  }

  function rcRender() {
    const box = $('rcBox');
    if (!box || !form) return;
    if (form.receipt) {
      const kb = Math.round(form.receipt.data.length * 0.75 / 1024);
      box.innerHTML = `<img src="${form.receipt.preview}" alt="">
        <div class="rc-info"><b>صورة جاهزة للرفع</b><small class="num">${kb} KB</small>
        <span><button type="button" data-act="rc-pick">تغيير</button><button type="button" data-act="rc-remove">إزالة</button></span></div>`;
    } else if (form.hasReceipt && !form.removeReceipt) {
      box.innerHTML = `<div class="rc-info"><b>يوجد إيصال مرفق بهذه الحركة</b>
        <span><button type="button" data-act="rc-pick">استبدال</button><button type="button" data-act="rc-remove">حذف الإيصال</button></span></div>`;
    } else {
      box.innerHTML = `<button type="button" class="rc-add" data-act="rc-pick">＋ إرفاق صورة الإيصال</button>${form.hasReceipt ? '<small class="warn">سيُحذف الإيصال الحالي عند الحفظ</small>' : ''}`;
    }
  }

  async function showReceipt(r) {
    const m = S.calc.list.find(x => x.r === r);
    if (!m) return;
    toast('جارٍ تحميل الإيصال…');
    try {
      const d = await api('receipt', { r, expect: { date: m.date, type: m.type, amount: m.amount } });
      const src = 'data:' + d.mime + ';base64,' + d.data;
      openSheet('إيصال الحركة رقم ' + m.no, `<p class="muted" style="margin:0 2px 10px;font-size:13px">${esc(d.name)}</p>
        <img class="receipt" src="${src}" alt="إيصال">
        <div class="btn-row"><a class="btn ghost" href="${src}" download="${esc(d.name)}">تنزيل الصورة</a>
        <button class="btn" data-act="detail" data-r="${m.r}">رجوع للتفاصيل</button></div>`);
      $('toast').hidden = true;
    } catch (e) {
      toast('تعذّر تحميل الإيصال: ' + (navigator.onLine === false ? 'لا يوجد إنترنت' : e.message));
    }
  }

  function formSync() {
    if (!form) return;
    document.querySelectorAll('#mvForm [data-seg]').forEach(seg => {
      seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === form[seg.dataset.seg]));
    });
    $('fRate').style.visibility = form.cur === 'ILS' ? '' : 'hidden';
    $('fComm').hidden = form.type !== 'in';
    const { row, commErr } = formRow();
    const c = calcRow(row);
    // الرصيد قبل هذه الحركة: عند التعديل نستبعد أثر الحركة القديمة
    const t = S.calc.t;
    let base = t.balance;
    if (form.r) { const old = S.calc.list.find(x => x.r === form.r); if (old) base -= old.k - old.l; }
    const check = commErr || c.check;
    const kv = (k, val, cls) => `<div class="kv ${cls || ''}"><span>${k}</span><span>${val}</span></div>`;
    $('preview').innerHTML =
      kv('الإجمالي (USD)', usd(c.h)) +
      (c.isIn ? kv('العمولة (USD)', usd(c.i)) : '') +
      kv('المبلغ المُرصّد (USD)', usd(c.j), 'big') +
      kv('الرصيد بعد الحركة', usd(base + c.k - c.l)) +
      kv('فحص الحركة', `<span class="badge ${check === 'سليم' ? 'ok' : 'bad'}">${esc(check)}</span>`);
    $('saveBtn').disabled = check !== 'سليم' || !row.date;
  }

  async function save() {
    const { row, commErr } = formRow();
    if (commErr || calcRow(row).check !== 'سليم') return;
    const btn = $('saveBtn');
    btn.disabled = true; btn.textContent = 'جارٍ الحفظ…';
    try {
      const rc = form.receipt ? { mime: form.receipt.mime, data: form.receipt.data } : undefined;
      if (rc) btn.textContent = 'جارٍ الحفظ ورفع الإيصال…';
      const data = form.r
        ? await api('update', { r: form.r, expect: form.expect, row, receipt: rc, removeReceipt: form.removeReceipt || undefined })
        : await api('add', { row, opId: form.opId, receipt: rc });
      const wasEdit = !!form.r;
      closeSheet(); apply(data);
      toast(data.warn || (wasEdit ? 'تم حفظ التعديل' : 'تمت إضافة الحركة ومزامنتها'));
    } catch (e) {
      btn.disabled = false; btn.textContent = 'إعادة المحاولة';
      toast('لم يتأكد الحفظ: ' + (navigator.onLine === false ? 'لا يوجد إنترنت' : 'الاتصال ضعيف') + ' — أعد المحاولة');
      // قد يكون الطلب وصل للملف دون أن يصل الرد؛ إعادة المحاولة آمنة لأن الخادم يتجاهل الطلب المكرر (opId)
    }
  }

  async function remove(r) {
    const m = S.calc.list.find(x => x.r === r);
    if (!m || !confirm(`حذف الحركة رقم ${m.no} نهائيًا من الملف؟\n${m.type} — ${m.amount} ${m.cur} — ${m.date}`)) return;
    try {
      const data = await api('delete', { r, expect: { date: m.date, type: m.type, amount: m.amount } });
      closeSheet(); apply(data); toast('تم حذف الحركة');
    } catch (e) {
      closeSheet();
      toast('لم يتأكد الحذف — جارٍ تحديث البيانات');
      sync(); // لمعرفة الحالة الفعلية في الملف قبل أي محاولة أخرى
    }
  }

  function share() {
    const url = location.origin + location.pathname + '#k=' + S.viewKey;
    if (navigator.share) navigator.share({ title: 'حساب جمعية الناصر', url }).catch(() => {});
    else if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => toast('تم نسخ رابط العرض'));
    else prompt('انسخ رابط العرض:', url);
  }

  // يمسح ملفات الواجهة المحفوظة فقط (لا الرمز ولا البيانات) ثم يعيد التحميل من الخادم
  async function updateApp() {
    toast('جارٍ تحديث التطبيق…');
    try {
      if (window.caches) { const ks = await caches.keys(); await Promise.all(ks.filter(k => k.startsWith(DEMO ? 'nasserdemo-' : 'nasser-')).map(k => caches.delete(k))); }
      if (navigator.serviceWorker) { const reg = await navigator.serviceWorker.getRegistration(); if (reg) await reg.update().catch(() => {}); }
    } catch (e) { /* نكمل بإعادة التحميل على أي حال */ }
    location.reload();
  }

  function gate(msg) {
    document.body.classList.remove('has-fab');
    $('fab').hidden = true; $('tabs').hidden = true; $('roleChip').hidden = true; $('syncline').textContent = '';
    if (!API) { $('view').innerHTML = '<div class="gate"><h1>التطبيق غير مربوط بعد</h1><p class="muted">لم يُضبط رابط ملف الحساب في config.js.</p></div>'; return; }
    $('view').innerHTML = `<div class="gate"><h1>حساب جمعية الناصر</h1>
      <p class="muted">${esc(msg || 'افتح التطبيق من الرابط الذي وصلك، أو أدخل رمز الدخول.')}</p>
      <form id="gateForm"><div class="f"><input name="k" placeholder="رمز الدخول" autocomplete="off" required></div>
      <button class="btn gold" style="max-width:320px;margin:auto">دخول</button></form></div>`;
  }

  function start() {
    $('tabs').hidden = false;
    const cached = LS.get(NS + 'cache');
    if (cached) { try { const c = JSON.parse(cached); S.lastSync = c.at || 0; apply(c, true); } catch (e) { /* نسخة تالفة */ } }
    if (!S.calc) $('view').innerHTML = '<div class="empty">جارٍ تحميل البيانات…</div>';
    sync();
  }

  /* ================= الأحداث ================= */
  document.addEventListener('click', e => {
    const tab = e.target.closest('[data-tab]');
    if (tab) { S.tab = tab.dataset.tab; render(); window.scrollTo(0, 0); return; }
    const seg = e.target.closest('#mvForm [data-seg] button');
    if (seg && form) { form[seg.parentElement.dataset.seg] = seg.dataset.v; formSync(); return; }
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act, r = Number(el.dataset.r);
    if (act === 'backdrop') { if (e.target === el && !form) closeSheet(); }
    else if (act === 'close') closeSheet();
    else if (act === 'refresh') sync(true);
    else if (act === 'detail') detail(r);
    else if (act === 'filter') {
      const g = el.dataset.g, v = el.dataset.v;
      if (g === 'type') S.filter.type = v; else S.filter.cur = S.filter.cur === v ? 'all' : v;
      render();
    }
    else if (act === 'share') share();
    else if (act === 'receipt') showReceipt(r);
    else if (act === 'update-app') updateApp();
    else if (act === 'demo-role') {
      S.key = S.role === 'admin' ? 'view' : 'admin';
      LS.set(NS + 'key', S.key); closeSheet();
      S.raw = ''; S.tab = 'home'; sync().then(() => { render(); toast(S.role === 'admin' ? 'أنت الآن مدير الحساب' : 'أنت الآن في وضع العرض فقط'); });
    }
    else if (act === 'demo-reset') {
      if (!confirm('إعادة البيانات التجريبية إلى حالتها الأصلية؟')) return;
      LS.del(NS + 'rows'); LS.del(NS + 'cache'); closeSheet();
      S.raw = ''; sync().then(() => toast('أُعيدت البيانات التجريبية'));
    }
    else if (S.role !== 'admin') return;
    else if (act === 'add') openForm(null);
    else if (act === 'edit') openForm(r);
    else if (act === 'del') remove(r);
    else if (act === 'rc-pick') { if ($('rcFile')) $('rcFile').click(); }
    else if (act === 'rc-remove' && form) { form.receipt = null; if (form.hasReceipt) form.removeReceipt = true; rcRender(); }
  });

  document.addEventListener('change', async e => {
    if (e.target.id !== 'rcFile' || !form) return;
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try { form.receipt = await compressImage(file); form.removeReceipt = false; rcRender(); }
    catch (err) { toast(err.message); }
  });

  document.addEventListener('input', e => {
    if (e.target.id === 'q') { S.filter.q = e.target.value; $('listBody').innerHTML = listBody(); }
    else if (e.target.id === 'cA' || e.target.id === 'cR') {
      const a = Number($('cA').value), rt = Number($('cR').value);
      $('cO').innerHTML = rt > 0 ? usd(a / rt) : '—';
    }
    else if (e.target.closest('#mvForm')) formSync();
  });

  document.addEventListener('submit', e => {
    e.preventDefault();
    if (e.target.id === 'mvForm') save();
    else if (e.target.id === 'gateForm') {
      S.key = new FormData(e.target).get('k').trim();
      LS.set(NS + 'key', S.key); start();
    }
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
  window.addEventListener('online', () => sync());
  window.addEventListener('hashchange', () => location.reload());
  setInterval(() => { if (!document.hidden && !form) sync(); }, POLL_MS);

  /* ================= التشغيل ================= */
  const hk = new URLSearchParams(location.hash.slice(1)).get('k');
  if (hk) {
    if (hk !== LS.get(NS + 'key')) LS.del(NS + 'cache');
    LS.set(NS + 'key', hk);
  }
  S.key = hk || LS.get(NS + 'key') || (DEMO ? 'admin' : null);
  if (S.key && API) start(); else gate();

  if ('serviceWorker' in navigator && !DEV) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
