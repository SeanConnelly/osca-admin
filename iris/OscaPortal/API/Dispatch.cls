/// SPDX-License-Identifier: AGPL-3.0-or-later
/// OSCA Admin's own REST API, served as the /api/osca web application
/// (see OscaPortal.Installer:CreateApiApp). It fills gaps in the SysAdmin API
/// (/api/admin/v2); docs/api-gaps.md lists each gap.
/// <p>Every route only reads. Nothing here raises privileges: the web
/// application grants no roles, so IRIS checks the caller's own access
/// (database, SQL and resource permissions) on every read. Errors are returned
/// as <code>{ "error": "message" }</code> with an HTTP status.</p>
Class OscaPortal.API.Dispatch Extends %CSP.REST
{

Parameter CONTENTTYPE = "application/json";

Parameter CHARSET = "utf-8";

Parameter HandleCorsRequest = 0;

Parameter UseSession = 0;

/// API version reported by /v1/info.
Parameter VERSION = "1";

/// The most rows any list returns.
Parameter MAXROWS = 500;

XData UrlMap [ XMLNamespace = "http://www.intersystems.com/urlmap" ]
{
<Routes>
<Route Url="/v1/info" Method="GET" Call="Info"/>
<Route Url="/v1/class" Method="GET" Call="ClassShape"/>
<Route Url="/v1/tasks/classes" Method="GET" Call="TaskClasses"/>
<Route Url="/v1/users/:name/logins" Method="GET" Call="Logins"/>
<Route Url="/v1/server" Method="GET" Call="Server"/>
<Route Url="/v1/fs/roots" Method="GET" Call="FsRoots"/>
<Route Url="/v1/fs/list" Method="GET" Call="FsList"/>
<Route Url="/v1/fs/stat" Method="GET" Call="FsStat"/>
<Route Url="/v1/log/messages" Method="GET" Call="MessagesLog"/>
</Routes>
}

/// GET /v1/info: what this API is and what it offers.
ClassMethod Info() As %Status
{
	Set eps = []
	Do eps.%Push({"method":"GET","path":"/v1/info","summary":"This description."})
	Do eps.%Push({"method":"GET","path":"/v1/class","params":["name","namespace"],"summary":"The shape of a compiled class: its properties (with inherited ones) and their types."})
	Do eps.%Push({"method":"GET","path":"/v1/tasks/classes","params":["namespace (a namespace or all)"],"summary":"Task classes that can be scheduled, with their settings."})
	Do eps.%Push({"method":"GET","path":"/v1/users/{name}/logins","params":["limit (1-500, default 50)","days (1-3650, default 90)"],"summary":"A user's recent logins and failed logins, from the audit log. Your own, or anyone's with %Admin_Secure."})
	Do eps.%Push({"method":"GET","path":"/v1/server","summary":"The server's host name, addresses, instance name, OS, CPUs and memory. Needs %Admin_Manage, %Admin_Operate or %Development."})
	Do eps.%Push({"method":"GET","path":"/v1/fs/roots","summary":"Where a server file picker can start: drives (or /) and useful folders. Administrators only."})
	Do eps.%Push({"method":"GET","path":"/v1/fs/list","params":["dir","filter (e.g. *.cer;*.pem)","dirsOnly (0|1)","hidden (0|1)","limit (1-2000, default 500)"],"summary":"The folders and files in a server folder: names, sizes and dates, never contents. Administrators only."})
	Do eps.%Push({"method":"GET","path":"/v1/fs/stat","params":["path"],"summary":"Whether a server path exists, and what it is. Administrators only."})
	Do eps.%Push({"method":"GET","path":"/v1/log/messages","params":["limit (1-1000, default 200)","before (byte offset: a previous reply's next)","minLevel (0-3)","q (text, case-insensitive)","since (server-local ISO time, e.g. 2026-09-27T13:00:00)","countFrom (byte offset: levels counts only lines at or after it)"],"summary":"The newest lines of the instance's console log (messages.log), newest first, a page at a time. Needs %Admin_Operate or %Admin_Manage."})
	Set out = {"api":"osca"}
	Do out.%Set("version", ..#VERSION, "string")
	Set out.endpoints = eps
	Quit ..Reply(out)
}

/// GET /v1/class?name=&lt;class&gt;&amp;namespace=&lt;ns&gt;: a class's shape,
/// read from %Dictionary.CompiledClass in that namespace. Never any values.
ClassMethod ClassShape() As %Status
{
	Try {
		Set name = $Get(%request.Data("name",1))
		If '..IsClassName(name) Return ..Fail(..#HTTP400BADREQUEST, "Give a class name, for example %CSP.Request.")
		Set ns = ..CheckNamespace($Get(%request.Data("namespace",1), $Namespace), .err)
		If ns = "" Return ..Fail(..#HTTP400BADREQUEST, err)

		New $Namespace
		Set $Namespace = ns
		Set cls = ##class(%Dictionary.CompiledClass).%OpenId(name, 0)
		If '$IsObject(cls) Return ..Fail(..#HTTP404NOTFOUND, "There is no compiled class "_name_" in "_ns_".")

		Set out = {"name":(cls.Name), "namespace":(ns), "super":(cls.Super)}
		Do out.%Set("abstract", +cls.Abstract, "boolean")
		Set out.classType = cls.ClassType
		Do out.%Set("persistent", cls.ClassType = "persistent", "boolean")
		Set out.description = ..FirstSentence(cls.Description)

		// Compiled properties include the inherited ones. Sort by name.
		Kill byName
		For i = 1:1:cls.Properties.Count() {
			Set p = cls.Properties.GetAt(i)
			Set:$IsObject(p) byName(p.Name) = i
		}
		Set props = [], count = 0, key = ""
		For {
			Set key = $Order(byName(key), 1, i)
			Quit:key=""
			Set count = count + 1
			Continue:count>..#MAXROWS
			Set p = cls.Properties.GetAt(i)
			Set row = {"name":(p.Name), "type":(p.Type), "collection":(p.Collection)}
			Do row.%Set("relationship", +p.Relationship, "boolean")
			Set:p.Relationship row.cardinality = p.Cardinality
			Do row.%Set("private", +p.Private, "boolean")
			Do row.%Set("calculated", +p.Calculated, "boolean")
			Do row.%Set("multiDimensional", +p.MultiDimensional, "boolean")
			Set row.origin = p.Origin
			Set row.description = ..FirstSentence(p.Description)
			Do props.%Push(row)
		}
		Set out.properties = props
		Set out.propertyCount = count
		Do out.%Set("truncated", count > ..#MAXROWS, "boolean")
		Return ..Reply(out)
	} Catch e {
		Return ..FailException(e)
	}
}

/// GET /v1/tasks/classes?namespace=&lt;ns|all&gt;: every non-abstract subclass of
/// %SYS.Task.Definition, with its TaskName, description and settings. A task's
/// settings are its public properties whose names don't start with "%"
/// (the rule %SYS.Task.Definition:GetSettings uses).
ClassMethod TaskClasses() As %Status
{
	Try {
		Set raw = $Get(%request.Data("namespace",1), $Namespace)
		Do ..Namespaces(.all)
		If $ZConvert(raw, "L") = "all" {
			Merge scan = all
		} Else {
			Set ns = ..CheckNamespace(raw, .err)
			If ns = "" Return ..Fail(..#HTTP400BADREQUEST, err)
			Set scan(ns) = ""
		}

		Kill found
		Set skipped = [], ns = ""
		For {
			Set ns = $Order(scan(ns))
			Quit:ns=""
			Try {
				Do ..ScanTaskClasses(ns, .found)
			} Catch e2 {
				Do skipped.%Push({"namespace":(ns), "error":(..ErrorText(e2))})
			}
		}

		// By class name, which puts the system (%) classes first.
		Set items = [], n = 0, cls = ""
		For {
			Set cls = $Order(found(cls))
			Quit:cls=""
			Set n = n + 1
			Continue:n>..#MAXROWS
			Do items.%Push(found(cls))
		}
		Set out = {"namespace":($Select($ZConvert(raw, "L") = "all":"all", 1:$Order(scan(""))))}
		Set out.items = items
		Set out.count = n
		Do out.%Set("truncated", n > ..#MAXROWS, "boolean")
		Set out.skipped = skipped
		Return ..Reply(out)
	} Catch e {
		Return ..FailException(e)
	}
}

/// Add the task classes visible in <var>ns</var> to <var>found</var> (by class).
/// A system (%) class is the same in every namespace and is read once; any
/// other class lists each namespace it was found in.
ClassMethod ScanTaskClasses(ns As %String, ByRef found) [ Private ]
{
	New $Namespace
	Set $Namespace = ns
	Set sc = $$GetAllDerivedClasses^%occLibrary("%SYS.Task.Definition", .derived)
	$$$ThrowOnError(sc)
	Set cls = ""
	For {
		Set cls = $Order(derived(cls))
		Quit:cls=""
		Set system = ($Extract(cls) = "%")
		If $Data(found(cls)) {
			Do:'system found(cls).namespaces.%Push(ns)
			Continue
		}
		Set info = ..TaskClassInfo(cls)
		Continue:info=""
		Set info.namespaces = $Select(system:[], 1:[(ns)])
		Set found(cls) = info
	}
}

/// A task class as JSON, or "" when it can't be scheduled (abstract, not compiled).
ClassMethod TaskClassInfo(cls As %String) As %DynamicObject [ Private ]
{
	Set def = ##class(%Dictionary.CompiledClass).%OpenId(cls, 0)
	Quit:'$IsObject(def) ""
	Quit:def.Abstract ""
	Set taskName = ..ParamDefault(cls, "TaskName")
	Set resource = ..ParamDefault(cls, "RESOURCE")
	Set out = {"class":(cls), "taskName":($Select(taskName'="":taskName, 1:cls)), "description":(..FirstSentence(def.Description))}
	Do out.%Set("system", $Extract(cls) = "%", "boolean")
	Do out.%Set("hidden", +def.Hidden, "boolean")
	// RESOURCE is "resource[:permission]"; the caller needs it to create or run the task.
	Set out.resource = resource
	If resource = "" {
		Do out.%Set("permitted", 1, "boolean")
	} Else {
		Set perm = $Piece(resource, ":", 2)
		Do out.%Set("permitted", +$System.Security.Check($Piece(resource, ":"), $Select(perm'="":perm, 1:"USE")), "boolean")
	}

	// Settings, in the order they are declared.
	Kill seq
	For i = 1:1:def.Properties.Count() {
		Set p = def.Properties.GetAt(i)
		Continue:'$IsObject(p)
		Continue:p.Private
		Continue:$Extract(p.Name)="%"
		Set seq($Select(p.Origin = cls:0, 1:1), +p.SequenceNumber, p.Name) = i
	}
	Set settings = []
	Set a = ""
	For {
		Set a = $Order(seq(a))
		Quit:a=""
		Set b = ""
		For {
			Set b = $Order(seq(a, b))
			Quit:b=""
			Set c = ""
			For {
				Set c = $Order(seq(a, b, c), 1, i)
				Quit:c=""
				Do settings.%Push(..SettingInfo(def.Properties.GetAt(i)))
			}
		}
	}
	Set out.settings = settings
	Quit out
}

/// One task setting: its type, default and constraints.
ClassMethod SettingInfo(p As %Dictionary.CompiledProperty) As %DynamicObject [ Private ]
{
	Set s = {"name":(p.Name), "type":(p.Type), "collection":(p.Collection)}
	Do s.%Set("required", +p.Required, "boolean")
	// InitialExpression is ObjectScript: report literals as values, anything else as an expression.
	// Never report a default for a setting that holds a secret.
	Set init = p.InitialExpression
	If (init = "") || ($ZConvert(p.Name, "L") ? .E1(1"pass",1"secret",1"token",1"key").E) {
		Set s.default = ""
	} ElseIf (init?1"""".E1"""") && ($Replace($Extract(init, 2, *-1), """""", "") '[ """") {
		Do s.%Set("default", $Replace($Extract(init, 2, *-1), """""", """"), "string")
	} ElseIf $IsValidNum(init) {
		Do s.%Set("default", +init, "number")
	} Else {
		Set s.default = ""
		Set s.defaultExpression = init
	}
	Set s.description = ..FirstSentence(p.Description)
	For param = "MAXLEN", "MINVAL", "MAXVAL" {
		Set v = p.Parameters.GetAt(param)
		Do:v'="" s.%Set($ZConvert(param, "L"), v)
	}
	For param = "VALUELIST", "DISPLAYLIST" {
		Set v = p.Parameters.GetAt(param)
		Continue:$Length(v)<2
		Set list = []
		Set parts = $ListFromString($Extract(v, 2, *), $Extract(v))
		For j = 1:1:$ListLength(parts) Do list.%Push($ListGet(parts, j))
		Do s.%Set($Select(param = "VALUELIST":"valueList", 1:"displayList"), list)
	}
	Quit s
}

/// GET /v1/users/:name/logins?limit=50&amp;days=90: the user's logins and
/// failed logins from the audit log (%System/%Login/Login and LoginFailure),
/// newest first. Also says whether auditing and those events are switched on,
/// because with either off there is no history to show.
/// <p>Callers may read their own history; anyone else's needs %Admin_Secure
/// (USE), the privilege that manages users. 403 otherwise.</p>
ClassMethod Logins(name As %String) As %Status
{
	Try {
		If (name = "") || ($Length(name) > 160) Return ..Fail(..#HTTP400BADREQUEST, "Give a user name.")
		// User names are case-insensitive in IRIS.
		Set self = ($ZConvert(name, "U") = $ZConvert($Username, "U"))
		If ('self) && ('$SYSTEM.Security.Check("%Admin_Secure", "USE")) Return ..Fail(..#HTTP403FORBIDDEN, "Reading another user's login history needs %Admin_Secure.")
		Set limit = ..IntParam("limit", 50, 1, ..#MAXROWS)
		Set days = ..IntParam("days", 90, 1, 3650)

		New $Namespace
		Set $Namespace = "%SYS"
		Set out = {"user":(name), "limit":(limit), "days":(days)}

		// Is history being recorded? null when the caller may not read the settings.
		Try {
			Kill sys
			$$$ThrowOnError(##class(Security.System).Get(, .sys))
			Do out.%Set("auditing", +$Get(sys("AuditEnabled")), "boolean")
		} Catch {
			Do out.%Set("auditing", "", "null")
		}
		For event = "Login", "LoginFailure" {
			Set key = $Select(event = "Login":"loginEventsEnabled", 1:"loginFailureEventsEnabled")
			Try {
				Kill ev
				$$$ThrowOnError(##class(Security.Events).Get("%System", "%Login", event, .ev))
				Do out.%Set(key, +$Get(ev("Enabled")), "boolean")
			} Catch {
				Do out.%Set(key, "", "null")
			}
		}

		// UTCTimeStamp leads the audit log's ID, so the date bound limits the scan.
		Set now = $ZTimeStamp
		Set since = $ZDateTime(($Piece(now, ",") - days)_","_$Piece(now, ",", 2), 3, 1)
		Set sql = "SELECT TOP "_limit_" UTCTimeStamp, Event, ClientIPAddress, ClientExecutableName, Authentication, Description, EventData"
			_" FROM %SYS.Audit WHERE UTCTimeStamp >= ? AND EventSource = '%System' AND EventType = '%Login'"
			_" AND Event IN ('Login', 'LoginFailure') AND Username = ? ORDER BY UTCTimeStamp DESC"
		Set st = ##class(%SQL.Statement).%New()
		Set st.%SelectMode = 2
		$$$ThrowOnError(st.%Prepare(sql))
		Set rs = st.%Execute(since, name)
		If rs.%SQLCODE < 0 Throw ##class(%Exception.SQL).CreateFromSQLCODE(rs.%SQLCODE, rs.%Message)

		Set items = []
		While rs.%Next() {
			Set event = rs.Event
			Set row = {"time":(..IsoTime(rs.UTCTimeStamp)), "event":(event)}
			Do row.%Set("success", event = "Login", "boolean")
			Set row.ip = rs.ClientIPAddress
			Set row.client = rs.ClientExecutableName
			Set row.authentication = rs.Authentication
			Kill data
			Do ..ParseEventData(rs.EventData, .data)
			Set row.service = $Get(data("service name"))
			Set row.application = $Get(data("web application"), $Get(data("application")))
			If event = "LoginFailure" {
				Set reason = $Get(data("error message"))
				Set:reason="" reason = rs.Description
				Set row.reason = ..CleanError(reason)
			}
			Do items.%Push(row)
		}
		Set out.items = items
		Return ..Reply(out)
	} Catch e {
		Return ..FailException(e)
	}
}

/// Split an audit record's EventData ("Label: value" lines) into
/// data(lowercase label) = value.
ClassMethod ParseEventData(text As %String, Output data) [ Private ]
{
	Kill data
	Set text = $Translate(text, $Char(13))
	For i = 1:1:$Length(text, $Char(10)) {
		Set line = $Piece(text, $Char(10), i)
		Continue:line'[":"
		Set label = $ZConvert($ZStrip($Piece(line, ":"), "<>W"), "L")
		Continue:(label="")||($Length(label)>40)
		Set:'$Data(data(label)) data(label) = $Extract($ZStrip($Piece(line, ":", 2, *), "<>W"), 1, 200)
	}
}

// ─── server identity ─────────────────────────────────────────────────

/// GET /v1/server: the server's own identity, for the portal header (the
/// browser only knows the name it used to reach the server).
/// <p>Addresses, CPU count and memory describe the host, so this needs
/// %Admin_Manage, %Admin_Operate or %Development (USE): the people who run or
/// build on the instance. 403 otherwise; the portal then shows the name the
/// browser used.</p>
ClassMethod Server() As %Status
{
	Try {
		If '..ServerPermitted() Return ..Fail(..#HTTP403FORBIDDEN, "The server's identity needs %Admin_Manage, %Admin_Operate or %Development.")
		Set windows = ..IsWindows()
		Set out = {"hostName":($SYSTEM.INetInfo.LocalHostName())}
		Set out.fqdn = $ZConvert(##class(%SYS.System).GetNodeName(0), "L")
		// Configured interfaces, loopback excluded. Address only (no prefix length or IPv6 scope), IPv4 first.
		Set v4 = [], v6 = [], seen = ""
		Set ifs = $SYSTEM.INetInfo.GetListOfConfiguredInterfaces()
		For i = 1:1:$ListLength(ifs) {
			Set if = $ListGet(ifs, i)
			For j = 2:1:$ListLength(if) {
				Set addr = $Piece($Piece($ListGet(if, j), "/"), "%")
				Continue:(addr="")||$ListFind(seen, addr)
				Set seen = seen_$ListBuild(addr)
				If $Length(addr, ":") > 2 { Do v6.%Push(addr) } Else { Do v4.%Push(addr) }
			}
		}
		Set iter = v6.%GetIterator()
		While iter.%GetNext(, .addr) { Do v4.%Push(addr) }
		Set out.ipAddresses = v4
		Set out.instanceName = ##class(%SYS.System).GetInstanceName()
		Set out.os = $SYSTEM.Version.GetOS()
		Set out.platform = $SYSTEM.Version.GetPlatform()
		// Windows reports 6.2.9200 to programs without a compatibility manifest: it means "8 or later", not a real version.
		Set osVersion = ""
		If windows {
			Try { Set osVersion = $SYSTEM.Util.GetOSVersionInfo() } Catch {}
			Set:osVersion="6.2.9200" osVersion = ""
		}
		Set out.osVersion = osVersion
		Set out.cpuCount = $SYSTEM.Util.NumberOfCPUs()
		// Physical memory (KB) is only available on Windows.
		If windows {
			Try {
				Set kb = $SYSTEM.Util.GetPhysicalMemory()
				Do:kb>0 out.%Set("memoryMB", kb \ 1024, "number")
			} Catch {}
		}
		Return ..Reply(out)
	} Catch e {
		Return ..FailException(e)
	}
}

/// Who may read the server's identity: %Admin_Manage, %Admin_Operate or %Development (USE).
ClassMethod ServerPermitted() As %Boolean [ Private ]
{
	Quit $SYSTEM.Security.Check("%Admin_Manage", "USE") || $SYSTEM.Security.Check("%Admin_Operate", "USE") || $SYSTEM.Security.Check("%Development", "USE")
}

// ─── server file browsing (never file contents) ──────────────────────

/// The Filesystem access purpose that governs IRIS's own file picker
/// (%ZEN.Dialog.fileSelect, through %CSP.Portal.Utils:GetAllowedDirectories).
/// This API is a file picker too, so it obeys the same limit.
Parameter FSPURPOSE = "%GUIFileSelector";

/// GET /v1/fs/roots: where browsing can start. Without a limit: the drives
/// (Windows) or / (Unix). With a limit: only its allowed folders. Plus the
/// installation, mgr and home folders as "places", when they are allowed.
ClassMethod FsRoots() As %Status
{
	Try {
		Return:'..FsPermitted() ..FsDenied()
		Set restricted = ..FsLimits(.allowed)
		Set roots = []
		If restricted {
			Set key = ""
			For {
				Set key = $Order(allowed(key), 1, dir)
				Quit:key=""
				Do roots.%Push(..FsRootInfo(dir, "allowed"))
			}
		} ElseIf ..IsWindows() {
			Set rs = ##class(%ResultSet).%New("%File:DriveList")
			$$$ThrowOnError(rs.Execute(1))
			While rs.Next() {
				Set drive = $ZConvert(rs.GetData(1), "U")
				Continue:drive=""
				Do roots.%Push(..FsRootInfo(drive, "drive"))
			}
		} Else {
			Do roots.%Push(..FsRootInfo("/", "root"))
		}

		Set places = []
		Set home = $System.Util.GetEnviron($Select(..IsWindows():"USERPROFILE", 1:"HOME"))
		For place = $ListBuild("install", "Installation", $SYSTEM.Util.InstallDirectory()), $ListBuild("mgr", "Manager (mgr)", ##class(%File).ManagerDirectory()), $ListBuild("home", "Home (IRIS server account)", home) {
			Set dir = $ListGet(place, 3)
			Continue:dir=""
			Continue:'##class(%File).DirectoryExists(dir)
			Set dir = ##class(%File).NormalizeDirectory(dir)
			Continue:..FsCheckAllowed(dir, restricted, .allowed)'=""
			Do places.%Push({"id":($ListGet(place)), "name":($ListGet(place, 2)), "path":(dir)})
		}
		Set out = {"separator":(..Separator()), "roots":(roots), "places":(places)}
		Do out.%Set("restricted", restricted, "boolean")
		Return ..Reply(out)
	} Catch e {
		Return ..FailException(e)
	}
}

/// A root folder: its path, kind and, when the OS answers, its size in bytes.
ClassMethod FsRootInfo(dir As %String, type As %String) As %DynamicObject [ Private ]
{
	Set out = {"name":(dir), "path":(dir), "type":(type)}
	If type '= "allowed" {
		Try {
			If $$$ISOK(##class(%File).GetDirectorySpace(dir, .free, .total, 0)), total > 0 {
				Do out.%Set("totalBytes", +total, "number")
				Do out.%Set("freeBytes", +free, "number")
			}
		} Catch {}
	}
	Quit out
}

/// GET /v1/fs/list?dir=&amp;filter=*.cer;*.pem&amp;dirsOnly=0&amp;hidden=0&amp;limit=500:
/// a folder's entries, folders first, then by name. Names, sizes and dates only.
ClassMethod FsList() As %Status
{
	Try {
		Return:'..FsPermitted() ..FsDenied()
		Set dir = ..FsPath($Get(%request.Data("dir",1)), 1, .err)
		If dir = "" Return ..Fail(..#HTTP400BADREQUEST, err)
		Set restricted = ..FsLimits(.allowed)
		Set err = ..FsCheckAllowed(dir, restricted, .allowed)
		If err '= "" Return ..Fail(..#HTTP403FORBIDDEN, err)
		If '##class(%File).DirectoryExists(dir) Return ..Fail(..#HTTP404NOTFOUND, "There is no folder "_dir_" on the server.")
		If '..FsCanList(dir) Return ..Fail(..#HTTP403FORBIDDEN, "IRIS can't read the folder "_dir_": the account the IRIS server runs as has no access to it.")

		Set filter = $ZStrip($Get(%request.Data("filter",1)), "<>W")
		If (filter '= "") && ((filter '? 1.(1AN,1"*",1"?",1".",1"_",1"-",1";",1" ")) || ($Length(filter) > 200)) {
			Return ..Fail(..#HTTP400BADREQUEST, "The filter can only hold file patterns, such as *.cer;*.pem.")
		}
		Set dirsOnly = ($Get(%request.Data("dirsOnly",1)) = 1)
		Set showHidden = ($Get(%request.Data("hidden",1)) = 1)
		Set limit = ..IntParam("limit", 500, 1, 2000)
		Set windows = ..IsWindows()

		// FileSet with includedirs=1 returns every folder first (whatever the filter), then the matching files, each by name.
		Set rs = ##class(%ResultSet).%New("%File:FileSet")
		Set sc = rs.Execute(dir, $Select(filter = "":"*", 1:filter), "Name", 1)
		If $$$ISERR(sc) Return ..Fail(..#HTTP403FORBIDDEN, "IRIS can't read the folder "_dir_": "_..CleanError($System.Status.GetOneErrorText(sc)))
		Set entries = [], n = 0, truncated = 0
		While rs.Next() {
			Set type = rs.Get("Type")
			Quit:dirsOnly&&(type'="D")
			Set path = rs.Get("Name"), name = rs.Get("ItemName")
			Set attr = ##class(%File).Attributes(path)
			Set hidden = ..FsHidden(name, attr, windows)
			Continue:hidden&&'showHidden
			Set link = ..FsIsLink(attr, windows)
			// Under a limit, a link could lead outside the allowed folders: leave links out.
			Continue:link&&restricted
			If n >= limit { Set truncated = 1 Quit }
			Set n = n + 1
			Set isDir = (type = "D")
			Set row = {"name":(name), "path":($Select(isDir:##class(%File).NormalizeDirectory(path), 1:path)), "type":($Select(isDir:"dir", 1:"file"))}
			Set size = $Select(isDir:"", 1:..FsSize(path))
			Do row.%Set("size", size, $Select(size = "":"null", 1:"number"))
			Set modified = ..FsModified(path)
			Do row.%Set("modified", modified, $Select(modified = "":"null", 1:"string"))
			Do row.%Set("hidden", hidden, "boolean")
			Do:link row.%Set("link", 1, "boolean")
			Do entries.%Push(row)
		}

		Set parent = ##class(%File).ParentDirectoryName(dir)
		Set:parent'="" parent = ##class(%File).NormalizeDirectory(parent)
		Set:..FsSame(parent, dir, windows) parent = ""
		Set:(parent'="")&&(..FsCheckAllowed(parent, restricted, .allowed)'="") parent = ""
		Set out = {"dir":(dir), "parent":(parent), "separator":(..Separator()), "entries":(entries)}
		Do out.%Set("truncated", truncated, "boolean")
		Do out.%Set("restricted", restricted, "boolean")
		Return ..Reply(out)
	} Catch e {
		Return ..FailException(e)
	}
}

/// GET /v1/fs/stat?path=: does a typed path exist, and what is it.
ClassMethod FsStat() As %Status
{
	Try {
		Return:'..FsPermitted() ..FsDenied()
		Set path = ..FsPath($Get(%request.Data("path",1)), 0, .err)
		If path = "" Return ..Fail(..#HTTP400BADREQUEST, err)
		Set restricted = ..FsLimits(.allowed)
		Set err = ..FsCheckAllowed(path, restricted, .allowed)
		If err '= "" Return ..Fail(..#HTTP403FORBIDDEN, err)

		Set isDir = ##class(%File).DirectoryExists(path)
		Set:isDir path = ##class(%File).NormalizeDirectory(path)
		Set exists = isDir || ##class(%File).Exists(path)
		Set out = {"path":(path)}
		Do out.%Set("exists", exists, "boolean")
		Set out.type = $Select('exists:"", isDir:"dir", 1:"file")
		Set size = $Select(exists&&'isDir:..FsSize(path), 1:"")
		Do out.%Set("size", size, $Select(size = "":"null", 1:"number"))
		Set modified = $Select(exists:..FsModified(path), 1:"")
		Do out.%Set("modified", modified, $Select(modified = "":"null", 1:"string"))
		Do out.%Set("readable", $Select('exists:0, isDir:..FsCanList(path), 1:$ZUtil(140, 12, path, 4) = 0), "boolean")
		Return ..Reply(out)
	} Catch e {
		Return ..FailException(e)
	}
}

/// Browsing needs administrative rights, as IRIS's own file picker does:
/// %Admin_Manage, %Admin_Secure or %Development (USE).
ClassMethod FsPermitted() As %Boolean [ Private ]
{
	Quit $System.Security.Check("%Admin_Manage", "USE") || $System.Security.Check("%Admin_Secure", "USE") || $System.Security.Check("%Development", "USE")
}

ClassMethod FsDenied() As %Status [ Private ]
{
	Quit ..Fail(..#HTTP403FORBIDDEN, "Browsing the server's files needs %Admin_Manage, %Admin_Secure or %Development.")
}

/// Is the file picker limited (Filesystem access, purpose %GUIFileSelector)?
/// If so, allowed(KEY) = normalized folder for each allowed folder. When the
/// limit is on but its folders can't be read, nothing is allowed (fail closed).
ClassMethod FsLimits(Output allowed) As %Boolean [ Private ]
{
	Kill allowed
	New $Namespace
	Set $Namespace = "%SYS"
	Quit:'##class(%SYS.FileSystemAccess).IsRestricted(..#FSPURPOSE) 0
	Kill paths
	Set sc = ##class(%SYS.FileSystemAccess).GetAllowedRootPaths(..#FSPURPOSE, .paths)
	Quit:$$$ISERR(sc) 1
	Set windows = ..IsWindows()
	Set p = ""
	For {
		Set p = $Order(paths(p))
		Quit:p=""
		Set dir = ##class(%File).NormalizeDirectory(p)
		Continue:dir=""
		Set allowed(..FsKey(dir, windows)) = dir
	}
	Quit 1
}

/// "" when <var>path</var> may be browsed; otherwise why not.
ClassMethod FsCheckAllowed(path As %String, restricted As %Boolean, ByRef allowed) As %String [ Private ]
{
	Quit:'restricted ""
	Set root = ..FsRoot(path, .allowed)
	Quit:root="" "IRIS limits which folders a file picker may open (Filesystem access, "_..#FSPURPOSE_"), and "_path_" isn't in them."
	Quit:..FsLinkBelow(path, root) "The path goes through a link, which could lead outside the folders IRIS allows a file picker to open."
	Quit ""
}

/// The allowed root folder that contains <var>path</var>, or "".
/// Both are normalized; Windows paths compare case-insensitively.
ClassMethod FsRoot(path As %String, ByRef allowed) As %String [ Private ]
{
	Set key = ..FsKey(path, ..IsWindows())
	Set:$Extract(key, *)'=..Separator() key = key_..Separator()
	Set r = ""
	For {
		Set r = $Order(allowed(r), 1, dir)
		Quit:r=""
		Return:$Extract(key, 1, $Length(r))=r dir
	}
	Quit ""
}

/// Is any folder below <var>root</var> on the way to <var>path</var> (or the path itself) a link?
ClassMethod FsLinkBelow(path As %String, root As %String) As %Boolean [ Private ]
{
	Set windows = ..IsWindows(), sep = ..Separator()
	Set rest = $Extract(path, $Length(root) + 1, *)
	Set:$Extract(rest, *)=sep rest = $Extract(rest, 1, *-1)
	Quit:rest="" 0
	Set cur = root
	For i = 1:1:$Length(rest, sep) {
		Set part = $Piece(rest, sep, i)
		Continue:part=""
		Set cur = cur_part
		Return:..FsIsLink(##class(%File).Attributes(cur), windows) 1
		Set cur = cur_sep
	}
	Quit 0
}

/// A symbolic link or junction: a Windows reparse point (0x400), or Unix mode S_IFLNK (0xA000).
ClassMethod FsIsLink(attr As %Integer, windows As %Boolean) As %Boolean [ Private ]
{
	Quit:attr<0 0
	Quit:windows (attr \ 1024 # 2)
	Quit (attr \ 4096 # 16) = 10
}

/// Hidden: Windows hidden (0x2) or system (0x4), or attributes that can't be read (such as pagefile.sys); Unix dot files.
ClassMethod FsHidden(name As %String, attr As %Integer, windows As %Boolean) As %Boolean [ Private ]
{
	Quit:windows (attr < 0) || (attr \ 2 # 2) || (attr \ 4 # 2)
	Quit $Extract(name) = "."
}

/// Can IRIS read this folder? $ZSEARCH finds "." (or, at a drive root, the first entry) when it can.
ClassMethod FsCanList(dir As %String) As %Boolean [ Private ]
{
	Quit:$ZSearch(dir_"*")'="" 1
	// An empty drive root has no "." entry: fall back to the OS access check there.
	Quit ($ZUtil(140, 12, dir, 4) = 0) && ..FsSame(##class(%File).ParentDirectoryName(dir), dir, ..IsWindows())
}

/// A request path, checked and normalized: absolute, Windows or Unix separators,
/// "." and ".." resolved; folders get a trailing separator. "" (with <var>err</var>) when unusable.
ClassMethod FsPath(raw As %String, isDir As %Boolean, Output err As %String) As %String [ Private ]
{
	Set err = "", windows = ..IsWindows()
	Set path = $ZStrip(raw, "<>W")
	If (path = "") || ($Length(path) > 1024) || (path [ $Char(0)) {
		Set err = "Give an absolute path on the server."
		Quit ""
	}
	If windows {
		Set path = $Translate(path, "/", "\")
		// UNC paths (\\server\share) would make the server connect, and authenticate, to another machine.
		If $Extract(path, 1, 2) = "\\" {
			Set err = "Network paths (\\server\share) can't be browsed. Use a drive letter."
			Quit ""
		}
		If path '? 1A1":".E {
			Set err = "Give an absolute path, such as C:\InterSystems\."
			Quit ""
		}
		Set:path?1A1":" path = path_"\"
	} Else {
		Set path = $Translate(path, "\", "/")
		If $Extract(path) '= "/" {
			Set err = "Give an absolute path, such as /usr/irissys/."
			Quit ""
		}
	}
	If isDir || ##class(%File).DirectoryExists(path) {
		Set norm = ##class(%File).NormalizeDirectory(path)
	} Else {
		Set norm = ##class(%File).NormalizeFilename(path)
	}
	Set:norm="" err = "The path "_$Extract(raw, 1, 200)_" isn't valid on this server."
	Quit norm
}

/// Compare key for a path: upper case on Windows, where paths are case-insensitive.
ClassMethod FsKey(path As %String, windows As %Boolean) As %String [ Private ]
{
	Quit $Select(windows:$ZConvert(path, "U"), 1:path)
}

ClassMethod FsSame(a As %String, b As %String, windows As %Boolean) As %Boolean [ Private ]
{
	Quit ..FsKey(a, windows) = ..FsKey(b, windows)
}

/// File size in bytes, or "" when unknown.
ClassMethod FsSize(path As %String) As %String [ Private ]
{
	Set size = ##class(%File).GetFileSize(path)
	Quit $Select(size < 0:"", 1:size)
}

/// Last modified, ISO 8601 UTC, or "" when unknown.
ClassMethod FsModified(path As %String) As %String [ Private ]
{
	Set h = ##class(%File).GetFileDateModified(path, 1)
	Quit:(h="")||(+h<=0) ""
	Quit $Translate($ZDateTime(h, 3, 1), " ", "T")_"Z"
}

/// The OS path separator.
ClassMethod Separator() As %String [ Private ]
{
	Quit $Select(..IsWindows():"\", 1:"/")
}

ClassMethod IsWindows() As %Boolean [ Private ]
{
	Quit $ZVersion(1) = 2
}

// ─── console log (messages.log) ──────────────────────────────────────

/// Bytes read from the file per step.
Parameter LOGCHUNK = 32000;

/// The most bytes one request reads; the reply says truncated when it stops here.
Parameter LOGSCANMAX = 4194304;

/// The longest text kept for one entry (a startup banner or a stack can run on).
Parameter LOGTEXTMAX = 20000;

/// GET /v1/log/messages?limit=200&amp;before=&amp;minLevel=0&amp;q=&amp;since=:
/// the instance's console log (messages.log, or the ConsoleFile the
/// configuration names), newest first. Never takes a path from the caller.
/// <p>The file is read backwards from <var>before</var> (a byte offset; the
/// end of the file when omitted), in steps, until <var>limit</var> entries
/// match or 4 MB have been read. A line such as
/// <code>09/27/26-13:16:11:060 (6168) 0 [Utility.Event] text</code> starts an
/// entry; any other line (a stack, a startup banner) belongs to the entry
/// above it. Filters: <var>minLevel</var> (0 information, 1 warning,
/// 2 severe, 3 fatal), <var>q</var> (case-insensitive, in the source or
/// text), <var>since</var> (server-local ISO time, such as
/// 2026-09-27T13:00:00: older entries end the read).</p>
/// <p>Reply: <code>{ file, size, entries: [{ offset, time, pid, level,
/// source, text }], next, truncated, scanned, utcOffset, levels }</code>.
/// <var>levels</var> is [information, warning, severe, fatal]: how many lines
/// of each level the read went through that match <var>q</var> and
/// <var>since</var>, whatever <var>minLevel</var> is; with
/// <var>countFrom</var> (a byte offset, e.g. the size from an earlier reply)
/// only lines starting at or after it are counted. Pass
/// <var>next</var> as <var>before</var> for older entries; null when there
/// are none. <var>time</var> is server-local ISO with the server's current
/// UTC offset. Needs %Admin_Operate or %Admin_Manage (USE); 403 otherwise.</p>
ClassMethod MessagesLog() As %Status
{
	Try {
		If '..LogPermitted() Return ..Fail(..#HTTP403FORBIDDEN, "Reading the messages log needs %Admin_Operate or %Admin_Manage.")
		Set limit = ..IntParam("limit", 200, 1, 1000)
		Set minLevel = ..IntParam("minLevel", 0, 0, 3)
		Set q = $ZConvert($ZStrip($Get(%request.Data("q",1)), "<>W"), "L")
		If $Length(q) > 200 Return ..Fail(..#HTTP400BADREQUEST, "The search text can be 200 characters at most.")
		Set since = $Translate($ZStrip($Get(%request.Data("since",1)), "<>W"), " ", "T")
		If (since '= "") && (since '? 4N1"-"2N1"-"2N.1(1"T"2N1":"2N.1(1":"2N.1(1"."1.N)))) {
			Return ..Fail(..#HTTP400BADREQUEST, "Give since as a server-local time, such as 2026-09-27T13:00:00.")
		}
		Set since = $Extract(since, 1, 23)
		Set rawBefore = $Get(%request.Data("before",1))
		If (rawBefore '= "") && (rawBefore '? 1.15N) Return ..Fail(..#HTTP400BADREQUEST, "before must be the next value from an earlier reply.")
		Set rawFrom = $Get(%request.Data("countFrom",1))
		If (rawFrom '= "") && (rawFrom '? 1.15N) Return ..Fail(..#HTTP400BADREQUEST, "countFrom must be a byte offset, such as the size from an earlier reply.")
		Set counts("from") = +rawFrom, counts(0) = 0, counts(1) = 0, counts(2) = 0, counts(3) = 0

		Set path = ..MessagesLogPath()
		If '##class(%File).Exists(path) Return ..Fail(..#HTTP404NOTFOUND, "The instance's messages log wasn't found.")
		Set size = ##class(%File).GetFileSize(path)
		Set end = $Select(rawBefore = "":size, +rawBefore > size:size, 1:+rawBefore)
		Set utcOffset = ..UtcOffset()

		Set entries = [], n = 0, next = "", truncated = 0, scanned = 0, done = 0
		// bound: start of the newest line not yet handed out (every line from it on is dealt with).
		// pending: lines below the last entry start, waiting for their entry's first line.
		Set pos = end, carry = "", bound = end, pending = "", pendingStart = ""
		Set io = $IO, opened = 0
		Try {
			Open path:("RUK\RAW\"):2
			If '$Test Throw ##class(%Exception.General).%New("<FILE>", 0, , "IRIS can't open the messages log.")
			Set opened = 1
			While 'done && (pos > 0) {
				If scanned >= ..#LOGSCANMAX {
					Set truncated = 1, done = 1
					If bound < end {
						Set next = bound
					} ElseIf pending '= "" {
						// No entry start in the whole read: hand out what was read, as one entry.
						Do ..LogPush(entries, .n, pendingStart, "", "", 0, "", pending, utcOffset, minLevel, q, since, .counts)
						Set next = pendingStart
					} Else {
						Set next = pos
					}
					Quit
				}
				Set from = $Select(pos > ..#LOGCHUNK:pos - ..#LOGCHUNK, 1:0)
				Use path
				Set x = $ZSeek(from, 0)
				Read data#(pos - from)
				Use io
				Set scanned = scanned + (pos - from)
				Set data = data_carry, pos = from
				Kill lines
				Set nl = 0, list = $ListFromString(data, $Char(10)), p = 0
				While $ListNext(list, p, v) { Set nl = nl + 1, lines(nl) = $Get(v) }
				// Above the start of the file, the first piece may be the end of a line: keep it for the next step.
				Set first = $Select(pos > 0:2, 1:1)
				Set carry = $Select(pos > 0:$Get(lines(1)), 1:"")
				Set off = pos + $Length(data) + 1
				For i = nl:-1:first {
					Set raw = lines(i)
					Set off = off - 1 - $Length(raw)
					Set line = $ZStrip($ZConvert($Translate(raw, $Char(13)), "I", "UTF8"), ">W")
					Continue:$ZStrip(line, "<>W")=""
					If '..ParseLogLine(line, .ts, .pid, .level, .source, .text) {
						Set pending = line_$Select(pending = "":"", 1:$Char(10)_pending), pendingStart = off
						Set:$Length(pending)>..#LOGTEXTMAX pending = $Extract(pending, 1, ..#LOGTEXTMAX)
						Continue
					}
					Set:pending'="" text = text_$Char(10)_pending
					Set pending = "", pendingStart = "", bound = off
					// The log is in time order: past since, there is nothing more to show.
					If (since '= "") && (ts < since) { Set done = 1, next = "" Quit }
					Do ..LogPush(entries, .n, off, ts, pid, level, source, text, utcOffset, minLevel, q, since, .counts)
					If n >= limit { Set done = 1, next = $Select(off > 0:off, 1:"") Quit }
				}
				Kill lines
			}
			// At the start of the file: lines above the first entry start stand on their own.
			If 'done && (pending '= "") && (since = "") {
				Do ..LogPush(entries, .n, pendingStart, "", "", 0, "", pending, utcOffset, minLevel, q, since, .counts)
			}
		} Catch e2 {
			Use io
			Close:opened path
			Throw e2
		}
		Use io
		Close:opened path

		Set out = {"file":(##class(%File).GetFilename(path))}
		Do out.%Set("size", size, "number")
		Set out.entries = entries
		Do out.%Set("next", next, $Select(next = "":"null", 1:"number"))
		Do out.%Set("truncated", truncated, "boolean")
		Do out.%Set("scanned", scanned, "number")
		Set out.utcOffset = utcOffset
		Set levels = []
		For i = 0:1:3 Do levels.%Push(counts(i), "number")
		Set out.levels = levels
		Return ..Reply(out)
	} Catch e {
		Return ..FailException(e)
	}
}

/// Add an entry when it passes the filters. <var>ts</var> is "" for lines above the file's first entry start.
/// <var>counts</var>(level) counts every line that matches q and since (at or after counts("from")), before minLevel.
ClassMethod LogPush(entries As %DynamicArray, ByRef n As %Integer, off As %Integer, ts As %String, pid As %String, level As %Integer, source As %String, text As %String, utcOffset As %String, minLevel As %Integer, q As %String, since As %String, ByRef counts) [ Private ]
{
	Quit:(since'="")&&(ts="")
	If q '= "" {
		Quit:($ZConvert(source, "L") '[ q)&&($ZConvert(text, "L") '[ q)
	}
	Set:(off>=$Get(counts("from")))&&(level>=0)&&(level<=3) counts(level) = $Get(counts(level)) + 1
	Quit:level<minLevel
	Set:$Length(text)>..#LOGTEXTMAX text = $Extract(text, 1, ..#LOGTEXTMAX - 1)_"…"
	Set row = {}
	Do row.%Set("offset", off, "number")
	Do row.%Set("time", $Select(ts = "":"", 1:ts_utcOffset), $Select(ts = "":"null", 1:"string"))
	Do row.%Set("pid", pid, $Select(pid = "":"null", 1:"number"))
	Do row.%Set("level", level, "number")
	Set row.source = source
	Set row.text = text
	Do entries.%Push(row)
	Set n = n + 1
}

/// Split an entry's first line: "09/27/26-13:16:11:060 (6168) 0 [Utility.Event] text".
/// <var>ts</var> becomes "2026-09-27T13:16:11.060" (server-local). 0 when the line doesn't start an entry.
ClassMethod ParseLogLine(line As %String, Output ts As %String, Output pid As %Integer, Output level As %Integer, Output source As %String, Output text As %String) As %Boolean [ Private ]
{
	Set (ts, pid, level, source, text) = ""
	Quit:line'?2N1"/"2N1"/"1(4N,2N)1"-"2N1":"2N1":"2N1":"1.N1" ("1.N1") "1N.E 0
	Set stamp = $Piece(line, " ")
	Set d = $Piece(stamp, "-"), t = $Piece(stamp, "-", 2)
	Set y = $Piece(d, "/", 3)
	Set ts = $Select($Length(y) = 2:"20"_y, 1:y)_"-"_$Piece(d, "/", 1)_"-"_$Piece(d, "/", 2)_"T"_$Piece(t, ":", 1, 3)_"."_$Extract($Piece(t, ":", 4)_"000", 1, 3)
	Set rest = $Piece(line, " ", 2, *)
	Set pid = +$Extract($Piece(rest, ")"), 2, *)
	Set rest = $Extract(rest, $Find(rest, ") "), *)
	Set level = +$Extract(rest)
	Set rest = $ZStrip($Extract(rest, 2, *), "<W")
	If ($Extract(rest) = "[") && (rest [ "]") {
		Set source = $Piece($Extract(rest, 2, *), "]")
		Set rest = $ZStrip($Piece(rest, "]", 2, *), "<W")
	}
	Set text = rest
	Quit 1
}

/// The console log: the ConsoleFile the configuration names, else messages.log, in the mgr directory.
ClassMethod MessagesLogPath() As %String [ Private ]
{
	Set file = ""
	Try {
		New $Namespace
		Set $Namespace = "%SYS"
		Kill p
		Set:$$$ISOK(##class(Config.config).Get(.p)) file = $Get(p("ConsoleFile"))
	} Catch {}
	Set:file="" file = "messages.log"
	Quit ##class(%File).NormalizeFilename(file, ##class(%File).ManagerDirectory())
}

/// The server's current offset from UTC, as "+01:00".
ClassMethod UtcOffset() As %String [ Private ]
{
	Set h = $Horolog, z = $ZTimeStamp
	Set secs = (($Piece(h, ",") - $Piece(z, ",")) * 86400) + ($Piece(h, ",", 2) - ($Piece(z, ",", 2) \ 1))
	Set mins = ((secs + $Select(secs < 0:-450, 1:450)) \ 900) * 15
	Set sign = $Select(mins < 0:"-", 1:"+"), mins = $Zabs(mins)
	Quit sign_$Translate($Justify(mins \ 60, 2), " ", "0")_":"_$Translate($Justify(mins # 60, 2), " ", "0")
}

/// Who may read the console log: %Admin_Operate or %Admin_Manage (USE), the people who run the instance.
ClassMethod LogPermitted() As %Boolean [ Private ]
{
	Quit $SYSTEM.Security.Check("%Admin_Operate", "USE") || $SYSTEM.Security.Check("%Admin_Manage", "USE")
}

// ─── helpers ─────────────────────────────────────────────────────────

/// Namespaces on this instance: list(NAME) = "". Implicit ("^system^dir") ones are left out.
ClassMethod Namespaces(Output list) [ Private ]
{
	Kill list, all
	$$$ThrowOnError(##class(%SYS.Namespace).ListAll(.all))
	Set ns = ""
	For {
		Set ns = $Order(all(ns))
		Quit:ns=""
		Set:$Extract(ns)'="^" list(ns) = ""
	}
}

/// The namespace name in upper case, or "" (with <var>err</var> set) when there is no such namespace.
ClassMethod CheckNamespace(raw As %String, Output err As %String) As %String [ Private ]
{
	Set err = ""
	Set ns = $ZConvert($ZStrip(raw, "<>W"), "U")
	Do ..Namespaces(.list)
	If (ns = "") || ($Length(ns) > 64) || '$Data(list(ns)) {
		Set err = "There is no namespace called "_$Extract(raw, 1, 64)_"."
		Quit ""
	}
	Quit ns
}

/// A syntactically valid class name, such as %CSP.Request or My.Pkg.Class.
ClassMethod IsClassName(name As %String) As %Boolean [ Private ]
{
	Quit:(name="")||($Length(name)>220) 0
	Quit ''(name?.1"%"1A.AN.(1"."1A.AN))
}

/// An integer query parameter, clamped to [min, max].
ClassMethod IntParam(name As %String, default As %Integer, min As %Integer, max As %Integer) As %Integer [ Private ]
{
	Set v = $Get(%request.Data(name, 1))
	Quit:v'?1.9N default
	Set v = +v
	Quit $Select(v < min:min, v > max:max, 1:v)
}

/// The value of a class parameter, or "".
ClassMethod ParamDefault(cls As %String, param As %String) As %String [ Private ]
{
	Set p = ##class(%Dictionary.CompiledParameter).%OpenId(cls_"||"_param, 0)
	Quit $Select($IsObject(p):p.Default, 1:"")
}

/// The first sentence of a class-reference description, as plain text.
ClassMethod FirstSentence(text As %String, max As %Integer = 300) As %String
{
	Set t = $Translate($Extract(text, 1, 4000), $Char(13, 10, 9), "   ")
	// Descriptions are HTML: drop the tags, decode the entities.
	Set out = "", inTag = 0
	For i = 1:1:$Length(t) {
		Set c = $Extract(t, i)
		If c = "<" { Set inTag = 1 Continue }
		If inTag { Set:c=">" inTag = 0 Continue }
		Set out = out_c
	}
	Set out = $ZStrip($ZConvert(out, "I", "HTML"), "<=>W")
	Set end = $Find(out_" ", ". ")
	Set:end out = $Extract(out, 1, end - 2)
	Set:$Length(out)>max out = $Extract(out, 1, max - 1)_"…"
	Quit out
}

/// "2026-09-27 10:00:00.123" (UTC) → "2026-09-27T10:00:00.123Z".
ClassMethod IsoTime(ts As %String) As %String [ Private ]
{
	Quit:ts="" ""
	Quit $Translate(ts, " ", "T")_"Z"
}

/// "ERROR #798: Password login failed" → "Password login failed".
ClassMethod CleanError(text As %String) As %String [ Private ]
{
	Set t = $ZStrip(text, "<>W")
	Set:t?1.E1"#".1"-"1.N1":".E t = $ZStrip($Piece(t, ":", 2, *), "<>W")
	Quit $Extract(t, 1, 200)
}

/// Plain-English text for an exception.
ClassMethod ErrorText(e As %Exception.AbstractException) As %String [ Private ]
{
	Quit:..IsDenied(e) "You don't have permission to read this."
	Quit:e.%IsA("%Exception.StatusException") ..CleanError($System.Status.GetOneErrorText(e.AsStatus()))
	Quit:e.%IsA("%Exception.SQL") ..CleanError(e.Data)
	Quit e.DisplayString()
}

/// Was this a privilege failure (&lt;PROTECT&gt;, SQLCODE -99, or a refused resource)?
ClassMethod IsDenied(e As %Exception.AbstractException) As %Boolean [ Private ]
{
	Quit:e.Name["<PROTECT>" 1
	Quit:e.%IsA("%Exception.SQL")&&(e.Code=-99) 1
	If e.%IsA("%Exception.StatusException") {
		Set text = $System.Status.GetErrorText(e.AsStatus())
		Quit:(text["SQLCODE: -99")||(text["SQLCODE=-99")||(text["<PROTECT>") 1
	}
	Quit 0
}

/// Report an exception: 403 for a privilege failure, 500 otherwise.
ClassMethod FailException(e As %Exception.AbstractException) As %Status [ Private ]
{
	Quit ..Fail($Select(..IsDenied(e):..#HTTP403FORBIDDEN, 1:..#HTTP500INTERNALSERVERERROR), ..ErrorText(e))
}

/// Send an error as { "error": message }.
ClassMethod Fail(status As %String, message As %String) As %Status [ Private ]
{
	Set %response.Status = status
	Write {"error":(message)}.%ToJSON()
	Quit $$$OK
}

/// Send a JSON body.
ClassMethod Reply(body As %DynamicAbstractObject) As %Status [ Private ]
{
	Write body.%ToJSON()
	Quit $$$OK
}

/// Framework errors (unknown route 404, wrong method 405, 401, 500) in the same { "error" } shape.
ClassMethod ReportHttpStatusCode(pHttpStatus, pSC As %Status = {$$$OK}) As %Status
{
	Set %response.Status = pHttpStatus
	Set message = $Piece(pHttpStatus, " ", 2, *)
	Set:$$$ISERR(pSC)&&(+pHttpStatus'=404)&&(+pHttpStatus'=405) message = ..CleanError($System.Status.GetOneErrorText(pSC))
	Write {"error":(message)}.%ToJSON()
	Quit $$$OK
}

}
