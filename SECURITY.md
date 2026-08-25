# Security

## What this app touches

OrbSniper relaunches your installed Discord with a remote debugging port (`9222` on localhost) and injects quest logic into it. It also writes one flag to Discord's own `settings.json` to allow that.

It does **not** read, store or transmit your Discord token. Every API call is made by Discord itself from your own session.

Network activity: one request to `discord.com` during the pre-flight check to confirm you're online, plus whatever your Discord client does normally. Nothing is sent anywhere else — no telemetry, no analytics, no update pings.

## Reporting a vulnerability

Found something that could harm users? Please **don't** open a public issue.

Message the author privately on Telegram: [@synaps_ss](https://t.me/synaps_ss)

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get an answer as fast as the author can manage.

## Verifying what you downloaded

Every release lists the SHA-256 of the `.exe` on its page. Check it before running:

```powershell
Get-FileHash .\OrbSniper.exe -Algorithm SHA256
```

If the hash doesn't match the one on the release page, don't run the file — and tell the author.

## Supported versions

Only the latest release gets fixes.

| Version | Supported |
|---|---|
| 1.4.x | yes |
| older | no |
