# FinTrack — Personal finance assistant

## Overview

FinTrack is a personal finance assistant designed to help people understand where their money goes, record what matters, and review summaries without friction. It is built around a WhatsApp-first conversational workflow and is designed by Kamate Group Ltd.

## Product purpose

The project supports a practical personal finance workflow in which a user can record income, expenses, refunds, loans, gifts, asset sales, and transfers through a conversational interface, then ask for a summary over a date range. It is intended to be a lightweight, trustworthy, and privacy-aware application for everyday financial tracking.

## Architecture

FinTrack is built as a Django backend with a SQLite database for local development and a separate Node.js and TypeScript WhatsApp service. The backend handles user identity, authentication, transaction storage, and summary calculations. The WhatsApp service reads the project-root environment configuration, authenticates to Django with a shared service key, and sends messages to the user while validating sender identity through the normalized WhatsApp phone number.

## Project structure

The application is organized around a small root project with a Django app named transactions and a WhatsApp service directory. The root contains the Django project configuration, database, environment files, and documentation. The WhatsApp service contains the Baileys client, message parser, handlers, and API client.

## Environment and configuration

The root project directory contains the environment files. The Django project reads its environment variables from the root .env file during startup, while the WhatsApp service resolves the same root file before connecting to Django. This keeps the environment layout consistent and avoids duplicate copies of the same configuration.

The main configuration values are:

- DJANGO_SECRET_KEY, which is required for secure Django signing and is not committed to source control.
- DJANGO_DEBUG, which controls the debug mode for local development.
- DJANGO_ALLOWED_HOSTS, which lists the valid hosts for the local backend.
- DJANGO_SERVICE_KEY, which is required for authenticated WhatsApp-to-Django requests.
- DJANGO_BASE_URL, which defines the base URL for the Django backend used by the WhatsApp service.

The root environment file is intentionally separate from the WhatsApp service directory so the service can load the shared settings from a single source of truth without copying secrets into multiple locations.

## Security model

The backend is designed to protect user data by requiring authenticated access to financial records. Django session authentication protects the standard browser or API use case, while the WhatsApp service authenticates with a shared service key in the X-Service-Key header. The sender’s WhatsApp number is also supplied in the X-WhatsApp-Phone header, and Django resolves that phone number to the matching user profile before allowing access to that user’s records.

This keeps ownership checks on the server instead of trusting the client. The service key is never disclosed to WhatsApp users, and the backend does not expose internal secrets or stack traces in health or error responses.

## User onboarding

A first-time WhatsApp user can begin by sending a greeting such as hello. The service introduces itself as FinTrack, explains the product and purpose, and asks for the user’s preferred name. Once a name is received, the system saves the preferred name and associates it with the normalized WhatsApp number. Returning users are recognized by their phone number and greeted appropriately.

## Supported transaction flows

The system supports several categories of financial records, including income, expenses, refunds, loans, gifts, and asset sales. The supported categories are intentionally conservative: unrecognized or ambiguous activity is clarified rather than guessed.

## Summary behavior

Users can request a summary for a date range, and the backend calculates the totals from the authenticated user’s records only. Income and expense totals are grouped by currency, transfers are counted separately, and transfers are excluded from the money totals used for net cash flow. The date range is treated as inclusive and uses the local Uganda timezone for practical finance tracking.

## API responsibilities

The Django backend exposes a versioned transaction API and a summary API. The transaction endpoints allow listing, creating, retrieving, updating, and deleting records that belong to the authenticated user only. Attempts by one user to access another user’s transaction are rejected. The summary endpoint only returns summary data for the current user and validates start and end dates before calculating results.

## Models and persistence

The core Django models include:

- User, which is the default Django authentication user.
- UserProfile, which stores the normalized WhatsApp phone number and the preferred display name for the user.
- Transaction, which stores the description, amount, currency, activity type, activity date, ownership, and timestamps.
- ProcessedMessage, which prevents duplicate processing when a WhatsApp message is resent or retried.

The local database is SQLite and is stored in the project root. The existing migrations are preserved, and new migrations are only created when a genuine schema change is required.

## Idempotency and reliability

The WhatsApp service, together with the ProcessedMessage model, guards against duplicate message processing. The service also handles unrecoverable or malformed input by asking for clarification or returning a user-friendly error instead of crashing. The backend health endpoint is intentionally minimal and contains no sensitive information.

## Installation and startup

For Ubuntu VPS setup, service supervision, database backup and migrations, Nginx integration, verification, and rollback, see the [deployment guide](docs/DEPLOYMENT.md).

The project is intended to run locally on a Windows system with a Python virtual environment and a Node.js environment. The Django app should be started with the project’s Python environment, while the WhatsApp service should be started from its own directory so it can resolve the shared root environment file and connect to the Django backend.

The root environment file must remain in the project root and should not be moved or duplicated. The system is designed to use one shared configuration for both services, with the WhatsApp service explicitly resolving the project-root settings before it starts listening for messages.

## WhatsApp pairing and usage

The WhatsApp service displays a QR code for pairing with a test or personal WhatsApp account. Once connected, it can recognize returning users, guide first-time onboarding, record transactions, and provide summary information. It is important to note that Baileys is an unofficial WhatsApp client integration and may be subject to account restrictions, so pairing should be done carefully with a test account whenever possible.

## Testing and verification

The project includes automated Django tests for the transaction model, user profiles, summary calculations, API access control, and transaction update/delete behavior. The Node.js service is validated with TypeScript compilation and a startup health check to confirm the backend URL and service key configuration are wired correctly before connection begins.

The final repository state was verified by running the actual Django test suite and by checking the WhatsApp service’s startup diagnostics against the real backend health endpoint. The Django suite passed successfully, and the WhatsApp service was verified to reach the configured backend when the environment variables were properly loaded from the project root.

## Security and limitations

The current implementation is intentionally conservative about financial advice and automation. It stores only the records the user explicitly chooses to send and keeps user ownership checks on the server.

FinTrack is implemented as a working local-version application with a secure backend, authenticated WhatsApp integration pattern, user onboarding flow, transaction recording, summary reporting, and verified tests. The project is prepared for local testing and further product iteration, with the root configuration kept in a single, secure location and the documentation aligned to the actual codebase.
