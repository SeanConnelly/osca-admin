// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Page help, shown when the user presses the ? beside a page title. Replaces
 * always-on subtitles: the page itself should be self-explanatory, and help is
 * for the "what am I looking at, and what should I watch for" questions.
 *
 * Each entry: a one-line lead, then a few "good to know" points. Plain
 * English, no implementation details (no API paths, class names or verbs).
 */
import { modelLine, EXT_ICON } from './ui';

const DOCS = 'https://docs.intersystems.com/irislatest/csp/docbook/DocBook.UI.Page.cls?KEY=';
const h = (lead: string, points: string[] = [], docsKey?: string): string =>
  `<p class="help-lead">${lead}</p>${points.length ? `<ul>${points.map((p) => `<li>${p}</li>`).join('')}</ul>` : ''}` +
  (docsKey ? `<a class="help-more" href="${DOCS}${docsKey}" target="_blank" rel="noopener">Learn more in the InterSystems documentation${EXT_ICON}</a>` : '');

/**
 * The Security section map, shown in the help of every Security screen:
 * how someone gets in, who they are, what they hold, and what that protects —
 * with this screen highlighted and every step a link to its screen.
 */
type Stage = 'in' | 'who' | 'roles' | 'res' | 'data';
const securityMap = (here: Stage): string => modelLine([
  { label: 'Connections', sub: 'services · ports · TLS · OAuth', route: 'security/services', here: here === 'in' },
  { label: 'Users', sub: 'who signs in', route: 'security/users', here: here === 'who' },
  { label: 'Roles', sub: 'bundles of permissions', route: 'security/roles', here: here === 'roles' },
  { label: 'Resources', sub: 'Read · Read & change · Use', route: 'security/resources', here: here === 'res' },
  { label: 'Protected data', sub: 'databases · SQL tables · secrets · keys', route: 'security/encryption', here: here === 'data' },
], ['sign in as', 'hold', 'grant', 'protect']);

export const HELP: Record<string, string> = {
  'operations/overview': h('How hard this instance is working: CPU, memory, database activity and storage, now and over the last five minutes.', [
    '<b>System CPU</b> is the whole machine, not just IRIS. Compare it with IRIS’s own share on the Processes page.',
    'Rates are averaged over 20 seconds, so a short spike shows up smoothed.',
    'The portal’s own monitoring costs a little work each time it refreshes; the figure is shown so you can discount it.',
  ], 'GCM_dashboard'),
  'operations/processes': h('Every process running inside IRIS. Select one to see what it’s doing right now, who it runs as, and what it holds.', [
    'The panel refreshes every 5 seconds while it’s open: the current line and last global, live CPU, global and journal activity, roles (escalated ones in amber), locks, devices and memory.',
    'Variables are hidden until you choose Show. They can hold passwords and tokens, and values are cleared when you close the panel.',
    'Suspend, Resume, Send message and Terminate are in the panel. Terminating rolls back any open transaction and releases its locks; IRIS’s own processes need their PID typed to confirm.',
  ], 'GCM_dashboard'),
  'tasks/upcoming': h('Every scheduled task, soonest first, with its schedule in plain English and how its last run went.', [
    '<b>Run now</b> queues a task; the Task Manager starts it within about a minute. <b>Suspend</b> keeps the schedule but stops runs until you resume it. Schedules are changed on Tasks › Schedule.',
    'Suspended tasks don’t run until someone resumes them.',
    'If the Task Manager itself isn’t running, nothing on this list will run.',
  ], 'GSA_manage_taskmgr'),
  'tasks/history': h('Every task run IRIS still remembers, and how it ended. Switch to <b>By task</b> for each task’s track record.', [
    'IRIS keeps task history for a limited number of days, then purges it.',
    '<b>Task Manager log</b> shows the scheduler’s own housekeeping, such as tasks being created or changed.',
  ], 'GSA_manage_taskmgr'),
  'logs/alerts': h('Alerts IRIS has raised about its own health, such as low disk space, journal problems or a hung process.', [
    'IRIS hands each alert over only once. The portal keeps the ones it has received so you can review them here.',
    'Alerts raised while the portal wasn’t open are counted, but their details live only in the instance’s alerts log.',
  ], 'GCM_healthmon'),
  'logs/audit': h('Whether IRIS is keeping an audit trail, what it has recorded, and how often each kind of security event happens.', [
    'An event is only written to the log when auditing is on <em>and</em> that event is enabled.',
    '<b>Happened</b> counts events even when they aren’t being recorded, which shows you what you’re missing.',
    'Viewing or searching the audit log is itself an audited event.',
  ], 'AAUDIT'),
  'logs/messages': h('What IRIS writes to its console log: startup and shutdown, journal switches, database mounts, warnings and errors, newest first.', [
    'Search and the level filter look through the whole log, not only the lines shown. <b>Load older</b> goes further back.',
    'Each line has a level: information, warning, severe or fatal. Severe lines also raise alerts.',
    'Lines that follow an entry, such as a stack or a startup banner, are shown as part of that entry.',
  ], 'GCM_monitor'),
  'web/apps': h('Every web application and REST API this instance serves, and how each one lets callers in.', [
    '<b>Disabling</b> an application makes IRIS refuse every request to its path; its settings are kept. IRIS’s own applications can be disabled but not deleted.',
    'An app that allows <b>No sign-in</b> (IRIS calls it Unauthenticated) runs anonymous requests as the UnknownUser account, with whatever that account can do.',
    'An app can require a resource: only users holding it can use the app.',
    'Application roles are added to a user’s roles for as long as they use that app.',
  ], 'GSA_manage_applications'),
  'security/users': securityMap('who') + h('A user can do exactly what their roles allow — nothing is ever granted to a user directly.', [
    'Everyone also gets the roles of the special <b>_PUBLIC</b> account, and every resource set to <b>Everyone · Use</b>.',
    'Role changes take effect the next time the user signs in.',
    '<b>UnknownUser</b> is the account anonymous requests run as. Its roles decide what anyone can do without signing in.',
    'Built-in accounts are created by IRIS at installation; think twice before changing them.',
  ], 'GSA_config_user_accounts'),
  'security/roles': securityMap('roles') + h('A role is a bundle of permissions. Give someone a role and they can do everything it allows.', [
    'A role can include other roles; whoever holds it gets theirs too.',
    'Access only ever adds up: there is no way to deny something another role grants.',
    'Built-in roles (starting with %) can’t be changed. Copy one to make your own version.',
    '<b>%All</b> grants everything. Keep the list of people who hold it short.',
  ], 'GSA_config_roles'),
  'security/resources': securityMap('res') + h('A resource is a lock on something: a database, a way in (such as SQL or the Terminal), an application or an admin tool.', [
    '<b>Read</b> and <b>Write</b> apply to databases; <b>Use</b> applies to everything else.',
    '<b>Everyone · Use</b> (IRIS calls it public access) means every user has it, including anonymous callers — use it sparingly.',
    'To open a namespace, a user needs Read on its databases.',
  ], 'GSA_using_resources'),
  'security/wallet': securityMap('data') + h('Collections hold secrets, such as passwords, API keys and encryption keys, kept encrypted inside IRIS.', [
    '<b>How it fits together:</b> a user holds roles, roles grant a permission on a resource, and that permission unlocks a collection. Each collection names one resource and permission for using its secrets and another for changing them, and IRIS checks exactly that permission each time.',
    'On a database resource the permission is Read or Read &amp; change; on any other resource it is Use. Wallet administrators (Use on %Admin_Wallet) and %All holders always pass, and roles a web app adds count while code runs inside it.',
    'Values can be set or replaced, never read back.',
  ], 'ROARS_secrets_mgmt'),
  'security/certs': securityMap('in') + h('TLS configurations and the certificates they use.', [
    '<b>How it fits together:</b> a connection uses a TLS configuration, which sets its protocols and ciphers, checks the other side’s certificate, and presents this side’s own certificate. A client that doesn’t verify the server is flagged.',
    '<b>Test connection</b> shows what a client configuration agrees with a server, and changes nothing.',
    'X.509 credentials store certificates and keys under an alias. Expired ones are flagged, and ones expiring within 30 days get a warning.',
  ], 'ATLS'),
  'security/oauth': securityMap('in') + h('OAuth 2.0 lets people sign in with tokens.', [
    '<b>How it fits together:</b> an app or user signs in at an authorization server (the issuer), which issues a token; IRIS checks the token over TLS, as a client or as a resource server, and the token’s user gets their IRIS roles.',
    'Create an issuer first (it needs a client TLS configuration), then clients or resource servers.',
    'Setting IRIS up as an authorization server is done in the Management Portal. Client secrets are write-only.',
  ], 'ROARS_iam_oauth'),
  'security/ldap': securityMap('who') + h('An LDAP configuration lets people sign in with their company directory account (LDAP or Active Directory) instead of a password kept in IRIS.', [
    '<b>How it fits together:</b> someone signs in as <b>user@domain</b>; the domain picks the configuration, IRIS looks them up with its search account, checks their password with the directory, and gives them the roles their directory groups (or roles attribute) name.',
    'Nobody can sign in this way unless LDAP sign-in is allowed for the instance and on the service they connect through, such as the Web Gateway or SQL.',
    'Turn TLS on: without it, passwords cross the network to the directory unencrypted.',
    'The first time someone signs in, IRIS creates an LDAP user for them. Their roles are taken from the directory again at every sign-in.',
  ], 'ROARS_iam_ldap'),
  'security/sqlpriv': securityMap('data') + h('SQL privileges decide which tables, views and procedures someone can use through SQL, and what they can do with them. Resources decide whether they can reach the database at all; SQL privileges decide which tables they can read or change once they’re there.', [
    'Both are needed: Use on the SQL service and Read on the namespace’s database (resources), then a grant on the table (SQL).',
    'Grant to roles, then give the role to people. Unlike resources, SQL privileges can also be granted to a user directly.',
    'Accounts with <b>%All</b> can do everything in SQL; specific grants make no difference to them.',
    'SQL privileges are checked for ODBC, JDBC, the SQL shell and dynamic SQL, not for embedded SQL in class code.',
  ], 'GSQL_privileges'),
  'security/fsaccess': securityMap('data') + h('Filesystem access rules limit which folders on the server a feature may open, such as the Management Portal’s file picker.', [
    'Each set of rules is a <b>purpose</b>. When it’s off it limits nothing; when it’s on, only its folders and everything inside them are allowed.',
    'A purpose that’s on with no folders blocks everything.',
    'Rules limit the feature, not people: they apply whoever is using it.',
  ], 'GSA_using_portal'),
  'security/encryption': securityMap('data') + h('Whether data is encrypted on disk, which keys are active, and what happens when IRIS restarts.', [
    '<b>How it fits together:</b> a key file on disk holds keys, locked by its administrators’ passwords; a key is activated from it into memory (until IRIS stops); the activated key encrypts databases, journal files and the audit log. Who can read the data inside IRIS is still decided by each database’s resource.',
    'At restart, keys are activated by no one (encrypted databases stay locked), by a person entering a password, or automatically. Automatic startup keeps the key and its password on the server.',
    'Encrypting databases while journal files and the audit log stay unencrypted leaves copies of the data unencrypted on disk.',
    'Keep copies of every key file and its passwords away from the server. A lost key can’t be re-created.',
  ], 'ROARS_encrypt'),
  'security/mft': securityMap('in') + h('Connections that let productions send and fetch files in Box, Dropbox or Kiteworks.', [
    '<b>How it fits together:</b> a connection signs in with an OAuth 2.0 client (the client ID and secret from the service), over a TLS configuration, to the service account, and is used by productions.',
    'A connection must be authorized once in a browser before it works; revoking its token stops transfers until it’s authorized again.',
    'Deleting a connection also deletes its OAuth 2.0 client when no other connection uses it.',
  ], 'GMFT_intro'),
  'security/services': securityMap('in') + h('A service is a way into IRIS: SQL and object connections, the Terminal, the Web Gateway and so on. Someone gets in only if the service is on, allows how they sign in, and they have Use on its resource.', [
    '<b>No sign-in</b> lets callers in without signing in, as UnknownUser with its roles; where that’s allowed, anyone can connect.',
    '<b>Everyone · Use</b> means anyone who gets through sign-in may use it; otherwise they need a role with Use on the service’s resource.',
    'Services between systems (ECP, mirroring, sharding…) have no sign-in; limit them by address.',
    'This portal runs through the Web Gateway: changes that could cut it off ask you to type its name.',
  ], 'GSA_manage_services'),
  'security/superservers': securityMap('in') + h('A superserver is a network port IRIS listens on. It sets which kinds of connection that port accepts and whether they use TLS; each connection then goes through its service’s own checks.', [
    'The system default superserver also carries the Web Gateway connection this portal uses: keep web connections on.',
    'ECP, mirroring and sharding can only use the system default superserver.',
    '<b>TLS Accepted</b> lets clients choose; <b>Required</b> refuses unencrypted connections and needs a server TLS configuration.',
  ], 'GSA_manage_superserver'),
  'databases/capacity': h('How full each disk that holds IRIS data is, and how much room every database has left to grow.', [
    'Namespaces keep their data in databases. Each database is a file on a disk volume, and it shares that disk’s free space with the other databases and journal files on it.',
    '<b>Room to grow</b> is whichever comes first: the database’s size limit, or its disk filling up. When the disk is the limit, that space is shared, so it is stated once, on the volume.',
    'A database grows in steps: by its expansion size, or by default 12% of its size (at least 10 MB, at most 1 GB). <b>Free inside</b> is used up before the file grows.',
    'A disk over 85% full is flagged, and over 95% is critical; the bar marks both lines. A database within 10% of its size limit is flagged too.',
    'Select a volume to see only its databases. Size limits are changed on the Databases screen.',
  ], 'GSA_manage_databases'),
  'operations/journals': h('Where IRIS records every change to journaled databases, how much room that has, and every journal file still on disk.', [
    'Every change to a journaled database is written to the one journal file in use. Closed files are kept for crash recovery and restores until the purge rule removes them, and files still needed by an open transaction are always kept.',
    'IRIS starts a new file on its daily schedule, at the size limit, or when you press <b>Switch journal file</b>. Nothing is lost when it switches.',
    '<b>Switch directory</b> moves journaling to the alternate directory, for example when the primary disk is filling. Put the alternate on a different disk.',
    'If journaling fails, IRIS either freezes updates (safer for data) or carries on (stays available, but later changes can’t be recovered after a crash). This is set in Journal settings.',
    '<b>Check integrity</b> reads every record of a file and reports damage. It changes nothing.',
    'Browsing records runs a background job in IRIS, and that job writes a few records of its own (to ^Api.Admin.Util.AsyncTaskD), so recent records include the ones your browsing made.',
  ], 'GCDI_journal'),
  'databases/databases': h('Every database IRIS knows about: where its file lives, how much room it has, and whether it is online. A namespace maps to databases; each database is protected by a resource and lives on a disk volume.', [
    '<b>Free inside</b> is space in the file not yet used by data; the file only grows once it is used up, by its growth step (IRIS’s default is 12% of its size, at least 10 MB). A database can’t grow past its maximum size or the free space on its disk.',
    '<b>Compact</b> moves free space to the end of the file and <b>Truncate</b> gives it back to the disk. <b>Defragment</b> rearranges data so each global sits together. All three run in the background while the database stays in use.',
    'Dismounting takes a database offline for every namespace that uses it. IRIS’s own system databases can’t be dismounted, compacted, truncated, defragmented or deleted here.',
    'To read a database’s data people need Read on its resource; to change it, Read &amp; change. How much room each disk has left is on the Capacity page.',
  ], 'GSA_config_databases'),
  'databases/namespaces': h('A namespace is where code runs. It reads its data and code from databases: one for data, one for code, plus anything mapped in from others. Each database is protected by a resource and lives on a disk volume.', [
    'To open a namespace, people need Read on the resource of its data database; to change its data, Read &amp; change.',
    'Mappings send chosen globals, routines or packages to another database, for example shared code for several namespaces.',
    'Switching on interoperability adds mappings to ENSLIB, where the production code lives.',
    'Namespaces and mappings are created and changed in the Management Portal.',
  ], 'GSA_config_namespace'),
  'operations/locks': h('Which process holds which lock right now, and who is waiting for one.', [
    'A process locks a name, usually a global node, so two processes don’t change the same data at once. Others that want it wait until it’s released: when the process unlocks it, when its transaction ends, or when it exits.',
    '<b>Held to transaction end</b> means the process has unlocked it, but IRIS keeps it until the transaction commits or rolls back.',
    'Short waits are normal. A wait that doesn’t clear usually means the holder is stuck; terminate that process rather than removing its lock, since the owner isn’t told and keeps working as if it still held it.',
    'IRIS won’t remove a lock whose owner is in a transaction. Locks marked IRIS belong to IRIS itself and are normal.',
  ], 'GAPPS_locktable'),
  'operations/sessions': h('Everyone connected through a web application right now, and when each session expires if they go idle.', [
    'A session is how IRIS remembers a browser or client between requests: who signed in, and what the app kept for them. Each request pushes the expiry back, and each session holds a license until it ends.',
    'Ending a session signs the user out of that app at their next request, and anything the app kept in it is lost. <b>No sign-in</b> sessions just start a new one.',
    'Management Portal and state-aware sessions can’t be ended here; they end when the user signs out or times out.',
  ], 'GCSP_session'),
  'operations/jobs': h('Long-running work you started, such as integrity checks, compacting or audit searches, with its progress, output and why it failed.', [
    'You only see your own jobs. IRIS clears each one a day after it finishes.',
    'Compact, defragment and integrity check can be paused, resumed or cancelled while they run; other jobs can only be cancelled before they start. Cancelling doesn’t undo work already done.',
    '<b>Read database figures</b> jobs are started by the portal itself whenever it shows a database’s free space.',
  ], 'GSA_manage_background'),
  'operations/langservers': h('The external language servers IRIS starts so your code can call Java, .NET, Python and R, and so the SQL Gateway, IntegratedML and XSLT can run.', [
    'IRIS starts a server the first time code calls it, and stops it when IRIS shuts down. A stopped server is normal.',
    'Each server is one definition on one port. Two servers on the same port can’t run at the same time.',
    'People need Use on the server’s resource (usually %Gateway_Object) to start or use it.',
    'Stop a server before changing its settings. IRIS reads them when it starts the server.',
  ], 'BEXTSERV_intro'),
  'operations/devices': h('The device names code opens (terminals, printers, files, tapes) and what each one maps to.', [
    'Code opens a device by name, or by its number. IRIS opens the physical device behind that name.',
    'A terminal type sets the line width, page length and control codes for a kind of terminal or printer.',
    'Devices that come with IRIS are used by terminals, printing and the device prompt, so change them with care.',
  ], 'GIOD_intro'),
  'operations/ecp': h('Distributed caching: this instance using another instance’s databases, and other instances using this one’s.', [
    'Data servers hold the data. Application servers use it over ECP and keep their own cache, so users can be spread across machines.',
    'A data server connects the first time code uses one of its remote databases. Disabled means it won’t connect until you connect it again.',
    'Other instances can only use this one’s databases while the ECP service is on.',
    'With TLS, each application server’s certificate waits for your approval the first time it connects.',
    `Connection limits and timeouts are set in <a class="help-more" href="/csp/sys/mgr/%25CSP.UI.Portal.ECP.zen" target="_blank" rel="noopener">ECP settings in the Management Portal${EXT_ICON}</a>.`,
  ], 'GDDM_ecp'),
  'tasks/schedule': h('When every task runs over the next seven days. Switch to <b>Day timeline</b> to see a single day hour by hour.', [
    'The Task Manager is the IRIS process that starts each task when it’s due. While it’s suspended or stopped, nothing on this page runs.',
    '<b>Change schedule</b> sets how often a task runs, on which days, at what time and between which dates. A task that runs after another one is changed in the Management Portal.',
    'Crossed-out times belong to suspended tasks. A note appears when disk-heavy tasks, such as the integrity check, start at the same minute.',
  ], 'GSA_manage_taskmgr'),
  'settings/license': h('The license key this instance runs on, and who is using its units right now.', [
    'Each user takes one license unit, and all of that user’s connections share it. Each web session takes one too. When every unit is in use, new users and connections are refused.',
    'After someone disconnects, IRIS holds the unit for a short grace period before releasing it.',
    '<b>Activate new key</b> checks the key file first and shows what it would change before anything is installed.',
    'License servers count units for every instance that shares one key.',
  ], 'GSA_license'),
  'settings/wqm': h('The pools IRIS runs parallel work in, such as parallel SQL queries and its own utilities, and how many background workers each pool may use.', [
    '<b>Automatic</b> lets IRIS size a pool from the CPU cores it may use.',
    'IRIS’s own categories, Default, SQL and Utility, can be changed but not deleted. Changes apply to new jobs straight away.',
    'A worker ceiling helps with disk-heavy work, where workers spend most of their time waiting.',
  ], 'GSA_config_wqm'),
  'web/explorer': h('Every REST API this instance serves, described from the definitions IRIS generates. Pick an API, then an endpoint, to see its parameters and responses.', [
    '<b>Try it</b> sends reads (GET) only, so nothing on the server changes. Your portal sign-in goes only to APIs that accept it.',
    'A few reads are held back because they change what others see: each alert goes to one reader only, and metric rates are worked out between reads.',
    'Older APIs list path parameters but not query parameters; add those under More query parameters.',
    'An API’s sign-in, required resource and on/off switch belong to its web application.',
  ], 'GREST'),
  'web/docdb': h('A DocDB application is IRIS’s security record for one document database: its namespace, whether clients can use it, and the resource they need.', [
    'Through the document API, people need Read on the resource to fetch documents, Read &amp; change to save or delete them, and Use to search.',
    'With no resource, anyone who can reach the document service can use the database.',
    'Clients reach document databases only while the document database service is on (Security › Services).',
    'Deleting the record leaves the documents in place; only the protection goes.',
  ], 'GDOCDB_rest'),
  'web/privroutine': h('A privileged routine application lets chosen routines and classes add roles to whoever runs them, for as long as that code’s work lasts.', [
    'The listed code asks for the roles by the application’s name. IRIS agrees only if the caller holds Use on the application’s resource; with no resource, anyone who runs the code gets them.',
    '<b>Roles it adds</b>: roles for everyone who calls, plus rules that give more roles to holders of a given role.',
    'Whoever can change the listed code decides what it does with those roles, so keep Read &amp; change on its database tight.',
    'While an application is disabled, the code’s requests fail.',
  ], 'GSA_manage_applications'),
};
