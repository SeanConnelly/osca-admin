// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Security › Filesystem access — which folders on the server a feature may
 * open. Each set of rules is a "purpose" (IRIS defines %GUIFileSelector for
 * the Management Portal's file picker). A purpose is either off, which
 * limits nothing, or on, which allows only its listed folders and everything
 * under them. Create, edit (limit on/off and the folder list) and delete all
 * happen in the detail panel.
 */
import '../styles-security.css';
import '../styles-sql.css';
import { pickServerPath, serverFilesAvailable } from '../file-picker';
import {
  getPurposes, getPaths, setPurpose, deletePurpose, addPath, removePath, samePath, KNOWN_PURPOSES, GUI_FILE_SELECTOR,
  type FsPurpose, type FsPath,
} from '../api-sql';
import {
  newButton, moreButton, moreMenu, confirm, toast, editorShell, panelWidth, section, textField, textareaField, checkField, selectField,
  readForm, fieldError, errorText, AdminError, type EditorHandle, type FieldProblem, type MenuHandle,
} from '../crud';
import { kv, esc, chip, cell, num, skeleton, errorPanel, liveIndicator, emptyState, noPermissionText, type ScreenCtx, type GridColumn, type Tone } from '../ui';
import type { DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';
import { sessionInfo, can } from '../session-info';

const EDIT_WIDTH = 520;
const NO_PRIV = noPermissionText('%Admin_FileSystemAccess', 'filesystem access administration');
const DOCS = 'https://docs.intersystems.com/irislatest/csp/docbook/DocBook.UI.Page.cls?KEY=GSA_using_portal';

interface Row { purpose: string; restricted: boolean; paths: FsPath[] | null }
const OTHER = '__other__';
/** The purpose name from the create form: a known feature, or the typed name for "Other". */
const purposeName = (v: Record<string, unknown>): string =>
  (v.PurposeKind === OTHER ? String(v.Purpose ?? '') : String(v.PurposeKind ?? '')).trim();

/** What a purpose does right now, in one phrase and a sentence. */
function status(r: Row): { short: string; long: string; tone: Tone } {
  if (!r.restricted) return { short: 'Not limiting', long: 'Disabled: the feature can open any folder the IRIS server process can reach. The folders listed are kept, ready for when it’s enabled.', tone: 'neutral' };
  const n = r.paths?.length ?? 0;
  if (r.paths && n === 0) return { short: 'Blocks every folder', long: 'On, with no folders allowed: the feature can’t open anything.', tone: 'danger' };
  return { short: `Only ${n} folder${n === 1 ? '' : 's'}`, long: `Enabled: the feature can open only ${n === 1 ? 'this folder' : `these ${n} folders`} and everything inside ${n === 1 ? 'it' : 'them'}.`, tone: 'success' };
}
const known = (p: string): { label: string; text: string } | undefined => KNOWN_PURPOSES[p];

const COLUMNS: GridColumn[] = [
  { key: 'Purpose', label: 'Feature (purpose)', width: '220px', sortable: true, renderCell: (v) => cell.id(v, String(v)) },
  { key: 'What', label: 'What it controls', sortable: true, renderCell: (v) => (v ? cell.text(v, String(v)) : cell.dim('Custom: used by your own code')) },
  { key: 'Status', label: 'Limit', width: '170px', sortable: true, description: 'Whether the limit is on, and how far it limits the feature. Limits apply to everyone who uses the feature, even accounts with %All.',
    renderCell: (v, row) => (row.Tone === 'neutral' ? cell.text(String(v), String(row.Long)) : chip(String(v), row.Tone as Tone, String(row.Long))) },
  { key: 'Folders', label: 'Folders', width: '84px', sortable: true, align: 'right', renderCell: (v) => (Number(v) < 0 ? cell.dim('—') : cell.num(num(Number(v)))) },
];
type GridEl = HTMLElement & { columns: GridColumn[]; rows: DataGridRow[]; select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void };

const callout = (tone: 'info' | 'warning' | 'danger', title: string, text = ''): string =>
  `<div class="sec-callout${tone === 'info' ? '' : ` sec-callout--${tone}`}" role="note"><ev-icon name="${tone === 'info' ? 'info' : 'alert-triangle'}" size="sm"></ev-icon><div><strong>${esc(title)}</strong>${text ? `<span>${text}</span>` : ''}</div></div>`;

/** One folder per line; blank lines ignored; duplicates (as IRIS compares them) dropped. */
function parseFolders(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const f = raw.trim();
    if (f && !out.some((x) => samePath(x, f))) out.push(f);
  }
  return out;
}

export function fsAccessScreen(ctx: ScreenCtx): void {
  ctx.fill();
  ctx.body.innerHTML = `
    <div class="toolbar-row" id="fs-toolbar">
      <div class="search-box"><ev-search id="fs-search" size="sm" full-width placeholder="Filter by feature or folder"></ev-search></div>
    </div>
    <ev-detail-panel id="fs-panel" detail-width="420" overlay-below="960" class="workspace">
      <div class="grid-wrap" id="fs-grid-wrap">${skeleton(4)}</div>
      <aside slot="detail" class="detail" id="fs-detail" aria-label="Folder limit details"></aside>
    </ev-detail-panel>
    <p class="table-foot" id="fs-foot"></p>`;

  const $ = <T extends HTMLElement = HTMLElement>(s: string): T => ctx.body.querySelector(s) as T;
  const panel = $<HTMLElement & { open: boolean }>('#fs-panel');
  const wrap = $('#fs-grid-wrap');
  const detail = $('#fs-detail');

  let rows: Row[] = [];
  let loaded = false;
  let alive = true;
  let query = '';
  let selected: string | null = null;
  let grid: GridEl | null = null;
  let canChange = true;
  let editor: EditorHandle | null = null;
  let restoreWidth: (() => void) | null = null;
  let menu: MenuHandle | null = null;

  const endEdit = (): void => {
    editor?.close(); editor = null;
    restoreWidth?.(); restoreWidth = null;
    ctx.beforeLeave(null);
  };
  ctx.onLeave(() => { alive = false; endEdit(); menu?.destroy(); });
  const guard = async (): Promise<boolean> => (editor ? editor.guard() : true);

  const newBtn = newButton(ctx, 'New folder limit', () => { void guard().then((ok) => { if (ok) openForm(null); }); });
  void sessionInfo().then((info) => {
    canChange = can(info, 'FileSystemAccess') !== false;
    newBtn.setHidden(!canChange);
    if (loaded) { renderGrid(); if (!editor) renderDetail(); }
  }).catch(() => { /* keep defaults */ });

  const rowOf = (p: string): Row | undefined => rows.find((r) => r.purpose === p);
  const matches = (r: Row): boolean => {
    if (!query) return true;
    const q = query.toLowerCase();
    return r.purpose.toLowerCase().includes(q) || (known(r.purpose)?.label.toLowerCase().includes(q) ?? false) || (r.paths ?? []).some((p) => p.RootPath.toLowerCase().includes(q));
  };

  const setPanel = (open: boolean): void => {
    if (panel.open === open) return;
    panel.open = open;
    grid?.setColumnVisible('What', !open);
  };
  const close = (): void => { endEdit(); selected = null; grid?.select([]); setPanel(false); };

  /* ── Grid ──────────────────────────────────────────────── */

  const emptyHtml = (): string => emptyState({
    icon: 'folder',
    title: 'No folder limits',
    what: canChange ? 'Any feature can open any folder. Limit features to the folders they need.' : `Any feature can open any folder. ${esc(NO_PRIV)}`,
    // The header's "New folder limit" is the action; the empty state keeps only the docs link.
    docs: { href: DOCS, label: 'Learn more' },
  });

  const renderGrid = (): void => {
    if (!loaded) return;
    ($('#fs-toolbar') as HTMLElement).hidden = !rows.length;
    if (!rows.length) {
      grid = null;
      wrap.innerHTML = emptyHtml();
      wrap.querySelector('#fs-limit-gui')?.addEventListener('click', () => void guard().then((ok) => { if (ok) openForm(null, GUI_FILE_SELECTOR); }));
      return;
    }
    if (!grid) {
      wrap.innerHTML = '';
      grid = document.createElement('ev-data-grid') as GridEl;
      grid.setAttribute('compact', '');
      grid.setAttribute('row-select', '');
      grid.setAttribute('row-key', 'Purpose');
      grid.setAttribute('sort-column', 'Purpose');
      grid.setAttribute('sort-direction', 'asc');
      grid.setAttribute('aria-label', 'Folder limits');
      grid.columns = COLUMNS;
      grid.addEventListener('ev-data-grid-row-click', (e) => {
        const p = String((e as CustomEvent<{ row: DataGridRow }>).detail.row.Purpose);
        if (p === selected && !editor) return;
        void guard().then((ok) => {
          if (!ok) { grid?.select(selected ? [selected] : []); return; }
          endEdit();
          selected = p;
          renderDetail();
        });
      });
      wrap.appendChild(grid);
    }
    const shown = rows.filter(matches);
    grid.rows = shown.map((r) => {
      const s = status(r);
      return { Purpose: r.purpose, What: known(r.purpose)?.label ?? '', Status: s.short, Long: s.long, Tone: s.tone, Folders: r.paths ? r.paths.length : -1 };
    });
    grid.setColumnVisible('What', !panel.open);
    if (selected) grid.select([selected]);
    wrap.querySelector('.grid-empty')?.remove();
    if (!shown.length) wrap.insertAdjacentHTML('beforeend', `<div class="grid-empty">Nothing matches “${esc(query)}”.</div>`);
  };

  const renderFoot = (): void => {
    const on = rows.filter((r) => r.restricted).length;
    const blocking = rows.filter((r) => r.restricted && r.paths && r.paths.length === 0).length;
    const folders = rows.reduce((n, r) => n + (r.paths?.length ?? 0), 0);
    $('#fs-foot').innerHTML = loaded && rows.length
      ? `<b>${rows.length}</b> folder limit${rows.length === 1 ? '' : 's'}<span class="meta-sep">·</span><b>${on}</b> enabled<span class="meta-sep">·</span><b>${folders}</b> folder${folders === 1 ? '' : 's'}${blocking ? `<span class="meta-sep">·</span><b>${blocking}</b> blocking all` : ''}`
      : '';
  };

  /* ── Detail ────────────────────────────────────────────── */

  const renderDetail = (): void => {
    if (editor) return;
    if (!selected) { setPanel(false); return; }
    const r = rowOf(selected);
    if (!r) { close(); return; }
    const s = status(r);
    const k = known(r.purpose);
    const paths = r.paths ?? [];
    detail.innerHTML = `
      <header class="detail-head">
        <div class="detail-title"><span class="detail-kicker">Folder limit · feature (purpose)</span><h2 class="mono">${esc(r.purpose)}</h2></div>
        <ev-icon-button icon="x" label="Close details" id="fs-close"></ev-icon-button>
      </header>
      <div class="detail-state">${chip(r.restricted ? 'Enabled' : 'Disabled', r.restricted ? 'success' : 'neutral')}${s.tone === 'danger' ? chip(s.short, 'danger') : ''}</div>
      <div class="detail-actions sec-actions">
        ${canChange ? `<button type="button" class="btn btn--sm" id="fs-edit"><ev-icon name="edit-2" size="xs"></ev-icon>Edit</button>
        ${!r.restricted && r.paths && !paths.length
          ? '<button type="button" class="link" id="fs-add-first">Add a folder first, then enable it →</button>'
          : `<button type="button" class="btn btn--sm" id="fs-toggle">${r.restricted ? 'Disable' : 'Enable'}</button>`}
        ${moreButton('fs-more', `More actions for ${r.purpose}`)}` : ''}
      </div>${canChange ? '' : `<p class="detail-note">${esc(NO_PRIV)}</p>`}
      <p class="sec-desc">${esc(k ? k.text : 'A custom feature name (purpose). It limits whatever code checks it by this name; IRIS’s own features don’t use it.')}</p>
      ${s.tone === 'danger' ? callout('danger', 'This blocks every folder', 'The limit is on but allows no folders, so the feature can’t open anything. Add a folder, or turn it off.')
        : r.restricted ? callout('info', s.long) : callout('info', 'Not limiting anything', esc(s.long))}
      <h3 class="detail-section">Allowed folders <span class="acc-count">${paths.length}</span></h3>
      ${paths.length ? `<ul class="fs-paths">${paths.map((p) => `<li><ev-icon name="folder" size="xs"></ev-icon><span class="mono">${esc(p.RootPath)}</span>${canChange ? `<button type="button" class="crud-icon-btn fs-remove" data-path="${esc(p.RootPath)}" aria-label="Remove ${esc(p.RootPath)}" title="Remove this folder"><ev-icon name="x" size="xs"></ev-icon></button>` : ''}</li>`).join('')}</ul>
`
        : `<p class="chip-list-empty">${r.paths === null ? 'Couldn’t load the folders' : '—'}</p>`}
      <h3 class="detail-section">How it works</h3>
      <dl class="kv-list">
        ${kv('When on', 'Only the listed folders, and everything under them')}
        ${kv('When off', 'Any folder the server process can reach')}
        ${kv('Who can change it', 'Holders of %Admin_FileSystemAccess')}
      </dl>
`;
    detail.querySelector('#fs-close')?.addEventListener('click', close);
    detail.querySelector('#fs-edit')?.addEventListener('click', () => openForm(r));
    detail.querySelector('#fs-toggle')?.addEventListener('click', () => void toggle(r));
    detail.querySelector('#fs-add-first')?.addEventListener('click', () => openForm(r));
    detail.querySelectorAll<HTMLButtonElement>('.fs-remove').forEach((b) => b.addEventListener('click', () => void removeOne(r, b.dataset.path ?? '')));
    const more = detail.querySelector<HTMLElement>('#fs-more');
    menu?.destroy(); menu = null;
    if (more) {
      menu = moreMenu(more, [
        { label: 'Delete folder limit…', icon: 'trash-2', danger: true, onSelect: () => void remove(r) },
      ]);
    }
    setPanel(true);
  };

  /* ── Actions ───────────────────────────────────────────── */

  async function toggle(r: Row): Promise<void> {
    const n = r.paths?.length ?? 0;
    const turningOn = !r.restricted;
    const label = known(r.purpose)?.label ?? r.purpose;
    const ok = await confirm({
      title: turningOn ? `Limit ${label} to ${n} folder${n === 1 ? '' : 's'}?` : `Stop limiting ${label}?`,
      body: turningOn
        ? `<p>From now on it can open only:</p><ul class="risk-list">${(r.paths ?? []).map((p) => `<li class="mono">${esc(p.RootPath)}</li>`).join('')}</ul><p>and everything inside ${n === 1 ? 'it' : 'them'}. Anything elsewhere is refused.</p>`
        : `<p>It will be able to open any folder the IRIS server process can reach. The folder list is kept, so you can turn the limit back on later.</p>`,
      confirmLabel: turningOn ? 'Enable' : 'Disable',
      danger: !turningOn,
    });
    if (!ok) return;
    try {
      await setPurpose(r.purpose, turningOn);
      toast(turningOn ? `${label} is now limited to ${n} folder${n === 1 ? '' : 's'}.` : `${label} is no longer limited.`, turningOn ? 'success' : 'warning');
      await load();
    } catch (err) { toast(errorText(err), 'danger'); }
  }

  async function removeOne(r: Row, path: string): Promise<void> {
    const last = (r.paths?.length ?? 0) === 1;
    const ok = await confirm({
      title: `Remove ${path}?`,
      body: `<p>${r.restricted
        ? last ? 'This is the only allowed folder, so the feature would be blocked from every folder. To stop limiting it instead, turn the limit off.' : 'The feature will no longer be able to open files in this folder.'
        : 'The limit is off, so this changes nothing until it’s turned on.'}</p>`,
      confirmLabel: 'Remove folder',
      danger: r.restricted,
      alternative: r.restricted && last ? { label: 'Disable instead', onSelect: () => void toggle(r) } : undefined,
    });
    if (!ok) return;
    try {
      await removePath(r.purpose, path);
      toast(`Removed ${path} from ${r.purpose}.`);
      await load();
    } catch (err) { toast(errorText(err), 'danger'); }
  }

  async function remove(r: Row): Promise<void> {
    const n = r.paths?.length ?? 0;
    const ok = await confirm({
      title: `Delete ${r.purpose}?`,
      body: `<p>Removes the limit and its ${n} folder${n === 1 ? '' : 's'}.${r.restricted ? ' The feature it controls is no longer limited: it can open any folder the server process can reach.' : ' It’s off now, so nothing changes today.'}</p><p>This can’t be undone.</p>`,
      confirmLabel: 'Delete folder limit',
      danger: true,
      typeToConfirm: r.restricted ? r.purpose : undefined,
      alternative: r.restricted ? { label: 'Disable instead', onSelect: () => void toggle(r) } : undefined,
    });
    if (!ok) return;
    try {
      await deletePurpose(r.purpose);
      toast(`Folder limit for ${r.purpose} deleted.`);
      close();
      await load();
    } catch (err) { toast(errorText(err), 'danger'); }
  }

  /* ── Create / edit ─────────────────────────────────────── */

  function openForm(r: Row | null, preset = ''): void {
    if (!canChange) return;
    endEdit();
    menu?.destroy(); menu = null;
    if (!r) { selected = null; grid?.select([]); }
    setPanel(true);
    restoreWidth = panelWidth(panel, EDIT_WIDTH);
    ctx.beforeLeave(() => guard());
    const isCreate = !r;
    const current = (r?.paths ?? []).map((p) => p.RootPath);
    const known1 = preset ? known(preset) : undefined;
    /** Set once the purpose exists, so a retry after a folder error doesn't try to create it again. */
    let createdName: string | null = null;
    editor = editorShell(detail, {
      title: r ? `Edit <span class="mono">${esc(r.purpose)}</span>` : 'New folder limit',
      name: r?.purpose ?? 'the new folder limit',
      submitLabel: r ? 'Save changes' : 'Create folder limit',
      startDirty: !!preset,
      sections: [
        isCreate ? section('Feature', `${selectField('PurposeKind', 'Feature to limit', [
          ...Object.entries(KNOWN_PURPOSES).map(([k, x]) => ({ value: k, label: `${x.label} (${k})` })),
          { value: OTHER, label: 'Other (for your own code)' },
        ], preset && !known(preset) ? OTHER : preset || GUI_FILE_SELECTOR, { required: true })}
          <div id="fs-other">${textField('Purpose', 'Name your code checks', preset && !known(preset) ? preset : '', { required: true, mono: true, maxlength: 64, hint: 'Can’t be changed later. IRIS’s own features don’t check custom names.' })}</div>
          <p class="crud-inline-note" id="fs-exists" hidden>A limit for this feature already exists. <button type="button" class="link" id="fs-open">Open it</button></p>
          <p class="preview-note" id="fs-known-text">${esc(known1?.text ?? known(GUI_FILE_SELECTOR)?.text ?? '')}</p>`) : '',
        section('Allowed folders', textareaField('Folders', 'Folders on the server, one per line', current.join('\n'), { rows: 5, mono: true, placeholder: 'C:\\InterSystems\\Backups\\', hint: 'Each folder allows everything inside it. Folders must already exist on the server.' })
          + '<p class="w-field-link" id="fs-add-folder-row" hidden><button type="button" class="link" id="fs-add-folder">Add folder…</button></p>'),
        section('Limit', checkField('Restricted', 'Enabled: allow only these folders', r?.restricted ?? false, { toggle: true, hint: 'Disabled keeps the list but limits nothing: the feature can open any folder the server can reach.' })),
        '<div id="fs-preview" class="preview" aria-live="polite"></div>',
      ].join(''),
      check: () => problems(),
      onCancel: () => { endEdit(); if (r) renderDetail(); else close(); },
      onSubmit: async (v) => submit(v),
    });
    const form = editor.form;
    // "Add folder…": the server file picker in folder mode, appending a line to the box (only when the OSCA file API answers).
    const addRow = form.querySelector<HTMLElement>('#fs-add-folder-row');
    void serverFilesAvailable().then((ok) => { if (addRow) addRow.hidden = !ok; }).catch(() => { /* no file API: typing only */ });
    form.querySelector('#fs-add-folder')?.addEventListener('click', () => {
      const box = form.querySelector('ev-textarea[name="Folders"]') as (HTMLElement & { value: string }) | null;
      const lines = parseFolders(String(box?.value ?? ''));
      void pickServerPath({ mode: 'dir', title: 'Choose a folder to allow', start: lines[lines.length - 1] }).then((p) => {
        if (!p || !box) return;
        if (!lines.some((l) => l.toLowerCase() === p.toLowerCase())) box.value = [...lines, p].join('\n');
        box.dispatchEvent(new Event('input', { bubbles: true }));
        editor?.refresh();
      });
    });
    const problems = (): FieldProblem[] => {
      const v = readForm(form);
      const out: FieldProblem[] = [];
      if (isCreate) {
        const n = purposeName(v);
        const other = v.PurposeKind === OTHER;
        const field = other ? 'Purpose' : 'PurposeKind';
        const exists = form.querySelector('#fs-exists') as HTMLElement | null;
        const hit = n && n !== createdName ? rows.find((x) => x.purpose === n) : undefined;
        if (exists) exists.hidden = !hit;
        if (!n) out.push({ field, label: other ? 'Name' : 'Feature', message: other ? 'Enter the name your code checks' : 'Choose a feature' });
        else if (n.length > 64) out.push({ field, label: 'Name', message: 'Use 64 characters or fewer' });
        else if (hit) out.push({ field, label: other ? 'Name' : 'Feature', message: 'A limit for this feature already exists' });
      }
      const folders = parseFolders(String(v.Folders ?? ''));
      if (folders.some((f) => f.length > 1024)) out.push({ field: 'Folders', label: 'Folders', message: 'A folder path can be at most 1,024 characters' });
      if (v.Restricted === true && !folders.length) out.push({ field: 'Folders', label: 'Folders', message: 'Add at least one folder, or turn the limit off: on with no folders blocks everything' });
      return out;
    };
    const preview = (): void => {
      const v = readForm(form);
      const folders = parseFolders(String(v.Folders ?? ''));
      const added = folders.filter((f) => !current.some((c) => samePath(c, f)));
      const removed = current.filter((c) => !folders.some((f) => samePath(c, f)));
      const on = v.Restricted === true;
      const lines: string[] = [];
      lines.push(on ? `The feature will open only <b>${folders.length}</b> folder${folders.length === 1 ? '' : 's'} and what’s inside ${folders.length === 1 ? 'it' : 'them'}.` : 'Disabled: nothing is limited.');
      if (r && (added.length || removed.length)) lines.push(`${added.length ? `Adds ${added.length}` : ''}${added.length && removed.length ? ', ' : ''}${removed.length ? `removes ${removed.length}` : ''} folder${added.length + removed.length === 1 ? '' : 's'}.`);
      (form.querySelector('#fs-preview') as HTMLElement).innerHTML = lines.map((l) => `<p class="preview-line">${l}</p>`).join('');
    };
    const submit = async (v: ReturnType<typeof readForm>): Promise<void> => {
      const name = r?.purpose ?? purposeName(v);
      const folders = parseFolders(String(v.Folders ?? ''));
      const on = v.Restricted === true;
      if (isCreate) {
        // Creating would overwrite nothing, but a purpose that already exists would have its limit changed: check first.
        const clash = createdName !== name && (rows.some((x) => x.purpose === name) || await getPaths(name).then(() => true, (e: unknown) => !(e instanceof AdminError && e.status === 404)));
        if (clash) { fieldError(form, v.PurposeKind === OTHER ? 'Purpose' : 'PurposeKind', 'A limit for this feature already exists'); throw new Error('A limit for this feature already exists'); }
        if (on && name === GUI_FILE_SELECTOR) {
          const ok = await confirm({
            title: 'Limit the Management Portal file picker?',
            body: `<p>Everyone using the Management Portal will only be able to pick files in:</p><ul class="risk-list">${folders.map((f) => `<li class="mono">${esc(f)}</li>`).join('')}</ul>`,
            confirmLabel: 'Create and turn on',
          });
          if (!ok) throw new Error('Not created.');
        }
        if (createdName !== name) { await setPurpose(name, false); createdName = name; } // start off, so nothing is blocked while folders are added
      }
      const existing = createdName ? await getPaths(name).then((ps) => ps.map((p) => p.RootPath)).catch(() => [] as string[]) : [];
      const current2 = r ? current : existing;
      const problemsOut: string[] = [];
      // Add before removing, and switch the limit on last, so it never blocks more than intended in between.
      for (const f of folders.filter((x) => !current2.some((c) => samePath(c, x)))) {
        try { await addPath(name, f); } catch (err) { problemsOut.push(`${f}: ${errorText(err)}`); }
      }
      if (problemsOut.length) {
        fieldError(form, 'Folders', problemsOut[0]);
        const lead = problemsOut.length === 1 ? problemsOut[0] : `${problemsOut.length} folders couldn’t be added. First: ${problemsOut[0]}`;
        throw new Error(isCreate ? `${lead} The limit was created and is off; fix the folders and save again.` : lead);
      }
      for (const c of current2.filter((x) => !folders.some((f) => samePath(x, f)))) await removePath(name, c);
      if (isCreate ? on : on !== r?.restricted) await setPurpose(name, on);
      editor?.markClean();
      toast(isCreate ? `Folder limit for ${name} created${on ? ` and on: ${folders.length} folder${folders.length === 1 ? '' : 's'} allowed` : ' (off)'}.` : `Folder limit for ${name} saved.`);
      endEdit();
      selected = name;
      await load();
    };
    form.querySelector('#fs-open')?.addEventListener('click', () => {
      const n = purposeName(readForm(form));
      void guard().then((ok) => { if (ok) { endEdit(); selected = n; renderGrid(); renderDetail(); } });
    });
    const syncKind = (): void => {
      if (!isCreate) return;
      const v = readForm(form);
      const other = v.PurposeKind === OTHER;
      (form.querySelector('#fs-other') as HTMLElement).hidden = !other;
      const k = other ? undefined : known(String(v.PurposeKind ?? ''));
      (form.querySelector('#fs-known-text') as HTMLElement).textContent = k?.text ?? '';
    };
    for (const t of ['input', 'change', 'ev-input-input', 'ev-toggle-change', 'ev-select-change']) form.addEventListener(t, () => queueMicrotask(() => { syncKind(); preview(); }));
    syncKind();
    preview();
  }


  /* ── Loading ───────────────────────────────────────────── */

  const updated = liveIndicator(ctx, () => void load(), { live: false });
  async function load(): Promise<void> {
    try {
      const list: FsPurpose[] = await getPurposes();
      const paths = await Promise.all(list.map((p) => getPaths(p.Purpose).catch(() => null)));
      if (!alive) return;
      rows = list.map((p, i) => ({ purpose: p.Purpose, restricted: p.Restricted, paths: paths[i] })).sort((a, b) => a.purpose.localeCompare(b.purpose));
      loaded = true;
      updated(new Date());
      renderGrid();
      renderFoot();
      if (!editor) { if (selected && !rowOf(selected)) close(); else renderDetail(); }
    } catch (err) {
      grid = null;
      wrap.innerHTML = errorPanel(err, 'retry-fs');
      wrap.querySelector('#retry-fs')?.addEventListener('click', () => void load());
    }
  }

  $('#fs-search').addEventListener('ev-search-input', (e) => {
    query = (e as CustomEvent<{ value: string }>).detail.value.trim();
    renderGrid();
  });

  void load();
}
