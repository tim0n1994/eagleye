# Production registration email

Keep RESEND_API_KEY and RESEND_FROM in a private systemd EnvironmentFile loaded
by the API service. Do not depend on a checkout .env: releases are git archives.
Use a verified production sender; never fall back to resend.dev or console OTP
logging. AUTH_COOKIE_SECURE=1 is required for the HTTPS deployment.

Registration normalizes email addresses. Pending registrations can resume via
resend. The verifier sets the account password while proving mailbox ownership;
a prior unverified registrant's password is never silently activated.

Verification delivery is limited to one attempt/address/minute, persistently
across restarts. The existing per-IP auth limit also applies. Each provider
request has a unique idempotency key and a 20s abort signal. A successful
provider response must include a message id. Only then does a transaction
invalidate old unused codes and save the new 10-minute code. A failed delivery
leaves prior codes valid until their existing expiry. Timeout acceptance is
uncertain; the UI reports a failure and permits a later resend.

verification_delivery records sending/accepted/failed, request id, provider id,
and error class. Accepted means the provider accepted sending; it does not
prove inbox delivery. No OTPs or API credentials are included in logs. Code
consumption, password assignment, email verification and session creation are
one transaction. Secure/HttpOnly/SameSite=Strict protect the production cookie.

Basic checks: syntax/lint, loaded-config presence without printing secrets,
provider acceptance using Resend's delivered@resend.dev test recipient (no user
account), public endpoint validation, and service health. Final inbox receipt,
registration and login are accepted by the operator with a real mailbox.

If sender-domain validation fails, inspect the domain's exact records in
Resend Domains. Add the supplied DKIM TXT and sending-subdomain SPF TXT/MX at
the DNS provider; do not invent a DKIM key or overwrite root-domain MX. Sending
keys may lack permission to list domains or inspect delivery logs; use the
Resend dashboard for that status instead of broadening production-key scope.
