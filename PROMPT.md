Build MediaPack from the attached handoff. Read README.md, BUILD_PLAN.md,
CONTRACTS.md, SOURCES.md, and the diagrams before coding.

MediaPack is general video search and retrieval for agents. Do not specialize
the application around coding agents or bug reports. Support arbitrary
questions about a short video, return source-backed time ranges, and let the
caller retrieve frames and clips within one purchased allowance.

Use the fixed stack in BUILD_PLAN.md: Node 22.22.2+, TypeScript, the verified
mcp-use v2 MCPServer/Hono API on Manufact, React/Vite, Supabase Postgres and
private Storage, Primitive, Blaxel, and Stripe MPP with a Link sandbox buyer.
Use Stripe Projects for the actual required infrastructure when the existing
accounts and hackathon credits support it. Provision resources only within
the operator's authorized accounts and budget.

First inspect the repository and its instructions. If no app exists, create a
new isolated mediapack app. Use the current official documentation in SOURCES.md
and inspect installed package types. Pin the versions that actually pass the
smoke checks. Do not mix mcp-use v1 and v2 APIs or invent SDK methods.

Implement the vertical slice in the build order. Keep shared domain services
behind both REST and MCP. Persist job, payment, operations, allowances, and
outbox state in Postgres. Check job purchase state before invoking MPP.
Unknown payment outcomes must reconcile; they must not trigger another charge.
Use real Primitive round trips and real Blaxel media extraction.

Use design/01-general-video-search.png for the main visual direction. The
other screens illustrate activity and evidence views; their sample copy,
timestamps, metrics, and payment states are not application data.

Validate with a real video, an actual Stripe sandbox purchase, a fresh agent
using only service instructions, a duplicate purchase request, a duplicated
Primitive event, and a payment-success-before-DB-write recovery test. Record
what was executed and link payment, job, message, and artifact identifiers.

Continue autonomously through reversible implementation and checks. If a
credential, account capability, or funded resource is unavailable, name the
specific blocker, finish unaffected work, and leave the blocked integration
explicit. Never show a mock adapter as a working real integration.

Deliver the repository, setup instructions, environment template, migrations,
tests, one reproducible demo, and a concise summary of what works and remains
blocked. Do not publish, incur unapproved charges, or include unrelated private
business documents or data.
