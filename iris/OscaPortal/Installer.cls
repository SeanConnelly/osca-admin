/// Install-time configuration for OSCA Portal.
/// The portal is a static SPA that signs in through the SysAdmin API's JWT
/// endpoints (/api/admin/login, /refresh, /logout, /revoke) and sends the
/// access token as a Bearer header to /api/admin and /api/monitor.
Class OscaPortal.Installer
{

/// Make sure both REST APIs the portal uses accept JWT bearer tokens and
/// password login. Only ADDS capabilities: authentication methods an
/// administrator already allowed (e.g. Unauthenticated on /api/monitor, which
/// Prometheus/SAM scrapers rely on) are left in place.
ClassMethod EnableJWT() As %Status
{
	New $Namespace
	Set $Namespace = "%SYS"
	Set sc = $$$OK
	For app = "/api/admin", "/api/monitor" {
		Kill current, change
		Set sc = ##class(Security.Applications).Get(app, .current)
		If $$$ISERR(sc) Quit
		Set change("JWTAuthEnabled") = 1
		// AutheEnabled is a bit mask; 32 = Password. OR it in, never clear bits.
		Set change("AutheEnabled") = $ZBoolean(+$Get(current("AutheEnabled")), 32, 7)
		Set sc = ##class(Security.Applications).Modify(app, .change)
		If $$$ISERR(sc) Quit
		Write !, "OSCA Portal: JWT and password authentication enabled on ", app
	}
	Quit sc
}

}
