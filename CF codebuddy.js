// ==UserScript==
// @name         Cloudflare Workers 编辑器 · 移动端代码助手（多站点版）
// @namespace    https://workbuddy.local/cf-workers-selectall
// @version      4.3.3
// @description  Worker 代码编辑页右下角圆形按钮，点开竖向弹出：全选 / 清空 / 复制 / 诊断；另：dash 里「输入名称以确认删除」弹窗自动出现「一键填入」按钮。
// @author       Youtube:好软推荐
// @match        https://dash.cloudflare.com/*
// @match        https://*.quick-edit-workers.devprod.cloudflare.dev/*
// @include      /^https:\/\/[^/]*quick-edit-workers[^/]*\.devprod\.cloudflare\.dev\//
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
  多站点扩展说明
  ===============================================================
  只在 Worker 代码编辑页显示圆形工具按钮（由 isEditorPage() 精确判断），
  其它页面不显示。
  「删除确认一键填入」独立于适配器，在 dash.cloudflare.com 所有页面生效（Pages / Workers / KV / D1 等）。

  核心层（圆形主按钮 + 竖向弹出菜单、postMessage 通信、剪贴板）与站点无关。
  要支持新网站，只需两步：

  1) 在上方 UserScript 头里增加 @match / @include：
       - 顶层管理页 URL
       - 若编辑器位于跨域 iframe，还要加该 iframe 的 URL

  2) 在 SITE_ADAPTERS 数组中新增一个适配器对象，字段如下：
       {
         id, label,
         topMatch(url)           -> bool   当前顶层页面是否属于该站点
         frameMatch(url)         -> bool   当前 iframe 是否是该站点的编辑器
         findInput(win)          -> el     返回编辑器输入元素
         doSelectAll(win)        -> {ok,method}          全选
         doClear(win)            -> {ok,method}          清空（全选+删除）
         doGetText(win)          -> string|null         读取全文（复制）
         diagnose(win)           -> string  (可选)
       }

  如需限定某个网站的具体页面才显示按钮，在 isEditorPage() 中按站点追加 URL 判断。
  参考下方 Cloudflare Workers 适配器即可。
  ===============================================================
*/

(function () {
  'use strict';

  var CMD = '__wbCfCmd';
  var RES = '__wbCfRes';
  var STYLE_ID = 'wb-cf-style';
  var isTop = (window.top === window.self);

  /* ==================== 通用工具 ==================== */
  function dispatchKey(win, el, key, code, vk, opts) {
    opts = opts || {};
    var base = {
      key: key, code: code, keyCode: vk, which: vk,
      ctrlKey: !!opts.ctrl, metaKey: !!opts.meta,
      shiftKey: !!opts.shift, altKey: !!opts.alt,
      bubbles: true, cancelable: true, composed: true
    };
    try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} }
    try { el.dispatchEvent(new win.KeyboardEvent('keydown', base)); return true; }
    catch (e3) { return false; }
  }

  function isEditContextSelected(el) {
    try {
      var ec = el && el.editContext;
      return !!(ec && typeof ec.text === 'string' && ec.text.length > 0 &&
        ec.selectionStart === 0 && ec.selectionEnd === ec.text.length);
    } catch (e) { return false; }
  }

  function monacoSelectAll(win) {
    try {
      var m = win.monaco;
      if (m && m.editor && typeof m.editor.getEditors === 'function') {
        var eds = m.editor.getEditors();
        for (var i = 0; i < eds.length; i++) {
          var ed = eds[i];
          var model = ed.getModel && ed.getModel();
          if (model && ed.setSelection) {
            ed.setSelection(model.getFullModelRange());
            if (ed.focus) ed.focus();
            return true;
          }
        }
      }
    } catch (e) {}
    return false;
  }

  function monacoGetText(win) {
    try {
      var m = win.monaco;
      if (m && m.editor && typeof m.editor.getModels === 'function') {
        var models = m.editor.getModels();
        if (models.length && models[0].getValue) return models[0].getValue();
      }
    } catch (e) {}
    return null;
  }

  function monacoReplaceAll(win, text) {
    try {
      var m = win.monaco;
      if (m && m.editor && typeof m.editor.getEditors === 'function') {
        var eds = m.editor.getEditors();
        for (var i = 0; i < eds.length; i++) {
          var ed = eds[i];
          var model = ed.getModel && ed.getModel();
          if (model && ed.executeEdits) {
            ed.executeEdits('wb-clear', [{
              range: model.getFullModelRange(), text: text, forceMoveMarkers: true
            }]);
            if (ed.focus) ed.focus();
            return true;
          }
        }
      }
    } catch (e) {}
    return false;
  }

  /* ==================== 站点适配器注册表（扩展点） ==================== */
  var SITE_ADAPTERS = [
    {
      id: 'cloudflare-workers',
      label: 'Cloudflare Workers',
      topMatch: function (url) { return /dash\.cloudflare\.com\/[^/]+\/workers\//.test(url); },
      frameMatch: function (url) {
        return /quick-edit-workers[^/]*\.devprod\.cloudflare\.dev/.test(url);
      },
      findInput: function (win) {
        var doc = win.document;
        var sels = [
          '.native-edit-context',
          'textarea.inputarea',
          '.monaco-editor textarea',
          'textarea[aria-label*="ditor"]',
          'textarea',
          '[contenteditable="true"]'
        ];
        for (var i = 0; i < sels.length; i++) {
          var el = doc.querySelector(sels[i]);
          if (el) return el;
        }
        return null;
      },
      doSelectAll: function (win) {
        var el = this.findInput(win);
        if (!el) return { ok: false, method: '未找到编辑器输入区' };
        // VSCode Web / EditContext：单个干净的 Ctrl+A（不要叠 Meta+A、不要 keyup）
        dispatchKey(win, el, 'a', 'KeyA', 65, { ctrl: true });
        if (isEditContextSelected(el)) return { ok: true, method: 'VSCode 编辑上下文' };
        if (monacoSelectAll(win)) return { ok: true, method: 'Monaco API' };
        var all = win.document.querySelectorAll('textarea, [contenteditable="true"]');
        for (var i = 0; i < all.length; i++) {
          if (all[i] !== el) dispatchKey(win, all[i], 'a', 'KeyA', 65, { ctrl: true });
        }
        return { ok: true, method: '输入区 Ctrl+A' };
      },
      doClear: function (win) {
        var el = this.findInput(win);
        if (!el) return { ok: false, method: '未找到编辑器输入区' };
        this.doSelectAll(win);
        // 删除键：EditContext / VSCode 会删除当前选区
        dispatchKey(win, el, 'Delete', 'Delete', 46, {});
        var ec = el.editContext;
        var len = (ec && typeof ec.text === 'string') ? ec.text.length : -1;
        if (len > 0) {
          dispatchKey(win, el, 'Backspace', 'Backspace', 8, {});
          len = (ec && typeof ec.text === 'string') ? ec.text.length : -1;
        }
        if (len === 0) return { ok: true, method: '全选+删除' };
        if (monacoReplaceAll(win, '')) return { ok: true, method: 'Monaco 清空' };
        return { ok: len === -1, method: len === -1 ? '已发送删除指令' : '删除未生效，请检查' };
      },
      doGetText: function (win) {
        var el = this.findInput(win);
        if (el) {
          try {
            var ec = el.editContext;
            if (ec && typeof ec.text === 'string' && ec.text.length) return ec.text;
          } catch (e) {}
          if (typeof el.value === 'string' && el.value.length) return el.value;
        }
        return monacoGetText(win);
      },
      diagnose: function (win) {
        var L = [];
        L.push('--- 编辑器 iframe 诊断 ---');
        L.push('URL: ' + location.href);
        L.push('native-edit-context: ' + win.document.querySelectorAll('.native-edit-context').length);
        L.push('monaco: ' + !!(win.monaco && win.monaco.editor));
        L.push('textarea: ' + win.document.querySelectorAll('textarea').length);
        var el = this.findInput(win);
        L.push('输入区: ' + (el ? el.tagName + '.' + el.className : '无'));
        if (el && el.editContext) {
          L.push('EditContext 文本长度: ' + (el.editContext.text || '').length);
        }
        return L.join('\n');
      }
    }
    // 新增站点：在此处追加适配器对象
  ];

  function findAdapterForTop() {
    for (var i = 0; i < SITE_ADAPTERS.length; i++) {
      if (SITE_ADAPTERS[i].topMatch(location.href)) return SITE_ADAPTERS[i];
    }
    return null;
  }
  function findAdapterForFrame() {
    for (var i = 0; i < SITE_ADAPTERS.length; i++) {
      if (SITE_ADAPTERS[i].frameMatch(location.href)) return SITE_ADAPTERS[i];
    }
    return null;
  }

  /* 只在 Worker 代码编辑页显示按钮 —— 多站点扩展时在此追加判断 */
  function isEditorPage() {
    var p = location.pathname;
    // /<account>/workers/services/edit/<name>[/<env>]   经典编辑页
    // /<account>/workers/edit/<name>                     新版编辑页
    // /<account>/workers/<name>/edit                     另一版编辑页
    if (/\/workers\/(services\/)?edit([\/?]|$)/.test(p)) return true;
    if (/\/workers\/[^/]+\/edit([\/?]|$)/.test(p)) return true;
    return false;
  }

  /* ==================== 子帧：编辑器 iframe 内执行 ==================== */
  if (!isTop) {
    var frameAdapter = findAdapterForFrame();
    if (frameAdapter) {
      window.addEventListener('message', function (e) {
        if (!e.data || e.data[CMD] !== true) return;
        var id = e.data.id, cmd = e.data.cmd, payload = e.data.payload || {};
        function reply(ok, method, extra) {
          var msg = { __wbCfRes: true, id: id, ok: !!ok, method: method || '' };
          if (extra) { for (var k in extra) msg[k] = extra[k]; }
          try { window.parent.postMessage(msg, '*'); } catch (err) {}
        }
        try {
          if (cmd === 'ping') {
            reply(true);
          } else if (cmd === 'selectAll') {
            var r = frameAdapter.doSelectAll(window);
            reply(r.ok, r.method);
          } else if (cmd === 'clear') {
            var c = frameAdapter.doClear(window);
            reply(c.ok, c.method);
          } else if (cmd === 'getText') {
            var txt = frameAdapter.doGetText(window);
            reply(txt !== null, txt !== null ? '已读取' : '读取失败', { text: txt || '' });
          } else if (cmd === 'diagnose') {
            reply(true, '', { diag: frameAdapter.diagnose ? frameAdapter.diagnose(window) : '' });
          }
        } catch (err) {
          reply(false, '异常: ' + String(err).slice(0, 120));
        }
      });
    }
    return; // iframe 内不注入按钮
  }

  /* ==================== 删除确认弹窗：一键填入（dash 所有页面通用） ====================
     识别「输入 xxx 以确认」/「Type xxx to confirm」类弹窗，在输入框下方加一个按钮，
     点一下就把要求输入的名称填进去（会触发 React 的 input 事件，删除按钮随即可点）。 */
  (function setupConfirmFill() {
    var ROW_ATTR = 'data-wb-cf-fill';
    var FILL_STYLE_ID = 'wb-cf-fill-style';
    var PATTERNS = [
      /输入\s*[“"「『‘']?\s*(.{1,100}?)\s*[”"」』’']?\s*以\s*(?:确认|继续|删除)/,
      /(?:type|enter)\s+["“'‘]?\s*(.{1,100}?)\s*["”'’]?\s+(?:below\s+)?to\s+(?:confirm|continue|delete|proceed)/i
    ];
    var INPUT_SEL = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])' +
      ':not([type="password"]):not([type="file"]):not([type="button"]):not([type="submit"]),textarea';

    function visible(el) {
      return !!(el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length));
    }

    function ensureFillStyle() {
      if (document.getElementById(FILL_STYLE_ID)) return;
      var s = document.createElement('style');
      s.id = FILL_STYLE_ID;
      s.textContent = [
        '[' + ROW_ATTR + ']{display:flex;justify-content:flex-end;box-sizing:border-box;',
        'width:100%;flex:0 0 100%;margin:8px 0 0;padding:0;}',
        '.wb-cf-fill-btn{-webkit-appearance:none;appearance:none;box-sizing:border-box;height:32px;',
        'padding:0 14px 0 12px;margin:0;border:0;border-radius:999px;background:#f6821f;color:#1a1206;',
        'display:inline-flex;align-items:center;gap:7px;cursor:pointer;',
        'font:600 13px/1 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;',
        'box-shadow:0 1px 3px rgba(0,0,0,.25);touch-action:manipulation;',
        '-webkit-tap-highlight-color:transparent;transition:transform .1s,filter .15s,background .2s;}',
        '.wb-cf-fill-btn:hover{filter:brightness(1.06);}',
        '.wb-cf-fill-btn:active{transform:scale(.96);}',
        '.wb-cf-fill-btn svg{width:14px;height:14px;display:block;flex:none;}',
        '.wb-cf-fill-btn code{max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
        'padding:3px 7px;border-radius:6px;background:rgba(0,0,0,.14);',
        'font:600 12px/1 ui-monospace,"SF Mono",Menlo,Consolas,monospace;}',
        '.wb-cf-fill-btn[data-done]{background:#1a7f37;color:#fff;}',
        '.wb-cf-fill-btn[data-done] code{display:none;}',
        '.wb-cf-fill-btn:focus-visible{outline:2px solid #f6821f;outline-offset:2px;}',
        /* 行内模式：贴在「输入 xxx 以确认。」这句话的末尾 */
        '[' + ROW_ATTR + '][data-inline]{display:inline-flex;vertical-align:middle;width:auto;flex:none;',
        'margin:0 0 0 8px;justify-content:flex-start;}',
        '[data-inline] .wb-cf-fill-btn{height:24px;padding:0 10px 0 8px;gap:5px;font-size:12px;}',
        '[data-inline] .wb-cf-fill-btn svg{width:12px;height:12px;}',
        '[data-inline] .wb-cf-fill-btn code{display:none;}'
      ].join('');
      (document.head || document.documentElement).appendChild(s);
    }

    function extractValue(text, input, container) {
      var cap = '';
      for (var i = 0; i < PATTERNS.length; i++) {
        var m = PATTERNS[i].exec(text);
        if (m && m[1]) { cap = m[1].trim(); break; }
      }
      var ph = (input.placeholder || '').trim();
      var val = cap;
      // 占位符通常就是要输入的名称；若截取结果混入了「复制」之类的图标文字，以占位符为准
      if (ph && cap && cap !== ph && cap.indexOf(ph) === 0) val = ph;
      // 句式没匹配上时的兜底：弹窗里同时有「输入/键入/type」和「确认/confirm」，且文字里出现了占位符
      if (!val && ph && text.indexOf(ph) !== -1 &&
          /(输入|键入|type|enter)/i.test(text) && /(确认|confirm)/i.test(text)) val = ph;
      val = val.replace(/\s*(复制|Copy)$/i, '').trim();
      if (!val) {
        var chip = cap ? container.querySelector('code,kbd,samp') : null;
        val = chip ? (chip.textContent || '').trim() : '';
      }
      return val.length >= 1 && val.length <= 100 ? val : '';
    }

    function matchesSentence(text) {
      for (var i = 0; i < PATTERNS.length; i++) if (PATTERNS[i].test(text)) return true;
      return false;
    }
    // 在容器里往下找，直到找到「刚好包住整句话」的最小元素（通常就是那个 <p>）
    function findSentenceEl(container, input) {
      var el = container;
      for (;;) {
        var next = null, kids = el.children;
        for (var i = 0; i < kids.length; i++) {
          if (kids[i].hasAttribute && kids[i].hasAttribute(ROW_ATTR)) continue;
          if (matchesSentence((kids[i].textContent || '').replace(/\s+/g, ' '))) { next = kids[i]; break; }
        }
        if (!next) break;
        el = next;
      }
      if (!matchesSentence((el.textContent || '').replace(/\s+/g, ' '))) return null;
      if (el.contains(input)) return null; // 句子和输入框混在同一块里，退回到输入框下方
      return el;
    }

    function findTargets() {
      var inputs = document.querySelectorAll(INPUT_SEL);
      var out = [];
      for (var i = 0; i < inputs.length; i++) {
        var inp = inputs[i];
        if (inp.disabled || inp.readOnly || !visible(inp)) continue;
        if (inp.closest && inp.closest('.wb-cf-root')) continue;
        var node = inp.parentElement, depth = 0;
        while (node && node !== document.body && depth < 14) {
          var txt = (node.textContent || '').replace(/\s+/g, ' ');
          if (txt.length > 20000) break; // 已经爬到整个页面了，不是弹窗
          var val = extractValue(txt, inp, node);
          if (val) { out.push({ input: inp, container: node, value: val }); break; }
          node = node.parentElement; depth++;
        }
      }
      return out;
    }

    function nativeSet(inp, val) {
      var proto = inp.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      // 用原型上的 setter 赋值，绕过 React 对 value 的拦截，React 才会认为值变了
      if (desc && desc.set) desc.set.call(inp, val); else inp.value = val;
      try {
        inp.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: val }));
      } catch (e) {
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // 返回是否已填成功。先走 execCommand（等同真人输入，框架一定认），不行再走原生 setter
    function setValue(inp, val) {
      try { inp.focus(); } catch (e) {}
      try { inp.select(); } catch (e) {}
      var ok = false;
      try { ok = document.execCommand('insertText', false, val); } catch (e) {}
      if (inp.value !== val) nativeSet(inp, val);
      return inp.value === val;
    }

    function buildRow(target) {
      var row = document.createElement('span');
      row.setAttribute(ROW_ATTR, '1');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wb-cf-fill-btn';
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg>' +
        '<span class="wb-cf-fill-t"></span><code></code>';
      // 按下时不抢走输入框焦点，也不让事件冒泡到弹窗的「点外部关闭」逻辑
      ['pointerdown', 'mousedown', 'touchstart'].forEach(function (ev) {
        btn.addEventListener(ev, function (e) { e.stopPropagation(); if (ev === 'mousedown') e.preventDefault(); });
      });
      btn.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        if (!row._input || !row._input.isConnected) return;
        var ok = setValue(row._input, row._value);
        try { console.log('[CF助手] 一键填入', JSON.stringify(row._value), ok ? '成功' : '失败'); } catch (err) {}
        refresh(row);
        if (!ok) { row._label = null; row._t.textContent = '填入失败，再试一次'; }
      });
      row.appendChild(btn);
      row._btn = btn;
      row._t = btn.querySelector('.wb-cf-fill-t');
      row._code = btn.querySelector('code');
      return row;
    }

    // 只在内容真的变了才写 DOM，避免触发 MutationObserver 死循环
    function refresh(row) {
      var done = row._input.value === row._value;
      var label = done ? '已填入' : '一键填入';
      if (row._label !== label) { row._t.textContent = label; row._label = label; }
      if (row._shownValue !== row._value) { row._code.textContent = row._value; row._shownValue = row._value; }
      if (done) { if (!row._btn.hasAttribute('data-done')) row._btn.setAttribute('data-done', '1'); }
      else if (row._btn.hasAttribute('data-done')) row._btn.removeAttribute('data-done');
    }

    function scan() {
      if (document.hidden || !document.body) return;
      var targets = findTargets();
      var keep = [];
      for (var i = 0; i < targets.length; i++) {
        var t = targets[i];
        var row = t.input.__wbFillRow;
        if (!row || !row.isConnected) {
          ensureFillStyle();
          row = buildRow(t);
          var sentence = findSentenceEl(t.container, t.input);
          if (sentence) {
            // 放在「输入 xxx 以确认。」这句话的末尾
            row.setAttribute('data-inline', '1');
            sentence.appendChild(row);
          } else {
            // 句式不规则时：放在输入框下方
            var anchor = t.input;
            while (anchor.parentElement && anchor.parentElement !== t.container &&
                   anchor.parentElement.children.length === 1) anchor = anchor.parentElement;
            if (!anchor.parentElement) continue;
            anchor.insertAdjacentElement('afterend', row);
          }
          t.input.__wbFillRow = row;
        }
        row._input = t.input;
        row._value = t.value;
        refresh(row);
        keep.push(row);
      }
      // 清理弹窗关闭后残留的按钮行
      var all = document.querySelectorAll('[' + ROW_ATTR + ']');
      for (var j = 0; j < all.length; j++) {
        if (keep.indexOf(all[j]) === -1 && all[j].parentNode) all[j].parentNode.removeChild(all[j]);
      }
    }

    var tmr = null;
    function schedule() {
      if (tmr) return;
      tmr = setTimeout(function () { tmr = null; try { scan(); } catch (e) {} }, 150);
    }
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('input', schedule, true);
    schedule();

    // 排查用：在控制台执行 __cfFillDebug() 看每个输入框为什么匹配 / 不匹配
    window.__cfFillDebug = function () {
      var rows = [];
      var ins = document.querySelectorAll(INPUT_SEL);
      for (var i = 0; i < ins.length; i++) {
        var inp = ins[i];
        var node = inp.parentElement, hit = '', d = 0;
        while (node && node !== document.body && d < 14) {
          var t = (node.textContent || '').replace(/\s+/g, ' ');
          var v = extractValue(t, inp, node);
          if (v) { hit = v; break; }
          node = node.parentElement; d++;
        }
        rows.push({ placeholder: inp.placeholder, visible: visible(inp), disabled: inp.disabled, readOnly: inp.readOnly, matchedValue: hit });
      }
      console.table(rows);
      return rows;
    };
    try { console.log('[CF助手] v4.3.3 已加载，删除确认一键填入就绪：' + location.pathname); } catch (e) {}
  })();

  /* ==================== 顶层：圆形主按钮 + 竖向弹出菜单 + 与 iframe 通信 ==================== */
  // 控制台是单页应用：脚本可能在首页加载、之后才跳转到编辑页，所以适配器在 inject() 里持续刷新
  var adapter = findAdapterForTop();

  var IDs = {
    wrap: 'wb-cf-editor-tools',
    fab: 'wb-cf-fab',
    select: 'wb-cf-btn-select',
    clear: 'wb-cf-btn-clear',
    copy: 'wb-cf-btn-copy',
    diag: 'wb-cf-btn-diag',
    toast: 'wb-cf-toast',
    panel: 'wb-cf-diag-panel',
    style: STYLE_ID
  };

  var SVG_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
  var ICONS = {
    // 主按钮箭头：默认指向上（菜单向上弹出），展开后由 CSS 翻转为指向下（收起）
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 15 12 9 18 15"/></svg>',
    select: SVG_OPEN + '<rect x="4" y="4" width="16" height="16" rx="3" stroke-dasharray="3 3"/><path d="M9 12l2 2 4-4"/></svg>',
    copy: SVG_OPEN + '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
    clear: SVG_OPEN + '<path d="M4 7h16M10 4h4M6 7l1 13h10l1-13M10 11v5M14 11v5"/></svg>',
    diag: SVG_OPEN + '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
    close: SVG_OPEN + '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>'
  };

  var pending = {};
  var seq = 0;

  /* ---------- 样式 ---------- */
  function ensureStyle() {
    if (document.getElementById(IDs.style)) return;
    var css = [
      /* 配色：跟随系统深浅色 */
      '.wb-cf-root{',
      '--bg:rgba(24,27,33,.92);--sheet:#171b21;--field:#0e1116;',
      '--bd:rgba(255,255,255,.10);--fg:#e9ecf1;--mute:#9aa3b2;',
      '--hover:rgba(255,255,255,.08);--press:rgba(255,255,255,.14);',
      '--accent:#f6821f;--on-accent:#1a1206;--danger:#ff7b72;--ok:#3fb950;',
      '--shadow:0 8px 28px rgba(0,0,0,.45),0 1px 2px rgba(0,0,0,.4);',
      '--font:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Segoe UI",system-ui,sans-serif;',
      '--mono:ui-monospace,"SF Mono",Menlo,Consolas,"Courier New",monospace;',
      'font-family:var(--font);-webkit-font-smoothing:antialiased;}',
      '@media (prefers-color-scheme:light){.wb-cf-root{',
      '--bg:rgba(255,255,255,.94);--sheet:#ffffff;--field:#f4f6f9;',
      '--bd:rgba(15,23,42,.12);--fg:#1b2230;--mute:#5d6778;',
      '--hover:rgba(15,23,42,.06);--press:rgba(15,23,42,.12);',
      '--accent:#d9650a;--on-accent:#ffffff;--danger:#c62828;--ok:#1a7f37;',
      '--shadow:0 8px 28px rgba(15,23,42,.18),0 1px 2px rgba(15,23,42,.12);}}',

      /* 圆形主按钮 + 竖向弹出菜单 */
      '.wb-cf-root{--fab-bg:#232834;--fab-fg:#ffffff;--fab-ring:rgba(255,255,255,.16);}',
      '@media (prefers-color-scheme:light){.wb-cf-root{--fab-bg:#ffffff;--fab-fg:#1b2230;--fab-ring:rgba(15,23,42,.14);}}',
      '#' + IDs.wrap + '{position:fixed;right:14px;',
      'bottom:calc(14px + env(safe-area-inset-bottom,0px));',
      'z-index:2147483647;display:flex;flex-direction:column;align-items:center;gap:10px;}',

      /* 主按钮：箭头向上，展开后翻转向下 */
      '.wb-cf-fab{-webkit-appearance:none;appearance:none;box-sizing:border-box;',
      'width:48px;height:48px;padding:0;margin:0;border:1px solid var(--fab-ring);border-radius:50%;',
      'display:inline-flex;align-items:center;justify-content:center;',
      'background:var(--fab-bg);color:var(--fab-fg);cursor:pointer;',
      'box-shadow:0 6px 20px rgba(0,0,0,.35),0 1px 3px rgba(0,0,0,.3);',
      'touch-action:manipulation;-webkit-user-select:none;user-select:none;',
      '-webkit-tap-highlight-color:transparent;transition:transform .12s,box-shadow .2s;}',
      '.wb-cf-fab svg{width:22px;height:22px;display:block;transition:transform .3s cubic-bezier(.3,.8,.3,1);}',
      '.wb-cf-fab:active{transform:scale(.92);}',
      '.wb-cf-open .wb-cf-fab svg{transform:rotate(180deg);}',

      /* 功能按钮：圆形彩色，向上依次弹出 */
      '.wb-cf-tool{-webkit-appearance:none;appearance:none;box-sizing:border-box;',
      'width:40px;height:40px;padding:0;margin:0;border:1px solid rgba(255,255,255,.2);border-radius:50%;',
      'display:inline-flex;align-items:center;justify-content:center;color:#fff;cursor:pointer;',
      'box-shadow:0 4px 14px rgba(0,0,0,.32),0 1px 2px rgba(0,0,0,.25);',
      'touch-action:manipulation;-webkit-user-select:none;user-select:none;',
      '-webkit-tap-highlight-color:transparent;',
      'opacity:0;visibility:hidden;pointer-events:none;transform:translateY(14px) scale(.6);',
      'transition:opacity .16s ease,transform .24s cubic-bezier(.3,.9,.3,1.2),visibility 0s linear .24s;}',
      '.wb-cf-tool svg{width:18px;height:18px;display:block;}',
      '.wb-cf-open .wb-cf-tool{opacity:1;visibility:visible;pointer-events:auto;transform:translateY(0) scale(1);',
      'transition-delay:calc(var(--i,0) * 35ms),calc(var(--i,0) * 35ms),0s;}',
      '.wb-cf-open .wb-cf-tool:active{transform:scale(.88);transition-delay:0s;}',
      '@media (hover:hover){.wb-cf-open .wb-cf-tool:hover{filter:brightness(1.1);}}',
      '.wb-cf-tool:focus-visible,.wb-cf-fab:focus-visible,.wb-cf-text-btn:focus-visible,.wb-cf-icon-btn:focus-visible{',
      'outline:2px solid var(--accent);outline-offset:2px;}',

      /* 提示条 */
      '.wb-cf-toast{position:fixed;left:50%;',
      'bottom:calc(28px + env(safe-area-inset-bottom,0px));',
      'transform:translate(-50%,8px);z-index:2147483647;max-width:86vw;box-sizing:border-box;',
      'display:flex;align-items:center;gap:9px;padding:10px 16px 10px 13px;',
      'background:var(--bg);color:var(--fg);border:1px solid var(--bd);border-radius:999px;',
      'box-shadow:var(--shadow);font-size:13px;line-height:1.2;pointer-events:none;opacity:0;',
      '-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);',
      'transition:opacity .22s,transform .22s;}',
      '.wb-cf-toast.wb-cf-show{opacity:1;transform:translate(-50%,0);}',
      '.wb-cf-toast i{flex:none;width:8px;height:8px;border-radius:50%;background:var(--ok);}',
      '.wb-cf-toast.wb-cf-bad i{background:var(--danger);}',
      '.wb-cf-toast span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',

      /* 诊断面板：居中卡片（手机上贴底） */
      '.wb-cf-mask{position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483647;',
      'display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;',
      'background:rgba(5,8,14,.55);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);}',
      '.wb-cf-sheet{width:min(640px,100%);height:min(72vh,560px);display:flex;flex-direction:column;',
      'background:var(--sheet);color:var(--fg);border:1px solid var(--bd);border-radius:16px;',
      'box-shadow:var(--shadow);overflow:hidden;}',
      '.wb-cf-sheet-head{display:flex;align-items:center;gap:12px;padding:14px 12px 12px 18px;}',
      '.wb-cf-sheet-title{flex:1;min-width:0;}',
      '.wb-cf-sheet-title b{display:block;font-size:15px;font-weight:600;line-height:1.3;}',
      '.wb-cf-sheet-title small{display:block;margin-top:2px;font-size:12px;color:var(--mute);',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.wb-cf-icon-btn{-webkit-appearance:none;appearance:none;flex:none;width:36px;height:36px;padding:0;',
      'border:0;border-radius:10px;background:transparent;color:var(--mute);cursor:pointer;',
      'display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s;}',
      '.wb-cf-icon-btn svg{width:18px;height:18px;display:block;}',
      '.wb-cf-icon-btn:hover{background:var(--hover);color:var(--fg);}',
      '.wb-cf-sheet textarea{flex:1;min-height:0;width:auto;margin:0 18px;box-sizing:border-box;resize:none;',
      'background:var(--field);color:var(--fg);border:1px solid var(--bd);border-radius:10px;',
      'padding:12px 14px;font:12.5px/1.65 var(--mono);outline:none;}',
      '.wb-cf-sheet textarea:focus{border-color:var(--accent);}',
      '.wb-cf-sheet-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px 16px;}',
      '.wb-cf-text-btn{-webkit-appearance:none;appearance:none;height:38px;padding:0 18px;margin:0;',
      'border:1px solid var(--bd);border-radius:10px;background:transparent;color:var(--fg);',
      'font:500 13px/1 var(--font);cursor:pointer;touch-action:manipulation;transition:background .15s;}',
      '.wb-cf-text-btn:hover{background:var(--hover);}',
      '.wb-cf-text-btn.wb-cf-primary{background:var(--accent);border-color:transparent;color:var(--on-accent);}',
      '.wb-cf-text-btn.wb-cf-primary:hover{filter:brightness(1.08);}',

      '@media (max-width:640px){',
      '#' + IDs.wrap + '{right:10px;bottom:calc(10px + env(safe-area-inset-bottom,0px));gap:8px;}',
      '.wb-cf-fab{width:44px;height:44px;}',
      '.wb-cf-tool{width:38px;height:38px;}',
      '.wb-cf-toast{bottom:calc(24px + env(safe-area-inset-bottom,0px));font-size:12.5px;}',
      '.wb-cf-mask{padding:0;align-items:flex-end;}',
      '.wb-cf-sheet{width:100%;height:78vh;border-radius:16px 16px 0 0;border-bottom:0;}',
      '.wb-cf-sheet-foot{padding-bottom:calc(16px + env(safe-area-inset-bottom,0px));}',
      '}',

      '@media (prefers-reduced-motion:reduce){',
      '.wb-cf-fab svg,.wb-cf-toast,.wb-cf-tool{transition:none !important;}}'
    ].join('');
    var style = document.createElement('style');
    style.id = IDs.style;
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  function sendToEditor(cmd, payload, cb) {
    if (typeof payload === 'function') { cb = payload; payload = {}; }
    payload = payload || {};
    var id = ++seq;
    var done = false;
    function finish(res) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      delete pending[id];
      cb(res);
    }
    var timer = setTimeout(function () {
      finish({ ok: false, method: '超时：编辑器 iframe 未响应' });
    }, 2500);
    pending[id] = { finish: finish };

    var frames = document.querySelectorAll('iframe');
    var sent = 0;
    for (var i = 0; i < frames.length; i++) {
      try {
        var src = frames[i].src || '';
        if (adapter.frameMatch(src) && frames[i].contentWindow) {
          frames[i].contentWindow.postMessage({
            __wbCfCmd: true, id: id, cmd: cmd, payload: payload
          }, '*');
          sent++;
        }
      } catch (e) {}
    }
    if (!sent) finish({ ok: false, method: '未找到编辑器 iframe' });
  }

  window.addEventListener('message', function (e) {
    if (!e.data || e.data[RES] !== true) return;
    var p = pending[e.data.id];
    if (!p) return;
    p.finish({ ok: e.data.ok, method: e.data.method, diag: e.data.diag, text: e.data.text });
  });

  /* ---------- 提示条：ok=false 时圆点变红 ---------- */
  function toast(msg, ok) {
    ensureStyle();
    var t = document.getElementById(IDs.toast);
    if (!t) {
      t = document.createElement('div');
      t.id = IDs.toast;
      t.className = 'wb-cf-root wb-cf-toast';
      t.setAttribute('role', 'status');
      t.innerHTML = '<i></i><span></span>';
      document.body.appendChild(t);
    }
    t.querySelector('span').textContent = msg;
    if (ok === false) t.classList.add('wb-cf-bad'); else t.classList.remove('wb-cf-bad');
    // 强制回流，保证连续点击时动画能重新触发
    void t.offsetWidth;
    t.classList.add('wb-cf-show');
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.classList.remove('wb-cf-show'); }, 2600);
  }

  /* ---------- 展开 / 收起 ---------- */
  function setOpen(open) {
    var wrap = document.getElementById(IDs.wrap);
    if (!wrap) return;
    if (open) wrap.classList.add('wb-cf-open'); else wrap.classList.remove('wb-cf-open');
    var fab = document.getElementById(IDs.fab);
    if (fab) {
      fab.setAttribute('aria-expanded', open ? 'true' : 'false');
      fab.title = open ? '收起代码工具' : '展开代码工具';
      fab.setAttribute('aria-label', fab.title);
    }
  }
    // 点击功能按钮不会自动折叠；只有再点主按钮才收起
  function mkTool(id, title, color, icon, order, handler) {
    var b = document.createElement('button');
    b.id = id;
    b.type = 'button';
    b.className = 'wb-cf-tool';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.style.background = color;
    b.style.setProperty('--i', String(order));
    b.innerHTML = icon;
    b.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      handler(e);
    });
    return b;
  }

  function mkFab() {
    var b = document.createElement('button');
    b.id = IDs.fab;
    b.type = 'button';
    b.className = 'wb-cf-fab';
    b.title = '展开代码工具';
    b.setAttribute('aria-label', '展开代码工具');
    b.setAttribute('aria-expanded', 'false');
    b.innerHTML = ICONS.chevron;
    b.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      var wrap = document.getElementById(IDs.wrap);
      if (!wrap) return;
      setOpen(!wrap.classList.contains('wb-cf-open'));
    });
    return b;
  }

  /* ---------- 剪贴板（顶层，用户手势上下文） ---------- */
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }
  function writeClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return legacyCopy(text); }
      );
    }
    return Promise.resolve(legacyCopy(text));
  }

  /* ---------- 工具动作 ---------- */
  function doSelect() {
    sendToEditor('selectAll', function (res) {
      if (res.ok) toast('已全选（' + (res.method || '编辑器') + '）', true);
      else toast('全选失败：' + (res.method || '未知原因'), false);
    });
  }

  // 清空：点击即执行，无二次确认
  function doClear() {
    sendToEditor('clear', function (res) {
      if (res.ok) toast('已清空（' + (res.method || '') + '）', true);
      else toast('清空失败：' + (res.method || '未知原因'), false);
    });
  }

  function doCopy() {
    sendToEditor('getText', function (res) {
      if (!res.ok || !res.text) { toast('读取代码失败：' + (res.method || '未知'), false); return; }
      writeClipboard(res.text).then(function (ok) {
        if (ok) toast('已复制全部代码', true);
        else toast('复制失败，请全选后手动复制', false);
      });
    });
  }

  /* ---------- 诊断面板 ---------- */
  function closeDiagPanel() {
    var p = document.getElementById(IDs.panel);
    if (p && p.parentNode) p.parentNode.removeChild(p);
  }

  function showDiagPanel() {
    if (document.getElementById(IDs.panel)) { closeDiagPanel(); return; }
    ensureStyle();

    var mask = document.createElement('div');
    mask.id = IDs.panel;
    mask.className = 'wb-cf-root wb-cf-mask';
    mask.addEventListener('click', function (e) { if (e.target === mask) closeDiagPanel(); });

    var sheet = document.createElement('div');
    sheet.className = 'wb-cf-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', '诊断信息');

    var head = document.createElement('div');
    head.className = 'wb-cf-sheet-head';
    var titleBox = document.createElement('div');
    titleBox.className = 'wb-cf-sheet-title';
    var b1 = document.createElement('b');
    b1.textContent = '诊断信息';
    var s1 = document.createElement('small');
    s1.textContent = adapter.label + ' · 长按可选中文本，也可直接截图';
    titleBox.appendChild(b1);
    titleBox.appendChild(s1);
    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'wb-cf-icon-btn';
    x.title = '关闭';
    x.setAttribute('aria-label', '关闭');
    x.innerHTML = ICONS.close;
    x.addEventListener('click', closeDiagPanel);
    head.appendChild(titleBox);
    head.appendChild(x);
    sheet.appendChild(head);

    var ta = document.createElement('textarea');
    ta.readOnly = true;
    ta.spellcheck = false;
    ta.value = topDiag();
    sheet.appendChild(ta);

    var foot = document.createElement('div');
    foot.className = 'wb-cf-sheet-foot';
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'wb-cf-text-btn';
    closeBtn.textContent = '关闭';
    closeBtn.addEventListener('click', closeDiagPanel);
    var copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'wb-cf-text-btn wb-cf-primary';
    copyBtn.textContent = '复制诊断';
    copyBtn.addEventListener('click', function () {
      writeClipboard(ta.value).then(function (ok) {
        if (ok) toast('已复制诊断文本', true);
        else toast('复制失败，请长按文本手动复制', false);
      });
    });
    foot.appendChild(closeBtn);
    foot.appendChild(copyBtn);
    sheet.appendChild(foot);

    mask.appendChild(sheet);
    document.body.appendChild(mask);

    sendToEditor('diagnose', function (res) {
      ta.value = topDiag().replace('等待编辑器 iframe 内诊断…', '') +
        (res.ok && res.diag ? res.diag : ('编辑器 iframe 诊断失败：' + (res.method || '无响应')));
    });
  }

  function topDiag() {
    var L = [];
    L.push('=== 编辑器助手 v4.2.0 诊断 ===');
    L.push('站点适配器: ' + adapter.label);
    L.push('时间: ' + new Date().toLocaleString());
    L.push('顶层URL: ' + location.href);
    var fs = document.querySelectorAll('iframe');
    L.push('顶层 iframe 数: ' + fs.length);
    for (var i = 0; i < fs.length; i++) {
      L.push('  iframe[' + i + '] src: ' + (fs[i].src || '(空)').slice(0, 160));
    }
    L.push('等待编辑器 iframe 内诊断…');
    return L.join('\n');
  }

  /* ---------- 注入工具栏 ---------- */
  var keyBound = false;
  function bindKeys() {
    if (keyBound) return;
    keyBound = true;
    // Esc 只关闭诊断面板，不影响工具菜单
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && document.getElementById(IDs.panel)) closeDiagPanel();
    });
  }

  function inject() {
    var wrap = document.getElementById(IDs.wrap);
    adapter = findAdapterForTop() || adapter;

    // 不在代码编辑页：移除按钮（兼容 SPA 内部导航）
    if (!adapter || !isEditorPage()) {
      if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
      return;
    }
    if (wrap) return;
    if (!document.body) return;
    ensureStyle();

    wrap = document.createElement('div');
    wrap.id = IDs.wrap;
    wrap.className = 'wb-cf-root';

    // 视觉从上到下：诊断 → 复制 → 清空 → 全选 → 主按钮（全选离主按钮最近）
    wrap.appendChild(mkTool(IDs.diag, '诊断', '#d97706', ICONS.diag, 3, showDiagPanel));
    wrap.appendChild(mkTool(IDs.copy, '复制全部代码', '#0f766e', ICONS.copy, 2, doCopy));
    wrap.appendChild(mkTool(IDs.clear, '清空代码', '#dc2626', ICONS.clear, 1, doClear));
    wrap.appendChild(mkTool(IDs.select, '全选代码', '#2563eb', ICONS.select, 0, doSelect));
    wrap.appendChild(mkFab());

    document.body.appendChild(wrap);
    bindKeys();
    sendToEditor('ping', function () {});
  }

  // 持续轮询（很轻量）：用户从控制台首页点进编辑页时也能及时出现
  setInterval(function () { try { inject(); } catch (e) {} }, 800);
})();
