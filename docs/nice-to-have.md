# Nice to have

Features we have parked: worth building later, not needed for the current release.

## Live object values in process variables

**Today:** expanding an object variable (for example `1@%CSP.Request`) on the Processes screen shows the class's structure: property names and types, from `/api/osca/v1/class`. It does not show their values.

**Wanted:** the actual property values, as a recursive tree.

**Why it's parked:** an object's values live only in the memory of the process that owns it. No REST API can read them, including the admin API and `/api/osca`. The only general way is to attach a debugger, the same way VS Code's ObjectScript debugger does, which pauses the process. See [API gap 1](api-gaps.md).

**Risks to design around:**
- The process stops until it's detached. A web server process would hang its request, possibly the portal's own.
- Locks, open transactions and licences stay held while the process is paused, so other processes queue behind it.
- Pausing a system daemon (write daemon, journal daemon, garbage collector) could stall the whole instance.
- Reading a computed property runs code inside the paused process.
- Process memory can hold passwords, tokens and keys, and attaching needs strong privileges.
- If the connection drops while attached, the process can be left paused.

**Safe version, if we build it:**
- Never on system processes or web server processes.
- Only for users with developer or administrator rights.
- Read stored values only, never computed ones.
- A clear "this pauses the process" confirmation.
- Automatic release after a few seconds.
- Demonstrate it first on a test job we start ourselves (`osca_test_…`) that holds sample objects.
