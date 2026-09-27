// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * pickServerPath(): a desktop-grade "Open" dialog for paths ON THE IRIS SERVER
 * (certificate files, key files, database and journal directories…).
 *
 *   const path = await pickServerPath({ id: 'tls.certFile', mode: 'file', title: 'Choose a certificate',
 *     filters: [{ label: 'Certificates', patterns: ['*.cer', '*.crt', '*.pem'] }], start: current });
 *   if (path) input.value = path;
 *
 * Layout (one 16px inset on every edge):
 * - header 48 (title; close on the right);
 * - path bar 44: Back · Up · Refresh · breadcrumbs (click to jump; click the bar
 *   or Ctrl+L to type or paste a path; Enter goes) · search this folder;
 * - a rail of places (Installation, Manager, Server home, drives, recent folders)
 *   beside a sortable list (Name · Modified · Size, folders first; the header is
 *   sticky inside the list so columns never drift from their data);
 * - footer 56: the selection (or the item count), the file-type filter, Cancel
 *   and Select ("Select folder" in directory mode).
 *
 * Keys: arrows, Home/End, PageUp/PageDown, type-ahead, Enter or double-click to
 * open a folder or pick a file, Backspace / Alt+Up up, Alt+Left back, Ctrl+L to
 * type a path, Ctrl+C to copy the highlighted path.
 *
 * With `id`, the last folder a choice was made in is remembered per field
 * (localStorage) and the picker opens there when the field is empty.
 *
 * Data comes from the OSCA API (fsRoots / fsList / fsStat in api-osca.ts). It
 * is loaded lazily and read defensively: when the API isn't installed the
 * dialog still opens, says so, and lets you type a path.
 * Resolves to the chosen full path, or null when cancelled.
 */
import '@evolution-ui/core/components/ev-dialog/ev-dialog.js';
import { esc, when } from './ui';
import { toast } from './crud';
import './styles-picker.css';
import { samePath } from './api-disk';
import { apiAvailable, fsRoots, fsList, fsStat, type FsRoots, type FsEntry, type FsStat } from './api-osca';

/** The file-system calls, present only once the OSCA API has answered; empty while it isn't installed. */
/** A drive from the display-only sample data (src/showcase): listed, but not on the server. */
const isSampleRoot = (r: object): boolean => (r as { sample?: boolean }).sample === true;

interface FsApi { fsRoots?: typeof fsRoots; fsList?: typeof fsList; fsStat?: typeof fsStat }

export interface PathFilter { label: string; patterns: string[] }
export interface PickServerPathOptions {
  mode?: 'file' | 'dir';
  filters?: PathFilter[];
  /** A folder to open in, or a file to open its folder with that file selected. */
  start?: string;
  title?: string;
  /** Which field is asking (e.g. "tls.certFile"): its last folder is remembered and reused. */
  id?: string;
}

/** Can the portal browse the server's files? (OSCA API installed, with the file-system calls.) */
export async function serverFilesAvailable(): Promise<boolean> {
  try { return await apiAvailable(); } catch { return false; }
}

/** Check a typed path on the server: null when it can't be checked (no API, no permission). */
export async function statServerPath(path: string): Promise<FsStat | null> {
  if (!path.trim()) return null;
  try { return await fsStat(path.trim()); } catch { return null; }
}

/** Folders visited this session, newest first (the rail's "Recent"). */
const recent: string[] = [];
const ALL_FILES: PathFilter = { label: 'All files', patterns: ['*'] };
const LAST_KEY = (id: string): string => `osca-portal:picker-last:${id}`;
const lastFolder = (id?: string): string => { if (!id) return ''; try { return localStorage.getItem(LAST_KEY(id)) ?? ''; } catch { return ''; } };
const rememberFolder = (id: string | undefined, folder: string): void => { if (!id || !folder) return; try { localStorage.setItem(LAST_KEY(id), folder); } catch { /* storage blocked */ } };

const globToRe = (p: string): RegExp =>
  new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');

function bytes(n: number | null): string {
  if (n === null || !Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
function modifiedText(s: string | null): string {
  if (!s) return '';
  const d = new Date(/^\d{4}-\d\d-\d\d \d/.test(s) ? s.replace(' ', 'T') : s);
  return Number.isNaN(d.getTime()) ? s : when(d);
}
/** Separator of a path as typed: backslash for "C:\…" or a UNC path, else slash. */
const sepOf = (p: string, fallback = '/'): string => (/^[a-z]:|^\\\\|\\/i.test(p) ? '\\' : p.includes('/') ? '/' : fallback);
/** Without the trailing separator ("C:\InterSystems\IRIS262"), except for a root ("C:\", "/"). */
const displayPath = (p: string): string => (/^([a-z]:[\\/]?|[\\/])$/i.test(p) ? p : p.replace(/[\\/]+$/, ''));

/** "C:\InterSystems\mgr" → [["C:\","C:\"], ["InterSystems","C:\InterSystems"], ["mgr","C:\InterSystems\mgr"]]. */
function segments(path: string, sep: string): Array<{ label: string; path: string }> {
  if (!path) return [];
  const out: Array<{ label: string; path: string }> = [];
  if (sep === '\\') {
    const m = /^([a-z]:\\?|\\\\[^\\]+\\[^\\]+\\?)/i.exec(path);
    let root = m ? m[1] : '';
    if (root && !root.endsWith('\\')) root += '\\';
    if (root) out.push({ label: root.replace(/\\$/, ''), path: root });
    let acc = root;
    for (const part of path.slice(m ? m[1].length : 0).split('\\').filter(Boolean)) {
      acc = acc.endsWith('\\') ? acc + part : `${acc}\\${part}`;
      out.push({ label: part, path: acc });
    }
  } else {
    out.push({ label: '/', path: '/' });
    let acc = '';
    for (const part of path.split('/').filter(Boolean)) { acc += `/${part}`; out.push({ label: part, path: acc }); }
  }
  return out;
}
function parentOf(path: string, sep: string): string | null {
  const segs = segments(path, sep);
  return segs.length > 1 ? segs[segs.length - 2].path : null;
}
/** Short rail names: "Installation", "Manager", "Server home" (the full path is the tooltip). */
function placeLabel(p: { label?: string; name?: string; path: string }): string {
  const raw = (p.label ?? p.name ?? '').trim();
  if (/install/i.test(raw)) return 'Installation';
  if (/\bmgr\b|manager/i.test(raw)) return 'Manager';
  if (/home/i.test(raw)) return 'Server home';
  return raw.replace(/\s*\(.*\)\s*$/, '') || p.path;
}

const chevron = (dir: 'up' | 'down'): string => `<ev-icon class="fp-arrow" name="chevron-${dir}" size="xs"></ev-icon>`;

export function pickServerPath(opts: PickServerPathOptions = {}): Promise<string | null> {
  const mode = opts.mode ?? 'file';
  const filters = mode === 'dir' ? [] : [...(opts.filters ?? []), ALL_FILES];
  const title = opts.title ?? (mode === 'dir' ? 'Choose a folder' : 'Choose a file');

  return new Promise((resolve) => {
    const dlg = document.createElement('ev-dialog') as HTMLElement & { open: boolean; close(): void };
    dlg.setAttribute('heading', title);
    Object.assign(dlg, { maxWidth: 'min(880px, calc(100vw - 32px))', maxHeight: 'min(560px, calc(100vh - 32px))', scrollMode: 'none' });
    dlg.className = 'fp-dialog';
    const filterOptions = filters.map((f, i) => `<option value="${i}" title="${esc(f.patterns.join(', '))}">${esc(f.label)}</option>`).join('');
    dlg.innerHTML = `
      <div slot="body" class="fp">
        <div class="fp-bar">
          <button type="button" class="fp-iconbtn" data-fp="back" title="Back (Alt+Left)" aria-label="Back"><ev-icon name="chevron-left" size="sm"></ev-icon></button>
          <button type="button" class="fp-iconbtn" data-fp="up" title="Up one folder (Backspace)" aria-label="Up one folder"><ev-icon name="arrow-up" size="sm"></ev-icon></button>
          <button type="button" class="fp-iconbtn" data-fp="refresh" title="Refresh" aria-label="Refresh"><ev-icon name="refresh-cw" size="sm"></ev-icon></button>
          <div class="fp-path" data-fp="path" title="Click to type a path (Ctrl+L)">
            <nav class="fp-crumbs" aria-label="Folder path"></nav>
            <input class="fp-path-input" type="text" spellcheck="false" autocomplete="off" aria-label="Path on the server" hidden>
          </div>
          <label class="fp-search-wrap"><ev-icon name="search" size="xs"></ev-icon><input class="fp-search" type="search" placeholder="Search" aria-label="Search this folder"></label>
        </div>
        <div class="fp-main">
          <nav class="fp-rail" aria-label="Places"></nav>
          <div class="fp-list" role="listbox" tabindex="0" aria-label="Folder contents">
            <div class="fp-head" role="presentation">
              <button type="button" class="fp-col fp-col--name" data-sort="name" tabindex="-1">Name${chevron('up')}</button>
              <button type="button" class="fp-col fp-col--mod" data-sort="modified" tabindex="-1">Modified${chevron('up')}</button>
              <button type="button" class="fp-col fp-col--size" data-sort="size" tabindex="-1">Size${chevron('up')}</button>
            </div>
            <div class="fp-rows"></div>
          </div>
        </div>
      </div>
      <div slot="footer" class="fp-foot">
        <span class="fp-selected" aria-live="polite"></span>
        ${filters.length ? `<span class="fp-type-wrap"><select class="fp-type" aria-label="File type" title="${esc(filters[0].patterns.join(', '))}">${filterOptions}</select><ev-icon name="chevron-down" size="xs"></ev-icon></span>` : ''}
        <button type="button" class="btn" data-dismiss>Cancel</button>
        <button type="button" class="btn btn--primary" data-fp="ok">${mode === 'dir' ? 'Select folder' : 'Select'}</button>
      </div>`;

    const $ = <T extends HTMLElement>(sel: string): T => dlg.querySelector(sel) as T;
    const crumbs = $<HTMLElement>('.fp-crumbs');
    const pathInput = $<HTMLInputElement>('.fp-path-input');
    const pathBox = $<HTMLElement>('.fp-path');
    const rail = $<HTMLElement>('.fp-rail');
    const list = $<HTMLElement>('.fp-list');
    const rowsEl = $<HTMLElement>('.fp-rows');
    const search = $<HTMLInputElement>('.fp-search');
    const typeSel = dlg.querySelector<HTMLSelectElement>('.fp-type');
    const selectedEl = $<HTMLElement>('.fp-selected');
    const okBtn = $<HTMLButtonElement>('[data-fp="ok"]');
    const backBtn = $<HTMLButtonElement>('[data-fp="back"]');
    const upBtn = $<HTMLButtonElement>('[data-fp="up"]');

    let api: FsApi = {};
    let roots: FsRoots | null = null;
    let dir = '';
    let sep = sepOf(opts.start ?? '', '/');
    let parent: string | null = null;
    let entries: FsEntry[] = [];
    let truncated = false;
    let error = '';
    /** The sample drive the current folder is on, if any: nothing to list, and nothing to choose. */
    let sample: { name: string; path: string } | null = null;
    let loading = false;
    let active = -1; // index into shown()
    let sort: { key: 'name' | 'modified' | 'size'; dir: 1 | -1 } = { key: 'name', dir: 1 };
    const history: string[] = [];
    let wantSelect: string | null = null;
    let token = 0;
    let result: string | null = null;

    const filterRes = (): RegExp[] => {
      const f = filters[Number(typeSel?.value ?? 0)] ?? ALL_FILES;
      return f.patterns.map(globToRe);
    };
    const shown = (): FsEntry[] => {
      const q = search.value.trim().toLowerCase();
      const res = filterRes();
      const rows = entries.filter((e) => (e.type === 'dir' || mode === 'dir' || res.some((r) => r.test(e.name))) && (!q || e.name.toLowerCase().includes(q)));
      const cmp = (a: FsEntry, b: FsEntry): number => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1; // folders first, whatever the sort
        const k = sort.key;
        const v = k === 'size' ? (a.size || 0) - (b.size || 0)
          : k === 'modified' ? String(a.modified).localeCompare(String(b.modified))
            : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        return v * sort.dir;
      };
      return rows.sort(cmp);
    };
    /** What Select returns right now. */
    const choice = (): string | null => {
      const row = shown()[active];
      if (mode === 'dir') return row?.type === 'dir' ? row.path : dir || null;
      if (row?.type === 'file') return row.path;
      const typed = pathInput.hidden ? '' : pathInput.value.trim();
      return typed && !typed.endsWith(sep) ? typed : null;
    };
    const renderFoot = (): void => {
      const c = choice();
      const n = loading || error || sample ? 0 : shown().length;
      selectedEl.innerHTML = c
        ? `<span class="fp-dim">Selected:</span> <span class="fp-mono" title="${esc(displayPath(c))}">${esc(displayPath(c))}</span>${sample ? '<span class="fp-dim"> · sample drive</span>' : ''}`
        : `<span class="fp-dim">${loading || error ? '' : `${n.toLocaleString()} item${n === 1 ? '' : 's'}`}</span>`;
      okBtn.disabled = !c || !!sample;
      backBtn.disabled = !history.length;
      upBtn.disabled = !parent;
    };
    const renderCrumbs = (): void => {
      const segs = segments(dir, sep);
      crumbs.innerHTML = segs.length
        ? segs.map((s, i) => `${i && !(i === 1 && segs[0].label === '/') ? `<span class="fp-crumb-sep" aria-hidden="true">${sep === '\\' ? '\u203a' : '/'}</span>` : ''}<button type="button" class="fp-crumb" data-path="${esc(s.path)}" title="${esc(displayPath(s.path))}"${i === segs.length - 1 ? ' aria-current="location"' : ''}>${esc(s.label)}</button>`).join('')
        : '<span class="fp-dim">Type a path</span>';
      crumbs.scrollLeft = crumbs.scrollWidth;
    };
    const renderHead = (): void => {
      dlg.querySelectorAll<HTMLElement>('.fp-col').forEach((b) => {
        const on = b.dataset.sort === sort.key;
        b.setAttribute('aria-sort', on ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none');
        b.classList.toggle('is-sorted', on);
        const arrow = b.querySelector('.fp-arrow');
        arrow?.setAttribute('name', on && sort.dir === -1 ? 'chevron-down' : 'chevron-up');
      });
    };
    const renderList = (): void => {
      if (loading) { rowsEl.innerHTML = Array.from({ length: 8 }, () => '<div class="fp-row fp-row--skel"><span></span><span></span><span></span></div>').join(''); return; }
      if (sample) {
        // An expected state, not an error: say what it is and offer the way back to a real drive.
        const real = (roots?.roots ?? []).find((r) => !isSampleRoot(r));
        rowsEl.innerHTML = `<div class="fp-sample" role="status">
          <ev-icon name="info" size="md"></ev-icon>
          <strong>${esc(sample.name)} is a sample drive</strong>
          <span>It’s part of the sample multi-drive layout, so there are no folders to show.${real ? ` Choose ${esc(real.name)} to browse the server, or turn off sample data in the status bar.` : ' Turn off sample data in the status bar to hide it.'}</span>
          ${real ? `<button type="button" class="btn btn--sm" data-fp="real" data-path="${esc(real.path)}">Go to ${esc(real.name)}</button>` : ''}
        </div>`;
        rowsEl.querySelector<HTMLElement>('[data-fp="real"]')?.addEventListener('click', (e) => { void go((e.currentTarget as HTMLElement).dataset.path ?? ''); list.focus(); });
        return;
      }
      if (error) {
        rowsEl.innerHTML = `<div class="fp-error" role="alert"><ev-icon name="alert-triangle" size="sm"></ev-icon><div><strong>Can’t open this folder</strong><span>${esc(error)}</span></div>
          ${parent ? '<button type="button" class="btn btn--sm" data-fp="up2">Go up</button>' : ''}<button type="button" class="btn btn--sm" data-fp="retry">Try again</button></div>`;
        rowsEl.querySelector('[data-fp="up2"]')?.addEventListener('click', () => { if (parent) { void go(parent); list.focus(); } });
        rowsEl.querySelector('[data-fp="retry"]')?.addEventListener('click', () => void go(dir, false));
        return;
      }
      const rows = shown();
      if (active >= rows.length) active = rows.length - 1;
      rowsEl.innerHTML = rows.length
        ? rows.map((e, i) => {
          const off = mode === 'dir' && e.type === 'file';
          return `<div class="fp-row${i === active ? ' is-active' : ''}${e.hidden ? ' fp-row--hidden' : ''}${off ? ' fp-row--off' : ''}" role="option" id="fp-r${i}" data-i="${i}" aria-selected="${i === active}"${off ? ' aria-disabled="true"' : ''} title="${esc(e.path)}">
            <span class="fp-name"><ev-icon name="${e.type === 'dir' ? 'folder' : 'file'}" size="sm"></ev-icon><span>${esc(e.name)}</span></span>
            <span class="fp-mod">${esc(modifiedText(e.modified))}</span>
            <span class="fp-size">${e.type === 'dir' ? '' : esc(bytes(e.size))}</span>
          </div>`;
        }).join('') + (truncated ? '<div class="fp-note">Showing the first entries only. Search or type a path to narrow it.</div>' : '')
        : `<div class="fp-note">${search.value.trim() ? 'Nothing here matches that search' : mode === 'dir' ? 'This folder is empty' : 'No matching files here'}</div>`;
      if (active >= 0) { list.setAttribute('aria-activedescendant', `fp-r${active}`); rowsEl.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' }); }
      else list.removeAttribute('aria-activedescendant');
    };
    const renderRail = (): void => {
      const places = (roots?.places ?? []).map((p) => ({ icon: 'folder', label: placeLabel(p), path: p.path }));
      const drives = (roots?.roots ?? []).map((r) => ({ icon: 'server', label: r.name, path: r.path, tag: isSampleRoot(r) ? 'Sample' : '' }));
      const known = [...places, ...drives];
      // Recent leaves out anything already listed as a place or a drive.
      const rec = recent.filter((p) => !known.some((k) => samePath(k.path, p))).slice(0, 6)
        .map((p) => ({ icon: 'clock', label: segments(p, sepOf(p, sep)).pop()?.label ?? p, path: p }));
      // "You are here": the deepest listed place that contains the current folder.
      const all = [...places, ...drives, ...rec];
      const here = dir ? all.filter((k) => { const a = displayPath(k.path); return samePath(a, dir) || dir.toLowerCase().startsWith(`${a.toLowerCase()}${sep}`) || (/[\\/]$/.test(k.path) && dir.toLowerCase().startsWith(k.path.toLowerCase())); })
        .sort((a, b) => b.path.length - a.path.length)[0] : undefined;
      const item = (k: { icon: string; label: string; path: string; tag?: string }): string =>
        `<button type="button" class="fp-place" data-path="${esc(k.path)}" title="${esc(displayPath(k.path))}"${k === here ? ' aria-current="true"' : ''}><ev-icon name="${k.icon}" size="sm"></ev-icon><span>${esc(k.label)}</span>${k.tag ? `<span class="fp-tag">${esc(k.tag)}</span>` : ''}</button>`;
      const group = (label: string, items: typeof all): string => (items.length ? `<div class="fp-rail-group"><div class="fp-rail-label">${esc(label)}</div>${items.map(item).join('')}</div>` : '');
      rail.innerHTML = [group('Places', places), group('Drives', drives), group('Recent', rec)].join('') || '<div class="fp-note">No places</div>';
    };
    const renderAll = (): void => { renderCrumbs(); renderHead(); renderList(); renderFoot(); renderRail(); };

    /** Open a folder (push = remember the current one for Back). */
    async function go(target: string, push = true): Promise<void> {
      if (!target) return;
      const t = ++token;
      if (push && dir && dir !== target) history.push(dir);
      loading = true; error = ''; active = -1; sample = null;
      renderList(); renderFoot();
      // "E:" and "E:\" are the same drive: compare without the trailing separator.
      const bare = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase();
      const onSample = (roots?.roots ?? []).find((r) => {
        if (!isSampleRoot(r)) return false;
        const root = bare(r.path); const t = bare(target);
        return t === root || t.startsWith(`${root}\\`) || t.startsWith(`${root}/`);
      });
      if (onSample) {
        loading = false;
        dir = target; sep = sepOf(target, sep); parent = parentOf(target, sep); entries = [];
        sample = onSample;
        renderAll();
        return;
      }
      if (!api.fsList) {
        loading = false;
        dir = target; sep = sepOf(target, sep); parent = parentOf(target, sep); entries = [];
        error = 'Browsing the server’s files needs the OSCA API, which isn’t installed on this instance. Type the path instead.';
        renderAll();
        return;
      }
      try {
        const r = await api.fsList(target, { limit: 2000 });
        if (t !== token) return;
        dir = r.dir || target;
        sep = r.separator || sepOf(dir, sep);
        parent = r.parent ?? parentOf(dir, sep);
        entries = r.entries ?? [];
        truncated = !!r.truncated;
        loading = false;
        const i = recent.findIndex((p) => samePath(p, dir));
        if (i >= 0) recent.splice(i, 1);
        recent.unshift(dir);
        if (recent.length > 8) recent.pop();
        if (wantSelect) { const w = wantSelect; wantSelect = null; active = shown().findIndex((e) => samePath(e.path, w) || e.name === w); }
        else active = -1;
      } catch (err) {
        if (t !== token) return;
        loading = false;
        dir = target; parent = parentOf(target, sep); entries = [];
        error = err instanceof Error ? err.message : String(err);
      }
      search.value = '';
      renderAll();
    }

    const finish = (path: string): void => {
      result = path;
      // Remember where this field's choice was made: the folder chosen, or the chosen file's folder.
      rememberFolder(opts.id, mode === 'dir' ? path : parentOf(path, sepOf(path, sep)) ?? dir);
      dlg.close();
    };
    const pick = (): void => { const c = choice(); if (c && !sample) finish(c); };
    const activate = (e: FsEntry | undefined): void => {
      if (!e) return;
      if (e.type === 'dir') { void go(e.path); list.focus(); }
      else if (mode === 'file') finish(e.path);
    };

    // ── Path bar: crumbs, or a text box to type / paste into ──
    const editPath = (on: boolean): void => {
      pathInput.hidden = !on;
      crumbs.hidden = on;
      if (on) { pathInput.value = displayPath(dir); pathInput.focus(); pathInput.select(); }
      renderFoot();
    };
    pathBox.addEventListener('click', (e) => {
      const c = (e.target as Element).closest<HTMLElement>('.fp-crumb');
      if (c) { void go(c.dataset.path ?? ''); list.focus(); return; }
      if (pathInput.hidden) editPath(true);
    });
    pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const v = pathInput.value.trim();
        if (!v) return;
        void (async () => {
          const st = api.fsStat ? await api.fsStat(v).catch(() => null) : null;
          if (st?.exists && st.type === 'file') {
            if (mode === 'file') { finish(v); return; }
            wantSelect = null; editPath(false); void go(parentOf(v, sepOf(v, sep)) ?? v); list.focus(); return;
          }
          // A file that doesn't exist yet (a new key or log file): keep it as the choice; Select takes it.
          if (mode === 'file' && st && !st.exists && !/[\\/]$/.test(v)) { renderFoot(); okBtn.focus(); return; }
          editPath(false);
          void go(v);
          list.focus();
        })();
      } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); editPath(false); list.focus(); }
    });
    pathInput.addEventListener('input', renderFoot);
    // Leave typing mode when focus goes elsewhere, except to Select (which takes the typed path).
    pathInput.addEventListener('blur', (e) => {
      if ((e as FocusEvent).relatedTarget === okBtn) return;
      setTimeout(() => { if (!pathInput.hidden && document.activeElement !== pathInput && document.activeElement !== okBtn) editPath(false); }, 150);
    });

    // ── Toolbar, rail, sort, filter ──
    backBtn.addEventListener('click', () => { const p = history.pop(); if (p) { void go(p, false); list.focus(); } });
    upBtn.addEventListener('click', () => { if (parent) { wantSelect = dir; void go(parent); list.focus(); } });
    $<HTMLButtonElement>('[data-fp="refresh"]').addEventListener('click', () => void go(dir, false));
    rail.addEventListener('click', (e) => { const b = (e.target as Element).closest<HTMLElement>('.fp-place'); if (b) { void go(b.dataset.path ?? ''); list.focus(); } });
    dlg.querySelector('.fp-head')?.addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLElement>('.fp-col');
      if (!b) return;
      const key = b.dataset.sort as typeof sort.key;
      sort = sort.key === key ? { key, dir: sort.dir === 1 ? -1 : 1 } : { key, dir: 1 };
      active = -1;
      renderHead(); renderList(); renderFoot();
      list.focus();
    });
    search.addEventListener('input', () => { active = shown().length ? 0 : -1; renderList(); renderFoot(); });
    search.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); list.focus(); if (active < 0 && shown().length) setActive(0); } });
    typeSel?.addEventListener('change', () => {
      typeSel.title = (filters[Number(typeSel.value)] ?? ALL_FILES).patterns.join(', ');
      active = -1; renderList(); renderFoot();
    });

    // ── List: click highlights, the second click (or Enter) opens or picks; arrows, Home/End, type-ahead ──
    /** Move the highlight without rebuilding the rows: a rebuild between the two clicks of a
     *  double-click replaces the element under the pointer, and the browser then never fires it. */
    const setActive = (i: number): void => {
      active = i;
      rowsEl.querySelectorAll<HTMLElement>('.fp-row[data-i]').forEach((row) => {
        const on = Number(row.dataset.i) === i;
        row.classList.toggle('is-active', on);
        row.setAttribute('aria-selected', String(on));
        if (on) row.scrollIntoView({ block: 'nearest' });
      });
      if (i >= 0) list.setAttribute('aria-activedescendant', `fp-r${i}`); else list.removeAttribute('aria-activedescendant');
      renderFoot();
    };
    rowsEl.addEventListener('click', (e) => {
      const r = (e.target as Element).closest<HTMLElement>('.fp-row[data-i]');
      if (!r) return;
      const i = Number(r.dataset.i);
      if (e.detail >= 2) { activate(shown()[i]); return; } // second click of a double-click: open / pick
      setActive(i);
    });
    let typed = '';
    let typedAt = 0;
    list.addEventListener('keydown', (e) => {
      const rows = shown();
      const move = (i: number): void => { e.preventDefault(); if (rows.length) setActive(Math.max(0, Math.min(rows.length - 1, i))); };
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        const path = rows[active]?.path ?? (dir ? displayPath(dir) : '');
        if (!path || !navigator.clipboard) return;
        e.preventDefault();
        void navigator.clipboard.writeText(path).then(() => toast('Path copied'), () => { /* clipboard blocked */ });
        return;
      }
      switch (e.key) {
        case 'ArrowDown': move(active + 1); return;
        case 'ArrowUp': move(active <= 0 ? 0 : active - 1); return;
        case 'Home': move(0); return;
        case 'End': move(rows.length - 1); return;
        case 'PageDown': move(active + 10); return;
        case 'PageUp': move(active - 10); return;
        case 'Enter': e.preventDefault(); if (rows[active]) activate(rows[active]); else pick(); return;
        case 'Backspace': e.preventDefault(); if (parent) { wantSelect = dir; void go(parent); } return;
        default:
          if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ') {
            const now = Date.now();
            typed = now - typedAt > 700 ? e.key.toLowerCase() : typed + e.key.toLowerCase();
            typedAt = now;
            const start = typed.length === 1 ? active + 1 : Math.max(0, active);
            const n = rows.length;
            for (let k = 0; k < n; k++) {
              const i = (start + k) % n;
              if (rows[i].name.toLowerCase().startsWith(typed)) { move(i); return; }
            }
          }
      }
    });
    dlg.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') { e.preventDefault(); editPath(true); }
      else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); backBtn.click(); }
      else if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); upBtn.click(); }
    });
    okBtn.addEventListener('click', pick);

    dlg.addEventListener('ev-dialog-close', () => {
      resolve(result);
      setTimeout(() => dlg.remove(), 0);
    }, { once: true });
    document.body.appendChild(dlg);
    dlg.open = true;
    renderAll();
    requestAnimationFrame(() => requestAnimationFrame(() => list.focus()));

    // ── Load: places, then the start folder (or the start file's folder, with it selected) ──
    void (async () => {
      api = (await apiAvailable().catch(() => false)) ? { fsRoots, fsList, fsStat } : {};
      if (api.fsRoots) roots = await api.fsRoots().catch(() => null);
      renderRail();
      // An empty field opens where this field's last choice was made.
      let start = (opts.start ?? '').trim() || lastFolder(opts.id);
      if (start && api.fsStat) {
        const st = await api.fsStat(start).catch(() => null);
        if (st?.exists && st.type === 'file') { wantSelect = start; start = parentOf(start, sepOf(start, sep)) ?? start; }
        else if (!st?.exists) {
          // A path that doesn't exist yet (a new file or folder): open the nearest folder above it.
          const up = parentOf(start, sepOf(start, sep));
          start = up ?? '';
        }
      }
      start ||= roots?.places?.[0]?.path || roots?.roots?.[0]?.path || '';
      if (start) await go(start, false);
      else { error = api.fsList ? 'No folder to start in. Type a path above.' : 'Browsing the server’s files needs the OSCA API, which isn’t installed on this instance. Type the path instead.'; renderAll(); }
    })();
  });
}
