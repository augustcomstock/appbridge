import { h, render, Component, createRef } from '/vendor/preact.js';
import htm from '/vendor/htm.js';
import { Galaxy, iconTint, MERGE_MS } from '/galaxy.js';

const html = htm.bind(h);
const METHOD = { std: 'Standard', local: 'Local', rea: 'REA / Ghidra' };
const NEXT = { '→': '↔', '↔': '←', '←': '→' };
const FLOW = { '→': 'ab-flow', '←': 'ab-flowr', '↔': 'ab-breathe' };
const iconUrl = id => `/api/icon?id=${encodeURIComponent(id)}`;

const api = async (path, body) => {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
};

const plural = (n, word) => `${n} ${n === 1 ? word.replace(/s$/, '') : word}`;
function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`;
  if (s < 86400 * 1.5) return s < 7200 ? 'an hour ago' : `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
}
function summary(c) {
  const parts = [`${c.create} created`, `${c.update} updated`];
  if (c.delete) parts.push(`${c.delete} deleted`);
  return parts.join(' · ');
}

function Icon({ app, size, small }) {
  return html`<img class=${'icon' + (small ? ' small' : '')} src=${iconUrl(app.bundleId)} width=${size} height=${size} alt=""
    onError=${e => { e.target.replaceWith(Object.assign(document.createElement('span'), { className: 'letter', textContent: app.name[0], style: `width:${size}px;height:${size}px;font-size:${Math.round(size * .45)}px` })); }} />`;
}

const MethodIcon = ({ m }) => m === 'std'
  ? html`<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M6.5 9.5l3-3M7.2 4.3l.9-.9a2.6 2.6 0 013.6 3.6l-.9.9M8.8 11.7l-.9.9a2.6 2.6 0 01-3.6-3.6l.9-.9"/></svg>`
  : m === 'rea'
    ? html`<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M5.5 2.5h-3v3M10.5 2.5h3v3M5.5 13.5h-3v-3M10.5 13.5h3v-3"/><circle cx="8" cy="8" r="2.2"/></svg>`
    : html`<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><ellipse cx="8" cy="4" rx="5" ry="1.9"/><path d="M3 4v8c0 1 2.2 1.9 5 1.9s5-.9 5-1.9V4M3 8c0 1 2.2 1.9 5 1.9s5-.9 5-1.9"/></svg>`;

const Tick = ({ stroke = '#111' }) => html`<svg width="10" height="8" viewBox="0 0 10 8"><path d="M1 4.2L3.8 7 9 1" fill="none" stroke=${stroke} stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

class App extends Component {
  state = { apps: [], L: null, R: null, health: null, phase: 'idle', prompt: '', pick: null, q: '', hov: false,
    saved: [], disc: [], pending: false, discError: null,
    sel: {}, st: {}, note: {}, just: {}, sheet: null, inspect: null, toast: null, cli: false, log: [], logLabel: '' };
  canvas = createRef();
  hero = createRef();
  queue = [];
  streams = [];

  async componentDidMount() {
    this.galaxy = new Galaxy(this.canvas.current, this.hero.current);
    window.addEventListener('keydown', this.onKey);
    const [apps, health] = await Promise.all([api('/api/apps'), api('/api/health')]);
    let [L, R] = (() => { try { return JSON.parse(localStorage.getItem('appbridge.pair')) || []; } catch { return []; } })();
    const has = id => apps.some(a => a.bundleId === id);
    if (!has(L) || !has(R) || L === R) [L, R] = [apps[0]?.bundleId, apps[1]?.bundleId];
    this.setState({ apps, health });
    this.setPair(L, R);
  }
  componentWillUnmount() { this.galaxy.destroy(); window.removeEventListener('keydown', this.onKey); this.streams.forEach(s => s.close()); }

  onKey = e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') this.start();
    // Backtick shows the transcript of the Claude CLI session working for this window.
    if (e.key === '`' && !e.metaKey && !e.ctrlKey && !/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) { e.preventDefault(); return this.setState(x => ({ cli: !x.cli })); }
    if (e.key === 'Escape') {
      if (this.state.cli) this.setState({ cli: false });
      else if (this.state.inspect) this.setState({ inspect: null });
      else if (this.state.sheet) this.closeSheet();
      else if (this.state.pick) this.setState({ pick: null });
    }
  };

  app(id) { return this.state.apps.find(a => a.bundleId === id); }

  async setPair(L, R) {
    if (!L || !R) return;
    this.setState({ L, R, pick: null, q: '', saved: [] });
    try { localStorage.setItem('appbridge.pair', JSON.stringify([L, R])); } catch {}
    Promise.all([iconTint(iconUrl(L)), iconTint(iconUrl(R))]).then(([a, b]) => { if (this.state.L === L && this.state.R === R) this.galaxy.setTints(a, b); });
    const { saved } = await api(`/api/pair?a=${encodeURIComponent(L)}&b=${encodeURIComponent(R)}`).catch(() => ({ saved: [] }));
    if (this.state.L === L && this.state.R === R) this.setState({ saved });
  }

  // Which arrows a set of [from, to] directions allows, relative to the current left/right sides.
  arrows(directions) {
    const { L, R } = this.state;
    const fwd = directions.some(d => d[0] === L && d[1] === R), back = directions.some(d => d[0] === R && d[1] === L);
    return fwd && back ? ['↔', '→', '←'] : fwd ? ['→'] : ['←'];
  }
  toDirections(arrow) {
    const { L, R } = this.state;
    return arrow === '→' ? [[L, R]] : arrow === '←' ? [[R, L]] : [[L, R], [R, L]];
  }

  listen(job, onEvent) {
    const es = new EventSource(`/api/events?job=${job}`);
    this.streams.push(es);
    es.onmessage = m => {
      const ev = JSON.parse(m.data);
      if (ev.type === 'log') return this.setState(x => ({ logLabel: ev.label, log: [...(x.logLabel === ev.label ? x.log : []), ev].slice(-600) }));
      onEvent(ev);
      if (ev.type === 'done') { es.close(); this.streams = this.streams.filter(s => s !== es); }
    };
  }

  start = async () => {
    const s = this.state;
    if (s.phase !== 'idle' || !s.L || !s.R) return;
    this.setState({ phase: 'merge', pick: null, hov: false, disc: [], discError: null });
    this.galaxy.merge();
    setTimeout(() => { if (this.state.phase === 'merge') this.setState({ phase: 'list' }); }, MERGE_MS * .8);
    const health = s.health?.loggedIn ? s.health : await api('/api/health').catch(() => s.health);
    this.setState({ health });
    if (!health?.loggedIn) return this.setState({ discError: 'Sign in to the Claude CLI to discover new integrations. Saved ones still run.' });
    this.setState({ pending: true });
    this.galaxy.generating(true);
    try {
      const { job } = await api('/api/discover', { a: s.L, b: s.R, prompt: s.prompt.trim() });
      this.listen(job, ev => {
        if (ev.type === 'candidate') this.setState(x => {
          const c = { ...ev.candidate, dir: this.arrows(ev.candidate.directions)[0] };
          const i = x.disc.findIndex(d => d.id === c.id);
          return { disc: i < 0 ? [...x.disc, c] : x.disc.map((d, j) => (j === i ? { ...c, dir: d.dir } : d)) };
        });
        if (ev.type === 'done') { this.galaxy.generating(false); this.setState({ pending: false, discError: ev.ok ? null : (ev.error || 'Discovery stopped early.') }); }
      });
    } catch (e) {
      this.galaxy.generating(false);
      this.setState({ pending: false, discError: e.message });
    }
  };

  reset = () => {
    this.streams.forEach(s => s.close()); this.streams = []; this.queue = [];
    this.setState({ phase: 'idle', disc: [], pending: false, sel: {}, st: {}, note: {}, just: {}, sheet: null, inspect: null, toast: null, discError: null });
    this.galaxy.reset();
  };

  build = async () => {
    const s = this.state;
    const chosen = s.disc.filter(d => s.sel[d.id]);
    if (!chosen.length) return;
    const mark = (ids, value) => this.setState(x => { const st = { ...x.st }; ids.forEach(id => (value ? (st[id] = value) : delete st[id])); return { st }; });
    mark(chosen.map(c => c.id), 'building');
    this.setState({ sel: {}, note: {} });
    try {
      const { job } = await api('/api/build', { a: s.L, b: s.R, selections: chosen.map(c => ({ id: c.id, directions: this.toDirections(c.dir) })) });
      this.listen(job, ev => {
        if (ev.type === 'status') this.setState(x => ({ note: { ...x.note, [ev.id]: ev.text } }));
        if (ev.type === 'built') {
          this.setState(x => ({ saved: [...x.saved.filter(i => i.id !== ev.integration.id), ev.integration], disc: x.disc.filter(d => d.id !== ev.integration.id) }));
          mark([ev.integration.id], null);
          this.openSheet(ev.integration.id);
        }
        if (ev.type === 'failed') { mark([ev.id], null); this.setState(x => ({ note: { ...x.note, [ev.id]: '!' + ev.error } })); }
        if (ev.type === 'done') mark(chosen.map(c => c.id), null);
      });
    } catch (e) {
      mark(chosen.map(c => c.id), null);
      this.setState({ discError: e.message });
    }
  };

  async openSheet(id) {
    if (this.state.sheet) { this.queue.push(id); return; }
    const { L, R } = this.state;
    this.setState({ sheet: { id, loading: true, confirm: false, all: false }, toast: null });
    try {
      const preview = await api('/api/preview', { a: L, b: R, id });
      this.setState(x => (x.sheet?.id === id ? { sheet: { ...x.sheet, loading: false, ...preview } } : null));
    } catch (e) {
      this.setState(x => (x.sheet?.id === id ? { sheet: { ...x.sheet, loading: false, error: e.message } } : null));
    }
  }
  closeSheet = () => { this.setState({ sheet: null }); const next = this.queue.shift(); if (next) setTimeout(() => this.openSheet(next), 300); };

  async run(allowDelete) {
    const sh = this.state.sheet;
    if (!sh?.token) return;
    const id = sh.id, { L, R } = this.state;
    this.setState(x => ({ sheet: null, st: { ...x.st, [id]: 'running' } }));
    const finish = patch => this.setState(x => { const st = { ...x.st }; delete st[id]; return { st, ...patch(x) }; });
    try {
      const result = await api('/api/run', { token: sh.token, allowDelete });
      const text = summary(result.counts) + (result.verified ? ` · ${result.checked} verified in ${this.app(sh.items.find(i => i.action !== 'skip')?.to || R)?.name || 'destination'}` : ' · could not verify every item');
      finish(x => ({ just: { ...x.just, [id]: result.verified ? 'ok' : 'warn' }, toast: { ok: result.verified, text }, saved: x.saved.map(i => (i.id === id ? { ...i, lastRun: result } : i)) }));
      if (result.verified) this.galaxy.pulse();
      setTimeout(() => this.setState(x => (x.toast?.text === text ? { toast: null } : null)), 6000);
    } catch (e) {
      finish(x => ({ note: { ...x.note, [id]: '!' + e.message } }));
    }
    const next = this.queue.shift(); if (next) setTimeout(() => this.openSheet(next), 900);
  }

  async inspect(id) {
    const { L, R } = this.state;
    const data = await api(`/api/inspect?a=${encodeURIComponent(L)}&b=${encodeURIComponent(R)}&id=${encodeURIComponent(id)}`).catch(() => null);
    if (data) this.setState({ inspect: data });
  }

  chip(arrow, anim) {
    const A = this.app(this.state.L), B = this.app(this.state.R);
    return html`<${Icon} app=${A} size=${14} small /><span class="arrow">${anim ? html`<span class="flow" style=${`animation:${anim} .9s linear infinite`}></span>` : arrow}</span><${Icon} app=${B} size=${14} small />`;
  }

  renderPicker() {
    const s = this.state;
    const other = s.pick === 'L' ? s.R : s.L, cur = s.pick === 'L' ? s.L : s.R;
    const list = s.apps.filter(a => a.name.toLowerCase().includes(s.q.toLowerCase()));
    return html`
      <div class="scrim" onClick=${() => this.setState({ pick: null })}></div>
      <div class="picker" style=${`left:${s.pick === 'R' ? 312 : 24}px`}>
        <input autofocus ref=${el => el && el.focus()} value=${s.q} onInput=${e => this.setState({ q: e.target.value })} placeholder="Search apps" aria-label="Search apps" />
        <div class="list">
          ${list.map(a => html`<button key=${a.bundleId} class=${'opt' + (a.bundleId === other ? ' blocked' : '')}
            onClick=${() => { if (a.bundleId !== other) this.setPair(...(s.pick === 'L' ? [a.bundleId, s.R] : [s.L, a.bundleId])); }}>
            <${Icon} app=${a} size=${20} small /><span>${a.name}</span><small>${a.bundleId === cur ? '✓' : a.bundleId === other ? 'other side' : ''}</small>
          </button>`)}
        </div>
      </div>`;
  }

  renderSaved(it, i) {
    const s = this.state;
    const running = s.st[it.id] === 'running', done = !running && s.just[it.id], err = (s.note[it.id] || '').startsWith('!') ? s.note[it.id].slice(1) : null;
    const arrow = this.arrows(it.directions)[0];
    return html`<div class="row" key=${it.id} style=${`animation-delay:${(.25 + i * .07).toFixed(2)}s`}>
      <span class="lead">${running ? html`<span class="spin"></span>` : done === 'ok' ? html`<span class="ok"><svg width="9" height="7" viewBox="0 0 9 7"><path d="M1 3.6L3.4 6 8 1" fill="none" stroke="#0b2a12" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>` : html`<span class="dot"></span>`}</span>
      <div class="text"><span class="title"><span>${it.title}</span></span>
        ${(running || err) && html`<span class=${'sub' + (err ? ' bad' : '')} title=${err || ''}>${running ? 'Transferring…' : err}</span>`}</div>
      <span class="dir">${this.chip(arrow, running && FLOW[arrow])}</span>
      <button class="method" title=${`${METHOD[it.method]} · how this was found`} aria-label="How this was found" onClick=${() => this.inspect(it.id)}><${MethodIcon} m=${it.method} /></button>
      <button class="run" disabled=${running} onClick=${() => this.openSheet(it.id)}>Run</button>
    </div>`;
  }

  renderDisc(it) {
    const s = this.state;
    const building = s.st[it.id] === 'building', on = !!s.sel[it.id];
    const note = s.note[it.id] || '', err = note.startsWith('!') ? note.slice(1) : null;
    const options = this.arrows(it.directions);
    const cycle = e => {
      e.stopPropagation();
      if (building || options.length < 2) return;
      this.setState(x => ({ disc: x.disc.map(d => (d.id === it.id ? { ...d, dir: NEXT[d.dir] } : d)) }));
    };
    return html`<div key=${it.id} class=${'row' + (building ? '' : ' pick') + (on ? ' on' : '')} role="checkbox" aria-checked=${on} tabindex="0"
      onClick=${() => { if (!building) this.setState(x => ({ sel: { ...x.sel, [it.id]: !x.sel[it.id] } })); }}
      onKeyDown=${e => { if (e.key === ' ' && e.target === e.currentTarget) { e.preventDefault(); e.currentTarget.click(); } }}>
      <span class="lead">${building ? html`<span class="spin"></span>` : html`<span class="check"><${Tick} /></span>`}</span>
      <div class="text">
        <span class="title typed"><span>${it.title}</span>${it.status === 'speculative' && html`<span class="tag" title="Not yet proven to work. Building it will test it.">unverified</span>`}</span>
        <span class=${'sub fadein' + (err ? ' bad' : '')} title=${err || it.description}>${building ? (note ? `Building · ${note}` : 'Building…') : err || it.description}</span>
      </div>
      <button class="dir" title=${options.length > 1 ? 'Change direction' : 'Only this direction is possible'} onClick=${cycle}>${this.chip(it.dir)}</button>
      <button class="method" title=${`${METHOD[it.method]} · how this was found`} aria-label="How this was found" onClick=${e => { e.stopPropagation(); this.inspect(it.id); }}><${MethodIcon} m=${it.method} /></button>
      ${building && html`<div class="busybar"></div>`}
    </div>`;
  }

  renderSheet() {
    const s = this.state, sh = s.sheet;
    const it = s.saved.find(x => x.id === sh.id);
    if (!it) return null;
    const arrow = this.arrows(it.directions)[0];
    const c = sh.counts || { create: 0, update: 0, skip: 0, delete: 0 };
    const dels = (sh.items || []).filter(i => i.action === 'delete');
    const changes = (sh.items || []).filter(i => i.action === 'create' || i.action === 'update');
    const nothing = sh.counts && !c.create && !c.update && !c.delete;
    const ok = sh.token && !nothing && (!c.delete || sh.confirm);
    const targets = [...new Set(dels.map(d => this.app(d.to)?.name))].join(' and ');
    const stat = (n, label, danger) => html`<div class=${'stat' + (n ? '' : ' zero') + (danger && n ? ' danger' : '')}><b>${sh.loading ? '–' : n}</b><span>${label}</span></div>`;
    const writes = [...(sh.resources?.write || []).map(p => p.replace(/^\/Users\/[^/]+/, '~')), ...(sh.resources?.automates || []).map(id => this.app(id)?.name || id)];
    return html`<div class="veil"><div class="sheet" role="dialog" aria-label="Review changes">
      <div class="body">
        <div><h2>Review changes</h2><p class="lede">${sh.error ? '' : nothing ? 'Everything is already transferred. Nothing to do.' : 'Nothing changes until you run.'}${writes.length && !sh.error ? ` Can change: ${writes.join(', ')}.` : ''}</p></div>
        <div class="what"><span class="dir" style="height:20px">${this.chip(arrow)}</span>${it.title}</div>
        ${sh.error ? html`<div class="empty bad" style="padding:0">${sh.error}</div>` : html`
          <div class="stats">${stat(c.create, 'Create')}${stat(c.update, 'Update')}${stat(c.skip, 'Skip')}${stat(c.delete, 'Delete', true)}</div>
          ${c.delete > 0 && html`<div class="delbox">
            <h3>Will be deleted from ${targets}</h3>
            ${dels.map(d => html`<div class="line"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 2l6 6M8 2L2 8" stroke="#ff6961" stroke-width="1.5" stroke-linecap="round"/></svg><span class="n">${d.name}</span><span class="m">${d.meta}</span></div>`)}
            <button class=${'confirm' + (sh.confirm ? ' on' : '')} role="checkbox" aria-checked=${sh.confirm} onClick=${() => this.setState(x => ({ sheet: { ...x.sheet, confirm: !x.sheet.confirm } }))}>
              <span class="check"><${Tick} stroke="#fff" /></span><span>Yes, delete ${plural(c.delete, 'items')}</span>
            </button>
          </div>`}
          ${changes.length > 0 && html`<div style="display:flex;flex-direction:column">
            <button class=${'more' + (sh.all ? ' open' : '')} onClick=${() => this.setState(x => ({ sheet: { ...x.sheet, all: !x.sheet.all } }))}><i>▸</i>Show all changes</button>
            ${sh.all && html`<div class="all">${changes.map(i => html`<div class="line"><span class="s" style=${`color:${i.action === 'create' ? '#5fe07a' : '#9ec1ff'}`}>${i.action === 'create' ? '+' : '↻'}</span><span class="n">${i.name}</span><span class="m">${[i.meta, this.app(i.to)?.name].filter(Boolean).join(' · ')}</span></div>`)}</div>`}
          </div>`}`}
      </div>
      <div class="actions">
        ${c.delete > 0 && (c.create + c.update > 0) && html`<button class="btn quiet" onClick=${() => this.run(false)}>Run without deleting</button>`}
        <span class="grow"></span>
        <button class="btn" onClick=${this.closeSheet}>${nothing || sh.error ? 'Close' : 'Cancel'}</button>
        ${!nothing && !sh.error && html`<button class="btn primary" disabled=${!ok} onClick=${() => ok && this.run(c.delete > 0)}>Run</button>`}
      </div>
    </div></div>`;
  }

  renderCli() {
    const s = this.state, busy = this.streams.length > 0;
    const mark = { say: '', tool: '⏵ ', result: '  ', error: '  ', end: '' };
    return html`<div class="veil" onClick=${e => { if (e.target === e.currentTarget) this.setState({ cli: false }); }}><div class="sheet term" role="dialog" aria-label="Claude CLI session">
      <div class="termhead"><b>claude</b><span>${s.logLabel || 'no session yet'}</span><span class="grow"></span>${busy && html`<span class="breathe"></span>`}<span>${busy ? 'running' : s.log.length ? 'ended' : ''}</span></div>
      <div class="termbody" ref=${el => { if (el) el.scrollTop = el.scrollHeight; }}>
        ${s.log.length === 0 && html`<div class="t-result">Nothing has run in this window yet.</div>`}
        ${s.log.map(l => html`<div class=${'t-' + l.kind}>${mark[l.kind]}${l.text}</div>`)}
      </div>
    </div></div>`;
  }

  renderInspect() {
    const it = this.state.inspect;
    const rea = (it.evidence || []).filter(e => e.source === 'rea'), conv = (it.evidence || []).filter(e => e.source !== 'rea');
    const tools = [...new Set(it.reaToolCalls || [])];
    const status = it.status === 'built' ? 'Built and tested' : it.status === 'validated' ? 'Technically validated, not built' : 'Speculative, not yet proven';
    const ev = (list, cls) => list.map(e => html`<div class=${'item ' + cls}><small>${e.tool}</small><span>${e.finding}</span></div>`);
    return html`<div class="veil" onClick=${e => { if (e.target === e.currentTarget) this.setState({ inspect: null }); }}><div class="sheet" role="dialog" aria-label="How this was found">
      <div class="body">
        <div><h2>${it.title}</h2><p class="lede">${it.description}</p></div>
        <dl class="kv">
          <dt>Method</dt><dd>${METHOD[it.method]}</dd>
          <dt>Status</dt><dd>${status}</dd>
          ${it.validation && html`<dt>Tests</dt><dd>${it.validation.tests} passed${it.validation.dryRun ? ` · dry run: ${it.validation.dryRun}` : ''}</dd>`}
          ${it.lastRun && html`<dt>Last run</dt><dd>${ago(it.lastRun.at)} · ${summary(it.lastRun.counts)} · ${it.lastRun.verified ? `${it.lastRun.checked} verified at destination` : 'verification incomplete'}</dd>`}
          ${it.apps?.length > 0 && html`<dt>Built for</dt><dd>${it.apps.map(a => `${a.name} ${a.version}`).join(' and ')}</dd>`}
        </dl>
        <div class="ev"><h3>What reverse engineering added</h3><p>${it.reaContribution || 'Nothing that conventional sources did not already show.'}</p>
          ${ev(rea, 'rea')}
          ${tools.length > 0 && html`<p style="color:var(--mute);font-size:12px">REA tools run for this pair: ${tools.join(', ')}</p>`}
        </div>
        ${conv.length > 0 && html`<div class="ev"><h3>From conventional sources</h3>${ev(conv, '')}</div>`}
      </div>
      <div class="actions"><span class="grow"></span><button class="btn" onClick=${() => this.setState({ inspect: null })}>Done</button></div>
    </div></div>`;
  }

  render(_, s) {
    const A = this.app(s.L), B = this.app(s.R);
    const merging = s.phase === 'merge', list = s.phase === 'list';
    const fade = `opacity:${merging ? 0 : 1}`;
    const nSel = Object.values(s.sel).filter(Boolean).length;
    const tall = (s.sheet || s.inspect || s.cli) ? 'min-height:600px' : '';
    return html`<div class="stage"><div class="win" style=${tall}>
      <div class="bar">
        ${list && html`<button class="back" title="Choose other apps" aria-label="Choose other apps" onClick=${this.reset}><svg width="9" height="14" viewBox="0 0 9 14"><path d="M7 1.5L1.8 7 7 12.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`}
        <div class="name">AppBridge</div>
      </div>

      <div class="hero" ref=${this.hero} style=${`height:${list ? 172 : 320}px`}>
        <canvas ref=${this.canvas}></canvas>
        ${!list && A && B && html`
          <button class="tilebtn" title="Choose app" style=${`left:100px;${fade};transform:${merging ? 'translate(150px,0) scale(.12) rotate(170deg)' : 'none'}`} onClick=${() => this.setState({ pick: 'L', q: '' })}><${Icon} app=${A} size=${60} /></button>
          <button class="tilebtn" title="Choose app" style=${`left:400px;${fade};transform:${merging ? 'translate(-150px,0) scale(.12) rotate(-170deg)' : 'none'}`} onClick=${() => this.setState({ pick: 'R', q: '' })}><${Icon} app=${B} size=${60} /></button>
          <button class="applabel" style=${`left:50px;${fade}`} onClick=${() => this.setState({ pick: 'L', q: '' })}><span>${A.name}</span><svg width="8" height="5" viewBox="0 0 8 5"><path d="M1 1l3 3 3-3" fill="none" stroke="rgba(255,255,255,.5)" stroke-width="1.4" stroke-linecap="round"/></svg></button>
          <button class="applabel" style=${`left:350px;${fade}`} onClick=${() => this.setState({ pick: 'R', q: '' })}><span>${B.name}</span><svg width="8" height="5" viewBox="0 0 8 5"><path d="M1 1l3 3 3-3" fill="none" stroke="rgba(255,255,255,.5)" stroke-width="1.4" stroke-linecap="round"/></svg></button>
          <button class="go" aria-label="Discover integrations" onClick=${this.start}
            onMouseEnter=${() => { this.galaxy.hover(true); this.setState({ hov: true }); }} onMouseLeave=${() => { this.galaxy.hover(false); this.setState({ hov: false }); }}></button>
          <div class="golabel" style=${fade}><b style=${`color:${s.hov ? '#fff' : 'rgba(255,255,255,.7)'}`}>Discover integrations</b><i>⌘ ↩</i></div>
`}
        ${s.pick && s.phase === 'idle' && this.renderPicker()}
        ${list && html`
          <div class="fused"><${Icon} app=${A} size=${56} small /><${Icon} app=${B} size=${56} small /></div>
          <div class="pairname">${A.name} + ${B.name}</div>
          ${s.prompt.trim() && html`<div class="pairprompt">“${s.prompt.trim()}”</div>`}`}
      </div>

      ${!list && html`<div class="field" style=${fade}>
        <input value=${s.prompt} onInput=${e => this.setState({ prompt: e.target.value })} onKeyDown=${e => { if (e.key === 'Enter') this.start(); }} placeholder="Describe what they should do together (optional)" aria-label="Describe what they should do together (optional)" />
        ${s.health && !s.health.loggedIn && html`<div class="note">Discovery needs the Claude CLI signed in. Run <code>claude auth login</code> in Terminal, then reload.</div>`}
      </div>`}

      ${list && html`<div class="rows">
        ${s.saved.length > 0 && html`<div class="head">Saved</div>${s.saved.map((it, i) => this.renderSaved(it, i))}`}
        ${(s.pending || s.disc.length > 0) && html`<div class="head second">Discovered${s.pending && html`<span class="breathe"></span>`}</div>`}
        ${s.disc.map(it => this.renderDisc(it))}
        ${s.pending && html`<div class="ghost"><span class="box"></span><div class="lines"><span class="shim"></span></div></div>`}
        ${s.discError && html`<div class="empty bad">${s.discError}</div>`}
        ${!s.pending && !s.discError && s.disc.length === 0 && html`<div class="empty">Nothing new this time. Describe a specific task to look deeper.</div>`}
      </div>
      ${nSel > 0 && html`<div class="foot"><span class="grow">${nSel} selected</span><button class="btn quiet" onClick=${() => this.setState({ sel: {} })}>Clear</button><button class="btn primary" onClick=${this.build}>Build ${nSel}</button></div>`}
      ${s.toast && nSel === 0 && html`<div class="foot" style="padding:13px 22px">
        ${s.toast.ok && html`<span class="ok" style="animation:none;flex:none"><svg width="9" height="7" viewBox="0 0 9 7"><path d="M1 3.6L3.4 6 8 1" fill="none" stroke="#0b2a12" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`}
        <span style="font-weight:600;flex:none">${s.toast.ok ? 'Transfer complete' : 'Transfer finished with problems'}</span><span class="grow">${s.toast.text}</span>
      </div>`}`}

      ${s.sheet && this.renderSheet()}
      ${s.inspect && this.renderInspect()}
      ${s.cli && this.renderCli()}
    </div></div>`;
  }
}

render(html`<${App} />`, document.getElementById('root'));
