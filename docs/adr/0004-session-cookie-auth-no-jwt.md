# Signed session cookie, no JWT library

Tenant sessions use an httpOnly cookie of the shape `<sessionId>.<hmac>`,
verified with `crypto.timingSafeEqual` — the same construction straders'
own dashboard-token gate already used, just applied to a per-session id
instead of one shared token, and without pulling in a JWT library for it.
`sessions` is the one table excluded from the automatic RLS policy: a
session must be looked up by its own id *before* `app.tenant_id` is known,
since that lookup is what establishes which tenant a request belongs to —
gating the lookup itself behind the tenant context it produces would be
circular. `resolveTenant` middleware reads the cookie, loads the session
and tenant, and runs `SET LOCAL app.tenant_id = ...` for that request's
transaction before any tenant-scoped query executes. Registering a new
agent and logging into an existing one share this same session-issuing
path; the only difference is whether the SpaceTraders token comes from the
visitor directly or from a fresh `POST /register` call.
