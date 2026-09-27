/// SPDX-License-Identifier: AGPL-3.0-or-later
/// Install-time setup for the optional osca-portal-showcase module
/// (module-showcase.xml). It creates the /api/osca-showcase web application
/// and nothing else: no sample objects are made at install. Those are only
/// ever made from the portal's Showcase page, after every fresh-install check
/// passes and the user types the confirmation phrase.
Class OscaShowcase.Installer
{

Parameter APP = "/api/osca-showcase";

Parameter DISPATCH = "OscaShowcase.Dispatch";

/// Create /api/osca-showcase in <var>namespace</var>, with /api/admin's
/// authentication methods plus JWT and no application roles. An existing
/// application of that name is never changed.
ClassMethod CreateApp(namespace As %String = {$Namespace}) As %Status
{
	New $Namespace
	Set $Namespace = "%SYS"
	If ##class(Security.Applications).Exists(..#APP) {
		Write !, "OSCA Admin showcase: ", ..#APP, " already exists; left as it is."
		Quit $$$OK
	}
	Kill admin, props
	Set sc = ##class(Security.Applications).Get("/api/admin", .admin)
	If $$$ISERR(sc) Quit sc
	Set props("NameSpace") = namespace
	Set props("DispatchClass") = ..#DISPATCH
	Set props("Description") = "OSCA Admin showcase (optional sample data)"
	Set props("Enabled") = 1
	Set props("AutheEnabled") = +$Get(admin("AutheEnabled"))
	Set props("JWTAuthEnabled") = 1
	Set props("IsNameSpaceDefault") = 0
	Set sc = ##class(Security.Applications).Create(..#APP, .props)
	If $$$ISERR(sc) Quit sc
	Write !, "OSCA Admin showcase: created ", ..#APP, " (namespace ", namespace, ")"
	Quit $$$OK
}

/// Delete /api/osca-showcase, but only if it is this module's (its dispatch
/// class is OscaShowcase.Dispatch). Sample objects are not touched:
/// remove them from the Showcase page first.
ClassMethod RemoveApp() As %Status
{
	New $Namespace
	Set $Namespace = "%SYS"
	Quit:'##class(Security.Applications).Exists(..#APP) $$$OK
	Kill props
	Set sc = ##class(Security.Applications).Get(..#APP, .props)
	If $$$ISERR(sc) Quit sc
	If $Get(props("DispatchClass")) '= ..#DISPATCH {
		Write !, "OSCA Admin showcase: ", ..#APP, " isn't this module's; left as it is."
		Quit $$$OK
	}
	Quit ##class(Security.Applications).Delete(..#APP)
}

}
