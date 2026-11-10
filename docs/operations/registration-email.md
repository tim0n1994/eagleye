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

## Password recovery

Login links to /forgot-password; /reset-password also opens code entry directly.
POST /api/auth/forgot-password accepts an email and uses the same sender and
persistent per-address cooldown as registration. For valid email syntax it
returns a generic response for eligible, unknown, disabled and unverified
accounts. Provider failures remain in the private delivery ledger; the public
response does not prove account existence or inbox delivery. Only active,
verified accounts receive recovery mail. Unverified users finish registration.

POST /api/auth/reset-password accepts email, code and password. Codes are
stored/checked with purpose=reset, separate from purpose=register, and expire
in 10 minutes. New password rules match registration; the UI also requires
password confirmation. In one transaction, resetting consumes the reset code,
updates the password hash, deletes every browser session for the account,
invalidates all outstanding verification codes and fences in-flight mail
requests. No automatic login follows. Service API keys are not browser sessions
and are not revoked by this workflow.

A login rechecks the current password hash under the session-creation write
lock after asynchronous bcrypt verification. This prevents an old-password
login racing a reset from creating a surviving session. A mail request whose
reservation was invalidated by reset cannot commit a late usable code.

Validation does not reset existing users' passwords. The operator accepts the
full mailbox/code/new-password/login path with their own account. Provider
acceptance of a reset-template message to Resend's test recipient and public
page/invalid-input checks only establish transport and basic connectivity.
