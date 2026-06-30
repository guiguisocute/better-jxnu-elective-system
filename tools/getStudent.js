// ==UserScript==
// @name         JXNU 课表批量抓取导出
// @namespace    https://jwc.jxnu.edu.cn/
// @version      0.2.0
// @description  在江西师大教务课表页批量抓取默认学期课表，导出 JSON 和 CSV
// @match        https://jwc.jxnu.edu.cn/MyControl/All_Display.aspx*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

// v0.2.0：
//  1) 修复下拉框「全白」：给 select 显式 color-scheme:dark + option 深底浅字。
//  2) 性能（~3 万学号不再卡死）：
//     - 成功/失败计数改累加器，renderSummary 不再每次 filter 整个 results（去掉 O(n²)）。
//     - 日志最多保留 250 条节点，避免几万条 <li> 撑爆 DOM。
//     - 去掉每个学号一条的「等待 Xms」日志噪音。
//     - 导出 JSON 不再缩进，避免超大字符串把主线程卡死。

(function () {
  'use strict';

  const STORAGE_KEY = 'jxnu-schedule-exporter-input';
  const THROTTLE_STORAGE_KEY = 'jxnu-schedule-exporter-throttle';
  const PANEL_STATE_STORAGE_KEY = 'jxnu-schedule-exporter-panel-state';
  const PANEL_POSITION_STORAGE_KEY = 'jxnu-schedule-exporter-panel-position';
  const PANEL_HOST_ID = 'jxnu-schedule-exporter-host';
  const DAY_LABELS = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
  const TIME_METADATA = {
    classDuration: 40,
    breakDuration: 10,
    slots: {
      1: { startTime: '08:00', endTime: '08:40', section: 'morning' },
      2: { startTime: '08:50', endTime: '09:30', section: 'morning' },
      3: { startTime: '09:40', endTime: '10:20', section: 'morning' },
      4: { startTime: '10:30', endTime: '11:10', section: 'morning' },
      5: { startTime: '11:20', endTime: '12:00', section: 'morning' },
      6: { startTime: '14:00', endTime: '14:40', section: 'afternoon' },
      7: { startTime: '14:50', endTime: '15:30', section: 'afternoon' },
      8: { startTime: '15:40', endTime: '16:20', section: 'afternoon' },
      9: { startTime: '16:30', endTime: '17:10', section: 'afternoon' },
      10: { startTime: '19:00', endTime: '19:40', section: 'evening' },
      11: { startTime: '19:50', endTime: '20:30', section: 'evening' },
    },
  };

  const state = {
    running: false,
    results: [],
    startedAt: '',
    targetCount: 0,
    // 累加计数器：避免每抓一个就 filter 一遍整个 results（3 万时是 O(n²) 卡死主因）。
    successCount: 0,
    failedCount: 0,
    throttle: loadThrottleSettings(),
    panelCollapsed: loadPanelCollapsedState(),
    panelClosed: loadPanelClosedState(),
    panelPosition: loadPanelPosition(),
  };

  function loadThrottleSettings() {
    const defaults = {
      baseDelayMs: 1200,
      jitterMs: 800,
      batchSize: 25,
      batchPauseMs: 8000,
    };

    try {
      const saved = JSON.parse(window.localStorage.getItem(THROTTLE_STORAGE_KEY) || '{}');
      return {
        baseDelayMs: Number(saved.baseDelayMs) > 0 ? Number(saved.baseDelayMs) : defaults.baseDelayMs,
        jitterMs: Number(saved.jitterMs) >= 0 ? Number(saved.jitterMs) : defaults.jitterMs,
        batchSize: Number(saved.batchSize) > 0 ? Number(saved.batchSize) : defaults.batchSize,
        batchPauseMs: Number(saved.batchPauseMs) >= 0 ? Number(saved.batchPauseMs) : defaults.batchPauseMs,
      };
    } catch (_error) {
      return defaults;
    }
  }

  function persistThrottleSettings(settings) {
    window.localStorage.setItem(THROTTLE_STORAGE_KEY, JSON.stringify(settings));
  }

  function loadPanelCollapsedState() {
    return window.localStorage.getItem(PANEL_STATE_STORAGE_KEY) === 'collapsed';
  }

  function loadPanelClosedState() {
    return window.localStorage.getItem(`${PANEL_STATE_STORAGE_KEY}-closed`) === 'closed';
  }

  function persistPanelCollapsedState(collapsed) {
    window.localStorage.setItem(PANEL_STATE_STORAGE_KEY, collapsed ? 'collapsed' : 'expanded');
  }

  function persistPanelClosedState(closed) {
    window.localStorage.setItem(`${PANEL_STATE_STORAGE_KEY}-closed`, closed ? 'closed' : 'open');
  }

  function loadPanelPosition() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(PANEL_POSITION_STORAGE_KEY) || 'null');
      if (!saved || typeof saved.left !== 'number' || typeof saved.top !== 'number') {
        return null;
      }

      return saved;
    } catch (_error) {
      return null;
    }
  }

  function persistPanelPosition(position) {
    if (!position) {
      window.localStorage.removeItem(PANEL_POSITION_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(PANEL_POSITION_STORAGE_KEY, JSON.stringify(position));
  }

  function cleanText(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\t\r]+/g, ' ')
      .replace(/\n{2,}/g, '\n')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function cleanMultilineText(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => cleanText(line))
      .filter(Boolean);
  }

  function normalizeKeyPart(value) {
    return cleanText(value).replace(/\s+/g, '');
  }

  function detailLookupKey(courseName, teachingClass) {
    return `${normalizeKeyPart(courseName)}||${normalizeKeyPart(teachingClass)}`;
  }

  function isLocationLine(line) {
    return /^[（(]\s*.+?\s*[)）]$/.test(cleanText(line));
  }

  function extractLocation(line) {
    return cleanText(line).replace(/^[（(]\s*/, '').replace(/\s*[)）]$/, '');
  }

  function isTeachingClassDescriptor(line) {
    const normalized = cleanText(line);
    return /班/.test(normalized) || /^教工/.test(normalized) || /^合班/.test(normalized);
  }

  function isLikelyPlaceholderCourseName(line) {
    const normalized = cleanText(line);
    return /^(?:\d{2}级.*班|教工.*班|合班.*班)$/.test(normalized) || /#\d+班\.?$/.test(normalized);
  }

  function splitTeachingClassAndNextCourseName(line) {
    const normalized = cleanText(line);
    if (!normalized.includes('、')) {
      return null;
    }

    const parts = normalized.split(/\s*、\s*/, 2);
    const left = cleanText(parts[0]);
    const right = cleanText(parts[1]);
    if (!left || !right) {
      return null;
    }
    
    if (!isTeachingClassDescriptor(left) || isLocationLine(right)) {
      return null;
    }
    
    return { teachingClass: left, nextCourseName: right };
  }

  function parseStudentIds(rawInput) {
    const unique = new Set();
    return String(rawInput || '')
      .split(/\r?\n/)
      .map((line) => cleanText(line))
      .filter(Boolean)
      .filter((line) => /^\d{8,}$/.test(line))
      .filter((line) => {
        if (unique.has(line)) {
          return false;
        }

        unique.add(line);
        return true;
      });
  }

  function inferSection(startPeriod) {
    return TIME_METADATA.slots[startPeriod]?.section || '';
  }

  function getTimeRange(startPeriod, endPeriod) {
    return {
      startTime: TIME_METADATA.slots[startPeriod]?.startTime || '',
      endTime: TIME_METADATA.slots[endPeriod]?.endTime || '',
      section: inferSection(startPeriod),
    };
  }

  function buildScheduleUrl(studentId) {
    const url = new URL('/MyControl/All_Display.aspx', window.location.origin);
    url.searchParams.set('UserControl', 'Xfz_Kcb.ascx');
    url.searchParams.set('UserType', 'Student');
    url.searchParams.set('UserNum', window.btoa(studentId));
    return url.toString();
  }

  function getSelectedTermValue(doc) {
    const select = doc.querySelector('#_ctl6_ddlSterm');
    if (!select) return '';
    const selectedOption = Array.from(select.options || []).find((option) => option.defaultSelected);
    return selectedOption?.value || select.value || select.options?.[0]?.value || '';
  }

  async function fetchScheduleDocument(studentId, termValue) {
    const url = buildScheduleUrl(studentId);
    const getResp = await window.fetch(url, { credentials: 'include' });
    if (!getResp.ok) {
      throw new Error(`请求失败：HTTP ${getResp.status}`);
    }

    const getHtml = await getResp.text();
    const getDoc = new window.DOMParser().parseFromString(getHtml, 'text/html');
    
    const defaultTermValue = getSelectedTermValue(getDoc);
    if (!termValue || termValue === defaultTermValue) {
      return { doc: getDoc, url };
    }
    
    const body = new window.URLSearchParams();
    ['__VIEWSTATE', '__VIEWSTATEGENERATOR', '__EVENTVALIDATION'].forEach((name) => {
      const field = getDoc.querySelector(`[name="${name}"]`);
      if (field) {
        body.set(name, field.value || '');
      }
    });
    body.set('_ctl6:ddlSterm', termValue);
    body.set('_ctl6:btnSearch', '确定');
    
    const postResp = await window.fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    
    if (!postResp.ok) {
      throw new Error(`切换学期失败：HTTP ${postResp.status}`);
    }
    
    const postHtml = await postResp.text();
    return { doc: new window.DOMParser().parseFromString(postHtml, 'text/html'), url };
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function getThrottleDelayMs() {
    const baseDelayMs = Math.max(0, Number(state.throttle.baseDelayMs) || 0);
    const jitterMs = Math.max(0, Number(state.throttle.jitterMs) || 0);
    return baseDelayMs + Math.round(Math.random() * jitterMs);
  }

  function getCurrentStudentId() {
    const userInfoText = cleanText(document.querySelector('#_ctl6_lblUserInfor')?.textContent || '');
    return userInfoText.match(/学号[:：]\s*(\d{8,})/)?.[1] || '';
  }

  function analyzeTable(table) {
    const grid = [];
    const placements = [];
    const rows = Array.from(table?.rows || []);

    rows.forEach((row, rowIndex) => {
      let colIndex = 0;
      Array.from(row.cells).forEach((cell) => {
        while (grid[rowIndex]?.[colIndex]) {
          colIndex += 1;
        }
    
        const rowSpan = Number.parseInt(cell.getAttribute('rowspan') || '1', 10);
        const colSpan = Number.parseInt(cell.getAttribute('colspan') || '1', 10);
        placements.push({ cell, rowIndex, colIndex, rowSpan, colSpan });
    
        for (let rowOffset = 0; rowOffset < rowSpan; rowOffset += 1) {
          const targetRow = rowIndex + rowOffset;
          if (!grid[targetRow]) {
            grid[targetRow] = [];
          }
    
          for (let colOffset = 0; colOffset < colSpan; colOffset += 1) {
            grid[targetRow][colIndex + colOffset] = cell;
          }
        }
    
        colIndex += colSpan;
      });
    });
    
    return { grid, placements };
  }

  function parsePeriodsFromRowLabel(label) {
    const normalized = cleanText(label).replace(/\s+/g, '');

    if (normalized === '12') {
      return [1, 2];
    }
    
    if (normalized === '3') {
      return [3];
    }
    
    if (normalized === '4') {
      return [4];
    }
    
    if (normalized === '5') {
      return [5];
    }
    
    if (normalized === '67') {
      return [6, 7];
    }
    
    if (normalized === '89') {
      return [8, 9];
    }
    
    if (normalized === '晚上') {
      return [10, 11];
    }
    
    return null;
  }

  function extractCellLines(cell) {
    const template = document.createElement('div');
    template.innerHTML = String(cell?.innerHTML || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/p>/gi, '\n');
    return cleanMultilineText(template.textContent || '');
  }

  function parseCourseChunks(cell) {
    const lines = extractCellLines(cell);
    if (!lines.length) {
      return [];
    }

    const chunks = [];
    const queue = [...lines];
    
    while (queue.length) {
      const courseName = cleanText(queue.shift() || '');
      if (!courseName) {
        continue;
      }
    
      let location = '';
      if (queue.length && isLocationLine(queue[0])) {
        location = extractLocation(queue.shift());
      }
    
      let teachingClass = '';
      if (queue.length && !isLocationLine(queue[0])) {
        const descriptorLine = cleanText(queue.shift());
        const splitDescriptor = splitTeachingClassAndNextCourseName(descriptorLine);
    
        if (splitDescriptor) {
          teachingClass = splitDescriptor.teachingClass;
          queue.unshift(splitDescriptor.nextCourseName);
        } else {
          teachingClass = descriptorLine;
        }
      }
    
      if (!location && !teachingClass && isLikelyPlaceholderCourseName(courseName)) {
        continue;
      }
    
      chunks.push({ courseName, location, teachingClass });
    }
    
    return chunks;
  }

  function parseDetailCourses(detailTable) {
    const rows = Array.from(detailTable?.querySelectorAll('tr') || []).slice(1);
    return rows
      .map((row) => Array.from(row.cells).map((cell) => cleanText(cell.textContent)))
      .filter((cells) => cells.length >= 5)
      .map((cells) => ({
        courseNo: cells[0],
        courseName: cells[1],
        weeklyHours: cells[2],
        teachingClass: cells[3],
        teacher: cells[4],
      }));
  }

  function buildDetailLookup(detailCourses) {
    const exact = new Map();
    const byCourseName = new Map();

    detailCourses.forEach((course) => {
      const exactKey = detailLookupKey(course.courseName, course.teachingClass);
      const nameKey = normalizeKeyPart(course.courseName);
    
      if (!exact.has(exactKey)) {
        exact.set(exactKey, []);
      }
      exact.get(exactKey).push(course);
    
      if (!byCourseName.has(nameKey)) {
        byCourseName.set(nameKey, []);
      }
      byCourseName.get(nameKey).push(course);
    });
    
    return { exact, byCourseName };
  }

  function matchDetailCourse(item, lookup) {
    const exactMatches = lookup.exact.get(detailLookupKey(item.courseName, item.teachingClass)) || [];
    if (exactMatches.length) {
      return exactMatches[0];
    }

    const nameMatches = lookup.byCourseName.get(normalizeKeyPart(item.courseName)) || [];
    if (nameMatches.length === 1) {
      return nameMatches[0];
    }
    
    if (nameMatches.length > 1 && item.teachingClass) {
      const filtered = nameMatches.filter((course) => {
        const currentClass = normalizeKeyPart(item.teachingClass);
        const detailClass = normalizeKeyPart(course.teachingClass);
        return currentClass.includes(detailClass) || detailClass.includes(currentClass);
      });
    
      if (filtered.length) {
        return filtered[0];
      }
    }
    
    return nameMatches[0] || null;
  }

  function mergeScheduleItems(items) {
    const groups = new Map();

    items.forEach((item) => {
      const groupKey = [
        item.dayOfWeek,
        item.courseName,
        item.location,
        item.teachingClass,
        item.teacher,
        item.courseNo,
        item.weeklyHours,
      ].join('\u0000');
    
      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }
    
      groups.get(groupKey).push({ ...item });
    });
    
    return Array.from(groups.values())
      .flatMap((groupItems) => {
        const sortedGroup = groupItems.sort((left, right) => {
          if (left.startPeriod !== right.startPeriod) {
            return left.startPeriod - right.startPeriod;
          }
    
          return left.endPeriod - right.endPeriod;
        });
    
        return sortedGroup.reduce((merged, item) => {
          const previous = merged[merged.length - 1];
    
          if (previous && previous.endPeriod + 1 >= item.startPeriod) {
            previous.endPeriod = Math.max(previous.endPeriod, item.endPeriod);
            const mergedTime = getTimeRange(previous.startPeriod, previous.endPeriod);
            previous.startTime = mergedTime.startTime;
            previous.endTime = mergedTime.endTime;
            previous.section = mergedTime.section;
            return merged;
          }
    
          merged.push({ ...item });
          return merged;
        }, []);
      })
      .sort((left, right) => {
        if (left.dayOfWeek !== right.dayOfWeek) {
          return left.dayOfWeek - right.dayOfWeek;
        }
    
        if (left.startPeriod !== right.startPeriod) {
          return left.startPeriod - right.startPeriod;
        }
    
        if (left.endPeriod !== right.endPeriod) {
          return left.endPeriod - right.endPeriod;
        }
    
        return left.courseName.localeCompare(right.courseName, 'zh-Hans-CN');
      });
  }

  function parseScheduleDocument(doc, requestedStudentId, pageUrl) {
    const tables = Array.from(doc.querySelectorAll('table'));
    const mainTable = doc.querySelector('#_ctl6_NewKcb table') || tables[0];
    const detailTable = doc.querySelector('#_ctl6_dgStudentLesson') || tables[1];

    if (!mainTable || !detailTable) {
      throw new Error('未找到主课表或课程明细表，可能是登录失效或页面结构已变更');
    }
    
    const userInfoText = cleanText(doc.querySelector('#_ctl6_lblUserInfor')?.textContent || doc.body.textContent);
    const termSelect = doc.querySelector('#_ctl6_ddlSterm');
    const termLabel = cleanText(termSelect?.selectedOptions?.[0]?.textContent || termSelect?.options?.[0]?.textContent || '');
    const termValue = cleanText(termSelect?.value || termSelect?.options?.[0]?.value || '');
    
    const studentId = userInfoText.match(/学号[:：]\s*(\d{8,})/)?.[1] || requestedStudentId;
    const studentName = userInfoText.match(/姓名[:：]\s*([^\s]+)/)?.[1] || '';
    const className = userInfoText.match(/班级名称[:：]\s*(.+?)\s+学号[:：]/)?.[1] || '';
    
    const { grid, placements } = analyzeTable(mainTable);
    const dayColumns = [];
    (grid[0] || []).forEach((cell, colIndex) => {
      const text = cleanText(cell?.textContent || '');
      const dayIndex = DAY_LABELS.indexOf(text);
      if (dayIndex >= 0) {
        dayColumns.push({ colIndex, dayOfWeek: dayIndex + 1, dayLabel: text });
      }
    });
    
    const dayColumnMap = new Map(dayColumns.map((item) => [item.colIndex, item]));
    const rowPeriods = new Map();
    
    grid.forEach((row, rowIndex) => {
      const rowText = row.map((cell) => cleanText(cell?.textContent || '')).join(' ');
      if (/中\s*午/.test(rowText) || /课表说明/.test(rowText)) {
        return;
      }
    
      const periodLabel = cleanText(row?.[1]?.textContent || row?.[0]?.textContent || '');
      const periods = parsePeriodsFromRowLabel(periodLabel);
      if (periods) {
        rowPeriods.set(rowIndex, periods);
      }
    });
    
    const detailCourses = parseDetailCourses(detailTable);
    const lookup = buildDetailLookup(detailCourses);
    const rawItems = [];
    
    placements.forEach((placement) => {
      const dayInfo = dayColumnMap.get(placement.colIndex);
      if (!dayInfo) {
        return;
      }
    
      const coveredPeriods = [];
      for (let offset = 0; offset < placement.rowSpan; offset += 1) {
        const periods = rowPeriods.get(placement.rowIndex + offset);
        if (periods) {
          coveredPeriods.push(...periods);
        }
      }
    
      const uniquePeriods = [...new Set(coveredPeriods)].sort((left, right) => left - right);
      if (!uniquePeriods.length) {
        return;
      }
    
      const chunks = parseCourseChunks(placement.cell);
      if (!chunks.length) {
        return;
      }
    
      chunks.forEach((chunk) => {
        const detail = matchDetailCourse(chunk, lookup);
        const startPeriod = uniquePeriods[0];
        const endPeriod = uniquePeriods[uniquePeriods.length - 1];
        const timeRange = getTimeRange(startPeriod, endPeriod);
        rawItems.push({
          courseName: chunk.courseName,
          teacher: detail?.teacher || '',
          location: chunk.location,
          dayOfWeek: dayInfo.dayOfWeek,
          dayLabel: dayInfo.dayLabel,
          startPeriod,
          endPeriod,
          startTime: timeRange.startTime,
          endTime: timeRange.endTime,
          section: timeRange.section,
          teachingClass: chunk.teachingClass,
          courseNo: detail?.courseNo || '',
          weeklyHours: detail?.weeklyHours || '',
        });
      });
    });
    
    const mergedItems = mergeScheduleItems(rawItems).map((item, index) => ({
      id: `skd_${studentId}_${String(index + 1).padStart(3, '0')}`,
      ...item,
    }));
    
    return {
      studentId,
      studentName,
      className,
      termLabel,
      termValue,
      sourceUrl: pageUrl,
      fetchedAt: new Date().toISOString(),
      scheduleItems: mergedItems,
      detailCourses,
    };
  }

  async function fetchStudentSchedule(studentId, termValue) {
    const { doc, url } = await fetchScheduleDocument(studentId, termValue);
    return parseScheduleDocument(doc, studentId, url);
  }

  function getTermOptionsFromPage() {
    const select = document.querySelector('#_ctl6_ddlSterm');
    if (!select) return [];
    return Array.from(select.options).map((option) => ({
      value: option.value,
      label: cleanText(option.textContent),
      selected: option.defaultSelected || option.selected,
    }));
  }

  function getSuccessfulResults() {
    return state.results.filter((result) => !result.error);
  }

  function getFailedResults() {
    return state.results.filter((result) => result.error);
  }

  function buildJsonPayload() {
    const success = getSuccessfulResults();
    const failed = getFailedResults().map((result) => ({
      studentId: result.studentId,
      error: result.error,
    }));

    return {
      code: failed.length ? 207 : 200,
      message: failed.length ? 'partial_success' : 'success',
      generatedAt: new Date().toISOString(),
      timeMetadata: TIME_METADATA,
      data: success,
      failures: failed,
    };
  }

  function buildCsvText() {
    const headers = [
      'studentId',
      'studentName',
      'className',
      'termLabel',
      'id',
      'courseName',
      'teacher',
      'location',
      'dayOfWeek',
      'dayLabel',
      'startPeriod',
      'endPeriod',
      'startTime',
      'endTime',
      'section',
      'teachingClass',
      'courseNo',
      'weeklyHours',
    ];

    const rows = getSuccessfulResults().flatMap((student) =>
      student.scheduleItems.map((item) => [
        student.studentId,
        student.studentName,
        student.className,
        student.termLabel,
        item.id,
        item.courseName,
        item.teacher,
        item.location,
        item.dayOfWeek,
        item.dayLabel,
        item.startPeriod,
        item.endPeriod,
        item.startTime,
        item.endTime,
        item.section,
        item.teachingClass,
        item.courseNo,
        item.weeklyHours,
      ]),
    );
    
    const escapeCsvValue = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    return [headers, ...rows].map((row) => row.map(escapeCsvValue).join(',')).join('\r\n');
  }

  function downloadTextFile(filename, text, mimeType) {
    const blob = new window.Blob([text], { type: mimeType });
    const anchor = document.createElement('a');
    anchor.href = window.URL.createObjectURL(blob);
    anchor.download = filename;
    anchor.click();
    window.setTimeout(() => window.URL.revokeObjectURL(anchor.href), 1000);
  }

  function clampPanelPosition(position, shellWidth, shellHeight) {
    const margin = 12;
    const maxLeft = Math.max(margin, window.innerWidth - shellWidth - margin);
    const maxTop = Math.max(margin, window.innerHeight - shellHeight - margin);
    return {
      left: Math.min(Math.max(position.left, margin), maxLeft),
      top: Math.min(Math.max(position.top, margin), maxTop),
    };
  }

  function getDefaultPanelPosition() {
    const shellWidth = Math.min(390, Math.max(280, window.innerWidth - 24));
    return clampPanelPosition(
      {
        left: window.innerWidth - shellWidth - 20,
        top: 20,
      },
      shellWidth,
      120,
    );
  }

  function createPanel() {
    if (document.getElementById(PANEL_HOST_ID)) {
      return null;
    }

    const host = document.createElement('div');
    host.id = PANEL_HOST_ID;
    document.body.appendChild(host);
    
    const shadowRoot = host.attachShadow({ mode: 'open' });
    shadowRoot.innerHTML = `
      <style>
        :host {
          all: initial;
        }
    
        .shell {
          position: fixed;
          top: 20px;
          right: 20px;
          z-index: 2147483647;
          width: min(390px, calc(100vw - 24px));
          color: #f6ecdc;
          font-family: Bahnschrift, "Microsoft YaHei UI", sans-serif;
          touch-action: none;
        }
    
        .shell[data-hidden="true"] {
          display: none;
        }
    
        .panel {
          overflow: hidden;
          border: 1px solid rgba(224, 164, 95, 0.5);
          border-radius: 20px;
          background:
            radial-gradient(circle at top right, rgba(255, 175, 95, 0.22), transparent 36%),
            linear-gradient(155deg, rgba(21, 18, 23, 0.96), rgba(8, 9, 13, 0.96));
          box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.06);
          backdrop-filter: blur(18px);
          transition: transform 180ms ease, box-shadow 180ms ease, border-color 180ms ease;
        }
    
        .panel[data-collapsed="true"] {
          box-shadow: 0 18px 44px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.06);
        }
    
        .panel[data-collapsed="true"] .body {
          display: none;
        }
    
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 16px 18px 12px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          cursor: move;
          user-select: none;
        }
    
        .title-wrap {
          display: grid;
          gap: 4px;
          flex: 1;
        }
    
        .eyebrow {
          color: #d2ab79;
          font-size: 11px;
          letter-spacing: 0.22em;
          text-transform: uppercase;
        }
    
        .title {
          margin: 0;
          font-size: 18px;
          letter-spacing: 0.04em;
        }
    
        .status-chip {
          padding: 6px 10px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.04);
          color: #f4d7aa;
          font-size: 11px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          white-space: nowrap;
        }
    
        .header-actions {
          display: flex;
          align-items: center;
          gap: 8px;
        }
    
        .collapse-toggle {
          width: 34px;
          height: 34px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.05);
          color: #f7dfb8;
          font: 700 18px/1 "Times New Roman", serif;
          cursor: pointer;
          transition: transform 120ms ease, background 120ms ease, border-color 120ms ease;
        }
    
        .collapse-toggle:hover {
          transform: translateY(-1px);
          border-color: rgba(230, 175, 92, 0.65);
          background: rgba(255, 255, 255, 0.09);
        }
    
        .close-toggle {
          width: 34px;
          height: 34px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 12px;
          background: rgba(125, 29, 29, 0.25);
          color: #ffd0c4;
          font: 700 18px/1 "Times New Roman", serif;
          cursor: pointer;
          transition: transform 120ms ease, background 120ms ease, border-color 120ms ease;
        }
    
        .close-toggle:hover {
          transform: translateY(-1px);
          border-color: rgba(255, 144, 120, 0.65);
          background: rgba(161, 40, 40, 0.35);
        }
    
        .reopen {
          position: fixed;
          top: 20px;
          right: 20px;
          z-index: 2147483647;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 12px 14px;
          border: 1px solid rgba(224, 164, 95, 0.48);
          border-radius: 999px;
          background:
            radial-gradient(circle at top right, rgba(255, 175, 95, 0.18), transparent 38%),
            linear-gradient(155deg, rgba(21, 18, 23, 0.95), rgba(8, 9, 13, 0.95));
          box-shadow: 0 16px 36px rgba(0, 0, 0, 0.35);
          color: #f7dfb8;
          font: 700 12px/1 Bahnschrift, "Microsoft YaHei UI", sans-serif;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          cursor: pointer;
        }
    
        .reopen[data-hidden="true"] {
          display: none;
        }
    
        .body {
          display: grid;
          gap: 14px;
          padding: 16px 18px 18px;
        }
    
        .note {
          color: rgba(246, 236, 220, 0.7);
          font-size: 12px;
          line-height: 1.55;
        }
    
        .textarea {
          min-height: 128px;
          resize: vertical;
          width: 100%;
          box-sizing: border-box;
          padding: 14px 14px 12px;
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 16px;
          background: rgba(255, 255, 255, 0.045);
          color: #fff9f0;
          font: 600 13px/1.6 Consolas, "Cascadia Mono", monospace;
          outline: none;
        }
    
        .textarea:focus {
          border-color: rgba(230, 175, 92, 0.82);
          box-shadow: 0 0 0 4px rgba(230, 175, 92, 0.14);
        }
    
        .grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px;
        }
    
        .button {
          appearance: none;
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 14px;
          padding: 12px 14px;
          cursor: pointer;
          color: #fff6eb;
          background: rgba(255, 255, 255, 0.05);
          font: 700 12px/1 Bahnschrift, "Microsoft YaHei UI", sans-serif;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
        }
    
        .button:hover:not(:disabled) {
          transform: translateY(-1px);
          border-color: rgba(230, 175, 92, 0.65);
          background: rgba(255, 255, 255, 0.08);
        }
    
        .button:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }
    
        .button-primary {
          background: linear-gradient(135deg, rgba(238, 177, 94, 0.92), rgba(186, 103, 52, 0.88));
          color: #24140d;
          border-color: rgba(255, 207, 141, 0.65);
        }
    
        .button-secondary {
          background: linear-gradient(135deg, rgba(43, 44, 58, 0.95), rgba(19, 19, 27, 0.95));
        }
    
        .summary {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 8px;
        }
    
        .throttle-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px;
        }
    
        .field {
          display: grid;
          gap: 6px;
        }
    
        .field-label {
          color: rgba(246, 236, 220, 0.72);
          font-size: 11px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
    
        .input {
          width: 100%;
          box-sizing: border-box;
          padding: 10px 12px;
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.045);
          color: #fff9f0;
          font: 700 12px/1.2 Consolas, "Cascadia Mono", monospace;
          outline: none;
        }
    
        .input:focus {
          border-color: rgba(230, 175, 92, 0.82);
          box-shadow: 0 0 0 4px rgba(230, 175, 92, 0.14);
        }
    
        /* 修复下拉框「全白」：原生 select 弹出的 option 默认是 OS 白底，
           而 .input 把文字设成近白色 → 白底白字看不见。这里给 select 显式深色方案 +
           给 option 显式深底浅字。 */
        select.input {
          color-scheme: dark;
          background-color: #15121a;
        }
    
        select.input option {
          background-color: #15121a;
          color: #f6ecdc;
        }
    
        .card {
          padding: 10px 12px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 14px;
          background: rgba(255, 255, 255, 0.04);
        }
    
        .label {
          display: block;
          margin-bottom: 4px;
          color: rgba(246, 236, 220, 0.62);
          font-size: 11px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
    
        .value {
          font-size: 18px;
          font-weight: 700;
        }
    
        .log {
          max-height: 190px;
          overflow: auto;
          margin: 0;
          padding: 0;
          list-style: none;
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 16px;
          background: rgba(255, 255, 255, 0.03);
        }
    
        .log-item {
          padding: 10px 12px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
          color: rgba(246, 236, 220, 0.82);
          font-size: 12px;
          line-height: 1.5;
        }
    
        .log-item:last-child {
          border-bottom: none;
        }
    
        .log-item[data-tone="success"] {
          color: #b9f4cb;
        }
    
        .log-item[data-tone="error"] {
          color: #ffb6b6;
        }
    
        .log-item[data-tone="info"] {
          color: #f2d7aa;
        }
    
        .footer {
          color: rgba(246, 236, 220, 0.54);
          font-size: 11px;
          line-height: 1.45;
        }
    
        @media (max-width: 640px) {
          .shell {
            top: auto;
            right: 12px;
            bottom: 12px;
            width: calc(100vw - 24px);
          }
        }
      </style>
      <div class="shell">
        <div class="panel">
          <div class="header">
            <div class="title-wrap">
              <div class="eyebrow">JXNU Schedule Lab</div>
              <h2 class="title">按学期批量抓取</h2>
            </div>
            <div class="header-actions">
              <div class="status-chip" data-role="status">Idle</div>
              <button class="collapse-toggle" data-role="toggle" type="button" aria-label="折叠面板">−</button>
              <button class="close-toggle" data-role="close" type="button" aria-label="关闭面板">×</button>
            </div>
          </div>
          <div class="body">
            <div class="note">每行一个学号。先选学期再开始抓取，脚本会自动切学期、合并连堂、导出 JSON 和 CSV。</div>
            <label class="field">
              <span class="field-label">抓取学期</span>
              <select class="input" data-role="term"></select>
            </label>
            <textarea class="textarea" data-role="textarea" placeholder="202426201050&#10;202426201051"></textarea>
            <div class="throttle-grid">
              <label class="field">
                <span class="field-label">基础间隔 ms</span>
                <input class="input" data-role="base-delay" type="number" min="0" step="100" />
              </label>
              <label class="field">
                <span class="field-label">随机抖动 ms</span>
                <input class="input" data-role="jitter" type="number" min="0" step="100" />
              </label>
              <label class="field">
                <span class="field-label">每批数量</span>
                <input class="input" data-role="batch-size" type="number" min="1" step="1" />
              </label>
              <label class="field">
                <span class="field-label">批间暂停 ms</span>
                <input class="input" data-role="batch-pause" type="number" min="0" step="1000" />
              </label>
            </div>
            <div class="grid">
              <button class="button button-primary" data-role="start">开始抓取</button>
              <button class="button button-secondary" data-role="fill-current">填入当前</button>
              <button class="button" data-role="export-json" disabled>导出 JSON</button>
              <button class="button" data-role="export-csv" disabled>导出 CSV</button>
            </div>
            <div class="summary">
              <div class="card"><span class="label">总学号</span><span class="value" data-role="count-total">0</span></div>
              <div class="card"><span class="label">成功</span><span class="value" data-role="count-success">0</span></div>
              <div class="card"><span class="label">失败</span><span class="value" data-role="count-failed">0</span></div>
            </div>
            <ul class="log" data-role="log"></ul>
            <div class="footer">晚上节次固定按 10-11 节处理。导出的绝对时间由内置 timeMetadata 推算。切换非默认学期时会先 GET 一次拿 ViewState 再 POST 模拟"确定"按钮。默认节流为 1200ms 基础间隔 + 800ms 随机抖动，每 25 个暂停 8 秒。</div>
          </div>
        </div>
      </div>
      <button class="reopen" data-role="reopen" type="button" aria-label="打开课表面板">
        <span>JXNU</span>
        <span>Open</span>
      </button>
    `;
    
    return shadowRoot;
  }

  function initializePanel() {
    const shadowRoot = createPanel();
    if (!shadowRoot) {
      return;
    }

    const elements = {
      shell: shadowRoot.querySelector('.shell'),
      panel: shadowRoot.querySelector('.panel'),
      header: shadowRoot.querySelector('.header'),
      status: shadowRoot.querySelector('[data-role="status"]'),
      toggle: shadowRoot.querySelector('[data-role="toggle"]'),
      close: shadowRoot.querySelector('[data-role="close"]'),
      reopen: shadowRoot.querySelector('[data-role="reopen"]'),
      textarea: shadowRoot.querySelector('[data-role="textarea"]'),
      term: shadowRoot.querySelector('[data-role="term"]'),
      start: shadowRoot.querySelector('[data-role="start"]'),
      fillCurrent: shadowRoot.querySelector('[data-role="fill-current"]'),
      baseDelay: shadowRoot.querySelector('[data-role="base-delay"]'),
      jitter: shadowRoot.querySelector('[data-role="jitter"]'),
      batchSize: shadowRoot.querySelector('[data-role="batch-size"]'),
      batchPause: shadowRoot.querySelector('[data-role="batch-pause"]'),
      exportJson: shadowRoot.querySelector('[data-role="export-json"]'),
      exportCsv: shadowRoot.querySelector('[data-role="export-csv"]'),
      countTotal: shadowRoot.querySelector('[data-role="count-total"]'),
      countSuccess: shadowRoot.querySelector('[data-role="count-success"]'),
      countFailed: shadowRoot.querySelector('[data-role="count-failed"]'),
      log: shadowRoot.querySelector('[data-role="log"]'),
    };
    
    const restoreInput = window.localStorage.getItem(STORAGE_KEY) || '';
    if (restoreInput) {
      elements.textarea.value = restoreInput;
    }
    
    const termOptions = getTermOptionsFromPage();
    if (termOptions.length) {
      elements.term.innerHTML = '';
      termOptions.forEach((option) => {
        const opt = document.createElement('option');
        opt.value = option.value;
        opt.textContent = option.label;
        if (option.selected) {
          opt.selected = true;
        }
        elements.term.appendChild(opt);
      });
    } else {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '默认学期（未识别到学期列表）';
      elements.term.appendChild(opt);
      elements.term.disabled = true;
    }
    
    elements.baseDelay.value = String(state.throttle.baseDelayMs);
    elements.jitter.value = String(state.throttle.jitterMs);
    elements.batchSize.value = String(state.throttle.batchSize);
    elements.batchPause.value = String(state.throttle.batchPauseMs);
    
    function applyPanelPosition() {
      const currentPosition = state.panelPosition || getDefaultPanelPosition();
      const shellWidth = elements.shell.offsetWidth || Math.min(390, Math.max(280, window.innerWidth - 24));
      const shellHeight = elements.shell.offsetHeight || 120;
      const nextPosition = clampPanelPosition(currentPosition, shellWidth, shellHeight);
      state.panelPosition = nextPosition;
      elements.shell.style.left = `${nextPosition.left}px`;
      elements.shell.style.top = `${nextPosition.top}px`;
      elements.shell.style.right = 'auto';
      elements.shell.style.bottom = 'auto';
      elements.reopen.style.left = `${nextPosition.left}px`;
      elements.reopen.style.top = `${nextPosition.top}px`;
      elements.reopen.style.right = 'auto';
    }
    
    function renderPanelState() {
      elements.panel.dataset.collapsed = state.panelCollapsed ? 'true' : 'false';
      elements.shell.dataset.hidden = state.panelClosed ? 'true' : 'false';
      elements.reopen.dataset.hidden = state.panelClosed ? 'false' : 'true';
      elements.toggle.textContent = state.panelCollapsed ? '+' : '−';
      elements.toggle.setAttribute('aria-label', state.panelCollapsed ? '展开面板' : '折叠面板');
      elements.status.textContent = state.running ? 'Running' : state.panelCollapsed ? 'Folded' : 'Ready';
      applyPanelPosition();
    }
    
    function setStatus(text) {
      elements.status.textContent = text;
    }
    
    const MAX_LOG_ITEMS = 250;
    function appendLog(message, tone) {
      const item = document.createElement('li');
      item.className = 'log-item';
      item.dataset.tone = tone;
      item.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
      elements.log.prepend(item);
      // 只保留最近 N 条，避免几万条日志节点把 DOM 撑爆导致卡死。
      while (elements.log.childElementCount > MAX_LOG_ITEMS) {
        elements.log.removeChild(elements.log.lastElementChild);
      }
    }
    
    function syncThrottleFromInputs() {
      state.throttle = {
        baseDelayMs: Math.max(0, Number(elements.baseDelay.value) || 0),
        jitterMs: Math.max(0, Number(elements.jitter.value) || 0),
        batchSize: Math.max(1, Number(elements.batchSize.value) || 1),
        batchPauseMs: Math.max(0, Number(elements.batchPause.value) || 0),
      };
      persistThrottleSettings(state.throttle);
    }
    
    function renderSummary() {
      elements.countTotal.textContent = String(state.targetCount);
      elements.countSuccess.textContent = String(state.successCount);
      elements.countFailed.textContent = String(state.failedCount);
      elements.exportJson.disabled = !state.results.length;
      elements.exportCsv.disabled = !state.successCount;
    }
    
    function setRunning(running) {
      state.running = running;
      elements.start.disabled = running;
      elements.fillCurrent.disabled = running;
      elements.term.disabled = running || !termOptions.length;
      elements.baseDelay.disabled = running;
      elements.jitter.disabled = running;
      elements.batchSize.disabled = running;
      elements.batchPause.disabled = running;
      elements.exportJson.disabled = running || !state.results.length;
      elements.exportCsv.disabled = running || !state.successCount;
      renderPanelState();
    }
    
    elements.textarea.addEventListener('input', () => {
      window.localStorage.setItem(STORAGE_KEY, elements.textarea.value);
    });
    
    [elements.baseDelay, elements.jitter, elements.batchSize, elements.batchPause].forEach((input) => {
      input.addEventListener('change', syncThrottleFromInputs);
    });
    
    elements.toggle.addEventListener('click', () => {
      state.panelCollapsed = !state.panelCollapsed;
      persistPanelCollapsedState(state.panelCollapsed);
      renderPanelState();
    });
    
    elements.close.addEventListener('click', () => {
      state.panelClosed = true;
      persistPanelClosedState(true);
      renderPanelState();
    });
    
    elements.reopen.addEventListener('click', () => {
      state.panelClosed = false;
      persistPanelClosedState(false);
      renderPanelState();
    });
    
    elements.header.addEventListener('pointerdown', (event) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest('button')) {
        return;
      }
    
      const rect = elements.shell.getBoundingClientRect();
      const startOffsetX = event.clientX - rect.left;
      const startOffsetY = event.clientY - rect.top;
    
      const handleMove = (moveEvent) => {
        const nextPosition = clampPanelPosition(
          {
            left: moveEvent.clientX - startOffsetX,
            top: moveEvent.clientY - startOffsetY,
          },
          elements.shell.offsetWidth,
          elements.shell.offsetHeight,
        );
        state.panelPosition = nextPosition;
        applyPanelPosition();
      };
    
      const handleUp = () => {
        persistPanelPosition(state.panelPosition);
        window.removeEventListener('pointermove', handleMove);
        window.removeEventListener('pointerup', handleUp);
      };
    
      window.addEventListener('pointermove', handleMove);
      window.addEventListener('pointerup', handleUp);
      elements.header.setPointerCapture?.(event.pointerId);
    });
    
    window.addEventListener('resize', () => {
      applyPanelPosition();
      persistPanelPosition(state.panelPosition);
    });
    
    elements.fillCurrent.addEventListener('click', () => {
      const currentStudentId = getCurrentStudentId();
      if (!currentStudentId) {
        appendLog('当前页面未识别到学号', 'error');
        return;
      }
    
      const ids = parseStudentIds(elements.textarea.value);
      if (!ids.includes(currentStudentId)) {
        const nextValue = ids.length ? `${ids.join('\n')}\n${currentStudentId}` : currentStudentId;
        elements.textarea.value = nextValue;
        window.localStorage.setItem(STORAGE_KEY, nextValue);
      }
    
      appendLog(`已填入当前学号 ${currentStudentId}`, 'info');
    });
    
    elements.start.addEventListener('click', async () => {
      if (state.running) {
        return;
      }
    
      const ids = parseStudentIds(elements.textarea.value);
      if (!ids.length) {
        appendLog('请输入至少一个有效学号', 'error');
        return;
      }
    
      syncThrottleFromInputs();
    
      const termValue = elements.term.value || '';
      const termLabel = elements.term.options[elements.term.selectedIndex]?.textContent || '默认学期';
    
      state.results = [];
      state.startedAt = new Date().toISOString();
      state.targetCount = ids.length;
      state.successCount = 0;
      state.failedCount = 0;
      elements.log.innerHTML = '';
      renderSummary();
      setRunning(true);
      appendLog(`开始抓取「${termLabel}」，共 ${ids.length} 个学号`, 'info');
    
      for (let index = 0; index < ids.length; index += 1) {
        const studentId = ids[index];
        appendLog(`抓取中 ${studentId} (${index + 1}/${ids.length})`, 'info');
    
        try {
          const result = await fetchStudentSchedule(studentId, termValue);
          state.results.push(result);
          state.successCount += 1;
          appendLog(`${studentId} 完成，解析到 ${result.scheduleItems.length} 个课块`, 'success');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          state.results.push({ studentId, error: message, fetchedAt: new Date().toISOString() });
          state.failedCount += 1;
          appendLog(`${studentId} 失败：${message}`, 'error');
        }
    
        renderSummary();
    
        const isLast = index === ids.length - 1;
        if (isLast) {
          continue;
        }
    
        const completedCount = index + 1;
        if (state.throttle.batchSize > 0 && completedCount % state.throttle.batchSize === 0) {
          if (state.throttle.batchPauseMs > 0) {
            appendLog(`已完成 ${completedCount} 个，批间暂停 ${state.throttle.batchPauseMs}ms`, 'info');
            await sleep(state.throttle.batchPauseMs);
          }
          continue;
        }
    
        const delayMs = getThrottleDelayMs();
        if (delayMs > 0) {
          await sleep(delayMs);
        }
      }
    
      setRunning(false);
      appendLog('抓取结束，可以导出 JSON 或 CSV', 'success');
    });
    
    elements.exportJson.addEventListener('click', () => {
      if (!state.results.length) {
        return;
      }
    
      const payload = buildJsonPayload();
      // 3 万学生数据量极大：不缩进，避免把字符串体积翻倍、JSON.stringify 卡住主线程。
      downloadTextFile(
        `jxnu-schedules-${Date.now()}.json`,
        JSON.stringify(payload),
        'application/json;charset=utf-8',
      );
      appendLog('JSON 已导出', 'success');
    });
    
    elements.exportCsv.addEventListener('click', () => {
      if (!getSuccessfulResults().length) {
        return;
      }
    
      downloadTextFile(`jxnu-schedules-${Date.now()}.csv`, `\ufeff${buildCsvText()}`, 'text/csv;charset=utf-8');
      appendLog('CSV 已导出', 'success');
    });
    
    renderPanelState();
    renderSummary();
    window.__jxnuScheduleExporter = {
      state,
      TIME_METADATA,
      fetchStudentSchedule,
      buildJsonPayload,
      buildCsvText,
    };
  }

  initializePanel();
})();