// ==UserScript==
// @name         JXNU 开课安排完整导出 v3
// @namespace    https://jwc.jxnu.edu.cn/
// @version      3.4
// @description  抓开课安排 + 课程详情 + 任课教师（GM_xhr 跨协议跟随重定向）
// @match        https://jwc.jxnu.edu.cn/MyControl/Public_Kkap.aspx*
// @grant        GM_xmlhttpRequest
// @connect      jwc.jxnu.edu.cn
// ==/UserScript==

// v3.2 变更：
//  1) 修复多时段去重：_key 加上 星期+节次（v3.0 只用 课程号_班级号_学期，
//     同一个班的多个上课时段会算出相同 key，被 IndexedDB put 覆盖 / 断点续传 skip，
//     最后只剩一个时段）。
//  2) 全部展开成正常多行，避免从聊天/网页复制时长行被换行截断（v3.1 报 "s is not defined"
//     就是 openDB 那行被复制时断行所致）。
// v3.3 性能：4-5k 行不再卡死。
//  1) IndexedDB 单例连接，复用同一个 db，不再每次操作都 open（旧版会堆上万个永不关闭的连接）。
//  2) 每行入库后清掉内存里的大字段（课程信息/任课老师简介），导出时从 IDB 读，省内存。
//  3) 进度刷新限频到 150ms 一次，减少 DOM 重排。
//  4) 导出后 revokeObjectURL 释放 blob。
// v3.4 增量对账：修复「只做超集、不清旧错误数据」。
//  旧版每次只 put，从不 delete。课程被撤销、上课时间改动（节次变了 → 算出新 key）、
//  拆班/并班等，旧记录都会作为孤儿永远留在 IDB 里，导出永远是历史并集。
//  现在「开始」时先对账：当前页面对它覆盖的 (单位名称 × 学期) 范围是权威来源，
//  删除该范围内已不在当前页面的孤儿行，再增量抓取。其它单位/学期的累积数据不受影响。

(function () {
  'use strict';

  const CONCURRENCY = 6;
  const DB_NAME = 'jxnu_kkap_v3';
  const PANEL_ID = 'kkap-panel-v3';

  // ---- IndexedDB ----
  // 单例连接：整个生命周期只 open 一次并复用，避免上万个永不关闭的连接把浏览器拖死。
  let _dbPromise = null;
  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('rows')) {
          db.createObjectStore('rows', { keyPath: '_key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { _dbPromise = null; reject(req.error); };
    });
    return _dbPromise;
  }

  async function saveRow(row) {
    const db = await openDB();
    const tx = db.transaction('rows', 'readwrite');
    tx.objectStore('rows').put(row);
    return new Promise((resolve) => { tx.oncomplete = resolve; });
  }

  async function getRow(key) {
    const db = await openDB();
    return new Promise((resolve) => {
      const r = db.transaction('rows').objectStore('rows').get(key);
      r.onsuccess = () => resolve(r.result);
    });
  }

  async function getAllRows() {
    const db = await openDB();
    return new Promise((resolve) => {
      const r = db.transaction('rows').objectStore('rows').getAll();
      r.onsuccess = () => resolve(r.result);
    });
  }

  async function clearAll() {
    const db = await openDB();
    const tx = db.transaction('rows', 'readwrite');
    tx.objectStore('rows').clear();
    return new Promise((resolve) => { tx.oncomplete = resolve; });
  }

  async function countDone() {
    const all = await getAllRows();
    return all.filter((r) => r._done).length;
  }

  // 增量对账：当前页面对它覆盖的 (单位名称 × 学期) 范围是权威来源。
  // 删除 IDB 中落在这些范围、但已不在当前页面里的孤儿行——
  // 课程被撤销、上课时间改动（节次变了算出新 key）、拆班/并班等历史残留，
  // 避免重复抓取只做「超集」而一直累积过时/错误的数据。
  // 仅删除 _key 不在当前页面的行；命中当前页面的 _done 行保留，断点续传照旧 skip。
  async function reconcile(rows) {
    const scopeKey = (r) => JSON.stringify([r.单位名称 || '', r.学期 || '']);
    const liveKeys = new Set(rows.map((r) => r._key));
    const scope = new Set(rows.map(scopeKey));
    const all = await getAllRows();
    const stale = all.filter((r) => scope.has(scopeKey(r)) && !liveKeys.has(r._key));
    if (!stale.length) return 0;
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('rows', 'readwrite');
      const store = tx.objectStore('rows');
      stale.forEach((r) => store.delete(r._key));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    return stale.length;
  }

  // ---- 提取表格基础数据 ----
  function extractBaseRows() {
    const table = document.getElementById('gvContent');
    if (!table) return [];
    return Array.from(table.rows).slice(1).map((r) => {
      const c = Array.from(r.cells).map((cell) => cell.textContent.trim());
      const link = r.cells[9] ? r.cells[9].querySelector('a') : null;
      const href = link ? link.href : '';
      const bjh = (href.match(/bjh=([^&]*)/) || [])[1] || '';
      const kch = (href.match(/kch=([^&]*)/) || [])[1] || '';
      const xq = decodeURIComponent((href.match(/xq=([^&]*)/) || [])[1] || '');
      return {
        // ⚠ 关键修复：key 带上 星期(c[6]) + 节次(c[7])，避免多时段班被覆盖去重。
        _key: kch + '_' + bjh + '_' + xq + '_' + c[6] + '_' + c[7],
        序号: c[0],
        单位名称: c[1],
        课程名称: c[2],
        班级名称: c[3],
        任课教师: c[4],
        教室: c[5],
        星期: c[6],
        节次: c[7],
        授课人数: c[8],
        课程号: kch,
        班级号: bjh,
        学期: xq,
      };
    }).filter((r) => r.课程号 && r.班级号);
  }

  // ---- 网络请求 ----
  // CourseSetting 的 302 Location 是 http://，必须用 GM_xhr 才能跟（fetch/XHR 被 mixed content 拦）
  function fetchCourseID(bjh, kch, xq) {
    const url = 'https://jwc.jxnu.edu.cn/wsktNew/CourseSetting.aspx'
      + '?bjh=' + bjh + '&kch=' + kch + '&xq=' + encodeURIComponent(xq);
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        timeout: 15000,
        onload: (r) => {
          const m = /CourseID=(\d+)/.exec(r.finalUrl || '')
            || /CourseID=(\d+)/.exec(r.responseText || '');
          if (m) resolve(m[1]);
          else reject(new Error('no CourseID, finalUrl=' + r.finalUrl));
        },
        onerror: (e) => reject(new Error('GM xhr error: ' + (e.error || e.statusText || 'unknown'))),
        ontimeout: () => reject(new Error('GM xhr timeout')),
      });
    });
  }

  const COURSE_LABELS = ['课程名称', '课程名称标识', '课程号', '学分', '课程英文名称', '内容简介'];

  function parseCourseInfo(doc) {
    const out = {};
    doc.querySelectorAll('td').forEach((td) => {
      const key = (td.textContent || '').replace(/\s+/g, '').replace(/[：:].*$/, '');
      if (COURSE_LABELS.includes(key)) {
        const next = td.nextElementSibling;
        if (next && !(key in out)) {
          out[key] = (next.textContent || '').trim().replace(/\s+/g, ' ');
        }
      }
    });
    return out;
  }

  async function fetchCourseInfo(courseID) {
    const r = await fetch('../wsktNew/CourseInfor.aspx?CourseID=' + courseID, { credentials: 'include' });
    const html = await r.text();
    return parseCourseInfo(new DOMParser().parseFromString(html, 'text/html'));
  }

  async function fetchTeacher(courseID) {
    const r = await fetch('../wsktNew/Teacher.aspx?CourseID=' + courseID, { credentials: 'include' });
    const html = await r.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const userNumMatch = html.match(/UserNum=(\d+)/);
    const pick = (id) => {
      const el = doc.getElementById(id);
      return el ? el.textContent.trim() : '';
    };
    return {
      UserNum: userNumMatch ? userNumMatch[1] : '',
      姓名: pick('_ctl0_cphContent_lblName'),
      性别: pick('_ctl0_cphContent_lblSex'),
      Email: pick('_ctl0_cphContent_lblEmail'),
      职称: pick('_ctl0_cphContent_lblZC'),
      教学简介: pick('_ctl0_cphContent_lblJJ'),
    };
  }

  // ---- 并发执行 ----
  const courseInfoCache = new Map();
  const teacherCache = new Map();
  let running = false;
  let paused = false;

  async function enrichRow(row, retries) {
    if (retries === undefined) retries = 2;
    try {
      const cid = await fetchCourseID(row.班级号, row.课程号, row.学期);
      if (!cid) throw new Error('no CourseID');
      row.CourseID = cid;

      let info;
      if (courseInfoCache.has(row.课程号)) {
        info = courseInfoCache.get(row.课程号);
      } else {
        info = await fetchCourseInfo(cid);
        courseInfoCache.set(row.课程号, info);
      }
      row.课程信息 = info;

      const teacher = await fetchTeacher(cid);
      if (teacher.UserNum && teacherCache.has(teacher.UserNum)) {
        row.任课老师 = teacherCache.get(teacher.UserNum);
      } else {
        row.任课老师 = teacher;
        if (teacher.UserNum) teacherCache.set(teacher.UserNum, teacher);
      }

      row._done = true;
      delete row._error;
    } catch (e) {
      if (retries > 0) {
        await new Promise((r) => setTimeout(r, 500));
        return enrichRow(row, retries - 1);
      }
      row._error = e.message || String(e);
      row._done = false;
    }
    await saveRow(row);
    // 释放内存：大字段（课程信息/任课老师含整段简介）已落 IDB，导出时从 IDB 读，
    // 内存数组里不再保留，避免 5000 行大文本把内存撑爆。
    row.课程信息 = undefined;
    row.任课老师 = undefined;
    return row;
  }

  async function runAll(rows, onProgress) {
    let i = 0;
    let done = 0;
    let failed = 0;
    async function worker() {
      while (i < rows.length) {
        while (paused) await new Promise((r) => setTimeout(r, 200));
        if (!running) return;
        const row = rows[i++];
        const saved = await getRow(row._key);
        if (saved && saved._done) {
          // 已抓过：只记完成数，不把 saved 的大字段拷回内存（导出时从 IDB 读）。
          row._done = true;
          done++;
          onProgress(done, failed, rows.length);
          continue;
        }
        const enriched = await enrichRow(row);
        if (enriched._done) done++;
        else failed++;
        onProgress(done, failed, rows.length);
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    return rows;
  }

  // ---- UI ----
  const baseRowCount = (document.getElementById('gvContent') ? document.getElementById('gvContent').rows.length : 1) - 1;
  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.innerHTML = [
    '<div style="position:fixed;top:10px;right:10px;z-index:99999;background:#fff;',
    'border:2px solid #337ab7;border-radius:8px;padding:12px;width:340px;',
    'box-shadow:0 4px 12px rgba(0,0,0,.3);font:13px/1.5 sans-serif;">',
    '<h3 style="margin:0 0 8px;color:#337ab7;">开课安排完整导出 v3.3</h3>',
    '<div id="kk-stat" style="padding:6px;background:#f8f8f8;border-radius:4px;',
    'margin-bottom:8px;font-size:12px;">检测到 ' + baseRowCount + ' 行</div>',
    '<div style="display:flex;flex-wrap:wrap;gap:5px;">',
    '<button id="kk-start" style="background:#337ab7;color:#fff;border:none;padding:6px 10px;border-radius:4px;cursor:pointer;">▶ 开始</button>',
    '<button id="kk-pause" style="background:#f0ad4e;color:#fff;border:none;padding:6px 10px;border-radius:4px;cursor:pointer;">⏸ 暂停</button>',
    '<button id="kk-stop" style="background:#777;color:#fff;border:none;padding:6px 10px;border-radius:4px;cursor:pointer;">■ 停止</button>',
    '<button id="kk-json" style="background:#9b59b6;color:#fff;border:none;padding:6px 10px;border-radius:4px;cursor:pointer;">📥 JSON</button>',
    '<button id="kk-csv" style="background:#5cb85c;color:#fff;border:none;padding:6px 10px;border-radius:4px;cursor:pointer;">📥 CSV</button>',
    '<button id="kk-reset" style="background:#d9534f;color:#fff;border:none;padding:6px 10px;border-radius:4px;cursor:pointer;">🗑 清</button>',
    '</div>',
    '<div id="kk-log" style="margin-top:8px;max-height:200px;overflow:auto;background:#000;',
    'color:#0f0;padding:6px;font:11px/1.4 Consolas,monospace;border-radius:4px;"></div>',
    '</div>',
  ].join('');
  document.body.appendChild(panel);

  const logEl = panel.querySelector('#kk-log');
  function log(s, c) {
    const d = document.createElement('div');
    if (c) d.style.color = c;
    d.textContent = '[' + new Date().toLocaleTimeString() + '] ' + s;
    logEl.appendChild(d);
    logEl.scrollTop = logEl.scrollHeight;
  }
  function setStat(s) {
    panel.querySelector('#kk-stat').textContent = s;
  }

  panel.querySelector('#kk-start').onclick = async () => {
    if (running) { log('已在运行', '#ff0'); return; }
    const rows = extractBaseRows();
    if (!rows.length) { log('无数据：检查是否在开课安排页、表格 id 是否 gvContent', '#f44'); return; }
    running = true;
    paused = false;
    // 增量对账：先清掉当前 (单位×学期) 范围里已不在页面的孤儿行（撤销/改时间/拆并班的旧残留），
    // 再增量抓取，避免导出只做历史超集。
    const removed = await reconcile(rows);
    if (removed) log('🧹 对账：清除 ' + removed + ' 条过时/已撤销记录', '#ff0');
    log('▶ 开始 ' + rows.length + ' 行 (并发 ' + CONCURRENCY + ')');
    const t0 = Date.now();
    let lastUI = 0;
    await runAll(rows, (done, failed, total) => {
      // 限频刷新进度：最多每 150ms 写一次 DOM，结束时强制刷一次。避免每行都触发重排。
      const now = Date.now();
      if (now - lastUI > 150 || done + failed === total) {
        lastUI = now;
        setStat('进度 ' + (done + failed) + '/' + total + '  成功 ' + done + '  失败 ' + failed);
      }
    });
    running = false;
    log('✅ 完成 用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's', '#0f0');
  };

  panel.querySelector('#kk-pause').onclick = () => {
    paused = !paused;
    log(paused ? '⏸ 暂停' : '▶ 继续', '#ff0');
  };

  panel.querySelector('#kk-stop').onclick = () => {
    running = false;
    paused = false;
    log('■ 已停止', '#ff0');
  };

  panel.querySelector('#kk-json').onclick = async () => {
    const all = await getAllRows();
    const clean = all.map((row) => {
      const copy = Object.assign({}, row);
      delete copy._key;
      delete copy._done;
      delete copy._error;
      return copy;
    });
    const blob = new Blob([JSON.stringify(clean, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'JXNU开课安排完整_' + new Date().toISOString().slice(0, 10) + '_' + clean.length + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    log('📥 JSON ' + clean.length + ' 条', '#0f0');
  };

  panel.querySelector('#kk-csv').onclick = async () => {
    const all = await getAllRows();
    const headers = [
      '序号', '单位名称', '课程名称', '班级名称', '任课教师', '教室', '星期', '节次', '授课人数',
      '课程号', '班级号', '学期', 'CourseID',
      '课程_学分', '课程_英文名', '课程_内容简介',
      '教师_UserNum', '教师_姓名', '教师_性别', '教师_Email', '教师_职称', '教师_教学简介',
      '_error',
    ];
    const rows = [headers];
    all.forEach((r) => {
      const info = r.课程信息 || {};
      const t = r.任课老师 || {};
      const flat = Object.assign({}, r, {
        CourseID: r.CourseID || '',
        '课程_学分': info['学分'] || '',
        '课程_英文名': info['课程英文名称'] || '',
        '课程_内容简介': info['内容简介'] || '',
        '教师_UserNum': t.UserNum || '',
        '教师_姓名': t.姓名 || '',
        '教师_性别': t.性别 || '',
        '教师_Email': t.Email || '',
        '教师_职称': t.职称 || '',
        '教师_教学简介': t.教学简介 || '',
        '_error': r._error || '',
      });
      rows.push(headers.map((h) => {
        const s = String(flat[h] == null ? '' : flat[h]).replace(/"/g, '""');
        return /[,"\n\r]/.test(s) ? '"' + s + '"' : s;
      }));
    });
    const blob = new Blob(['﻿' + rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'JXNU开课安排完整_' + new Date().toISOString().slice(0, 10) + '_' + all.length + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    log('📥 CSV ' + all.length + ' 条', '#0f0');
  };

  panel.querySelector('#kk-reset').onclick = async () => {
    if (!confirm('清空所有已抓取数据？')) return;
    await clearAll();
    courseInfoCache.clear();
    teacherCache.clear();
    setStat('已清空，检测到 ' + baseRowCount + ' 行');
    log('🗑 已清空', '#ff0');
  };

  (async () => {
    const done = await countDone();
    if (done) {
      setStat('检测到 ' + baseRowCount + ' 行，已有 ' + done + ' 条完成（点击 ▶ 继续）');
      log('📦 已存 ' + done + ' 条');
    }
  })();
})();
