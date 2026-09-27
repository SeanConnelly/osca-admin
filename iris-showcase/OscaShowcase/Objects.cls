/// SPDX-License-Identifier: AGPL-3.0-or-later
/// Creates and removes the OSCA Admin showcase's sample objects.
/// <p>Every object's name starts with osca_demo_ (web application:
/// /api/osca_demo_orders) and its description reads "OSCA Admin showcase:
/// safe to delete". Users and the web application are disabled, tasks are
/// suspended, the namespace has no interoperability, and the users' passwords
/// are random, never shown and never stored. No wallet or OAuth objects are
/// made (saving an OAuth client switches on /csp/sys/oauth2).</p>
/// <p>Each object is recorded in ^OscaShowcase("created",n) =
/// $ListBuild(kind, name, extra, time) in the REST application's namespace.
/// Remove deletes exactly the recorded objects (and only names with the
/// prefix), checks each is gone, and forgets only those.</p>
/// <p>Callers must run OscaShowcase.Checks first: Apply is only ever
/// called by OscaShowcase.Dispatch after every check passed.</p>
Class OscaShowcase.Objects
{

Parameter TAG = "OSCA Admin showcase: safe to delete";

Parameter PREFIX = "osca_demo_";

Parameter NAMESPACE = "OSCA_DEMO_APP";

Parameter DATABASE = "OSCA_DEMO_DATA";

/// plan = count, plan(i) = $ListBuild(kind, name), in creation order.
ClassMethod Plan(Output plan)
{
	Kill plan
	Set plan = 0
	Set plan($Increment(plan)) = $ListBuild("resource", "osca_demo_reports")
	Set plan($Increment(plan)) = $ListBuild("database", ..#DATABASE)
	Set plan($Increment(plan)) = $ListBuild("namespace", ..#NAMESPACE)
	Set plan($Increment(plan)) = $ListBuild("role", "osca_demo_analyst")
	Set plan($Increment(plan)) = $ListBuild("role", "osca_demo_operator")
	Set plan($Increment(plan)) = $ListBuild("user", "osca_demo_alice")
	Set plan($Increment(plan)) = $ListBuild("user", "osca_demo_bob")
	Set plan($Increment(plan)) = $ListBuild("user", "osca_demo_carol")
	Set plan($Increment(plan)) = $ListBuild("webapp", "/api/osca_demo_orders")
	Set plan($Increment(plan)) = $ListBuild("task", "osca_demo_nightly_check")
	Set plan($Increment(plan)) = $ListBuild("task", "osca_demo_weekly_check")
}

/// The plan as [{ kind, name }].
ClassMethod PlanJson() As %DynamicArray
{
	Do ..Plan(.plan)
	Set out = []
	For i = 1:1:plan Do out.%Push({"kind":($ListGet(plan(i), 1)), "name":($ListGet(plan(i), 2))})
	Quit out
}

/// What is recorded as created, as [{ kind, name }].
ClassMethod CreatedJson(home As %String) As %DynamicArray
{
	Set out = [], n = ""
	For {
		Set n = $Order(^|home|OscaShowcase("created", n), 1, rec)
		Quit:n=""
		Do out.%Push({"kind":($ListGet(rec, 1)), "name":($ListGet(rec, 2))})
	}
	Quit out
}

/// Create every planned object, recording each one. If anything fails,
/// everything made so far is removed again and the error is thrown.
ClassMethod Apply(home As %String) As %DynamicArray
{
	New $Namespace
	Set $Namespace = "%SYS"
	Do ..Plan(.plan)
	Set made = []
	Try {
		For i = 1:1:plan {
			Set kind = $ListGet(plan(i), 1), name = $ListGet(plan(i), 2)
			If ..Exists(kind, name, "") $$$ThrowStatus($$$ERROR($$$GeneralError, name_" already exists, so nothing more was created."))
			Set extra = ..Create(kind, name)
			Set ^|home|OscaShowcase("created", $Increment(^|home|OscaShowcase("created"))) = $ListBuild(kind, name, extra, $ZDateTime($Horolog, 3))
			Do made.%Push({"kind":(kind), "name":(name)})
		}
	} Catch e {
		Do ..Remove(home)
		Throw e
	}
	Quit made
}

/// Delete exactly the recorded objects, newest first. Returns
/// { removed: [...], remaining: [...] }; remaining lists any that still exist.
ClassMethod Remove(home As %String) As %DynamicObject
{
	New $Namespace
	Set $Namespace = "%SYS"
	Set removed = [], remaining = [], n = ""
	For {
		Set n = $Order(^|home|OscaShowcase("created", n), -1, rec)
		Quit:n=""
		Set kind = $ListGet(rec, 1), name = $ListGet(rec, 2), extra = $ListGet(rec, 3)
		// Never anything without the prefix, whatever the record says.
		If $ZConvert(name, "L") '[ ..#PREFIX {
			Do remaining.%Push({"kind":(kind), "name":(name), "error":"not a sample object; left alone"})
			Continue
		}
		Set err = ""
		Try {
			Do ..Delete(kind, name, extra)
		} Catch e {
			Set err = e.DisplayString()
		}
		If '..Exists(kind, name, extra) {
			Kill ^|home|OscaShowcase("created", n)
			Do removed.%Push({"kind":(kind), "name":(name)})
		} Else {
			Do remaining.%Push({"kind":(kind), "name":(name), "error":(err)})
		}
	}
	Kill:$Order(^|home|OscaShowcase("created", ""))="" ^|home|OscaShowcase("created")
	Quit {"removed":(removed), "remaining":(remaining)}
}

/// Create one object; returns what Remove needs besides the name
/// (a database's directory, a task's ID).
ClassMethod Create(kind As %String, name As %String) As %String [ Private ]
{
	Set tag = ..#TAG
	If kind = "resource" {
		$$$ThrowOnError(##class(Security.Resources).Create(name, tag, ""))
		Quit ""
	}
	If kind = "database" {
		Set dir = ##class(%File).NormalizeDirectory($ZUtil(12)_$ZConvert(name, "L"))
		If ##class(%File).Exists(dir_"IRIS.DAT") $$$ThrowStatus($$$ERROR($$$GeneralError, "A database file already exists in "_dir))
		If '##class(%File).DirectoryExists(dir), '##class(%File).CreateDirectoryChain(dir) $$$ThrowStatus($$$ERROR($$$GeneralError, "Couldn't create "_dir))
		$$$ThrowOnError(##class(SYS.Database).CreateDatabase(dir, 1))
		Kill p
		Set p("Directory") = dir
		Set sc = ##class(Config.Databases).Create(name, .p)
		If $$$ISERR(sc) {
			Do ##class(SYS.Database).DeleteDatabase(dir)
			Do ##class(%File).RemoveDirectory(dir)
			$$$ThrowStatus(sc)
		}
		Quit dir
	}
	If kind = "namespace" {
		Kill p
		Set p("Globals") = ..#DATABASE, p("Routines") = ..#DATABASE
		$$$ThrowOnError(##class(Config.Namespaces).Create(name, .p))
		Quit ""
	}
	If kind = "role" {
		Set grants = $Select(name["operator":"osca_demo_reports:RWU", 1:"osca_demo_reports:RU")
		$$$ThrowOnError(##class(Security.Roles).Create(name, tag, grants, ""))
		Quit ""
	}
	If kind = "user" {
		Set roles = $Case(name, "osca_demo_alice":"osca_demo_analyst", "osca_demo_bob":"osca_demo_operator", :"osca_demo_analyst,osca_demo_operator")
		Set full = $Case(name, "osca_demo_alice":"Alice Analyst (sample)", "osca_demo_bob":"Bob Operator (sample)", :"Carol Lead (sample)")
		// Random, never shown or stored; the account is disabled anyway.
		Set pwd = "Aa9!"_$Translate(##class(%SYSTEM.Encryption).Base64Encode(##class(%SYSTEM.Encryption).GenCryptRand(18)), "+/=", "xyz")
		$$$ThrowOnError(##class(Security.Users).Create(name, roles, pwd, full, ..#NAMESPACE, "", "", 0, 0, tag))
		Set pwd = ""
		Quit ""
	}
	If kind = "webapp" {
		Kill p
		Set p("NameSpace") = ..#NAMESPACE, p("Enabled") = 0, p("Description") = tag
		Set p("DispatchClass") = "%CSP.REST", p("AutheEnabled") = 32, p("Resource") = "osca_demo_reports"
		Set p("IsNameSpaceDefault") = 0, p("CookiePath") = name_"/"
		$$$ThrowOnError(##class(Security.Applications).Create(name, .p))
		Quit ""
	}
	If kind = "task" {
		Set t = ##class(%SYS.Task).%New()
		Set t.Name = name, t.Description = tag, t.NameSpace = ..#NAMESPACE
		Set t.TaskClass = "%SYS.Task.CheckLogging"
		Set t.TimePeriodEvery = 1, t.DailyFrequency = 0, t.DailyStartTime = 7200
		If name["weekly" { Set t.TimePeriod = 1, t.TimePeriodDay = "1" } Else { Set t.TimePeriod = 0 }
		Set t.Suspended = 1
		$$$ThrowOnError(t.%Save())
		Set id = t.%Id()
		$$$ThrowOnError(##class(%SYS.Task).Suspend(id))
		Quit id
	}
	$$$ThrowStatus($$$ERROR($$$GeneralError, "Unknown kind "_kind))
}

/// Delete one object, checking first that it is the one recorded.
ClassMethod Delete(kind As %String, name As %String, extra As %String) [ Private ]
{
	Quit:'..Exists(kind, name, extra)
	If kind = "task" {
		Set t = ##class(%SYS.Task).%OpenId(extra)
		If $IsObject(t) && (t.Name = name) {
			Kill t
			$$$ThrowOnError(##class(%SYS.Task).%DeleteId(extra))
		}
	} ElseIf kind = "webapp" {
		$$$ThrowOnError(##class(Security.Applications).Delete(name))
	} ElseIf kind = "user" {
		$$$ThrowOnError(##class(Security.Users).Delete(name))
	} ElseIf kind = "role" {
		$$$ThrowOnError(##class(Security.Roles).Delete(name))
	} ElseIf kind = "resource" {
		$$$ThrowOnError(##class(Security.Resources).Delete(name))
	} ElseIf kind = "namespace" {
		$$$ThrowOnError(##class(Config.Namespaces).Delete(name))
	} ElseIf kind = "database" {
		$$$ThrowOnError(##class(Config.Databases).Delete(name))
		// The file and folder too, but only the sample's own folder.
		If $ZConvert(extra, "L") [ ..#PREFIX {
			If ##class(%File).Exists(extra_"IRIS.DAT") $$$ThrowOnError(##class(SYS.Database).DeleteDatabase(extra))
			Do ##class(%File).RemoveDirectory(extra)
		}
	}
}

ClassMethod Exists(kind As %String, name As %String, extra As %String) As %Boolean [ Private ]
{
	Quit:kind="resource" ##class(Security.Resources).Exists(name)
	Quit:kind="role" ##class(Security.Roles).Exists(name)
	Quit:kind="user" ##class(Security.Users).Exists(name)
	Quit:kind="webapp" ##class(Security.Applications).Exists(name)
	Quit:kind="namespace" ##class(Config.Namespaces).Exists(name)
	Quit:kind="database" ##class(Config.Databases).Exists(name)
	If kind = "task" {
		Quit:extra'="" ##class(%SYS.Task).%ExistsId(extra)
		Quit ##class(%SYS.Task).FindId(name) '= ""
	}
	Quit 0
}

}
