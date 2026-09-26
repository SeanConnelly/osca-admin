/**
 * Logs › Alerts & errors — system alerts IRIS has raised.
 *
 * IRIS's alert feed is read-once (iris_system_alerts_new: "alerts posted since
 * the last time the Alerts API was read"), so the portal keeps every alert it
 * receives. Alerts delivered before that can't be recovered through any API;
 * when that's the case the screen says so and points at alerts.log.
 */
import { alerts, severity } from '../alerts';
import { metrics, value, samples } from '../metrics';
import type { Alert } from '../api';
import { esc, relative, chip, cell, liveIndicator, type ScreenCtx } from '../ui';
import type { DataGridColumn, DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';

type Filter = 'all' | 'danger' | 'warning' | 'info';

const COLUMNS: DataGridColumn[] = [
  { key: 'time', label: 'When', width: '130px', sortable: true, renderCell: (v) => {
    const d = new Date(String(v));
    return cell.text(relative(d), d.toLocaleString());
  } },
  { key: 'severity', label: 'Severity', width: '100px', sortable: true, renderCell: (v) => { const s = severity(String(v)); return chip(s.label, s.tone); } },
  { key: 'source', label: 'Source', width: '140px', sortable: true, renderCell: (v) => (v ? cell.mono(v) : cell.dim('—')) },
  { key: 'message', label: 'Message', renderCell: (v) => cell.wrap(String(v)) },
];

/** "ISCLOG: apimgmnt [Class:Error] …" → source "apimgmnt", message "…". */
function split(a: Alert): { source: string; message: string } {
  const m = /^(?:ISCLOG:\s*)?([\w.%-]+)\s+\[[^\]]*\]\s*(.*)$/.exec(a.message);
  return m ? { source: m[1], message: m[2] } : { source: '', message: a.message };
}

export function alertsScreen(ctx: ScreenCtx): void {
  ctx.body.innerHTML = `
    <div class="toolbar-row">
      <ev-segmented-button id="alert-filter" size="sm"></ev-segmented-button>
      <div class="toolbar-spacer"></div>
      <span class="summary" id="alert-summary"></span>
      <button type="button" class="btn btn--sm btn--quiet" id="alert-clear" hidden>Clear list</button>
    </div>
    <div class="grid-card" id="alert-wrap"></div>`;

  const filterEl = ctx.body.querySelector('#alert-filter') as HTMLElement & { options: unknown; value: string };
  filterEl.value = 'all';
  const clearBtn = ctx.body.querySelector('#alert-clear') as HTMLButtonElement;
  const wrap = ctx.body.querySelector('#alert-wrap') as HTMLElement;
  let filter: Filter = 'all';
  let list: Alert[] = [];
  let sinceStartup = NaN;
  let logDir = '';

  const render = (): void => {
    const count = (f: Filter): number => list.filter((a) => f === 'all' || severity(a.severity).tone === f).length;
    filterEl.options = (['all', 'danger', 'warning', 'info'] as Filter[]).map((f) => ({
      value: f,
      label: `${{ all: 'All', danger: 'Severe', warning: 'Warning', info: 'Info' }[f]} ${count(f)}`,
      disabled: f !== 'all' && count(f) === 0,
    }));
    // Nothing to filter or clear until the portal holds alerts; with none, the
    // explanation below carries the count instead of a row of zeros.
    const held = list.length > 0;
    (ctx.body.querySelector('.toolbar-row') as HTMLElement).hidden = !held;
    clearBtn.hidden = !held;
    (ctx.body.querySelector('#alert-summary') as HTMLElement).innerHTML = held && Number.isFinite(sinceStartup)
      ? `<b>${sinceStartup}</b> raised since IRIS started`
      : '';

    const shown = list.filter((a) => filter === 'all' || severity(a.severity).tone === filter);
    if (shown.length > 0) {
      let grid = wrap.querySelector('ev-data-grid') as (HTMLElement & { columns: DataGridColumn[]; rows: DataGridRow[] }) | null;
      if (!grid) {
        wrap.innerHTML = '';
        grid = document.createElement('ev-data-grid') as HTMLElement & { columns: DataGridColumn[]; rows: DataGridRow[] };
        grid.setAttribute('compact', '');
        grid.setAttribute('row-key', 'id');
        grid.setAttribute('sort-column', 'time');
        grid.setAttribute('sort-direction', 'desc');
        grid.columns = COLUMNS;
        wrap.appendChild(grid);
      }
      grid.rows = shown.map((a) => ({ id: a.time + a.message, time: a.time, severity: a.severity, ...split(a) }));
      return;
    }

    const missed = Number.isFinite(sinceStartup) ? sinceStartup - list.length : 0;
    const where = logDir ? `<code class="path">${esc(logDir)}alerts.log</code>` : 'alerts.log in the instance’s mgr directory';
    wrap.innerHTML = missed > 0 && list.length === 0
      ? `<div class="empty">
          <div class="empty-main">
            <ev-icon name="info" size="md"></ev-icon>
            <div class="empty-text">
              <strong>IRIS has raised ${missed} alert${missed === 1 ? '' : 's'} since it started — ${missed === 1 ? 'it' : 'they'} can’t be shown here</strong>
              <span class="lead">${missed === 1 ? 'It is' : 'They are'} recorded in ${where}.</span>
              <span>IRIS delivers each alert once, and ${missed === 1 ? 'this one was' : 'these were'} delivered before the portal started keeping them. New alerts appear here within 30 seconds.</span>
            </div>
          </div>
          ${logDir ? `<button type="button" class="btn btn--sm" id="copy-path"><ev-icon name="copy" size="xs"></ev-icon>Copy path</button>` : ''}
        </div>`
      : `<div class="empty">
          <ev-icon name="check-circle" size="md"></ev-icon>
          <div class="empty-text">
            <strong>${list.length === 0 ? 'No alerts' : 'No alerts at this severity'}</strong>
            <span>${list.length === 0 ? 'IRIS hasn’t raised an alert since it started. New alerts appear here within 30 seconds.' : 'Choose another severity to see the rest.'}</span>
          </div>
        </div>`;
    const copy = wrap.querySelector<HTMLButtonElement>('#copy-path');
    copy?.addEventListener('click', () => {
      void navigator.clipboard.writeText(`${logDir}alerts.log`).then(() => {
        copy.innerHTML = '<ev-icon name="check" size="xs"></ev-icon>Copied';
        setTimeout(() => { copy.innerHTML = '<ev-icon name="copy" size="xs"></ev-icon>Copy path'; }, 1600);
      });
    });
  };

  filterEl.addEventListener('ev-segmented-button-change', (e) => { filter = (e as CustomEvent<{ value: Filter }>).detail.value; render(); });
  clearBtn.addEventListener('click', () => alerts.clear());

  const updated = liveIndicator(ctx, () => { void alerts.refresh(); void metrics.refresh(); });
  ctx.onLeave(alerts.subscribe((l) => { list = l; render(); }));
  ctx.onLeave(metrics.subscribe((snap, at) => {
    updated(at);
    sinceStartup = value(snap, 'iris_system_alerts');
    // The IRISSYS database lives in the mgr directory, which is where alerts.log is.
    logDir = samples(snap, 'iris_db_size_mb').find((s) => s.labels.id === 'IRISSYS')?.labels.dir ?? '';
    render();
  }));
}
