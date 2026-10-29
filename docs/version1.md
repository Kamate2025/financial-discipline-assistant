# FinTrack Version 1 — Technical Implementation Record

This document describes the implementation present in the repository. It is the running technical record for FinTrack: update it when later work changes the architecture, data model, API, message flows, or operational behavior. It describes behavior and design; it is not a place for source-code listings.

## Product and scope

FinTrack is a WhatsApp-first personal finance tracker. It records income, expenses, refunds, loan advances and repayments, and returns date-range summaries. It is not business accounting software. Budgets, affordability decisions, currency conversion, and downloadable reports are outside the implemented financial capabilities. New transfer entries are unsupported; legacy transfers remain readable.

## Architecture

The application has two services:

- **Django backend** (`config/`, `transactions/`): owns user profiles, authentication, transaction persistence, validation, and summary calculations. SQLite is configured for the local project.
- **WhatsApp bridge** (`whatsapp-service/`): a Node.js/TypeScript service using Baileys to receive and send WhatsApp messages. It resolves sender identity, handles the conversation, interprets supported natural language, and calls Django over HTTP.

The bridge loads shared configuration from the repository-root `.env`. It uses `DJANGO_BASE_URL` and `DJANGO_SERVICE_KEY` to reach Django; Groq settings configure natural-language interpretation. `.env` and WhatsApp session credentials are local secrets/state and must not be copied into documentation or committed.

The backend is authoritative for identity-to-user resolution, validation, persistence, ownership, and summaries. The bridge does not connect directly to the database. Groq receives the current message and, during a pending clarification, the saved details needed to continue that action. It is not given the sender's phone number, profile, or transaction history. Its structured response is validated before the bridge acts on it.

## Django data model

The default Django authentication user is the account attached to financial records.

| Model | Purpose |
| --- | --- |
| `UserProfile` | One-to-one with a Django user. Stores a unique normalized WhatsApp phone number and preferred display name. The phone number is the bridge-facing identity. |
| `Transaction` | Stores up to 500 characters of description, activity type, optional category, positive decimal amount, three-character currency code, activity date, timestamps, owning user, and soft-void audit fields. Types include income, expense, refund, loan received, loan repayment, and legacy transfer. |
| `ProcessedMessage` | Stores unique WhatsApp message IDs for create and void idempotency. Its optional many-to-one link points to the related transaction. |
| `PendingAction` | Stores one expiring clarification or confirmation workflow per profile, with user-scoped context and a 30-minute expiry. Includes an explicit account-data deletion confirmation state. |
| `Currency` | Administrator-managed unique three-letter code, name, optional symbol, and active status. |
| `Country` | Administrator-managed unique two-letter code, name, active status, supported-currency relation, and required default currency. |

Transactions keep their actual currency code on each record (default `UGX`). The per-transaction value remains independent of the user's preference so later preference changes do not rewrite historical amounts or currencies. Summaries group by transaction currency rather than adding unlike units. `UserProfile.country` and `preferred_currency` are nullable to keep existing accounts compatible; a completed country choice sets both from the selected country's configured default.

Phone normalization trims formatting characters, translates a leading Ugandan local `0` to `+256`, translates `00` to `+`, and ensures a leading plus sign. Phone uniqueness and a database non-empty constraint protect profiles. Transaction amounts are checked by serializer/model validation and a positive-value database constraint. Migrations `0001`–`0004` establish transactions, profiles, processed-message tracking, and its transaction link.

## Country and currency configuration

`Currency` and `Country` are registered in Django admin. The admin provides searchable/filterable lists and validates that an active country has an active default currency included in its supported currencies. Country codes and currency codes are normalized to uppercase and checked for the expected two- and three-letter formats. Database uniqueness and foreign-key constraints protect identifiers and relationships.

Migration `0005_country_currency_userprofile_country_and_more` adds these models and nullable profile preferences, then seeds Uganda (`UG`) as the only active country and UGX as its active default/supported currency. Other currencies and countries can be added and activated in admin without country-specific transaction calculation code. The active-country endpoint only returns countries whose default currency is active and included in the country's supported-currency relation. There is no exchange-rate or cross-currency conversion system.

The migration has been applied to the local SQLite database. Existing profiles were left without country/currency preferences; at the time of implementation, four existing profiles had no country. When one of those users next contacts FinTrack, the bridge recognizes the existing phone/profile and asks for the country without collecting the name again. Existing transaction currency values are not rewritten.

## WhatsApp identity and onboarding

Baileys receives message events in `whatsapp-service/src/client.ts`. The bridge ignores self messages, groups, and broadcasts, and only handles direct messages after it has a verified phone identity. A phone JID is used directly; LID-based messages rely on verified phone-number-share mappings. Numeric LID values are never treated as phone numbers. The LID mapping cache is in memory and populated from WhatsApp phone-number-share events.

When the phone is not registered, the bridge introduces FinTrack, explains income/expense tracking and WhatsApp summaries, gives message examples, and asks for the user's name. A clear bare name, “Call me …”, or “My name is …” is handled deterministically and submitted to Django. The backend normalizes the phone number and creates a Django user with an unusable password plus a profile. The bridge then retrieves active country choices from Django and asks the user to select by displayed number, country name, or country code. Django accepts only an active configured country and assigns that country's configured default currency to the profile.

The onboarding status endpoint returns the persisted registration step for a service-key-authenticated phone. The bridge checks it on subsequent messages, so a saved name and pending country choice survive a bridge restart. Its in-memory sets remain useful for dispatch/deduplication, but they are not the source of truth for onboarding progress. Unexpected replies during country selection repeat the available choices without losing the saved name. Existing profile retries update the profile rather than creating duplicate users.

## Natural-language interpretation and message flow

The bridge handles greetings, onboarding replies, name questions, help/menu, deletion requests, and common summaries before Groq. Clear transaction commands with complete details can be parsed and written deterministically; other natural-language messages go to Groq with a constrained structured response schema. The bridge validates intent, amount, currency, date, description, and field lengths before dispatching. If Groq is unavailable, it does not save a transaction based on an uncertain interpretation. A directionless amount/description such as `300 meat` can still be safely preserved as a pending clarification with the configured currency, date, and description. Currency omitted by interpretation defaults to the user's configured preference (UGX for Uganda). Dates use the user's country time zone.

For a transaction, the bridge sends description, activity type, amount, currency, and activity date to Django. A valid WhatsApp message ID is sent in `X-WhatsApp-Message-ID`. Django saves the transaction and processed-message row atomically. On a repeated ID, the backend returns the existing result to the same owner; re-use by another owner returns conflict without disclosing the saved record. The bridge replies after persistence. A failed outbound reply can therefore be retried without duplicating a transaction when the same message ID reaches the API again.

Bridge process-local message deduplication also exists, but the database-backed idempotency record applies specifically to transaction creation. Greetings, summaries, and profile updates do not have equivalent durable message-idempotency records.

## Authentication, API, and data isolation

API routes are under `/api/v1/`:

| Route | Behavior |
| --- | --- |
| `GET/POST /transactions/` | List the authenticated user's active records or create one. Supports description/category search, exact amount and recent ordering. Owner is assigned from authenticated identity. |
| `GET/PUT/PATCH/DELETE /transactions/<id>/` | Read, change, or soft-void only a record owned by the authenticated user. Other users' records are filtered out. |
| `POST /transactions/<id>/void/` | Idempotently soft-void an owned transaction as an undo or confirmed deletion, retaining audit history. |
| `GET/POST/DELETE /pending-action/` | Read, persist, or clear the caller's pending conversation action. Expired actions are discarded. |
| `GET /insights/` | Calculate user-scoped exact summaries, matching transactions, categories, largest expenses, daily totals, and optional period/category/description filters and comparisons. |
| `DELETE /account/data/` | Delete the authenticated user's account and associated financial data after the WhatsApp confirmation flow. Requires the confirmation message ID. |
| `GET /summaries/?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD` | Return inclusive-date summaries for the authenticated user, grouped by currency. |
| `GET /health/` | Minimal Django health response; it does not indicate WhatsApp readiness. |
| `GET /countries/` | Public list of active selectable countries and their default currencies; includes no user data. |
| `POST /onboarding/` | Bridge-only profile creation/update, protected by the service key. Accepts a name first and a country code in a later request. |
| `GET /onboarding/status/` | Service-key-authenticated lookup of the caller's onboarding step using `X-WhatsApp-Phone`. |

For bridge requests, Django's `ServiceKeyAuthentication` checks `X-Service-Key`, then resolves `X-WhatsApp-Phone` to a profile and uses that profile's Django user as the authenticated principal. The backend never accepts a caller-supplied owner as authority. Transaction querysets and summary calculations are scoped to that principal. The onboarding route separately compares the service key in constant time and does not expose general user creation. Session authentication is also configured for ordinary Django/API access.

## Summary calculation

The summary endpoint requires valid start and end dates and rejects reversed ranges. The date bounds are inclusive. Income, expenses, refunds, loan receipts, and loan repayments have separate totals and counts per currency. Net cash flow is income minus expenses plus refunds and loan receipts minus loan repayments. Loans remain separate from income and expenses. Transfers are counted separately and excluded from these totals. Voided records do not appear in summaries. No exchange rates or cross-currency totals are calculated.

## Stage 2 conversational finance operations

The structured Groq schema distinguishes completed transactions from plans, hypotheticals, questions, negation, and unclear statements. It supports expense, income, refund, loan received, loan repayment, summaries, recent/search operations, correction, deletion, undo, and non-transaction responses. The bridge validates the structured response and only writes a high-confidence completed transaction. Optional enum values use the `UNSPECIFIED` sentinel because Groq rejects empty-string enum members; application validation maps this sentinel to empty internal values. The deterministic parser supports common summaries and dates and can safely retain amount/description details for clarification if Groq is unavailable; it writes complete, explicit transaction commands deterministically and asks for clarification when details or intent remain unclear. Compact `k`/`m` amounts and common date formats/relative dates are recognized with date tokens kept separate from amounts.

Each profile can have one persistent pending action. Missing transaction fields are requested conversationally; answers are interpreted with the saved context. Corrections, deletions, and undo require confirmation before mutation. When a query matches multiple correction/deletion targets, the bridge asks the user to choose a listed candidate. Searches and mutations use user-authenticated backend endpoints and cannot access another user's records. Undo and deletion mark records void while retaining audit details. Refunds and loan activity use distinct activity types and summary lines rather than being classified as income or expense.

The bridge uses the profile's configured currency and country time zone when interpreting dates and omitted currency. Groq errors are classified for configuration, authentication, unavailable model, quota, timeout, network, and malformed response cases. Error replies do not claim that an unpersisted write succeeded. Message text and credentials are not written to diagnostic logs.

## Stage 3 summaries, insights, and support

Natural-language financial questions are classified by Groq into a summary/insight intent and date, period, category, and description filters. The application then queries Django; Groq does not provide financial figures. `/insights/` uses only the authenticated user's non-voided transactions, supports case-insensitive description/location token search, and returns exact matching records, per-currency totals, category expenses, the top five expenses within each currency, daily expense points, and optional comparison/category deltas. Date ranges are inclusive and ISO-validated. Time-relative ranges use the user's country time zone, defaulting to Africa/Kampala. Comparisons use equivalent prior ranges when the request does not supply both comparison bounds.

All totals stay grouped by the transaction's stored currency; FinTrack does not convert currencies. Income, expenses, refunds, loan receipts, and loan repayments are distinct. A refund is counted once as its own type and added once to net cash flow. Loan receipts are excluded from earned income but included in cash flow; repayments are excluded from expenses but subtracted from cash flow. Transfers remain outside cash-flow totals. Responses state that figures reflect saved records and may cover only part of a period. An empty filter is reported as no matching recorded transactions, not proof that no spending occurred.

Insights can show spending categories, largest expenses, income versus expenses, date trends, and comparisons including categories that rose or fell. Feedback is tied to returned figures and avoids guaranteed-savings claims. FinTrack sends no proactive financial notifications. The menu appears only when requested (or during onboarding) and is numbered plain text because this Baileys integration sends ordinary text and does not implement WhatsApp interactive list/button payloads. Natural-language requests and the displayed examples invoke the same actions.

Help describes recording and querying FinTrack data. Human support/troubleshooting requests direct users to Kamate Group Ltd at [WhatsApp support](https://wa.me/256787360381); ordinary transaction and summary replies do not add the support contact. Privacy replies explain that FinTrack stores the financial details the user sends and does not read bank/mobile-money accounts. “Delete my FinTrack account” creates a user-scoped pending confirmation; only the confirmation phrase calls the authenticated account-data endpoint. On success, the endpoint atomically removes that user's processed-message links and Django user, cascading through the profile, pending action, and financial records while leaving other users' data untouched. The bridge confirms only after the endpoint succeeds.

## Operations and reliability

The WhatsApp bridge acquires a process lock for its session directory to prevent two local bridge instances using one session. It checks Django health once at startup but can continue if Django is temporarily unavailable. Baileys connection state drives readiness and reconnect behavior; retries are bounded. Logged-out and replaced-session states stop automatic reconnects, and session data is not automatically deleted. The session directory is persistent authentication state and must be protected like a credential.

Bridge logs use bounded correlation identifiers and omit message text, phone identity, API keys, and raw Baileys payloads in the relevant diagnostic paths. The bridge API client has a 10-second HTTP timeout; Groq requests have a 12-second timeout. The Django health endpoint checks Django only; there is no bridge readiness HTTP endpoint.

Local operation instructions and environment variable names are in [how2run.md](how2run.md) and [.env.example](../.env.example). The checked-in `.env.example` contains placeholders; real credentials belong only in the ignored local `.env` or a deployment secret store.

## Relevant implementation map

- Django settings and root URLs: `config/settings.py`, `config/urls.py`.
- Models and migrations: `transactions/models.py`, `transactions/migrations/`.
- Authentication and API: `transactions/authentication.py`, `transactions/views.py`, `transactions/summary_views.py`, `transactions/urls.py`.
- Transaction validation and summary rules: `transactions/serializers.py`, `transactions/services.py`, `transactions/summary_serializers.py`.
- Django admin: `transactions/admin.py`.
- WhatsApp connection, sender identity, and message events: `whatsapp-service/src/client.ts`, `whatsapp-service/src/lid-mapping.ts`, `whatsapp-service/src/index.ts`.
- WhatsApp parsing, Groq integration, and Django client: `whatsapp-service/src/parser.ts`, `whatsapp-service/src/groq.ts`, `whatsapp-service/src/api.ts`, `whatsapp-service/src/handlers.ts`.

## Version 1 boundaries and follow-on work

Version 1 includes configurable country/currency administration, resumable name-then-country registration, expanded transaction types, searchable history, confirmed correction/undo/deletion flows, natural-language summaries, evidence-based insights, a requested text menu, help, privacy explanations, and confirmed account-data deletion. Currency omitted from a transaction uses the profile's preferred currency; an explicitly supplied three-letter code remains attached to that transaction. Summaries group by recorded currency. Affordability decisions, budgets, new transfers, exchange-rate conversion, external bank access, downloadable reports, voice transcription, and proactive notifications are not provided.

Do not treat a future requirement as already implemented merely because it is recorded here. Update the status and technical description when later implementation lands, and keep the operational guidance consistent with the code.

## Verification record

Migrations `0001`–`0007` show as applied in the local SQLite database. The Django suite passed 83 tests (532 seconds); `manage.py check` reported no issues and `makemigrations --check --dry-run` reported no model changes. The bridge suite had previously passed with the previous language provider. The bridge now uses Groq; its live model discovery and generation commands have not been run as part of this provider migration. The complete WhatsApp/Django live flow was not run.
