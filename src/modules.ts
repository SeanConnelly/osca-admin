// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ScreenCtx } from './ui';
import { homeScreen } from './screens/home';
import { operationsScreen } from './screens/operations';
import { processesScreen } from './screens/processes';
import { alertsScreen } from './screens/alerts';
import { usersScreen } from './screens/users';
import { ldapScreen } from './screens/ldap';
import { rolesScreen } from './screens/roles';
import { resourcesScreen } from './screens/resources';
import { sqlPrivilegesScreen } from './screens/sql-privileges';
import { fsAccessScreen } from './screens/fs-access';
import { encryptionScreen } from './screens/encryption';
import { mftScreen } from './screens/mft';
import { capacityScreen } from './screens/capacity';
import { apiExplorerScreen } from './screens/api-explorer';
import { docDbScreen } from './screens/docdb';
import { privRoutinesScreen } from './screens/priv-routines';
import { scheduleScreen } from './screens/schedule';
import { licenseScreen } from './screens/license';
import { wqmScreen } from './screens/wqm';
import { locksScreen } from './screens/locks';
import { webSessionsScreen } from './screens/web-sessions';
import { jobsScreen } from './screens/jobs';
import { langServersScreen } from './screens/lang-servers';
import { devicesScreen } from './screens/devices';
import { ecpScreen } from './screens/ecp';
import { databasesScreen } from './screens/databases';
import { namespacesScreen } from './screens/namespaces';
import { journalsScreen } from './screens/journals';
import { servicesScreen } from './screens/services';
import { superserversScreen } from './screens/superservers';
import { walletScreen } from './screens/wallet';
import { certificatesScreen } from './screens/certificates';
import { oauthScreen } from './screens/oauth';
import { webAppsScreen } from './screens/webapps';
import { tasksScreen } from './screens/tasks';
import { taskHistoryScreen } from './screens/task-history';
import { auditScreen } from './screens/audit';
import { messagesLogScreen } from './screens/messages-log';

export interface SubItem {
  key: string;
  label: string;
  /** One line under the page title: what this screen is for. */
  /** One line under the page title, if a screen needs it (help lives in help.ts). */
  description?: string;
  count?: number;
  /** Starts a labelled group within its section's menu (e.g. "Connections"). */
  group?: string;
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

/**
 * The single navigation tree. Groups are ordered by how often an admin
 * reaches for them; items within a group run from routine to rare.
 */
export const MODULES: Module[] = [
  {
    key: 'home', label: 'Home', icon: 'house',
    nav: [{ key: 'overview', label: 'Overview', screen: homeScreen }],
  },
  {
    key: 'operations', label: 'Operations', icon: 'activity',
    nav: [
      { key: 'overview', label: 'Activity', screen: operationsScreen },
      { key: 'processes', label: 'Processes', screen: processesScreen },
      { key: 'locks', label: 'Locks', screen: locksScreen },
      { key: 'journals', label: 'Journals', screen: journalsScreen },
      { key: 'sessions', label: 'Web sessions', screen: webSessionsScreen },
      { key: 'jobs', label: 'Background jobs', screen: jobsScreen },
      { key: 'langservers', label: 'Language servers', screen: langServersScreen },
      { key: 'devices', label: 'Devices', screen: devicesScreen },
      { key: 'ecp', label: 'ECP', screen: ecpScreen },
    ],
  },
  {
    key: 'tasks', label: 'Tasks', icon: 'calendar-clock',
    nav: [
      { key: 'upcoming', label: 'Upcoming', screen: tasksScreen },
      { key: 'history', label: 'History', screen: taskHistoryScreen },
      { key: 'schedule', label: 'Schedule', screen: scheduleScreen },
    ],
  },
  {
    key: 'logs', label: 'Logs', icon: 'scroll-text',
    nav: [
      { key: 'alerts', label: 'Alerts & errors', screen: alertsScreen },
      { key: 'audit', label: 'Audit log', screen: auditScreen },
      { key: 'messages', label: 'Messages log', screen: messagesLogScreen },
    ],
  },
  {
    key: 'web', label: 'Web & APIs', icon: 'globe',
    nav: [
      { key: 'apps', label: 'Web applications', screen: webAppsScreen },
      { key: 'explorer', label: 'API explorer', screen: apiExplorerScreen },
      { key: 'docdb', label: 'DocDB applications', screen: docDbScreen },
      { key: 'privroutine', label: 'Privileged routine apps', screen: privRoutinesScreen },
    ],
  },
  {
    key: 'security', label: 'Security', icon: 'shield',
    nav: [
      // Grouped as access control, connections and data protection.
      { key: 'users', label: 'Users', group: 'Access control', screen: usersScreen },
      { key: 'roles', label: 'Roles', screen: rolesScreen },
      { key: 'resources', label: 'Resources', screen: resourcesScreen },
      { key: 'sqlpriv', label: 'SQL privileges', screen: sqlPrivilegesScreen },
      { key: 'ldap', label: 'LDAP', screen: ldapScreen },
      { key: 'services', label: 'Services', group: 'Connections', screen: servicesScreen },
      { key: 'superservers', label: 'Superservers', screen: superserversScreen },
      { key: 'certs', label: 'Certificates & TLS', screen: certificatesScreen },
      { key: 'oauth', label: 'OAuth 2.0', screen: oauthScreen },
      { key: 'mft', label: 'Managed file transfer', screen: mftScreen },
      { key: 'encryption', label: 'Encryption', group: 'Data protection', screen: encryptionScreen },
      { key: 'wallet', label: 'Secrets wallet', screen: walletScreen },
      { key: 'fsaccess', label: 'Filesystem access', screen: fsAccessScreen },
    ],
  },
  {
    key: 'databases', label: 'Databases', icon: 'database',
    nav: [
      { key: 'namespaces', label: 'Namespaces', screen: namespacesScreen },
      { key: 'databases', label: 'Databases', screen: databasesScreen },
      { key: 'capacity', label: 'Capacity', screen: capacityScreen },
    ],
  },
  {
    key: 'settings', label: 'Settings', icon: 'settings',
    nav: [
      { key: 'license', label: 'License', screen: licenseScreen },
      { key: 'wqm', label: 'Work queue categories', screen: wqmScreen },
    ],
  },
];
