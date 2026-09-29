# App Service Authentication (Easy Auth)

AgentForEach can use Azure App Service Authentication ("Easy Auth") on the Function App to sign users in. It is one of the providers in `auth.providers` in `gateway/config/agentforeach.json` (with JWT, API keys and a trusted proxy); providers are tried in order and the first match wins.

## How identity is resolved

- The `easy-auth` provider reads the `x-ms-client-principal` header that App Service adds after sign-in and takes the user id and roles from its claims.
- That header is trusted on Azure only when App Service Authentication is actually on (`WEBSITE_AUTH_ENABLED=True`, which Azure sets; the platform then strips client-sent copies). Anywhere else it is an ordinary client header and is trusted only with `AUTH_TRUST_EASY_AUTH_HEADERS=true`, for example behind a proxy that sets it or to emulate Easy Auth locally.
- `/api/*`, `/api/token`, `/negotiate` and the cron routes all go through the same resolver.
- Easy Auth excludes `/ws/*`, so Web PubSub's CloudEvent callbacks reach the handlers; those requests are verified by their signature instead.

## The `x-user-id` header is for local development only

The `insecure-header` provider lets a request name its user with an `x-user-id` header (or `?userId=`). Anyone who can reach the endpoint can then act as any user, so:

- It is **off** unless `AUTH_ALLOW_INSECURE_USER_ID_HEADER=true` is set explicitly.
- It is **always off on Azure** App Service / Functions (detected by `WEBSITE_SITE_NAME`), whatever that setting says.
- Other hosts (Docker, AKS, a VM) can't be told apart from a laptop, so on those it is honoured whenever the setting is `true`. **Never set it in any deployment that real users can reach.** Leave it unset (the default) in production.

## Pulumi config

Set these in your `infra` stack:

```bash
pulumi config set agentforeach:easyAuthEnabled true
pulumi config set agentforeach:easyAuthRequireAuthentication true
pulumi config set agentforeach:easyAuthGoogleClientId "<google-client-id>"
pulumi config set --secret agentforeach:easyAuthGoogleClientSecret "<google-client-secret>"
pulumi config set --path 'agentforeach:easyAuthAllowedAudiences[0]' "https://<your-function-app>.azurewebsites.net"
pulumi config set --path 'agentforeach:corsAllowedOrigins[0]' "https://<your-web-app-origin>"
```

`agentforeach:authAllowInsecureUserIdHeader` exists and defaults to `false`; keep it that way. It has no effect on Azure in any case.

The Function App then gets the `EASY_AUTH_GOOGLE_CLIENT_SECRET` (a Key Vault reference) and `CORS_ALLOWED_ORIGINS` app settings when those are set, and an App Service Authentication configuration with Google as the identity provider.
