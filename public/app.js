const state = {
  snapshot: null,
  recordId: 'SKU-1001',
  pendingOrder: null,
  showRaw: false,
  busy: new Set(),
  banners: [],
  lastAction: null,
  scenarioRunning: false,
};

const STATUS_TEXT = {
  authorized: '已授权',
  cleared: '明确清空',
  denied: '未授权',
  missing: '已答复·缺失',
  pending: '等待中',
  uncollected: '未采集',
  invalid: '格式无效',
  unavailable: '无来源负责',
};

const STATUS_GLYPH = {
  authorized: '✓',
  cleared: '∅',
  denied: '⊘',
  missing: '–',
  pending: '…',
  uncollected: '○',
  invalid: '!',
  unavailable: '×',
};

const EVENT_TEXT = {
  demo_reset: '重置演示',
  priority_changed: '调整优先级',
  fetch_ok: '采集成功',
  fetch_failed: '采集失败',
  collect_finished: '一轮采集结束',
  published: '发布新版本',
  delivered: '投递下游',
  source_admin: '来源控制',
  revision_queued: '来源修订入队',
};

const $ = (selector) => document.querySelector(selector);

const els = {
  recordSelect: $('#record-select'),
  clock: $('#clock'),
  resetDemo: $('#reset-demo'),
  bannerStack: $('#banner-stack'),
  sourceGrid: $('#source-grid'),
  priorityStrip: $('#priority-strip'),
  priorityImpact: $('#priority-impact'),
  priorityReset: $('#priority-reset'),
  collectAll: $('#collect-all'),
  fieldRows: $('#field-rows'),
  fieldsSub: $('#fields-sub'),
  toggleRaw: $('#toggle-raw'),
  legend: $('#legend'),
  promiseBody: $('#promise-body'),
  publishBody: $('#publish-body'),
  receiverBody: $('#receiver-body'),
  rawList: $('#raw-list'),
  rawCount: $('#raw-count'),
  eventList: $('#event-list'),
  scenarioGrid: $('#scenario-grid'),
  scenarioStatus: $('#scenario-status'),
  toastRegion: $('#toast-region'),
  partialDialog: $('#partial-dialog'),
  partialSummary: $('#partial-summary'),
  partialNote: $('#partial-note'),
  partialConfirm: $('#partial-confirm'),
};

/* ---------------------------------- utils --------------------------------- */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function timeOf(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

function shortDateTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return String(value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(data.message ?? `HTTP ${response.status}`);
    error.code = data.error;
    error.status = response.status;
    error.detail = data.detail;
    throw error;
  }
  return data;
}

function toast(message, kind = '') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`.trim();
  node.textContent = message;
  els.toastRegion.append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .3s ease';
    setTimeout(() => node.remove(), 320);
  }, 4200);
}

function setBanner(id, kind, html) {
  state.banners = state.banners.filter((banner) => banner.id !== id);
  state.banners.unshift({ id, kind, html });
  renderBanners();
}

function clearBanner(id) {
  state.banners = state.banners.filter((banner) => banner.id !== id);
  renderBanners();
}

function renderBanners() {
  els.bannerStack.innerHTML = state.banners
    .map(
      (banner) => `<div class="banner ${banner.kind}" data-banner="${escapeHtml(banner.id)}">
        <div>${banner.html}</div>
        <button class="banner-close" type="button" data-dismiss="${escapeHtml(banner.id)}" aria-label="关闭提示">✕</button>
      </div>`,
    )
    .join('');
}

async function withBusy(key, fn) {
  state.busy.add(key);
  render();
  try {
    return await fn();
  } finally {
    state.busy.delete(key);
    render();
  }
}

/* ---------------------------------- data ---------------------------------- */

async function loadSnapshot(recordId = state.recordId) {
  const data = await api(`/api/bootstrap?record=${encodeURIComponent(recordId)}`);
  state.recordId = recordId;
  state.snapshot = data;
  state.pendingOrder = null;
  render();
}

function sourceById(id) {
  return state.snapshot?.sources.find((source) => source.id === id) ?? null;
}

function priorityOrder() {
  return (state.pendingOrder ?? state.snapshot?.sources ?? []).map((source) => source.id);
}

/* --------------------------------- render --------------------------------- */

function render() {
  if (!state.snapshot) return;
  document.body.dataset.record = state.recordId;
  renderRecordPicker();
  renderSources();
  renderPriority();
  renderFields();
  renderPromise();
  renderPublish();
  renderReceiver();
  renderRaw();
  renderEvents();
  renderScenarios();
  els.clock.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function renderRecordPicker() {
  const products = state.snapshot.products;
  if (els.recordSelect.options.length !== products.length) {
    els.recordSelect.innerHTML = products
      .map((product) => `<option value="${escapeHtml(product.id)}">${escapeHtml(product.id)} · ${escapeHtml(product.title ?? '（无标题）')}</option>`)
      .join('');
  }
  for (const product of products) {
    const option = els.recordSelect.querySelector(`option[value="${CSS.escape(product.id)}"]`);
    if (option) option.textContent = `${product.id} · ${product.title ?? '（无标题）'}`;
  }
  els.recordSelect.value = state.recordId;
}

function renderSources() {
  const record = state.snapshot.record;
  els.sourceGrid.innerHTML = state.snapshot.sources
    .map((source) => {
      const health = record.health[source.id] ?? {};
      const busyKey = `source:${source.id}`;
      const pendingRev = health.pendingRevision;
      const lastAttempt = health.lastAttempt;
      return `<article class="source-card ${source.online ? '' : 'is-offline'} ${source.priority === 1 ? 'is-priority-1' : ''}" data-source="${source.id}">
        <div class="source-top">
          <div class="source-name"><span class="dot ${source.online ? '' : 'off'}"></span>${escapeHtml(source.name)}</div>
          <span class="rank-chip">P${source.priority}</span>
        </div>
        <div class="source-meta">
          <span><code>${escapeHtml(source.dialect)}</code></span>
          <span>:${source.port}</span>
          <span>${source.requests} 次请求</span>
        </div>
        <p class="source-note">${escapeHtml(source.note)}</p>
        <div class="source-facts">
          <span>负责 <b>${source.owned.length}</b> 字段</span>
          <span>本记录版本 <b>v${health.recordVersion ?? '?'}</b></span>
          <span>${
            pendingRev
              ? `<b style="color:var(--warn)">● 待回传 ${escapeHtml(pendingRev.field)}</b>`
              : lastAttempt
                ? `上次 ${lastAttempt.status === 'ok' ? '成功' : '失败'} ${timeOf(lastAttempt.finishedAt)}`
                : '尚未请求'
          }</span>
        </div>
        <div class="source-controls">
          <button class="btn btn-small ${state.busy.has(busyKey) ? 'busy' : ''}" type="button" data-source-action="online" data-source-id="${source.id}" data-online="${source.online ? 'false' : 'true'}">
            ${source.online ? '断开连接' : '恢复连接'}
          </button>
          <button class="btn btn-small" type="button" data-source-action="revision" data-source-id="${source.id}" ${source.owned.length ? '' : 'disabled'}>回传修订</button>
          <button class="btn btn-small" type="button" data-source-action="fail-next" data-source-id="${source.id}">注入失败</button>
        </div>
      </article>`;
    })
    .join('');
}

function renderPriority() {
  const items = state.pendingOrder ?? state.snapshot.sources;
  els.priorityStrip.innerHTML = items
    .map(
      (source, index) => `<li class="priority-item" draggable="true" data-priority-id="${source.id}" data-index="${index}">
        <span class="priority-handle" aria-hidden="true">⠿</span>
        <span class="priority-rank">${index + 1}</span>
        <span>${escapeHtml(source.name)}</span>
        <button class="priority-arrow" type="button" data-move="${source.id}" data-dir="-1" ${index === 0 ? 'disabled' : ''} aria-label="${escapeHtml(source.name)} 上移">↑</button>
        <button class="priority-arrow" type="button" data-move="${source.id}" data-dir="1" ${index === items.length - 1 ? 'disabled' : ''} aria-label="${escapeHtml(source.name)} 下移">↓</button>
      </li>`,
    )
    .join('');
  renderImpact();
}

function renderImpact() {
  if (!state.pendingOrder) {
    els.priorityImpact.innerHTML = '';
    return;
  }
  const decision = state.snapshot.record.decision;
  const hypothetical = computeHypothetical(decision, state.pendingOrder);
  const changed = hypothetical.changed;
  if (!changed.length) {
    els.priorityImpact.innerHTML = `<div class="impact-head"><strong>按此顺序，当前裁决不变。</strong>
      <button class="btn btn-small" type="button" data-apply-priority>应用顺序</button>
      <button class="btn btn-small btn-quiet" type="button" data-cancel-priority>取消</button></div>`;
    return;
  }
  els.priorityImpact.innerHTML = `
    <div class="impact-head">
      <strong>将影响 ${changed.length} 个字段</strong>
      <span style="color:var(--ink-faint);font-size:12px">应用后仅重取这些字段，不碰其它字段</span>
    </div>
    <ul class="impact-list">
      ${changed
        .map(
          (item) => `<li class="impact-row">
            <span class="field-name">${escapeHtml(item.label)}</span>
            <span>${describeWinner(item.before)}</span>
            <span class="impact-arrow">→</span>
            <span>${describeWinner(item.after)}</span>
          </li>`,
        )
        .join('')}
    </ul>
    <div class="impact-actions">
      <button class="btn btn-primary btn-small" type="button" data-apply-priority>应用顺序并补采 ${changed.length} 个字段</button>
      <button class="btn btn-small" type="button" data-apply-priority-only>仅改顺序</button>
      <button class="btn btn-small btn-quiet" type="button" data-cancel-priority>取消</button>
    </div>`;
}

/**
 * Mirror of the server's priority decision, used only to preview the impact
 * before applying. The authoritative result is recomputed by the server.
 */
function computeHypothetical(decision, order) {
  const rank = Object.fromEntries(order.map((source, index) => [source.id, index + 1]));
  const changed = [];
  for (const [field, info] of Object.entries(decision.fields)) {
    const candidates = info.considered
      .filter((entry) => entry.state === 'authorized' || entry.state === 'cleared')
      .sort((a, b) => rank[a.sourceId] - rank[b.sourceId]);
    const current = info.state === 'authorized' || info.state === 'cleared'
      ? { sourceId: info.sourceId, value: info.value, state: info.state }
      : null;
    const next = candidates[0] ? { sourceId: candidates[0].sourceId, value: candidates[0].value, state: candidates[0].state } : null;
    const differs = (current?.sourceId ?? null) !== (next?.sourceId ?? null) || (current?.state ?? null) !== (next?.state ?? null);
    if (differs) {
      changed.push({
        field,
        label: info.label,
        before: current ?? { sourceId: null, state: info.state, value: null },
        after: next ?? { sourceId: null, state: info.state, value: null },
      });
    }
  }
  return { changed };
}

function describeWinner(entry) {
  if (!entry || (!entry.sourceId && entry.state !== 'pending')) {
    return `<span style="color:var(--ink-faint)">${escapeHtml(STATUS_TEXT[entry?.state] ?? '无')}</span>`;
  }
  if (!entry.sourceId) return `<span style="color:var(--ink-faint)">${escapeHtml(STATUS_TEXT[entry.state] ?? '无')}</span>`;
  const source = sourceById(entry.sourceId);
  const name = source?.name ?? entry.sourceId;
  const value = formatValue(entry.value);
  return `<span class="source-chip">${escapeHtml(name)}</span> <span style="font-family:var(--mono);font-size:11.5px">${value === null ? '（清空）' : escapeHtml(value)}</span>`;
}

function badgeFor(fieldInfo) {
  const badges = [`<span class="badge ${fieldInfo.state}"><span class="glyph">${STATUS_GLYPH[fieldInfo.state] ?? '·'}</span>${STATUS_TEXT[fieldInfo.state] ?? fieldInfo.state}</span>`];
  if (fieldInfo.provisional) badges.push('<span class="badge provisional"><span class="glyph">~</span>暂定</span>');
  if (fieldInfo.stale) badges.push('<span class="badge denied" style="font-size:10.5px"><span class="glyph">!</span>来源不可达</span>');
  if (fieldInfo.revisionPending) badges.push('<span class="badge pending" style="font-size:10.5px"><span class="glyph">↻</span>来源有更新待取</span>');
  return `<div class="badge-stack">${badges.join('')}</div>`;
}

function fieldRowClass(info) {
  if (info.stale) return 'row-stale';
  if (info.state === 'pending' || info.state === 'uncollected' || info.provisional) return 'row-waiting';
  return '';
}

function evidenceFor(info) {
  const lines = [];
  if (info.state === 'cleared') {
    const sup = info.suppressed.filter((item) => item.reason === 'higher_priority_clear');
    lines.push(`<div class="ev-line ev-warn">${escapeHtml(info.sourceName)} 明确清空；${sup.length ? `${sup.length} 个低优先值未采用` : '无低优先值'}</div>`);
  }
  if (info.deniedBy?.length) {
    const names = info.deniedBy.map((entry) => entry.sourceName).join('、');
    lines.push(`<div class="ev-line ev-danger">${escapeHtml(names)} 未授权该字段（不同于缺失）</div>`);
  }
  if (info.state === 'missing') {
    const answered = info.considered.filter((entry) => entry.state === 'missing').map((entry) => entry.sourceName);
    if (answered.length) lines.push(`<div class="ev-line">已答复但无值：${escapeHtml(answered.join('、'))}</div>`);
  }
  if (info.state === 'pending' || info.state === 'uncollected') {
    const waiting = (info.unverifiedBy?.length ? info.unverifiedBy : info.waitingFor) ?? [];
    const names = waiting.map((entry) => `${entry.sourceName}（${reasonText(entry.reason)}）`).join('、');
    lines.push(`<div class="ev-line ev-warn">${escapeHtml(names || '尚未提问')}</div>`);
  }
  if (info.provisional && info.unverifiedBy?.length) {
    const names = info.unverifiedBy.map((entry) => entry.sourceName).join('、');
    lines.push(`<div class="ev-line ev-warn">高优先 ${escapeHtml(names)} 尚未答复，当前值只作过渡</div>`);
  }
  if (info.stale) {
    lines.push(`<div class="ev-line ev-danger">最近一次请求失败或来源不可达，这个值是较早响应的存量，暂不可用于承诺</div>`);
  }
  if (info.pendingAtSource?.length) {
    const pending = info.pendingAtSource.map((entry) => entry.sourceName).join('、');
    lines.push(`<div class="ev-line ev-warn">${escapeHtml(pending)} 已排队修订，下一次请求才会体现</div>`);
  }
  if (info.versionBehind > 0) {
    lines.push(`<div class="ev-line ev-warn">来源已推进 ${info.versionBehind} 个版本，本地尚未重取</div>`);
  }
  if (info.suppressed?.length && info.state !== 'cleared') {
    const lower = info.suppressed.map((entry) => entry.sourceName);
    lines.push(`<div class="ev-line">未采用：${escapeHtml(lower.join('、'))}（优先级更低）</div>`);
  }
  if (info.rawResponseId) {
    lines.push(
      `<div class="ev-line">凭据 <button class="ev-button" type="button" data-open-raw="${info.rawResponseId}">原始响应 #${info.rawResponseId}</button> · v${info.sourceVersion ?? '?'} · ${timeOf(info.fetchedAt)}</div>`,
    );
  }
  if (!lines.length) lines.push('<div class="ev-line">—</div>');
  return lines.join('');
}

function reasonText(reason) {
  return (
    {
      never_asked: '未提问',
      source_offline: '来源离线',
      last_request_failed: '上次请求失败',
      no_claim: '无答复',
    }[reason] ?? reason
  );
}

function renderFields() {
  const decision = state.snapshot.record.decision;
  const fields = state.snapshot.fields;
  els.fieldsSub.textContent = `按当前优先级逐字段选择来源。${decision.complete ? '必填字段均已确认。' : `仍有 ${decision.blockingRequired.length} 个必填字段未确认。`}`;
  const waiting = new Set([...decision.waitingFields]);
  els.fieldRows.innerHTML = fields
    .map((meta) => {
      const info = decision.fields[meta.field];
      const value = formatValue(info.value);
      const isWaiting = waiting.has(meta.field);
      const source = info.sourceId ? sourceById(info.sourceId) : null;
      const sourceClass = info.stale ? 'is-stale' : info.provisional ? 'is-provisional' : '';
      return `<tr class="${fieldRowClass(info)}" data-field-row="${meta.field}">
        <td class="field-name-cell">
          <span class="label">${escapeHtml(meta.label)}${meta.required ? '<span class="req-tag">必填</span>' : ''}</span>
          <span class="field-key">${meta.field}</span>
        </td>
        <td>${badgeFor(info)}</td>
        <td class="value-cell">
          ${
            value === null
              ? `<span class="value-main empty">${
                  info.state === 'cleared' ? '（来源明确清空）' : info.state === 'denied' ? '（来源未授权）' : info.state === 'missing' ? '（来源无此值）' : isWaiting ? '（等待中）' : '（无值）'
                }</span>`
              : `<span class="value-main">${escapeHtml(value)}</span>`
          }
        </td>
        <td>${
          source
            ? `<span class="source-chip ${sourceClass}"><span class="src-rank">P${source.priority}</span>${escapeHtml(source.name)}</span>`
            : '<span style="color:var(--ink-faint);font-size:12px">—</span>'
        }</td>
        <td><div class="evidence">${evidenceFor(info)}</div></td>
        <td>
          <div class="row-actions">
            <button class="btn btn-small" type="button" data-refetch-field="${meta.field}" ${state.busy.has('collect') ? 'disabled' : ''}>重取</button>
          </div>
        </td>
      </tr>`;
    })
    .join('');
  renderLegend();
  els.toggleRaw.setAttribute('aria-pressed', String(state.showRaw));
  els.toggleRaw.textContent = state.showRaw ? '隐藏原始帧' : '显示原始帧';
}

function renderLegend() {
  const items = ['authorized', 'missing', 'cleared', 'denied', 'pending', 'uncollected'];
  els.legend.innerHTML = items
    .map(
      (key, index) => `<span class="legend-item"><span class="legend-swatch ${key === 'uncollected' ? 'swatch-uncollected' : `swatch-${key}`}"></span>${STATUS_TEXT[key]}${
        index === 0 ? '：可发布' : index === 4 ? '：尚无答案' : index === 5 ? '：从未提问' : ''
      }</span>`,
    )
    .join('') + '<span class="legend-item">「缺失」= 来源明确答复但没有值，不是清空，也不等于未授权。</span>';
}

function renderPromise() {
  const decision = state.snapshot.record.decision;
  const active = state.snapshot.record.activePublication;
  const unpublished = state.snapshot.record.unpublishedChanges;
  const waiting = decision.waitingFields;
  const blocking = decision.blockingRequired;
  const promiseNow = decision.complete ? 'complete' : 'partial';
  const promiseText = decision.complete ? '可承诺完整' : '只能承诺部分';
  const summaryCopy = decision.complete
    ? '所有必填字段都已由授权来源确认，且没有更高优先来源尚未答复。'
    : blocking.length
      ? `必填字段 ${blocking.map((field) => fieldLabel(field)).join('、')} 尚未确认，发布只能声明「部分」。`
      : '当前只有一个部分结果可发布。';

  const pct = decision.requiredTotal ? Math.round((decision.requiredFilled / decision.requiredTotal) * 100) : 0;

  const settledBlockers = blocking.filter((field) => {
    const info = decision.fields[field];
    return info.state !== 'pending' && info.state !== 'uncollected' && !info.provisional;
  });
  const waitList = waiting.length
    ? `<ul class="wait-list">${waiting
        .map((field) => {
          const info = decision.fields[field];
          const sources = (info.unverifiedBy?.length ? info.unverifiedBy : info.waitingFor) ?? [];
          const sourceCopy = sources.length
            ? sources.map((entry) => `${escapeHtml(entry.sourceName)} · ${reasonText(entry.reason)}`).join('；')
            : '已排队的来源修订尚未拉取';
          const why =
            info.stale && info.state === 'authorized'
              ? '值来自较早响应，来源当前不可达；不可用于承诺'
              : info.state === 'uncollected'
              ? '从未向来源请求，不能当作「缺失」'
              : info.state === 'pending'
                ? '来源尚未给出答复'
                : info.provisional
                  ? '已有值守，但更高优先来源未答复'
                  : '来源有更新待取';
          return `<li class="wait-item">
            <span class="wait-field">${escapeHtml(fieldLabel(field))}${info.required ? '<span class="req-tag" style="margin-left:5px">必填</span>' : ''}</span>
            <span class="wait-copy">${why}<br />${sourceCopy}</span>
          </li>`;
        })
        .join('')}</ul>`
    : settledBlockers.length
      ? `<div class="promise-empty">没有字段在等待。${settledBlockers
          .map((field) => `「${escapeHtml(fieldLabel(field))}」`)
          .join('、')} 已有明确结论（${
          settledBlockers.map((field) => STATUS_TEXT[decision.fields[field].state] ?? '已答复').join('、')
        }），不是缺失，也不会随时间自行补齐；需来源给出新的答复后才能承诺完整。</div>`
      : `<div class="promise-empty">没有字段在等待。每个字段都有明确结论。</div>`;

  const delta = active
    ? unpublished.fields.length || unpublished.contractChanged
      ? `<div class="promise-delta"><span class="delta-tag">未发布</span>当前裁决与已发布 r${active.revision} 不同${
          unpublished.contractChanged ? `（承诺 ${unpublished.promised} → ${unpublished.wouldPromise}）` : ''
        }：${unpublished.fields.map((field) => escapeHtml(fieldLabel(field))).join('、') || '仅承诺表述'}</div>`
      : `<div class="promise-delta"><span class="delta-tag" style="color:var(--ok);background:var(--ok-soft);border-color:#b2d4c1">一致</span>当前裁决与已发布 r${active.revision} 一致。</div>`
    : `<div class="promise-delta"><span class="delta-tag">未发布</span>尚无发布版本，下游拿不到任何结果。</div>`;

  els.promiseBody.innerHTML = `
    <div class="promise-summary ${promiseNow}">
      <span class="promise-icon">${decision.complete ? '◉' : '◐'}</span>
      <div>
        <h3>${promiseText}</h3>
        <p>${escapeHtml(summaryCopy)}</p>
      </div>
    </div>
    <div class="meter">
      <div class="meter-track"><div class="meter-fill ${decision.complete ? '' : 'is-partial'}" style="width:${pct}%"></div></div>
      <div class="meter-label"><span>必填完成 ${decision.requiredFilled}/${decision.requiredTotal}</span><span>${pct}%</span></div>
    </div>
    <h3 class="subhead">仍在等待</h3>
    ${waitList}
    ${delta}
  `;
}

function fieldLabel(field) {
  const key = Array.isArray(field) ? field[0] : field;
  const meta = state.snapshot.fields.find((item) => item.field === key);
  return meta?.label ?? key;
}

function renderPublish() {
  const record = state.snapshot.record;
  const active = record.activePublication;
  const history = record.publicationHistory;
  const decision = record.decision;
  const canComplete = decision.complete;
  const busy = state.busy.has('publish') || state.busy.has('deliver');

  els.publishBody.innerHTML = `
    <div class="publish-status">
      ${
        active
          ? `<span>当前版本 <b>r${active.revision}</b> · <span class="mini-badge ${active.contract.promise}">${active.contract.promise === 'complete' ? '完整' : '部分'}</span></span><span class="rev">${shortDateTime(active.created_at)}</span>`
          : '<span style="color:var(--ink-faint)">尚未发布任何版本</span><span></span>'
      }
    </div>
    ${active?.contract?.note ? `<div class="publish-note">备注：${escapeHtml(active.contract.note)}</div>` : ''}
    <div class="publish-actions">
      <button class="btn btn-primary" type="button" id="publish-complete" ${canComplete ? '' : 'disabled'} ${busy ? 'disabled' : ''} title="${canComplete ? '' : '必填字段未确认，无法承诺完整'}">发布完整版</button>
      <button class="btn ${canComplete ? '' : 'btn-warn'}" type="button" id="publish-partial" ${busy ? 'disabled' : ''}>发布部分版…</button>
      <button class="btn" type="button" id="deliver-active" ${active ? '' : 'disabled'} ${busy ? 'disabled' : ''}>投递当前版本</button>
      <button class="btn btn-quiet" type="button" id="deliver-duplicate" ${active ? '' : 'disabled'} ${busy ? 'disabled' : ''} title="用同一个幂等键再次投递，验证下游不会重复入库">重复领取</button>
    </div>
    <div class="history">
      <h3>版本历史（点击查看当时承诺）</h3>
      ${
        history.length
          ? `<ul class="history-list">${history
              .map(
                (pub) => `<li class="history-item ${pub.id === active?.id ? 'is-active' : ''}">
                  <span class="rev-no">r${pub.revision}</span>
                  <span class="mini-badge ${pub.contract.promise}">${pub.contract.promise === 'complete' ? '完整' : '部分'}</span>
                  <span class="hist-meta">${shortDateTime(pub.created_at)}${pub.id === active?.id ? ' · 当前' : pub.superseded_by ? ' · 已被取代' : ''}${
                    pub.deliveries?.length ? ` · 投递 ${pub.deliveries.length}` : ''
                  }</span>
                  <button type="button" data-view-pub="${pub.id}">查看</button>
                </li>`,
              )
              .join('')}</ul>`
          : '<div class="promise-empty" style="padding:8px">还没有发布记录。</div>'
      }
    </div>
  `;
}

function renderReceiver() {
  const receiver = state.snapshot.receiver;
  const receipts = receiver.receipts;
  els.receiverBody.innerHTML = `
    <div class="publish-status">
      <span>端口 <b>:${receiver.port ?? '—'}</b></span>
      <span class="rev">已入库 ${receipts.length} 份 · 重复领取 ${receiver.duplicateAttempts} 次</span>
    </div>
    ${
      receipts.length
        ? `<ul class="receipt-list">${[...receipts]
            .reverse()
            .map(
              (receipt) => `<li class="receipt">
                <span class="rcpt-id">${escapeHtml(receipt.id)}</span>
                <span>${escapeHtml(receipt.recordId)} · r${receipt.revision}</span>
                <span class="mini-badge ${receipt.promise}">${receipt.promise === 'complete' ? '完整' : '部分'}</span>
                ${receipt.duplicates ? `<span class="dup-flag">+${receipt.duplicates} 重复被拒收</span>` : ''}
                <span class="rcpt-meta">${timeOf(receipt.receivedAt)}</span>
              </li>`,
            )
            .join('')}</ul>`
        : '<div class="receiver-empty">下游还没有收到任何版本。</div>'
    }
    ${
      receipts.some((receipt) => receipt.promise === 'partial')
        ? `<div class="promise-delta" style="border-top:none;padding-top:6px"><span class="delta-tag">等待中</span>接收端保存了部分版本：${escapeHtml(
            receipts
              .filter((receipt) => receipt.promise === 'partial')
              .slice(-1)[0]
              .blockingRequired.map((field) => fieldLabel(field))
              .join('、'),
          )} 仍未确认。</div>`
        : ''
    }
    <div class="receiver-actions">
      <button class="btn btn-small btn-quiet" type="button" id="reset-receiver">清空接收记录</button>
    </div>
  `;
}

function renderRaw() {
  const rows = state.snapshot.record.rawResponses;
  els.rawCount.textContent = String(rows.length);
  if (!rows.length) {
    els.rawList.innerHTML = '<li class="raw-empty">本记录还没有发出过请求。</li>';
    return;
  }
  els.rawList.innerHTML = rows
    .map((raw) => {
      const isError = raw.httpStatus >= 400;
      const source = sourceById(raw.sourceId);
      return `<li><details class="raw-item ${isError ? 'is-error' : ''}" data-raw-id="${raw.id}" ${state.showRaw ? 'open' : ''}>
        <summary>
          <span class="raw-time">${timeOf(raw.fetchedAt)}</span>
          <span>${escapeHtml(source?.name ?? raw.sourceId)}</span>
          <span class="raw-kind">${escapeHtml(raw.requestKind)}</span>
          <span class="raw-fields">${escapeHtml(raw.requestedFields.join(', '))}</span>
          <span class="status-code ${isError ? 'bad' : 'ok'}">${raw.httpStatus}</span>
        </summary>
        <pre class="raw-body">${escapeHtml(prettyJson(raw.body))}</pre>
        <div class="raw-meta">
          <span>原始响应 <b>#${raw.id}</b></span>
          <span>来源版本 <b>v${raw.version ?? '—'}</b></span>
          <span>抓取时优先级 <b>P${raw.priority}</b></span>
          <span>触发：<b>${escapeHtml(raw.reason)}</b></span>
        </div>
      </details></li>`;
    })
    .join('');
}

function prettyJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function renderEvents() {
  const events = state.snapshot.events;
  if (!events.length) {
    els.eventList.innerHTML = '<li class="event-empty">还没有操作。</li>';
    return;
  }
  els.eventList.innerHTML = events
    .map((event) => {
      const detail = eventDetail(event);
      return `<li class="event-item">
        <span class="event-time">${timeOf(event.at)}</span>
        <span class="event-copy"><span class="event-kind">${EVENT_TEXT[event.kind] ?? event.kind}</span>${escapeHtml(event.record_id ?? '')}${detail ? `<span class="event-detail">${detail}</span>` : ''}</span>
      </li>`;
    })
    .join('');
}

function eventDetail(event) {
  const detail = event.detail ?? {};
  switch (event.kind) {
    case 'priority_changed':
      return `${detail.order?.join(' → ')}${detail.affectedFields?.length ? ` · 影响 ${detail.affectedFields.map((f) => escapeHtml(fieldLabel(f))).join('、')}` : ' · 无影响'}`;
    case 'fetch_ok':
      return `${escapeHtml(detail.sourceName ?? '')} · ${detail.fields?.join(', ')} · v${detail.version}`;
    case 'fetch_failed':
      return `${escapeHtml(detail.sourceId)} · ${escapeHtml(detail.errorCode)}`;
    case 'collect_finished':
      return `${escapeHtml(detail.reason)} · ${detail.attempts?.map((attempt) => `${attempt.sourceId}:${attempt.ok ? 'ok' : attempt.errorCode}`).join(' ')}`;
    case 'published':
      return `第 ${detail.revision} 版 · ${detail.promise === 'complete' ? '完整' : '部分'}`;
    case 'delivered':
      return `HTTP ${detail.status}${detail.duplicate ? ' · 重复领取被识别' : ''}`;
    case 'source_admin':
      return `${escapeHtml(detail.sourceId)} · ${escapeHtml(detail.action)}${detail.action === 'online' ? ` · ${detail.online ? '在线' : '离线'}` : ''}${detail.delayMs != null ? ` · ${detail.delayMs}ms` : ''}`;
    case 'revision_queued':
      return `${escapeHtml(detail.sourceId)} · ${escapeHtml(fieldLabel(detail.field))} → ${detail.value === null ? '（清空）' : escapeHtml(String(detail.value))}`;
    default:
      return '';
  }
}

const SCENARIOS = [
  {
    id: 'priority',
    title: '换优先级只补采受影响字段',
    copy: '把 Cirrus 提到首位，先看影响面；应用后仅重取受影响的字段，然后发布新版并对比旧版。',
    steps: 'priority → 影响字段 → 补采 → 发布 → 旧版仍可查',
  },
  {
    id: 'disconnect',
    title: '来源断连与补采',
    copy: '断开 Aurora 后只补标题与价格，观察必填字段如何变为等待、发布被拒绝，再恢复连接补取。',
    steps: 'offline aurora → 补采 title,price → 发布被挡 → 恢复 → 补采',
  },
  {
    id: 'revision',
    title: '补采途中再次修订',
    copy: '在请求在途时让 Aurora 排队一条修订：本次响应不会包含它，页面会标出「来源有更新待取」。',
    steps: '调慢 aurora → 发起补采 → 途中排队修订 → 再取一次',
  },
  {
    id: 'duplicate',
    title: '下游重复领取',
    copy: '同一版本用同一幂等键投递两次，接收端只入库一份，并记录第二次为重复。',
    steps: '发布 → 投递 → 重复领取 → 核对接收端',
  },
];

function renderScenarios() {
  els.scenarioGrid.innerHTML = SCENARIOS.map(
    (scenario) => `<article class="scenario-card">
      <h3>${escapeHtml(scenario.title)}</h3>
      <p>${escapeHtml(scenario.copy)}</p>
      <div class="scenario-steps">${escapeHtml(scenario.steps)}</div>
      <button class="btn btn-small" type="button" data-scenario="${scenario.id}" ${state.scenarioRunning ? 'disabled' : ''}>运行</button>
    </article>`,
  ).join('');
}

/* -------------------------------- actions --------------------------------- */

async function refresh(recordId = state.recordId) {
  const data = await api(`/api/recompute`, { method: 'POST', body: { recordId } });
  state.snapshot = data.snapshot;
  render();
}

async function runCollect({ recordId = state.recordId, fields = null, reason = null, silent = false } = {}) {
  return withBusy('collect', async () => {
    if (!silent) toast(fields ? `正在补采 ${fields.map((f) => fieldLabel(f)).join('、')}…` : '正在向三个来源采集…');
    const body = { recordId, reason: reason ?? (fields ? 'manual_scoped_refetch' : 'manual_full_fetch') };
    if (fields) body.fields = fields;
    const data = await api('/api/collect', { method: 'POST', body });
    state.snapshot = data.snapshot;
    const failures = data.attempts.filter((attempt) => !attempt.ok);
    if (failures.length) {
      const copy = failures.map((attempt) => `${sourceById(attempt.sourceId)?.name ?? attempt.sourceId}（${attempt.errorCode}）`).join('、');
      setBanner('collect-failure', 'danger', `<strong>有来源未能应答：</strong>${escapeHtml(copy)}。相关字段不会被当作缺失处理。`);
    } else {
      clearBanner('collect-failure');
    }
    const changed = data.attempts.filter((attempt) => attempt.ok).length;
    if (!silent) toast(`采集完成：${changed}/${data.attempts.length} 个来源应答`, failures.length ? 'error' : 'success');
    return data;
  });
}

async function runApplyPriority({ refetch = true } = {}) {
  if (!state.pendingOrder) return null;
  const order = state.pendingOrder.map((source) => source.id);
  return withBusy('priority', async () => {
    const data = await api('/api/priority', { method: 'POST', body: { order, recordId: state.recordId } });
    state.snapshot = data.snapshot;
    state.pendingOrder = null;
    render();
    const affected = data.affectedFields;
    if (!affected.length) {
      toast('优先级已更新，当前裁决无需变化');
      return;
    }
    setBanner(
      'priority-applied',
      'info',
      `<strong>优先级已改为 ${escapeHtml(order.join(' → '))}。</strong>受影响字段：${affected.map((field) => escapeHtml(fieldLabel(field))).join('、')}。${
        refetch ? '正在只补采这些字段。' : '尚未重取，页面会标出未发布差异。'
      }`,
    );
    toast(`优先级已更新，影响 ${affected.length} 个字段`);
    if (refetch) {
      await runCollect({ fields: affected, reason: 'priority_scoped_refetch', silent: true });
      toast('受影响字段已补采，原始帧已留存', 'success');
      setBanner('priority-applied', 'success', `<strong>补采完成。</strong>${affected.map((field) => escapeHtml(fieldLabel(field))).join('、')} 已按新优先级重新裁决，可发布新版。`);
    }
  });
}

async function runPublish({ allowIncomplete = false, note = null }) {
  return withBusy('publish', async () => {
    try {
      const data = await api('/api/publish', { method: 'POST', body: { recordId: state.recordId, allowIncomplete, note } });
      state.snapshot = data.snapshot;
      const pub = data.publication;
      toast(`已发布 r${pub.revision}（${pub.completeness === 'complete' ? '完整' : '部分'}）`, 'success');
      if (pub.completeness === 'partial') {
        setBanner(
          'partial-published',
          'warn',
          `<strong>r${pub.revision} 以「部分」发布。</strong>未承诺完整，仍在等待：${pub.contract.blockingRequired.map((field) => escapeHtml(fieldLabel(field))).join('、')}。`,
        );
      } else {
        clearBanner('partial-published');
        setBanner('last-publish', 'success', `<strong>r${pub.revision} 已发布为完整版本。</strong>必填 ${pub.contract.requiredFilled}/${pub.contract.requiredTotal}，承诺已冻结。`);
      }
    } catch (error) {
      if (error.code === 'incomplete_decision') {
        const detail = error.detail ?? {};
        const blocking = (detail.blockingRequired ?? []).map((field) => fieldLabel(field)).join('、');
        setBanner('publish-blocked', 'danger', `<strong>不能发布完整版：</strong>${escapeHtml(blocking || '必填字段未确认')}。可选择发布部分版，承诺会明确标为不完整。`);
        toast('发布被拒绝：必填字段未确认', 'error');
        return;
      }
      toast(`发布失败：${error.message}`, 'error');
    }
  });
}

async function runDeliver({ duplicate = false } = {}) {
  const active = state.snapshot.record.activePublication;
  if (!active) return null;
  return withBusy('deliver', async () => {
    // Both deliveries use the same default idempotency key on purpose: the
    // second one must be recognised as a duplicate claim downstream.
    const body = { recordId: state.recordId, publicationId: active.id };
    try {
      const data = await api('/api/deliver', { method: 'POST', body });
      state.snapshot = data.snapshot;
      if (data.result?.duplicate) {
        toast('下游识别为重复领取，未新增入库', 'success');
        setBanner('duplicate', 'info', `<strong>重复领取被识别。</strong>幂等键 <code>${escapeHtml(data.result.receiptId)}</code> 已存在，接收端只保留一份。`);
      } else {
        toast(`下游已接收（HTTP ${data.httpStatus}）`, 'success');
        setBanner('delivered', data.result.promise === 'partial' ? 'warn' : 'success', `<strong>下游收下 ${escapeHtml(data.result.recordId)} r${data.result.revision}（${data.result.promise === 'complete' ? '完整' : '部分'}）。</strong>${escapeHtml(data.result.note ?? '')}`);
      }
    } catch (error) {
      toast(`投递失败：${error.message}`, 'error');
    }
  });
}

async function runSourceAdmin(sourceId, action, payload = {}) {
  await withBusy(`source:${sourceId}`, async () => {
    const body = { sourceId, action, recordId: state.recordId, ...payload };
    if (action === 'online') body.online = payload.online ?? false;
    if (action === 'delay') body.delayMs = payload.delayMs ?? 120;
    const data = await api('/api/source-admin', { method: 'POST', body });
    state.snapshot = data.snapshot;
    render();
    if (action === 'online') {
      toast(`${sourceById(sourceId)?.name} 已${body.online ? '恢复' : '断开'}`);
      if (!body.online) {
        setBanner(
          'source-offline',
          'danger',
          `<strong>${escapeHtml(sourceById(sourceId)?.name)} 已断开。</strong>它负责的字段不会被当成「缺失」，而是标为等待或来源不可达。`,
        );
      } else {
        clearBanner('source-offline');
      }
    }
    if (action === 'fail-next') toast('已注入一次失败，下次请求会返回错误');
    if (action === 'delay') toast(`延迟已设为 ${body.delayMs}ms`);
  });
}

async function runRevision(sourceId, recordId, field, value) {
  const data = await api('/api/revisions', { method: 'POST', body: { sourceId, recordId, field, value } });
  state.snapshot = data.snapshot;
  render();
  return data.revision;
}

/* -------------------------------- dialogs --------------------------------- */

async function viewPublication(id) {
  try {
    const data = await api(`/api/publication?id=${id}`);
    const pub = data.publication;
    const states = Object.entries(pub.field_states)
      .map(
        ([field, info]) =>
          `<tr><td>${escapeHtml(fieldLabel(field))}</td><td>${escapeHtml(STATUS_TEXT[info.state] ?? info.state)}</td><td style="font-family:var(--mono);font-size:11.5px">${
            info.value === null ? '—' : escapeHtml(formatValue(info.value))
          }</td><td>${escapeHtml(info.sourceName ?? '—')}</td></tr>`,
      )
      .join('');
    const deliveries = data.deliveries?.length
      ? data.deliveries
          .map(
            (delivery) =>
              `<li class="receipt"><span class="rcpt-id">${escapeHtml(delivery.outcome)}</span><span>HTTP ${delivery.http_status ?? '—'}</span><span class="rcpt-meta">${timeOf(delivery.attempted_at)}</span>${
                delivery.receipt_id ? `<span class="dup-flag">${escapeHtml(delivery.receipt_id)}</span>` : ''
              }</li>`,
          )
          .join('')
      : '<li class="receiver-empty">该版本没有投递记录。</li>';
    const dialog = document.createElement('dialog');
    dialog.className = 'confirm-dialog';
    dialog.innerHTML = `<form method="dialog" style="max-height:80vh;overflow:auto">
      <h2>已发布 r${pub.revision} · ${pub.contract.promise === 'complete' ? '完整' : '部分'}</h2>
      <p>${escapeHtml(pub.contract.statement)}</p>
      <p style="font-family:var(--mono);font-size:11.5px">发布于 ${shortDateTime(pub.created_at)} · 模式 ${escapeHtml(pub.mode)}${
        pub.superseded_by ? ' · 已被更新版本取代' : ' · 当前生效'
      }</p>
      ${pub.contract.note ? `<div class="publish-note">备注：${escapeHtml(pub.contract.note)}</div>` : ''}
      <table class="field-table" style="font-size:12.5px">
        <thead><tr><th>字段</th><th>状态</th><th>冻结值</th><th>来源</th></tr></thead>
        <tbody>${states}</tbody>
      </table>
      <h3 class="subhead" style="margin-top:12px">投递记录</h3>
      <ul class="receipt-list">${deliveries}</ul>
      <div class="dialog-actions"><button class="btn" value="close" type="submit">关闭</button></div>
    </form>`;
    document.body.append(dialog);
    dialog.addEventListener('close', () => dialog.remove());
    dialog.showModal();
  } catch (error) {
    toast(`读取版本失败：${error.message}`, 'error');
  }
}

function openPartialDialog() {
  const decision = state.snapshot.record.decision;
  const blocking = decision.blockingRequired;
  els.partialSummary.innerHTML = `将发布 <strong>${escapeHtml(state.recordId)}</strong> 的部分结果。以下必填字段仍未确认，不会出现在 payload 中：<br /><strong>${escapeHtml(
    blocking.map((field) => fieldLabel(field)).join('、') || '（无）',
  )}</strong>。`;
  els.partialNote.value = '';
  els.partialDialog.showModal();
}

/* ------------------------------- listeners -------------------------------- */

document.addEventListener('click', async (event) => {
  const target = event.target.closest('button, [data-dismiss]');
  if (!target) return;

  if (target.dataset.dismiss) {
    clearBanner(target.dataset.dismiss);
    return;
  }
  if (target === els.collectAll) {
    try {
      await runCollect({});
    } catch (error) {
      toast(`采集失败：${error.message}`, 'error');
    }
    return;
  }
  if (target === els.priorityReset) {
    const defaultOrder = ['aurora', 'borealis', 'cirrus'];
    state.pendingOrder = defaultOrder.map((id) => sourceById(id)).filter(Boolean);
    render();
    return;
  }
  if (target.id === 'publish-complete') {
    await runPublish({ allowIncomplete: false });
    return;
  }
  if (target.id === 'publish-partial') {
    openPartialDialog();
    return;
  }
  if (target.id === 'deliver-active') {
    await runDeliver({ duplicate: false });
    return;
  }
  if (target.id === 'deliver-duplicate') {
    await runDeliver({ duplicate: true });
    return;
  }
  if (target.id === 'reset-receiver') {
    await api('/api/receiver/reset', { method: 'POST', body: {} });
    await refresh();
    toast('接收端已清空');
    return;
  }
  if (target.dataset.move) {
    const id = target.dataset.move;
    const dir = Number(target.dataset.dir);
    const list = [...(state.pendingOrder ?? state.snapshot.sources)];
    const index = list.findIndex((source) => source.id === id);
    const next = index + dir;
    if (next >= 0 && next < list.length) {
      [list[index], list[next]] = [list[next], list[index]];
      state.pendingOrder = list;
      render();
    }
    return;
  }
  if (target.hasAttribute('data-apply-priority') || target.hasAttribute('data-apply-priority-only')) {
    const refetch = target.hasAttribute('data-apply-priority');
    await runApplyPriority({ refetch });
    return;
  }
  if (target.hasAttribute('data-cancel-priority')) {
    state.pendingOrder = null;
    render();
    return;
  }
  if (target.dataset.refetchField) {
    try {
      await runCollect({ fields: [target.dataset.refetchField], reason: 'manual_scoped_refetch' });
    } catch (error) {
      toast(`补采失败：${error.message}`, 'error');
    }
    return;
  }
  if (target.dataset.openRaw) {
    const details = document.querySelector(`details[data-raw-id="${target.dataset.openRaw}"]`);
    if (details) {
      details.open = true;
      details.scrollIntoView({ behavior: 'smooth', block: 'center' });
      details.querySelector('summary')?.focus?.();
    }
    return;
  }
  if (target.dataset.viewPub) {
    await viewPublication(Number(target.dataset.viewPub));
    return;
  }
  if (target.dataset.scenario) {
    await runScenario(target.dataset.scenario);
    return;
  }
  if (target.dataset.sourceAction) {
    const sourceId = target.dataset.sourceId;
    if (target.dataset.sourceAction === 'online') {
      await runSourceAdmin(sourceId, 'online', { online: target.dataset.online === 'true' });
    } else if (target.dataset.sourceAction === 'fail-next') {
      await runSourceAdmin(sourceId, 'fail-next');
    } else if (target.dataset.sourceAction === 'revision') {
      openRevisionFlow(sourceId);
    }
    return;
  }
});

els.toggleRaw.addEventListener('click', () => {
  state.showRaw = !state.showRaw;
  render();
});

els.recordSelect.addEventListener('change', async () => {
  const recordId = els.recordSelect.value;
  try {
    await loadSnapshot(recordId);
    clearBanner('source-offline');
    clearBanner('priority-applied');
  } catch (error) {
    toast(`切换记录失败：${error.message}`, 'error');
  }
});

els.resetDemo.addEventListener('click', async () => {
  await withBusy('reset', async () => {
    const data = await api('/api/reset', { method: 'POST', body: {} });
    state.snapshot = data;
    state.pendingOrder = null;
    state.banners = [];
    state.recordId = 'SKU-1001';
    render();
    toast('演示已重置', 'success');
  });
});

els.partialDialog.addEventListener('close', async () => {
  if (els.partialDialog.returnValue !== 'confirm') return;
  await runPublish({ allowIncomplete: true, note: els.partialNote.value.trim() || null });
});

/* ------------------------------- drag & drop ------------------------------ */

let dragId = null;

els.priorityStrip.addEventListener('dragstart', (event) => {
  const item = event.target.closest('[data-priority-id]');
  if (!item) return;
  dragId = item.dataset.priorityId;
  item.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
});

els.priorityStrip.addEventListener('dragend', () => {
  dragId = null;
  document.querySelectorAll('.priority-item').forEach((node) => node.classList.remove('dragging', 'drop-target'));
});

els.priorityStrip.addEventListener('dragover', (event) => {
  event.preventDefault();
  const item = event.target.closest('[data-priority-id]');
  document.querySelectorAll('.priority-item').forEach((node) => node.classList.remove('drop-target'));
  if (item && item.dataset.priorityId !== dragId) item.classList.add('drop-target');
});

els.priorityStrip.addEventListener('drop', (event) => {
  event.preventDefault();
  const item = event.target.closest('[data-priority-id]');
  if (!item || !dragId) return;
  const list = [...(state.pendingOrder ?? state.snapshot.sources)];
  const from = list.findIndex((source) => source.id === dragId);
  const to = list.findIndex((source) => source.id === item.dataset.priorityId);
  if (from === -1 || to === -1 || from === to) return;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  state.pendingOrder = list;
  dragId = null;
  render();
});

/* ----------------------------- revision flow ----------------------------- */

function openRevisionFlow(sourceId) {
  const source = sourceById(sourceId);
  const decision = state.snapshot.record.decision;
  const ownedFields = source.owned;
  const field = ownedFields[0];
  const info = decision.fields[field];
  const nextValue = suggestRevisionValue(field, info.value);
  const row = document.querySelector(`[data-field-row="${field}"]`);
  const panel = document.createElement('div');
  panel.className = 'banner info';
  panel.innerHTML = `
    <div style="flex:1">
      <strong>${escapeHtml(source.name)} 回传修订</strong>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;align-items:center">
        <select id="rev-field">${ownedFields.map((f) => `<option value="${f}">${escapeHtml(fieldLabel(f))}</option>`).join('')}</select>
        <input id="rev-value" style="flex:1;min-width:180px;border:1px solid var(--line-strong);border-radius:6px;padding:5px 8px" value="${escapeHtml(nextValue)}" />
        <label style="font-size:12px;display:flex;gap:5px;align-items:center"><input type="checkbox" id="rev-clear" /> 明确清空</label>
        <button class="btn btn-small btn-primary" type="button" id="rev-queue">排队修订</button>
        <button class="btn btn-small" type="button" id="rev-cancel">取消</button>
      </div>
      <div style="font-size:11.5px;color:var(--ink-faint);margin-top:4px">修订在来源侧排队，下一次对该字段的请求才会返回它。</div>
    </div>`;
  row?.after(panel);
  const fieldSelect = panel.querySelector('#rev-field');
  const valueInput = panel.querySelector('#rev-value');
  const clearBox = panel.querySelector('#rev-clear');
  fieldSelect.addEventListener('change', () => {
    const selected = fieldSelect.value;
    valueInput.value = suggestRevisionValue(selected, decision.fields[selected].value);
  });
  clearBox.addEventListener('change', () => {
    valueInput.disabled = clearBox.checked;
  });
  panel.querySelector('#rev-cancel').addEventListener('click', () => panel.remove());
  panel.querySelector('#rev-queue').addEventListener('click', async () => {
    try {
      const value = clearBox.checked ? null : valueInput.value;
      await runRevision(sourceId, state.recordId, fieldSelect.value, value);
      panel.remove();
      toast(`${source.name} 已排队修订 ${fieldLabel(fieldSelect.value)}`);
    } catch (error) {
      toast(`排队修订失败：${error.message}`, 'error');
    }
  });
}

function suggestRevisionValue(field, current) {
  if (field === 'price') return String(Math.round(((Number(current) || 10) * 1.08) * 100) / 100);
  if (field === 'weight_g') return String(Math.round((Number(current) || 300) * 0.97));
  if (field === 'origin') return `${String(current ?? 'Origin').split(' · ')[0]} · 更正`;
  if (field === 'material') return current === 'ceramic' ? 'stoneware' : `${current ?? 'material'} (rev)`;
  return `${String(current ?? 'Value').replace(/ \(rev.*\)$/, '')} (rev.)`;
}

/* -------------------------------- scenarios ------------------------------- */

async function runScenario(id) {
  if (state.scenarioRunning) return;
  state.scenarioRunning = true;
  els.scenarioStatus.textContent = '运行中…';
  render();
  try {
    if (id === 'priority') await scenarioPriority();
    if (id === 'disconnect') await scenarioDisconnect();
    if (id === 'revision') await scenarioRevision();
    if (id === 'duplicate') await scenarioDuplicate();
    els.scenarioStatus.textContent = '刚才的演示已完成';
  } catch (error) {
    els.scenarioStatus.textContent = '';
    toast(`演示中断：${error.message}`, 'error');
  } finally {
    state.scenarioRunning = false;
    render();
  }
}

async function scenarioPriority() {
  await api('/api/reset', { method: 'POST', body: {} });
  await loadSnapshot('SKU-1001');
  await runCollect({ reason: 'scenario_baseline' });
  await runPublish({ allowIncomplete: false });
  await runDeliver({});
  const baselineRevision = state.snapshot.record.activePublication?.revision;
  toast('基线已发布并投递，接下来换优先级');

  state.pendingOrder = ['cirrus', 'aurora', 'borealis'].map((id) => sourceById(id));
  render();
  await sleep(900);
  await runApplyPriority({ refetch: true });
  await sleep(500);
  await runPublish({ allowIncomplete: false });
  await runDeliver({});
  setBanner(
    'scenario-priority',
    'success',
    `<strong>换序完成。</strong>基线 r${baselineRevision} 仍保留在版本历史里，r${
      state.snapshot.record.activePublication?.revision
    } 只重取了受影响字段。点击版本历史中的 r${baselineRevision} 可查看当时的来源与承诺。`,
  );
}

async function scenarioDisconnect() {
  await api('/api/reset', { method: 'POST', body: {} });
  await loadSnapshot('SKU-1001');
  await runCollect({ reason: 'scenario_baseline' });
  await runSourceAdmin('aurora', 'online', { online: false });
  const attempts = await runCollect({ fields: ['title', 'price'], reason: 'scenario_disconnected_refetch', silent: true });
  await sleep(300);
  const decision = state.snapshot.record.decision;
  const blocked = decision.blockingRequired.map((field) => fieldLabel(field)).join('、');
  setBanner(
    'scenario-disconnect',
    'danger',
    `<strong>Aurora 断开后补采标题与价格。</strong>${blocked || '必填字段'} 现在只能等待；页面不会把它们显示成「缺失」，也不会允许发布完整版。${
      attempts.attempts.some((attempt) => attempt.errorCode === 'source_disconnected') ? '失败响应已作为原始帧留存。' : ''
    }`,
  );
  await runPublish({ allowIncomplete: false }).catch(() => {});
  els.scenarioStatus.textContent = '已演示：断连时发布被拒绝。点「恢复连接」后再补采';
}

async function scenarioRevision() {
  await api('/api/reset', { method: 'POST', body: {} });
  await loadSnapshot('SKU-1001');
  await runCollect({ reason: 'scenario_baseline' });
  const original = state.snapshot.record.decision.fields.title.value;
  await runSourceAdmin('aurora', 'delay', { delayMs: 1300 });
  const collectPromise = runCollect({ fields: ['title'], reason: 'scenario_inflight_refetch', silent: true });
  await sleep(450);
  await runRevision('aurora', 'SKU-1001', 'title', 'Nimbus Ceramic Mug · 修订于补采途中');
  await collectPromise;
  await sleep(200);
  const info = state.snapshot.record.decision.fields.title;
  setBanner(
    'scenario-revision',
    'warn',
    `<strong>修订发生在请求在途时。</strong>本次响应仍是旧值「${escapeHtml(String(info.value ?? original))}」；来源侧已排队标题修订，页面标出「来源有更新待取」。再点一次重取即可拿到新值。`,
  );
  els.scenarioStatus.textContent = '已演示：补采途中再次修订；再取一次才会生效';
}

async function scenarioDuplicate() {
  await api('/api/reset', { method: 'POST', body: {} });
  await loadSnapshot('SKU-1001');
  await runCollect({ reason: 'scenario_baseline' });
  if (!state.snapshot.record.decision.complete) {
    await runPublish({ allowIncomplete: true, note: '场景：完整数据未能采集' });
  } else {
    await runPublish({ allowIncomplete: false });
  }
  await runDeliver({});
  await sleep(300);
  await runDeliver({ duplicate: true });
  const receiver = state.snapshot.receiver;
  setBanner(
    'scenario-duplicate',
    'info',
    `<strong>两次投递使用同一幂等键。</strong>接收端共入库 ${receiver.receipts.length} 份，重复 ${receiver.duplicateAttempts} 次被识别为重复，没有产生第二份记录。`,
  );
}

/* ---------------------------------- boot ---------------------------------- */

async function boot() {
  try {
    await loadSnapshot('SKU-1001');
  } catch (error) {
    els.bannerStack.innerHTML = `<div class="banner danger">无法连接控制台 API：${escapeHtml(error.message)}</div>`;
  }
  setInterval(() => {
    if (!state.busy.size) refresh().catch(() => {});
  }, 5000);
}

boot();
