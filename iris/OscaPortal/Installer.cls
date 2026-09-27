/// SPDX-License-Identifier: AGPL-3.0-or-later
/// Install-time configuration for OSCA Admin.
/// The portal is a static SPA that signs in through the SysAdmin API's JWT
/// endpoints (/api/admin/login, /refresh, /logout, /revoke) and sends the
/// access token as a Bearer header to /api/admin, /api/monitor, /api/mgmnt
/// and /api/osca.
Class OscaPortal.Installer
{

/// Make sure the system REST APIs the portal calls accept JWT bearer tokens and
/// password login:
/// <ul>
/// <li>/api/admin: the SysAdmin API (2026.2 ships it with JWT on);</li>
/// <li>/api/monitor: metrics and alerts;</li>
/// <li>/api/mgmnt: the REST application list and specs, used by the API
/// explorer and the Web applications screens.</li>
/// </ul>
/// Only ADDS capabilities: authentication methods an administrator already
/// allowed (e.g. Unauthenticated on /api/monitor, which Prometheus/SAM scrapers
/// rely on) are left in place. Each change is printed with its before and after
/// values, so it can be undone exactly (see the README).
ClassMethod EnableJWT() As %Status
{
	New $Namespace
	Set $Namespace = "%SYS"
	Set sc = $$$OK
	For app = "/api/admin", "/api/monitor", "/api/mgmnt" {
		If '##class(Security.Applications).Exists(app) {
			Write !, "OSCA Admin: ", app, " not found, skipped"
			Continue
		}
		Kill current, change
		Set sc = ##class(Security.Applications).Get(app, .current)
		If $$$ISERR(sc) Quit
		Set oldAuth = +$Get(current("AutheEnabled")), oldJWT = +$Get(current("JWTAuthEnabled"))
		Set change("JWTAuthEnabled") = 1
		// AutheEnabled is a bit mask; 32 = Password. OR it in, never clear bits.
		Set change("AutheEnabled") = $ZBoolean(oldAuth, 32, 7)
		Set sc = ##class(Security.Applications).Modify(app, .change)
		If $$$ISERR(sc) Quit
		Write !, "OSCA Admin: JWT and password authentication enabled on ", app
		Write " (AutheEnabled ", oldAuth, " -> ", change("AutheEnabled"), ", JWTAuthEnabled ", oldJWT, " -> 1)"
	}
	Quit sc
}

/// Create the /api/osca web application (OscaPortal.API.Dispatch, the portal's
/// own read-only REST API) in <var>namespace</var>, the namespace the module
/// installs into. It accepts the same authentication methods as /api/admin,
/// plus JWT, so the portal's Bearer token works.
/// <p>Its code lives in <var>namespace</var>, so running it needs Read on that
/// namespace's databases, which an administrator such as %Operator may not
/// hold (/api/admin runs in %SYS instead). The application therefore carries
/// one application role, OscaAdminAPI: Read (never Write) on the namespace's
/// code and data databases, for requests to /api/osca only. Every route still
/// checks the caller's own privileges (%Admin_Operate and so on) before it
/// answers.</p>
/// If the application already exists, only its namespace, dispatch class, JWT
/// flag and that role are updated; authentication methods are only ever added.
ClassMethod CreateApiApp(namespace As %String = {$Namespace}) As %Status
{
	New $Namespace
	Set $Namespace = "%SYS"
	Set app = "/api/osca"
	Kill admin, props
	Set sc = ##class(Security.Applications).Get("/api/admin", .admin)
	If $$$ISERR(sc) Quit sc
	Set sc = ..ApiRole(namespace)
	If $$$ISERR(sc) Quit sc
	Set props("NameSpace") = namespace
	Set props("DispatchClass") = "OscaPortal.API.Dispatch"
	Set props("JWTAuthEnabled") = 1
	Set props("MatchRoles") = ":"_..#APIROLE
	If ##class(Security.Applications).Exists(app) {
		Kill current
		Set sc = ##class(Security.Applications).Get(app, .current)
		If $$$ISERR(sc) Quit sc
		Set props("AutheEnabled") = $ZBoolean(+$Get(current("AutheEnabled")), +$Get(admin("AutheEnabled")), 7)
		Set sc = ##class(Security.Applications).Modify(app, .props)
		If $$$ISERR(sc) Quit sc
		Write !, "OSCA Admin: updated ", app, " (namespace ", namespace, ")"
		Quit $$$OK
	}
	Set props("Description") = "OSCA Admin API (read only)"
	Set props("Enabled") = 1
	Set props("AutheEnabled") = +$Get(admin("AutheEnabled"))
	Set sc = ##class(Security.Applications).Create(app, .props)
	If $$$ISERR(sc) Quit sc
	Write !, "OSCA Admin: created ", app, " (namespace ", namespace, ")"
	Quit $$$OK
}

/// The application role /api/osca carries (see CreateApiApp).
Parameter APIROLE = "OscaAdminAPI";

/// Create or update the OscaAdminAPI role: Read on the resources of
/// <var>namespace</var>'s code and data databases, nothing else.
ClassMethod ApiRole(namespace As %String) As %Status
{
	Kill ns
	Set sc = ##class(Config.Namespaces).Get(namespace, .ns)
	If $$$ISERR(sc) Quit sc
	Set grants = "", seen = ""
	For key = "Routines", "Globals" {
		Set db = $Get(ns(key)) If db = "" Continue
		Kill dbp
		If $$$ISERR(##class(Config.Databases).Get(db, .dbp)) Continue
		Set obj = ##class(SYS.Database).%OpenId($Get(dbp("Directory")))
		If '$IsObject(obj) Continue
		Set res = obj.ResourceName If (res = "") || $ListFind(seen, res) Continue
		Set seen = seen_$ListBuild(res), grants = grants_$Select(grants = "":"", 1:",")_res_":R"
	}
	Set role = ..#APIROLE, desc = "OSCA Admin API: read-only access to "_namespace_"'s databases for /api/osca"
	If ##class(Security.Roles).Exists(role) {
		Kill p Set p("Description") = desc, p("Resources") = grants
		Set sc = ##class(Security.Roles).Modify(role, .p)
	} Else {
		Set sc = ##class(Security.Roles).Create(role, desc, grants)
	}
	If $$$ISOK(sc) Write !, "OSCA Admin: role ", role, " grants ", $Select(grants = "":"nothing", 1:grants), " to /api/osca requests"
	Quit sc
}

/// Uninstall step: delete the /api/osca web application, but only when it is
/// the one CreateApiApp made (its dispatch class is OscaPortal.API.Dispatch);
/// an application someone else put at that URL is left alone. Its OscaAdminAPI role goes with it.
/// Nothing else is changed: the README says how to undo the other install steps.
ClassMethod Unconfigure() As %Status
{
	New $Namespace
	Set $Namespace = "%SYS"
	Set app = "/api/osca"
	If '##class(Security.Applications).Exists(app) {
		Write !, "OSCA Admin: ", app, " not found, nothing to remove"
		Quit $$$OK
	}
	Kill current
	Set sc = ##class(Security.Applications).Get(app, .current)
	If $$$ISERR(sc) Quit sc
	Set dispatch = $Get(current("DispatchClass"))
	If dispatch '= "OscaPortal.API.Dispatch" {
		Write !, "OSCA Admin: ", app, " runs ", $Select(dispatch = "":"no dispatch class", 1:dispatch), ", not OSCA Admin's API; left in place"
		Quit $$$OK
	}
	Set sc = ##class(Security.Applications).Delete(app)
	If $$$ISERR(sc) Quit sc
	Write !, "OSCA Admin: removed ", app
	If ##class(Security.Roles).Exists(..#APIROLE) {
		Set sc = ##class(Security.Roles).Delete(..#APIROLE)
		If $$$ISERR(sc) Quit sc
		Write !, "OSCA Admin: removed role ", ..#APIROLE
	}
	Quit $$$OK
}

/// Last install step: say where the portal is. The web server's host and port
/// depend on how the instance is reached (a container maps its own port), so
/// only the path is printed.
ClassMethod Ready() As %Status
{
	Write !, "OSCA Admin: installed. Open /portal/index.html on this instance's web server"
	Write !, "OSCA Admin: (http://<host>:<web port>/portal/index.html) and sign in with an IRIS account."
	Quit $$$OK
}

}
