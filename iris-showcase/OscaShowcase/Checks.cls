/// SPDX-License-Identifier: AGPL-3.0-or-later
/// Fresh-install ("virgin instance") checks for the OSCA Admin showcase.
/// Sample objects may be created only when EVERY check passes; a check that
/// can't be read (an error, no permission) fails. The default lists below
/// come from a fresh IRIS for Health 2026.2 (build 221) install, verified on
/// the IRISHealth262 development instance on 2026-09-27; see
/// iris-showcase/README.md for how each list was worked out.
/// <p>The lists allow for what OSCA Admin itself installs (the /portal,
/// /api/osca and /api/osca-showcase web applications) and for the
/// HSCUSTOM, HSLIB and HSSYS namespaces and databases that other IRIS for
/// Health versions create. Anything else makes the instance ineligible.</p>
Class OscaShowcase.Checks
{

/// Namespaces a fresh install has.
Parameter NAMESPACES = "%SYS,USER,HSCUSTOM,HSLIB,HSSYS";

/// Databases a fresh install has.
Parameter DATABASES = "IRISSYS,IRISSECURITY,IRISLIB,IRISTEMP,IRISLOCALDATA,IRISAUDIT,IRISMETRICS,ENSLIB,USER,HSCUSTOM,HSLIB,HSSYS";

/// Users IRIS creates itself (irisowner in container images, HS_Services in IRIS for Health).
Parameter USERS = "Admin,CSPSystem,IAM,SuperUser,UnknownUser,_Ensemble,_PUBLIC,_SYSTEM,HS_Services,irisowner";

/// Web, REST and system applications a fresh install has, plus OSCA Admin's own.
/// /csp/&lt;namespace&gt; and /csp/healthshare/&lt;namespace&gt; are allowed for the default namespaces.
Parameter WEBAPPS = "/api/admin,/api/atelier,/api/deepsee,/api/docdb,/api/iam,/api/iknow,/api/interop-editors,/api/mgmnt,/api/monitor,/csp/broker,/csp/documatic,/csp/sys,/csp/sys/exp,/csp/sys/mgr,/csp/sys/oauth2,/csp/sys/op,/csp/sys/sec,/isc/studio/rules,/isc/studio/templates,/isc/studio/usertemplates,/ui/interop,/portal,/api/osca,/api/osca-showcase";

/// The Task Manager's own tasks (all %SYS.Task.* classes running in %SYS).
Parameter TASKS = "Switch Journal,Purge Journal,Purge Tasks,Integrity Check,Security Scan,Diagnostic Report,Purge Audit Database,Inventory Scan,Purge errors and log files,Check Logging activity,Purge Backup Log,Purge ZEN Reports temp files,Feature Tracker,Cleanup Source Journal,Purge Interoperability Usage Metrics,Automatic Table Statistic Collection";

/// Every sample object's name starts with this (compared without case).
Parameter PREFIX = "osca_demo_";

/// A user created within this many seconds of _SYSTEM counts as made by the installer.
Parameter INSTALLWINDOW = 3600;

/// Run every check. Returns { eligible, checks: [{ id, label, pass, detail }] }.
/// <var>home</var> is the namespace that holds ^OscaShowcase (the REST application's).
ClassMethod Run(home As %String = {$Namespace}) As %DynamicObject
{
	New $Namespace
	Set $Namespace = "%SYS"
	Set checks = [], eligible = 1
	Do ..One(checks, .eligible, "namespaces", "Only the default namespaces", home)
	Do ..One(checks, .eligible, "users", "Only the built-in users, plus at most one made by the installer", home)
	Do ..One(checks, .eligible, "roles", "No custom roles", home)
	Do ..One(checks, .eligible, "resources", "No custom resources", home)
	Do ..One(checks, .eligible, "webapps", "Only the standard web applications", home)
	Do ..One(checks, .eligible, "tasks", "Only the standard system tasks", home)
	Do ..One(checks, .eligible, "wallet", "No secrets wallet collections", home)
	Do ..One(checks, .eligible, "demo", "No sample objects yet", home)
	Do ..One(checks, .eligible, "databases", "Only the default databases", home)
	Do ..One(checks, .eligible, "mirror", "Not part of a mirror", home)
	Do ..One(checks, .eligible, "ecp", "No ECP data servers", home)
	Set out = {"checks":(checks)}
	Do out.%Set("eligible", eligible, "boolean")
	Quit out
}

/// Run one check; an error is a failure, never a pass.
ClassMethod One(checks As %DynamicArray, ByRef eligible As %Boolean, id As %String, label As %String, home As %String) [ Private ]
{
	Set pass = 0, detail = ""
	Try {
		// Direct calls: this runs in %SYS, where this class isn't visible by name.
		If id = "namespaces" { Set pass = ..CheckNamespaces(.detail, home) }
		ElseIf id = "users" { Set pass = ..CheckUsers(.detail, home) }
		ElseIf id = "roles" { Set pass = ..CheckRoles(.detail, home) }
		ElseIf id = "resources" { Set pass = ..CheckResources(.detail, home) }
		ElseIf id = "webapps" { Set pass = ..CheckWebapps(.detail, home) }
		ElseIf id = "tasks" { Set pass = ..CheckTasks(.detail, home) }
		ElseIf id = "wallet" { Set pass = ..CheckWallet(.detail, home) }
		ElseIf id = "demo" { Set pass = ..CheckDemo(.detail, home) }
		ElseIf id = "databases" { Set pass = ..CheckDatabases(.detail, home) }
		ElseIf id = "mirror" { Set pass = ..CheckMirror(.detail, home) }
		ElseIf id = "ecp" { Set pass = ..CheckEcp(.detail, home) }
	} Catch e {
		Set pass = 0, detail = "Couldn't be checked: "_..ErrorText(e)
	}
	Set:'pass eligible = 0
	Set row = {"id":(id), "label":(label), "detail":(detail)}
	Do row.%Set("pass", ''pass, "boolean")
	Do checks.%Push(row)
}

ClassMethod CheckNamespaces(Output detail As %String, home As %String) As %Boolean
{
	Do ..ConfigNames("Config.Namespaces", .names)
	Quit ..OnlyAllowed(.names, ..#NAMESPACES, .detail)
}

ClassMethod CheckDatabases(Output detail As %String, home As %String) As %Boolean
{
	Do ..ConfigNames("Config.Databases", .names)
	Quit ..OnlyAllowed(.names, ..#DATABASES, .detail)
}

/// Built-in users only, plus at most one other created within INSTALLWINDOW
/// seconds of _SYSTEM (the account an installer asks for).
ClassMethod CheckUsers(Output detail As %String, home As %String) As %Boolean
{
	Do ..Query("SELECT Name, CreateDateTime FROM Security.Users", .rows)
	Set install = "", extra = 0, installer = 0, list = ""
	For i = 1:1:rows If $ZConvert($ListGet(rows(i), 1), "L") = "_system" Set install = ..Seconds($ListGet(rows(i), 2))
	For i = 1:1:rows {
		Set name = $ListGet(rows(i), 1)
		Continue:..InList(name, ..#USERS)
		Set extra = extra + 1
		Set created = ..Seconds($ListGet(rows(i), 2)), after = created - install
		If (install '= "") && (created '= "") && ($ZAbs(after) <= ..#INSTALLWINDOW) {
			Set installer = installer + 1
			Set $List(list, *+1) = name_" (made at install)"
		} Else {
			Set $List(list, *+1) = name_$Select(created = "":"", install = "":"", 1:" (created "_..Ago(after)_" after install)")
		}
	}
	Set pass = (extra = 0) || ((extra = 1) && (installer = 1))
	Set detail = $Select(extra = 0:"Only built-in users", pass:"Built-in users and "_$ListToString(list, ", "), 1:"Also found: "_$ListToString(list, ", "))
	Quit pass
}

/// Custom roles and resources are the ones whose names don't start with %.
ClassMethod CheckRoles(Output detail As %String, home As %String) As %Boolean
{
	Do ..Query("SELECT Name FROM Security.Roles", .rows)
	Quit ..NoCustom(.rows, "roles", .detail)
}

ClassMethod CheckResources(Output detail As %String, home As %String) As %Boolean
{
	Do ..Query("SELECT Name FROM Security.Resources", .rows)
	Quit ..NoCustom(.rows, "resources", .detail)
}

ClassMethod CheckWebapps(Output detail As %String, home As %String) As %Boolean
{
	Do ..Query("SELECT Name FROM Security.Applications", .rows)
	Set bad = "", n = 0
	For i = 1:1:rows {
		Set name = $ListGet(rows(i), 1), low = $ZConvert(name, "L")
		Continue:..InList(name, ..#WEBAPPS)
		// /csp/<ns> and /csp/healthshare/<ns> for a default namespace.
		Set ns = $Select(low?1"/csp/healthshare/"1.E:$Piece(low, "/", 4), low?1"/csp/"1.E:$Piece(low, "/", 3), 1:"")
		Continue:(ns '= "")&&(ns '= "sys")&&(..InList(ns, ..#NAMESPACES))&&($Length(low, "/") <= $Select(low["/healthshare/":4, 1:3))
		Set n = n + 1, $List(bad, *+1) = name
	}
	Set detail = $Select(n = 0:rows_" standard applications", 1:"Also found: "_..Few(bad))
	Quit n = 0
}

ClassMethod CheckTasks(Output detail As %String, home As %String) As %Boolean
{
	Do ..Query("SELECT Name, TaskClass, NameSpace FROM %SYS.Task", .rows)
	Set bad = "", n = 0
	For i = 1:1:rows {
		Set name = $ListGet(rows(i), 1), cls = $ListGet(rows(i), 2), ns = $ListGet(rows(i), 3)
		Continue:..InList(name, ..#TASKS)&&($Extract(cls, 1, 10) = "%SYS.Task.")&&(ns = "%SYS")
		Set n = n + 1, $List(bad, *+1) = name
	}
	Set detail = $Select(n = 0:rows_" system tasks", 1:"Also found: "_..Few(bad))
	Quit n = 0
}

ClassMethod CheckWallet(Output detail As %String, home As %String) As %Boolean
{
	Set rs = ##class(%ResultSet).%New("%SYS.Wallet.Collection:List")
	$$$ThrowOnError(rs.Execute("*"))
	Set bad = "", n = 0
	While rs.Next() {
		Set name = rs.GetData(1)
		Continue:$Extract(name)="%"
		Set n = n + 1, $List(bad, *+1) = name
	}
	Set detail = $Select(n = 0:"None", 1:"Found: "_..Few(bad))
	Quit n = 0
}

/// No osca_demo_ object anywhere, and nothing recorded from an earlier run.
ClassMethod CheckDemo(Output detail As %String, home As %String) As %Boolean
{
	Set found = ""
	For sql = "SELECT Name FROM Security.Users", "SELECT Name FROM Security.Roles", "SELECT Name FROM Security.Resources", "SELECT Name FROM Security.Applications", "SELECT Name FROM %SYS.Task" {
		Kill rows
		Do ..Query(sql, .rows)
		For i = 1:1:rows Set name = $ListGet(rows(i), 1) Set:$ZConvert(name, "L")[..#PREFIX $List(found, *+1) = name
	}
	For cls = "Config.Namespaces", "Config.Databases" {
		Kill names
		Do ..ConfigNames(cls, .names)
		Set name = "" For { Set name = $Order(names(name)) Quit:name=""  Set:$ZConvert(name, "L")[..#PREFIX $List(found, *+1) = name }
	}
	Set recorded = ($Order(^|home|OscaShowcase("created", "")) '= "")
	Set detail = $Select((found = "") && 'recorded:"None", found = "":"Sample objects are recorded from an earlier run", 1:"Found: "_..Few(found))
	Quit (found = "") && 'recorded
}

ClassMethod CheckMirror(Output detail As %String, home As %String) As %Boolean
{
	Set member = +$SYSTEM.Mirror.IsMember()
	Set detail = $Select(member:"This instance is a mirror member", 1:"Not a mirror member")
	Quit 'member
}

ClassMethod CheckEcp(Output detail As %String, home As %String) As %Boolean
{
	Do ..ConfigNames("Config.ECPServers", .names)
	Set list = "", name = ""
	For { Set name = $Order(names(name)) Quit:name=""  Set $List(list, *+1) = name }
	Set detail = $Select(list = "":"None configured", 1:"Configured: "_..Few(list))
	Quit list = ""
}

/* ── Helpers ───────────────────────────────────────────────────── */

/// rows = count, rows(i) = $ListBuild(columns). Throws on any SQL error.
ClassMethod Query(sql As %String, Output rows) [ Private ]
{
	Kill rows
	Set rows = 0
	Set rs = ##class(%SQL.Statement).%ExecDirect(, sql)
	If rs.%SQLCODE < 0 Throw ##class(%Exception.SQL).CreateFromSQLCODE(rs.%SQLCODE, rs.%Message)
	Set cols = rs.%GetMetadata().columnCount
	While rs.%Next() {
		Set row = ""
		For c = 1:1:cols Set $List(row, c) = rs.%GetData(c)
		Set rows($Increment(rows)) = row
	}
}

/// names(name) = "" for every entry of a Config class's List query.
ClassMethod ConfigNames(cls As %String, Output names) [ Private ]
{
	Kill names
	Set rs = ##class(%ResultSet).%New(cls_":List")
	$$$ThrowOnError(rs.Execute("*"))
	While rs.Next() { Set names(rs.GetData(1)) = "" }
}

ClassMethod OnlyAllowed(ByRef names, allowed As %String, Output detail As %String) As %Boolean [ Private ]
{
	Set ok = "", bad = "", name = ""
	For {
		Set name = $Order(names(name))
		Quit:name=""
		If ..InList(name, allowed) { Set $List(ok, *+1) = name } Else { Set $List(bad, *+1) = name }
	}
	Set detail = $Select(bad = "":$ListToString(ok, ", "), 1:"Also found: "_..Few(bad))
	Quit bad = ""
}

ClassMethod NoCustom(ByRef rows, what As %String, Output detail As %String) As %Boolean [ Private ]
{
	Set bad = "", n = 0
	For i = 1:1:rows {
		Set name = $ListGet(rows(i), 1)
		Continue:$Extract(name)="%"
		Set n = n + 1, $List(bad, *+1) = name
	}
	Set detail = $Select(n = 0:"Only built-in "_what, 1:"Found: "_..Few(bad))
	Quit n = 0
}

/// Is <var>value</var> in a comma-separated list? (Case-insensitive.)
ClassMethod InList(value As %String, list As %String) As %Boolean
{
	Quit (","_$ZConvert(list, "L")_",") [ (","_$ZConvert(value, "L")_",")
}

/// At most five names, then "and N more".
ClassMethod Few(list As %List) As %String [ Private ]
{
	Set n = $ListLength(list)
	Quit $ListToString($List(list, 1, $Select(n > 5:5, 1:n)), ", ")_$Select(n > 5:" and "_(n - 5)_" more", 1:"")
}

/// $Horolog text ("67834,36328.38") as seconds; "" when empty.
ClassMethod Seconds(h As %String) As %String [ Private ]
{
	Quit:$Get(h)="" ""
	Quit (+$Piece(h, ",") * 86400) + $Piece(h, ",", 2)
}

ClassMethod Ago(secs As %Numeric) As %String [ Private ]
{
	Set s = $ZAbs(secs)
	Quit $Select(s < 7200:(s \ 60)_" minutes", s < 172800:(s \ 3600)_" hours", 1:(s \ 86400)_" days")
}

ClassMethod ErrorText(e As %Exception.AbstractException) As %String
{
	Quit:e.Name["<PROTECT>" "no permission to read this"
	Quit:e.%IsA("%Exception.StatusException") $System.Status.GetOneErrorText(e.AsStatus())
	Quit:e.%IsA("%Exception.SQL") e.Data
	Quit e.DisplayString()
}

}
