# How to run FD locally

This project has two runtime pieces that must be started together:

1. The Django backend on the project root
2. The WhatsApp bridge service in `whatsapp-service/`

## 1) Prerequisites

- Python 3.11+
- Node.js 20+
- A project-root `.env` file with the shared configuration values used by both the Django app and the WhatsApp service
- Windows PowerShell or Git Bash is assumed for local development

Example `.env` values:

```env
DJANGO_SECRET_KEY=replace-with-a-secret
DJANGO_DEBUG=True
DJANGO_ALLOWED_HOSTS=127.0.0.1,localhost
DJANGO_SERVICE_KEY=replace-with-shared-service-key
DJANGO_BASE_URL=http://127.0.0.1:8000
```

The service key must match the value used by the Django backend. Do not put a second copy of the service config into `whatsapp-service/.env`; the service is designed to read the project-root `.env` automatically.

## 2) Start the Django backend

From the project root:

```powershell
cd C:\kd\Projects\fd
.\.venv\Scripts\python manage.py migrate
.\.venv\Scripts\python manage.py runserver 127.0.0.1:8000
```

Verify the backend health endpoint:

```powershell
curl http://127.0.0.1:8000/api/v1/health/
```

Expected result: HTTP 200 with a health payload.

## 3) Start the WhatsApp bridge

From the service directory:

```powershell
cd C:\kd\Projects\fd\whatsapp-service
npm install
npm run build
npm start
```

The service will:

- load the project-root `.env`
- verify the Django backend is reachable
- print a terminal QR code to pair the WhatsApp device
- persist the auth state in `whatsapp-service/whatsapp-session/`

## 4) Pairing and recovery

When the service starts with no valid session, it prints a QR code in the terminal. Open WhatsApp on your phone and scan the QR using:

- WhatsApp > Linked Devices > Link a device

If the service displays `logged_out` or fails after the login stage, the saved auth state is stale or invalid. Remove only the generated session folder if you are intentionally resetting the WhatsApp link:

```powershell
Remove-Item -Recurse -Force C:\kd\Projects\fd\whatsapp-service\whatsapp-session
```

Then start the service again and scan the new QR code. This is safer than deleting the Django `.env` or overwriting the project config.

## 5) Production notes

- Run Django behind a real web server or container process, not `manage.py runserver`.
- Keep `.env` secrets out of source control.
- Run the WhatsApp service as a persistent background process or a managed service.
- Ensure the Django `DJANGO_BASE_URL` and `DJANGO_SERVICE_KEY` are the same values used by the WhatsApp service.
- If the backend is unreachable, the service logs a warning but continues to boot so the link step can still be attempted.

## 6) Useful checks

```powershell
cd C:\kd\Projects\fd
.\.venv\Scripts\python manage.py test

cd C:\kd\Projects\fd\whatsapp-service
npm run build
npm test
```
