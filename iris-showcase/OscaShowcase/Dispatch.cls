/// SPDX-License-Identifier: AGPL-3.0-or-later
/// REST API of the optional OSCA Admin showcase module, served as
/// /api/osca-showcase (see OscaShowcase.Installer). It is not part of
/// the osca-portal module and exists only where osca-portal-showcase is
/// installed on purpose.
/// <ul>
/// <li>GET /v1/check: every fresh-install check, what Create would make, and
/// what is recorded as made.</li>
/// <li>POST /v1/apply {"confirm":"CREATE SAMPLE DATA"}: re-runs every check
/// here on the server and answers 409, writing nothing, unless all pass and
/// the phrase matches exactly.</li>
/// <li>POST /v1/remove: deletes only the objects recorded as made.</li>
/// </ul>
/// <p>Safeguards: POST only, JSON bodies only, the caller must hold
/// %Admin_Secure:USE, the web application grants no roles (IRIS checks the
/// caller's own privileges), and Apply is refused unless every check passes.
/// Errors are { "error": "message" }.</p>
Class OscaShowcase.Dispatch Extends %CSP.REST
{

Parameter CONTENTTYPE = "application/json";

Parameter CHARSET = "utf-8";

Parameter HandleCorsRequest = 0;

Parameter UseSession = 0;

Parameter PHRASE = "CREATE SAMPLE DATA";

XData UrlMap [ XMLNamespace = "http://www.intersystems.com/urlmap" ]
{
<Routes>
<Route Url="/v1/check" Method="GET" Call="Check"/>
<Route Url="/v1/apply" Method="POST" Call="Apply"/>
<Route Url="/v1/remove" Method="POST" Call="Remove"/>
</Routes>
}

ClassMethod Check() As %Status
{
	Try {
		Set home = $Namespace
		Set out = ##class(OscaShowcase.Checks).Run(home)
		Set out.plan = ##class(OscaShowcase.Objects).PlanJson()
		Set out.created = ##class(OscaShowcase.Objects).CreatedJson(home)
		Return ..Reply(out)
	} Catch e {
		Return ..Fail(..#HTTP500INTERNALSERVERERROR, ##class(OscaShowcase.Checks).ErrorText(e))
	}
}

ClassMethod Apply() As %Status
{
	Try {
		Set home = $Namespace
		Set body = ..Body(.err)
		If err '= "" Return ..Fail($Select(err["JSON":..#HTTP415UNSUPPORTEDMEDIATYPE, 1:..#HTTP400BADREQUEST), err)
		If '..Allowed() Return ..Fail(..#HTTP403FORBIDDEN, "Creating sample data needs the %Admin_Secure:USE privilege.")
		// Every check again, here, whatever the page showed.
		Set checks = ##class(OscaShowcase.Checks).Run(home)
		Set phrase = body.%Get("confirm")
		If (phrase '= ..#PHRASE) || 'checks.eligible {
			Set %response.Status = ..#HTTP409CONFLICT
			Set out = {"error":($Select('checks.eligible:"This server isn't a fresh install, so no sample data was created.", 1:"The confirmation phrase doesn't match, so no sample data was created."))}
			Do out.%Set("eligible", checks.eligible, "boolean")
			Set out.checks = checks.checks
			Return ..Reply(out)
		}
		Set made = ##class(OscaShowcase.Objects).Apply(home)
		Set %response.Status = ..#HTTP201CREATED
		Return ..Reply({"ok":true, "message":("Created "_made.%Size()_" sample objects."), "created":(made)})
	} Catch e {
		Return ..Fail(..#HTTP500INTERNALSERVERERROR, "Nothing was kept: "_##class(OscaShowcase.Checks).ErrorText(e))
	}
}

ClassMethod Remove() As %Status
{
	Try {
		Set home = $Namespace
		Do ..Body(.err)
		If err '= "" Return ..Fail($Select(err["JSON":..#HTTP415UNSUPPORTEDMEDIATYPE, 1:..#HTTP400BADREQUEST), err)
		If '..Allowed() Return ..Fail(..#HTTP403FORBIDDEN, "Removing sample data needs the %Admin_Secure:USE privilege.")
		Set r = ##class(OscaShowcase.Objects).Remove(home)
		Set left = r.remaining.%Size()
		Set r.message = $Select(left = 0:"Removed "_r.removed.%Size()_" sample objects.", 1:"Removed "_r.removed.%Size()_"; "_left_" could not be removed.")
		Do r.%Set("ok", left = 0, "boolean")
		Return ..Reply(r)
	} Catch e {
		Return ..Fail(..#HTTP500INTERNALSERVERERROR, ##class(OscaShowcase.Checks).ErrorText(e))
	}
}

/// The JSON body (an object). err is set for a missing JSON content type or bad JSON.
ClassMethod Body(Output err As %String) As %DynamicObject [ Private ]
{
	Set err = ""
	If $ZConvert($Piece(%request.ContentType, ";"), "L") '= "application/json" Set err = "Send a JSON body (Content-Type: application/json)." Quit {}
	Try {
		Set text = $Select($IsObject(%request.Content):%request.Content.Read(32000), 1:"")
		Set body = $Select(text = "":{}, 1:##class(%DynamicObject).%FromJSON(text))
		If '$IsObject(body) || 'body.%IsA("%DynamicObject") Set err = "The body must be a JSON object.", body = {}
	} Catch {
		Set err = "The body isn't valid JSON.", body = {}
	}
	Quit body
}

ClassMethod Allowed() As %Boolean [ Private ]
{
	Quit $SYSTEM.Security.Check("%Admin_Secure", "USE")
}

ClassMethod Fail(status As %String, message As %String) As %Status [ Private ]
{
	Set %response.Status = status
	Write {"error":(message)}.%ToJSON()
	Quit $$$OK
}

ClassMethod Reply(body As %DynamicAbstractObject) As %Status [ Private ]
{
	Write body.%ToJSON()
	Quit $$$OK
}

/// Framework errors (unknown route 404, wrong method 405, 401, 500) in the same { "error" } shape.
ClassMethod ReportHttpStatusCode(pHttpStatus, pSC As %Status = {$$$OK}) As %Status
{
	Set %response.Status = pHttpStatus
	Write {"error":($Piece(pHttpStatus, " ", 2, *))}.%ToJSON()
	Quit $$$OK
}

}
