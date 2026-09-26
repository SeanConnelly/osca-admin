import * as api from './api';
import type { ScreenCtx } from './ui';
import { homeScreen } from './screens/home';
import { operationsScreen } from './screens/operations';
import { processesScreen } from './screens/processes';
import { alertsScreen } from './screens/alerts';

export interface SubItem {
  key: string;
  label: string;
  /** One line under the page title: what this screen is for. */
  description?: string;
  count?: number;
  /** Legacy body-only renderer (stubs and not-yet-rebuilt screens). */
  render?: (el: HTMLElement) => void | Promise<void>;
  /** Full screen: owns its body and header actions, registers cleanup. */
  screen?: (ctx: ScreenCtx) => void;
}

export interface Module {
  key: string;
  label: string;
  icon: string;
  nav: SubItem[];
}

function loading(el: HTMLElement): void {
  el.innerHTML = `<div class="load-note">Loading…</div>`;
}
function failed(el: HTMLElement, err: unknown): void {
  el.innerHTML = `<div class="error-note">${err instanceof Error ? err.message : String(err)}</div>`;
}
function badge(on: boolean): string {
  return on
    ? `<span class="badge on"><span></span>Enabled</span>`
    : `<span class="badge off"><span></span>Disabled</span>`;
}

function stub(endpoint: string, desc: string): (el: HTMLElement) => void {
  return (el) => {
    el.innerHTML = `<div class="stub">
      <span class="tag">Wireframe stub · endpoint ready</span>
      <h3>Screen not built yet</h3>
      <p>${desc}</p>
      <span class="ep">${endpoint}</span>
    </div>`;
  };
}

async function usersView(el: HTMLElement): Promise<void> {
  loading(el);
  try {
    const rows = await api.getUsers();
    el.innerHTML = `<div class="card">
      <div class="hd"><h3>Users</h3><span class="hint">GET /api/admin/v2/security/users</span></div>
      <table class="portal-table">
        <tr><th>Name</th><th>Full name</th><th>Type</th><th>Status</th></tr>
        ${rows.map((r) => `<tr><td class="mono">${r.Name}</td><td>${r.FullName}</td><td>${r.Type}</td><td>${badge(r.Enabled)}</td></tr>`).join('')}
      </table>
    </div>`;
  } catch (err) { failed(el, err); }
}

async function webAppsView(el: HTMLElement): Promise<void> {
  loading(el);
  try {
    const rows = await api.getWebApps();
    el.innerHTML = `<div class="card">
      <div class="hd"><h3>Web applications</h3><span class="hint">GET /api/admin/v2/web-apps · ${rows.length} total</span></div>
      <table class="portal-table">
        <tr><th>Path</th><th>Dispatch class</th><th>Namespace</th><th>Status</th></tr>
        ${rows.map((r) => `<tr><td class="mono">${r.Name}</td><td class="mono">${r.DispatchClass}</td><td class="mono">${r.Namespace}</td><td>${badge(r.Enabled)}</td></tr>`).join('')}
      </table>
    </div>`;
  } catch (err) { failed(el, err); }
}


async function tasksView(el: HTMLElement): Promise<void> {
  loading(el);
  try {
    const rows = await api.getUpcomingTasks();
    el.innerHTML = `<div class="card">
      <div class="hd"><h3>Upcoming tasks</h3><span class="hint">GET /api/admin/v2/task/upcoming · ${rows.length} scheduled</span></div>
      <table class="portal-table">
        <tr><th>Task</th><th>Namespace</th><th>Next run</th></tr>
        ${rows.map((r) => `<tr><td>${r.Name}</td><td class="mono">${r.Namespace}</td><td class="mono">${r.Datetime}</td></tr>`).join('')}
      </table>
    </div>`;
  } catch (err) { failed(el, err); }
}

async function namespacesView(el: HTMLElement): Promise<void> {
  loading(el);
  try {
    const rows = await api.getNamespaces();
    el.innerHTML = `<div class="card">
      <div class="hd"><h3>Namespaces</h3><span class="hint">GET /api/admin/v2/namespaces</span></div>
      <table class="portal-table">
        <tr><th>Name</th></tr>
        ${rows.map((r) => `<tr><td class="mono">${r.Name}</td></tr>`).join('')}
      </table>
    </div>`;
  } catch (err) { failed(el, err); }
}




/**
 * The single navigation tree. Groups are ordered by how often an admin
 * reaches for them; items within a group run from routine to rare.
 */
export const MODULES: Module[] = [
  {
    key: 'home', label: 'Home', icon: 'info',
    nav: [{ key: 'overview', label: 'Overview', screen: homeScreen }],
  },
  {
    key: 'operations', label: 'Operations', icon: 'cpu',
    nav: [
      { key: 'overview', label: 'Activity', description: 'How hard the instance is working, now and over the last five minutes.', screen: operationsScreen },
      { key: 'processes', label: 'Processes', description: 'Every process running on the instance. Select one for its details.', screen: processesScreen },
      { key: 'locks', label: 'Locks', render: stub('/api/admin/v2/locks', 'Live lock table with holder, waiters and resource.') },
      { key: 'journals', label: 'Journals', render: stub('/api/admin/v2/journal/files', 'Journal files, switch controls and integrity checks.') },
      { key: 'sessions', label: 'Web sessions', render: stub('/api/admin/v2/web-sessions', 'Active CSP/REST sessions with terminate action.') },
      { key: 'jobs', label: 'Background jobs', render: stub('/api/admin/v2/async-results', 'Long-running admin operations you triggered — track, cancel, pause, resume.') },
      { key: 'langservers', label: 'Language servers', render: stub('/api/admin/v2/ext-lang-servers', 'Python / embedded-language gateway processes — start, stop, activity.') },
      { key: 'devices', label: 'Devices', render: stub('/api/admin/v2/devices', 'Device & device-subtype configuration (telnet/serial I/O).') },
      { key: 'ecp', label: 'ECP', render: stub('/api/admin/v2/ecp/settings', 'Distributed-cache connections between application and data servers.') },
    ],
  },
  {
    key: 'tasks', label: 'Tasks', icon: 'calendar',
    nav: [
      { key: 'upcoming', label: 'Upcoming', render: tasksView },
      { key: 'history', label: 'History', render: stub('/api/admin/v2/task/history', 'Run history with status, duration and output per task.') },
      { key: 'schedule', label: 'Schedule', render: stub('/api/admin/v2/task/manager', 'Recurring schedule editor.') },
      { key: 'new', label: 'New task', render: stub('/api/admin/v2/task/manager/run', 'Guided task creation.') },
    ],
  },
  {
    key: 'logs', label: 'Logs', icon: 'file-text',
    nav: [
      { key: 'alerts', label: 'Alerts & errors', description: 'Alerts IRIS has raised about its own health.', screen: alertsScreen },
      { key: 'audit', label: 'Audit log', render: stub('/api/admin/v2/security/audit/records', 'Searchable audit-record browser with export; event configuration alongside.') },
    ],
  },
  {
    key: 'web', label: 'Web & APIs', icon: 'globe',
    nav: [
      { key: 'apps', label: 'Web applications', render: webAppsView },
      { key: 'explorer', label: 'API explorer', render: stub('/api/mgmnt/v1/%25SYS/spec/{app}', 'Embedded Swagger-style browser fed by the live discovery endpoint.') },
      { key: 'docdb', label: 'DocDB applications', render: stub('/api/admin/v2/doc-dbs', 'Native document-database applications.') },
      { key: 'privroutine', label: 'Privileged routine apps', render: stub('/api/admin/v2/security/privileged-routines', 'Routine-based applications granted privileged execution.') },
    ],
  },
  {
    key: 'security', label: 'Security', icon: 'key-round',
    nav: [
      { key: 'users', label: 'Users', render: usersView },
      { key: 'roles', label: 'Roles', render: stub('/api/admin/v2/security/roles', 'Role definitions and their assigned resources.') },
      { key: 'resources', label: 'Resources', render: stub('/api/admin/v2/security/resources', 'Security resources and their public/protected state.') },
      { key: 'sqlpriv', label: 'SQL privileges', render: stub('/api/admin/v2/security/sql-privileges', 'Table, column and admin-level SQL grants.') },
      { key: 'wallet', label: 'Secrets wallet', render: stub('/api/admin/v2/wallet/secrets', 'Credential vault — masked by default, explicit reveal.') },
      { key: 'certs', label: 'Certificates & TLS', render: stub('/api/admin/v2/security/x509-credentials', 'X.509 credentials and SSL/TLS configurations.') },
      { key: 'oauth', label: 'OAuth 2.0', render: stub('/api/admin/v2/security/oauth2', 'Client, server and resource-server configuration.') },
      { key: 'services', label: 'Services', render: stub('/api/admin/v2/security/services', '%Service_* bindings — enable/disable, allowed IPs.') },
      { key: 'fsaccess', label: 'Filesystem access', render: stub('/api/admin/v2/fs-access-purposes', 'Which OS paths IRIS processes may touch.') },
      { key: 'encryption', label: 'Encryption', render: stub('/api/admin/v2/security/encryption', 'Key files, database encryption, data-element encryption.') },
      { key: 'superservers', label: 'Superservers', render: stub('/api/admin/v2/security/superservers', 'Superserver port bindings and SSL.') },
      { key: 'mft', label: 'Managed file transfer', render: stub('/api/admin/v2/security/mft/connections', 'Managed file-transfer connections.') },
    ],
  },
  {
    key: 'databases', label: 'Databases', icon: 'archive',
    nav: [
      { key: 'namespaces', label: 'Namespaces', render: namespacesView },
      { key: 'databases', label: 'Databases', render: stub('/api/admin/v2/databases', 'Config.Databases entries.') },
      { key: 'local', label: 'Local databases', render: stub('/api/admin/v2/database-dirs', 'Mount, dismount, compact, defragment, truncate, integrity check, expand.') },
      { key: 'capacity', label: 'Capacity', render: stub('/api/monitor/metrics', 'Per-database size / free-space / % full — from %Api.Monitor, not %Api.Admin.') },
    ],
  },
  {
    key: 'settings', label: 'Settings', icon: 'settings',
    nav: [
      { key: 'license', label: 'License', render: stub('/api/admin/v2/license/key', 'License key and license servers.') },
      { key: 'wqm', label: 'Work queue categories', render: stub('/api/admin/v2/wqm-categories', 'Parallel work-queue tuning.') },
    ],
  },
];
