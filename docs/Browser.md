# Browser

The agent can use a real web browser the way a person does: open pages, read them, click, type, fill in forms, upload and download files. The browser runs inside the user's own [sandbox](Sandbox.md), so each user's browser is isolated from everyone else's, it keeps their cookies and logins between conversations, and an idle browser costs nothing but disk.

It is off by default and needs the ACA Sandboxes backend.

## Why it runs in the user's sandbox

Managed browser services, like Amazon Bedrock AgentCore Browser, run each browser session in its own isolated container and hand the agent a CDP connection, a live view and recordings. AgentForEach already gives each user an isolated microVM that suspends when idle, with an egress proxy that injects credentials and a disk that keeps state. So the browser is one more process in that sandbox, not a new kind of machine:

- **No second machine per user.** A separate browser VM would double every idle user's disk snapshots and resumes, and the microVM is already the boundary between users.
- **Files flow both ways.** A file the browser downloads is in `/mnt/data`, where `sandbox_exec` can process it and `sandbox_file_export` can give it to the user; a file the agent made can be uploaded to a page.
- **Same controls.** The browser gets the same egress policy, credential injection, account deletion and image pipeline as code.

The trade-off is that the browser and code share one egress policy and one Linux user (see [What the browser can reach](#what-the-browser-can-reach) and [Security](#security)).

OpenClaw's browser tool (MIT) informed the design: one tool with actions, a snapshot of refs that navigation returns inline, and labelled screenshots. OpenClaw runs its browser in a separate container because its code sandbox has no network; that reason doesn't apply to a microVM with a per-host egress policy.

## How it works

```
model ── browser {action: "click", ref: "e12"} ──▶ BrowserToolHandler (Function App)
  ──▶ the sandbox's exec API: afe-browser click <base64 payload>
    ──▶ driver on 127.0.0.1 in the sandbox ──▶ Chromium on Xvfb
  ◀── URL, title, alerts and the page's elements, each with a ref
```

- The **driver** (`gateway/sandbox-container/browser/`) is a small Node process that holds a headed Chromium on a virtual display. The `afe-browser` command starts it on the first call, and again after the sandbox resumes from a suspend. It exits after `idleShutdownSec` (2 minutes) without a call, freeing memory for code.
- The brain stays stateless: every call is one exec, and the page stays open in the sandbox between calls and turns.
- The Chromium profile lives in `/mnt/data/.browser/`, on the sandbox disk, so cookies and logins survive suspends. Deleting the user's data deletes it with the sandbox.
- The driver runs one action at a time; parallel calls queue. Every action has a deadline (the navigation timeout plus 25 s), so a stuck page can't hold up the next call, and a call whose caller gave up is dropped rather than run late.

### Snapshots and refs

The model works mainly from a **text snapshot** of the page, and takes a [screenshot](#screenshots) when it needs to see it. A snapshot has the URL, title, headings, any alert or status messages (validation errors, "added to cart"), and the elements a person could use, each with a ref:

```
[e12] link "Sign in" → /login
[e31] textbox "Email" type=email value=""
[e33] combobox "Size" value="Medium" options=[Small | Medium | Large]
[e40] button "Place order" (offscreen)
```

- **Refs are stable.** An element keeps its ref for as long as it is on the page; new elements get new numbers. A ref from an earlier snapshot either still means the same element or, if the element is gone, returns an error; it never silently means a different element.
- **In view first.** A snapshot lists up to 200 elements, those in the window first, and says how many it didn't list. `query` searches every element on the page (up to 5,000), listed or not.
- **Frames and web components.** Elements inside the frames a person can see (cookie banners, payment forms and other embeds, cross-origin ones included) are listed with the rest, with refs that start with the frame's id: `[f2e5]` is `e5` in frame `f2`, and the snapshot says which site each frame is from (`Frames: f2 js.stripe.com`). Up to 12 frames are read; hidden ones and tracking pixels are skipped. Elements inside open shadow roots are listed like any other. Closed shadow roots are out of a page script's reach.
- **Human checks are never listed.** Nothing inside a CAPTCHA widget's frame (reCAPTCHA, hCaptcha, Turnstile, Arkose Labs, DataDome) gets a ref, nor does an element that holds one (a click at its centre would land on the checkbox), and the driver refuses an action on such an element even with an older ref. See [Bot walls and human checks](#bot-walls-and-human-checks).
- Passwords and card numbers are shown as `••••`, never their values. A field counts as a card field by its `autocomplete` (`cc-…`), by its name, id, label or placeholder (card number, CVV, expiry, PAN), or by holding a number that passes the card checksum (Luhn); fields inside open shadow roots and editable text areas count too. Page text never carries a card number either.
- When a page has almost nothing to act on (a result page, an error), the start of its text is included.
- Snapshots are cut at `maxSnapshotChars` at a line break, with a note on how to see more.

## What the model gets

One tool, `browser`, with an `action`:

| Action | Does |
|---|---|
| `navigate` | Opens a URL (a bare `example.com` means `https://`) and returns a snapshot |
| `snapshot` | The page as above; `query` keeps only elements containing all its words |
| `click`, `hover` | Click an element, or hover over it to open a menu |
| `type` | Replace a field's value; `submit` presses Enter after it |
| `select` | Choose an option of a `<select>` by label or value. A missing option fails at once and lists the options. Custom dropdowns are clicked instead |
| `upload` | Set a file input to a file under `/mnt/data` |
| `press` | A key or chord, such as `Enter`, `Escape`, `Control+A` |
| `scroll` | Up, down, top or bottom, or to a ref |
| `back`, `wait` | Go back in the tab; wait for text to appear, or for a time |
| `text` | The page's readable text, or a part of it (`selector`); `offset` reads further |
| `tabs`, `tab_open`, `tab_focus`, `tab_close` | Tabs, with ids `t1`, `t2`, … A link that opens a new tab switches to it |
| `screenshot` | Shows the model the page as an image, optionally with refs drawn on it, and gives the user a download link ([Screenshots](#screenshots)) |
| `handoff` | Gives the browser to the user for a login, a CAPTCHA, a second factor or a payment ([Handing the browser to the user](#handing-the-browser-to-the-user)) |
| `reset` | Closes the browser and deletes its profile: cookies, logins and history. Downloads and screenshots in `/mnt/data/browser/` stay |

- **Dialogs.** Alerts are accepted; "Are you sure?" confirms and prompts are declined, unless the action passes `accept_dialogs: true`, which the model is told to do only after the user agreed. Every dialog is reported in the result.
- **Downloads** land in `/mnt/data/browser/downloads/`. An action waits up to 15 s for downloads it starts; a longer one is listed in a later result. Chromium saves PDFs instead of opening them in its viewer.
- **Errors say what to do next**: a ref that has gone, an element something covers (usually a cookie banner or dialog), a field that wants a format (`HH:MM`), a timeout.

### Screenshots

A snapshot can't show images, charts, prices set in pictures, layout, or a banner covering the page. For those the model takes a screenshot and sees it:

- The driver saves two files in `/mnt/data/browser/screenshots/`: a PNG for the user (the window, or the whole page with `full_page`), which comes back as a download link, and a JPEG of the window for the model. The newest 60 files (30 screenshots) are kept.
- With `labels`, each element's ref is drawn on the image, so what the model sees lines up with what it can act on.
- The image travels with the tool's result, in each provider's own form: an image block inside Anthropic's `tool_result`, an `input_image` in the OpenAI Responses `function_call_output`, and, because Chat Completions tool messages are text only, a user message right after the tool messages.
- **Cost.** A 1280×800 screenshot is roughly 1,000–1,500 input tokens, about a long snapshot. The model sees each one in the round it was taken, once; later rounds of the same turn get a note in its place instead of the image. With OpenAI's Responses API, which keeps the conversation on OpenAI's side, an image stays in that conversation's context for later turns too, like an image the user sent. The tool description tells the model not to take a screenshot after every step.
- **Storage.** Screenshots are never written to session history in Cosmos; only the user's message and the final reply are.
- **No screenshot of card details.** While any card field on the page (in any frame, including a payment iframe) holds a value, `screenshot` takes no picture at all, for the model or the user, and says why. After a `payment` handoff, screenshots of that site are withheld until the next `reset`.
- **Models that can't read images.** Set `showScreenshots: false`. The screenshot then only goes to the user as a link, and the model works from snapshots.

## Handing the browser to the user

Some steps are the user's to take, not the agent's: typing a password, solving a CAPTCHA, entering a code sent to their phone, paying. For those the agent calls `handoff` (for a human check, a page's result tells it to; see [Bot walls and human checks](#bot-walls-and-human-checks)) with a `reason` the user reads ("Log in to your Amazon account, then press Done.") and a `kind` (`login`, `captcha`, `2fa`, `payment` or `other`). The user takes over the live browser in the chat, and the agent carries on when they're done. The model is told never to ask for a password or card details, and never to type them itself.

```
agent ── browser {action: "handoff"} ──▶ gateway: a new random group, two tokens that can only join it
  ──▶ driver in the sandbox connects OUT to Web PubSub, streams the page (CDP screencast)
  ──▶ the run pauses on a "browser_handoff" form; web chat shows the live view in it
user clicks and types in the live view ──▶ Web PubSub ──▶ driver ──▶ Chromium
user presses Done ──▶ the run resumes: the agent takes a snapshot and continues
```

- **Relayed, not exposed.** The sandbox takes no inbound connections, and the live view doesn't change that: the driver connects out to the deployment's Web PubSub, as chat replies do. It uses its own hub, `<hub>_browser` (set `handoff.hub` to change it), which has no event handlers, so a handoff token can't reach the chat's upstream events. The gateway issues two tokens for a new random group per handoff, the driver's and the user's, each allowed to join and send to that group only, and valid for the handoff's time limit. The viewer's link, with its token, is delivered on the user's own authenticated real-time connection, in the form; it never passes through the model.
- **Only the user drives, and only the driver speaks.** Web PubSub stamps each message with the sender's user id from their token. The driver accepts input only from the user the handoff was issued to, and only the kinds it recognises (mouse, keys, text, scroll, dialog answers, Done, Cancel). The viewer, in turn, draws and believes only messages from the driver's id, and connects only to this deployment's Web PubSub host (pinned in the page), so a link pointing at another relay is refused.
- **The user sees where they are.** The viewer shows the page's host on its own line, apart from the page title, so a long or misleading title can't hide which site is asking for a password.
- **Nothing reaches the model.** The frames go to the user only. What the user types goes to the browser only. When the agent resumes it reads the outcome (`done`, `cancelled` or `expired`, with the user's `userNote` if the client sent one), and it's told not to redo what the user did and not to screenshot payment forms. Snapshots mask password and card fields, and [card fields block screenshots](#screenshots). Code in the sandbox is another matter: it runs as the same user as the browser, so a script the agent left running there could watch the screen or the keys while the user is in control. The handoff trusts the sandbox as much as the browser itself does.
- **Time limit.** The user has `handoff.maxMinutes` (10 by default, at most 30). The driver ends the live view at the deadline on its own; if the user presses Done more than 30 s after it, the agent is told the view had closed and checks the page. If the user sends a message instead of pressing Done, the handoff is cancelled, the live view is stopped, and the model sees their message.
- **The agent takes the browser back** on its next action: the driver closes the live view first, and releases any key or mouse button the user was holding. A new handoff replaces an old one. If the run is aborted or fails while it waits, the live view is stopped.
- **Dialogs and files.** A "Are you sure?" confirm or a prompt the page opens during the handoff is shown in the viewer, and the user's answer goes back to the page (unanswered, it is declined after 2 minutes). Alerts show as a notice. A file picker can't be shown; the viewer says so, and the user can tell the agent to `upload` the file instead.
- **Light on the sandbox.** Frames are JPEG at quality 55 and at most about 7 a second. If the viewer hasn't been heard from for 30 s (it pings every 10 s), the driver stops sending frames until it is. A burst of mouse moves collapses to the latest, so a click is never stuck behind them; dialog answers and Done jump the queue. The viewer shows "lost connection" when the driver has been silent for 25 s.
- **One handoff per turn, on its own.** The handoff must be the only tool call in its round, and not in a turn that already asked the user something; otherwise the tool refuses and the model asks again on its own.
- **The page.** `GET /api/browser/view` serves the viewer (404 while the browser or the handoff is off, or without Web PubSub). It carries no secret: the relay address and token arrive in the URL fragment, which browsers never send to a server. The page moves them into the tab's session storage and out of the address bar, so a reload reconnects but the link can't be copied from the address bar. It runs only its own script (a hashed Content-Security-Policy), connects only to the relay's `wss:` host, and can be framed by any site (`frame-ancestors *`), since the chat that embeds it may be on any domain; it only listens to `postMessage` from its own parent. It handles mouse, touch (drag to scroll, tap to click), keyboard (Command maps to Control on a Mac, paste works), and a text box for phone keyboards, and it fits the picture to any window size.
- **Web chat** renders the `browser_handoff` form as the live view with Done and Cancel (`examples/web-chat/`). Another client renders it from the form's `proposedArgs.viewerUrl` (an `iframe` is enough) and answers it like any form (`hitlInputResponse` with `{ data: { done: true } }` or `cancelled`).
- **Where it's offered.** Only where forms render and the run can pause on one and resume where it stopped: web chat and apps on the real-time protocol, with Web PubSub and the HITL store configured, on a model through the **OpenAI Responses API** with `chainResponses` on (the default). Resuming a paused tool call needs the provider to keep the conversation, which Anthropic and Chat Completions don't do here. Elsewhere, on Telegram and WhatsApp, and in scheduled runs, the agent is told to tell the user what they need to do instead. A handoff counts as one browser action, plus a `browserHandoff` unit for `credits.unitCoins`.

## Turning it on

The browser runs in the sandbox, so it needs skills and sandboxes on, with the ACA Sandboxes backend (`agentforeach:sandboxEnabled true`, the default `sandboxProvider`). Then:

1. **Build a disk image with the browser.** It adds Chromium, Xvfb, fonts and the driver to the [usual image](Sandbox.md#building-the-disk-image), about 1 GB more (if you set `sandboxes.disk`, it must fit):

   ```bash
   npx tsc -p gateway
   ACA_SANDBOX_SUBSCRIPTION_ID=... ACA_SANDBOX_RESOURCE_GROUP=... \
   ACA_SANDBOX_GROUP=... ACA_SANDBOX_REGION=... \
   SANDBOX_IMAGE_BROWSER=1 node scripts/build-aca-sandbox-image.mjs
   pulumi config set agentforeach:sandboxDiskImageId <printed id>
   ```

   The build boots the image with egress denied and checks that Chromium starts. For the weekly rebuild, set the repository variable `SANDBOX_IMAGE_BROWSER` to `1`.

   **Existing sandboxes keep the image they were created from.** A user whose sandbox predates the browser image gets "This sandbox has no browser" until their sandbox is deleted (by `autoDeleteDays`, or by you) and recreated.

2. **Turn it on:** `pulumi config set agentforeach:sandboxBrowserEnabled true`, which sets the `SANDBOX_BROWSER_ENABLED` app setting, or `skills.sandbox.browser.enabled: true` in `agentforeach.json`. The app setting wins when it is set (`true`, `1` or `yes` turn it on; anything else off); setting the Pulumi key to `false` sets nothing, so `agentforeach.json` decides.

3. **Choose what the browser can reach** ([below](#what-the-browser-can-reach)) and **who gets it** ([below](#who-gets-it-and-what-it-costs-them)), then `pulumi up`.

The browser doesn't change the sandbox size. Chromium with real pages open fits the default 1 vCPU and 2 GiB (the sandbox used about 530 MB on BBC News). A bigger size (`skills.sandbox.sandboxes.cpu` and `memory`) loads heavy pages faster, but it costs more for every running second of every user's sandbox, code included, and uses more of the region's "Sandbox Cores" quota. Sandboxes keep the size they were created with.

## Guardrails

A browser costs sandbox time and, above all, model tokens: each snapshot is up to `maxSnapshotChars` of input. The defaults keep both small:

| Guardrail | Default | Stops |
|---|---|---|
| `maxActionsPerTurn` | 30 | A runaway click loop in one run. At the cap the tool refuses and tells the model to answer with what it has; the user can ask it to carry on |
| `maxActionsPerScheduledRun` | 10 | The same in a scheduled run: a `main` job or heartbeat delivered into the user's session. A run resumed after the user answers `request_user_input` is not a scheduled run |
| `rateLimit.browser` | 30 a minute, 300 a day per user | Heavy use across all of a user's chats and jobs. Counted in Cosmos, shared by every instance, and fails open like the message limit. `0` means no limit; `rateLimit.enabled: false` turns it off with the other limits |
| `maxSnapshotChars` | 8,000 (at most 40,000) | Large snapshots. The model can ask for just the elements it needs with `query` |
| `idleShutdownSec` | 120 | An idle browser holding memory. The sandbox also suspends after `autoSuspendSec` (300 s) idle, which stops billing |

The caps count per run: a conversation turn that pauses for the user's answer and resumes gets a fresh count in the resumed run. Refused and invalid calls don't use up a cap. The tool description also tells the model to prefer `web_fetch` or `http_fetch` for plain reading.

```json
{
  "rateLimit": { "browser": { "perMinute": 30, "perDay": 300 } },
  "skills": { "sandbox": { "browser": { "maxActionsPerTurn": 30, "maxActionsPerScheduledRun": 10 } } }
}
```

## Who gets it, and what it costs them

**Only some users.** List them in `skills.sandbox.browser.users`, for a pilot group or the users on a paid plan. Everyone else is never offered the tool, so it costs them nothing, not even the tool's description in the prompt. Without `users`, every user gets the browser. An empty list offers it to nobody.

```json
{ "skills": { "sandbox": { "browser": { "enabled": true, "users": ["user-id-1", "user-id-2"] } } } }
```

The list holds the same user ids the rest of AgentForEach uses (the `userId` a request runs as). It applies to chats and scheduled jobs alike. A change takes effect when the Function App reloads its config.

**Charging for it.** With [credits](../gateway/credits/) on, a run is charged for its tokens. `credits.unitCoins` adds a price per browser action:

```json
{ "credits": { "enabled": true, "unitCoins": { "browserAction": 1 } } }
```

An action counts when the browser carried it out, even if it failed on the page (a ref that had gone, a site that timed out). Invalid calls, calls a guardrail refused and calls that never reached the browser (no browser in the image, the sandbox unavailable) are free. The charge is added to the run's single settlement, for completed, aborted, paused (`awaiting_input`) and failed runs alike:

`coins = max(minimumCharge, round(token cost × costMultiplier + browser actions × unitCoins.browserAction))`

Prices must be numbers of coins, 0 or more; anything else is ignored with a warning. Without `unitCoins`, browsing is free apart from the tokens it uses.

## What the browser can reach

The browser shares the sandbox's egress policy with code, because the policy applies to the whole sandbox.

- **`networkAccess: "enabled"`** lets the browser open any public site. Code in the sandbox gets the same access. This is the setting for general browsing.
- **`networkAccess: "disabled"`** (the default) allows only `skills.sandbox.sandboxes.egressAllowHosts`. Pages on those hosts load, but images, scripts and fonts from other hosts don't, so most real sites break. Use it only for a few known sites.

In every mode, the sandbox can't reach private addresses, link-local addresses (including the metadata endpoint), or Azure's internal address `168.63.129.16`; we measured this on a live sandbox group. The browser adds its own checks: it refuses non-http(s) URLs, local host names, and names that resolve to local or private addresses, whether the agent opens them or a page redirects there.

The egress proxy inspects TLS by re-signing it with its own certificate authority, which the platform writes into the sandbox at boot. The driver imports it into Chromium's certificate store on every start; without it, every HTTPS page fails with `ERR_CERT_AUTHORITY_INVALID`. How much the proxy re-signs depends on the policy the sandbox client sends:

| Policy | Inspection | TLS |
|---|---|---|
| Open, no credential rules | Not set (the service's default) | Measured: every host re-signed |
| Open, with credential rules | `Partial` | Only hosts with a credential rule are re-signed; others pass through with the site's own certificate |
| Deny, with or without credential rules | `Full` | Every host re-signed |

A change to the egress policy (for example, a credential revoked mid-conversation) doesn't close connections the browser already has open; `reset` starts a clean browser. Chromium runs with `--disable-quic`, so all its traffic goes through the TCP proxy.

## Security

- **Isolation.** Each user's browser is in their own microVM; users never share a browser.
- **Page content is untrusted.** Snapshots, text, titles and notes are marked as page content in the tool result, and the tool description tells the model never to follow instructions found on a page, to confirm irreversible steps with the user (`request_user_input`), and, when it can't ask (a scheduled run), not to take them.
- **Credentials a page could borrow.** The egress proxy adds a skill's credential to every request to the hosts it is bound to, whoever sends it. So the driver blocks requests to those hosts that a page makes itself (its scripts, images, frames); only a page the agent opens directly may go there, which is the same access `http_fetch` has. The gateway sends the list of bound hosts with every call. WebSocket connections aren't covered by this block.
- **The driver's port.** The driver listens on `127.0.0.1` inside the sandbox and refuses any request without its random token, so a web page can't drive it. Code in the sandbox runs as the same user and can read the token, so it can drive the browser too.
- **Nothing the model writes reaches the shell.** The action comes from a fixed list, and every argument travels base64-encoded. Uploads are limited to files under `/mnt/data`.
- **Cookies and logins live in the sandbox.** Sandbox commands run as root and Chromium runs with Playwright's defaults for root (`--no-sandbox`), so code the model writes, or a page that exploited Chromium, could read them. That is the user's own data, but a prompt-injected agent could leak it: keep `requireCredentialHosts` on, and don't give the agent both open egress and logins it doesn't need.
- **A crash never repeats an action.** If the driver dies mid-action, the call returns an error ("the browser stopped during this action") rather than sending the action again, so a submit can't happen twice.
- **Handing off.** The user's live view is relayed through Web PubSub, on a hub of its own, with tokens scoped to one handoff; the viewer only talks to this deployment's relay and only believes the driver. Code in the sandbox can see what the user does in the live view. See [Handing the browser to the user](#handing-the-browser-to-the-user).
- **Deleting a user** deletes their sandbox, and with it the browser profile.

## Limits

- **Bot walls.** Some sites block or challenge browsers on cloud IP addresses. In our tests Reddit, IRCTC, Stack Overflow and Booking.com did; Google, Bing, BBC, Amazon.in, Flipkart, GitHub, Wikipedia, LinkedIn and Hacker News worked. The proxy also adds `x-adc-proxy` and `traceparent` headers. See [Bot walls and human checks](#bot-walls-and-human-checks).
- **Frames.** Up to 12 visible frames are read per snapshot; a page with more says how many it left out. Closed shadow roots (some web components) can't be read.
- **Handoff on message channels.** Telegram and WhatsApp can't show the live view yet; sending the viewer link straight to the chat, without it passing through the model, is a follow-up.
- **Late navigations.** After an action the driver waits for the page to settle (up to about 1.6 s of quiet); a page that navigates later shows the new page on the next call.
- **Startup.** Chromium starts in 0.35–0.5 s; the first call in a fresh sandbox takes about 5 s (Xvfb, the driver, Chromium and the page). After a suspend, add the resume (about 1.5 s).
- **Scheduled jobs.** A `main` job (delivered through the heartbeat queue into the user's session) gets the browser with the lower per-run cap. An `isolated` job (the default) is a single model call with no tools at all, so it can't browse, or fetch anything else; see [the scheduler](Crons.md#51-isolated-jobs).

## Bot walls and human checks

AgentForEach doesn't try to get around bot checks. The tool tells two kinds of wall apart, and the model is told never to retry either one:

- **`challenge`**: the page asks for a check a person can pass. This means a visible reCAPTCHA or hCaptcha checkbox that isn't ticked yet, a CAPTCHA puzzle on screen, an Arkose Labs or DataDome check, Cloudflare's "Just a moment" page or its `cf-mitigated: challenge` header, PerimeterX's "Press & Hold", DuckDuckGo's and Amazon's checks. Where a [handoff](#handing-the-browser-to-the-user) can happen, the agent asks the user what to do: **Give me the browser**, **Always give me the browser**, **Skip this site** or **Always skip these**. Handing over opens the live view (kind `captcha`); skipping carries on without the page. An "Always" answer is saved as one of the user's preferences (`USER.preferences`, the same list as any other preference they state, like "prefers coffee over tea"), which is in every prompt, so the next check goes straight to the live view, or is skipped, without asking. The user can change it by saying so. Elsewhere (a scheduled run, Telegram, WhatsApp, a model without handoff) the agent tells the user the site wants a human check. The agent itself can't click the check: it isn't in snapshots, and the driver refuses actions on it.
- **`blocked`**: the site refused (an empty 403, a 429, Akamai's "Access Denied", Reddit's network block). The model tells the user they can open the page themselves.

An invisible reCAPTCHA badge or a Turnstile widget that passes on its own isn't a challenge. A ticked checkbox isn't one either.

## What we measured

On a live ACA Sandboxes group in Central India (September 2026), with the image from `SANDBOX_IMAGE_BROWSER=1`:

| | Result |
|---|---|
| Chromium start | 0.35–0.5 s warm; about 5 s for the first call in a fresh sandbox |
| Heavy page (BBC News) at 1 vCPU / 2 GiB | Loaded in 2.1 s; 529 of 2,218 MB of the sandbox's memory in use |
| Resume after a suspend | About 1.5 s; the first page after it about 4.7 s, cookies intact |
| Image size | About 1 GB more than the plain image (Chromium itself is about 390 MB) |
| Reachability | No private, link-local or Azure-internal address was reachable in any egress mode |
| Credential injection | The proxy's header reached the page's server; the secret never entered the sandbox |
| Handoff, from the sandbox through the egress proxy to Web PubSub | First frame at the user in about 0.8 s; the user's typing reached the page |
| Handoff relay throughput (spike) | 60–80 KB frames at 5–8 a second without loss, in open and deny-by-default egress; input round trip about 75–80 ms |

Screenshots reaching the model, and the tool driving a real model, were checked with `gpt-5-mini` on Azure AI Foundry (October 2026), through the gateway's own providers, handler and driver:

| | Result |
|---|---|
| Screenshot in an OpenAI Responses `function_call_output` | The model read the ref drawn on a button (`e4`) and described the picture: 2,799 input tokens for that round |
| Screenshot after a Chat Completions tool message | Same answers: 2,346 input tokens |
| Agent loop: find a Wikipedia article, read a fact, describe its main photo | Done in 7 actions (navigate, query, text, click, screenshot), about 44,000 input tokens across rounds |
| Agent loop: fill and submit an order form | Asked for confirmation first; with the user's consent, done in 7 actions (type, three clicks, a time field, submit), about 19,500 input tokens |

The Anthropic form (an image block inside `tool_result`) follows Anthropic's documented format and is unit-tested, but hasn't been run against a live Claude model yet.

The proxy dropped connections to some hosts for a minute or two once, for `curl` as much as the browser, so the driver retries a navigation once after a dropped connection (`ERR_CONNECTION_CLOSED`, `_RESET`, `ERR_EMPTY_RESPONSE`, `ERR_TIMED_OUT`) when there is time left.

## Testing

- **Unit tests** (in `npm test`, or `npm run test:browser` in `gateway/`): the tool's argument checks, the command it builds, how results reach the model, the guardrails, metering, access and config (`skills/browser/handler.test.ts`), and the driver's URL guard, bot-wall and human-check detection, error messages, card-number masking and which viewer input it accepts (`sandbox-container/browser/guard.test.mjs`).
- **Live test** against a real group: build first (`npx tsc -p gateway`), then run `scripts/test-browser-live.mjs` with the four `ACA_SANDBOX_*` variables and `ACA_SANDBOX_DISK_IMAGE_ID` (an image built with the browser). It drives the same path as the agent: search by ref, text, a labelled screenshot, refused local addresses, the driver token, a heavy page at the default size, cookies across a suspend, and `reset`. With `WEBPUBSUB_CONNECTION_STRING` set it also hands the browser to a user: frames stream out through the sandbox's egress, and the script, playing the user, types into the page and presses Done.
- **The driver on your machine**, headless, without Azure (the lock file this creates is git-ignored):

  ```bash
  cd gateway/sandbox-container/browser && npm install && npx playwright-core install chromium
  export AFE_BROWSER_HEADLESS=1 AFE_BROWSER_DATA_DIR=/tmp/afe-data AFE_BROWSER_RUN_DIR=/tmp/afe-run
  node cli.mjs navigate "$(printf '{"args":{"url":"https://example.com"}}' | base64)"
  node cli.mjs reset      # stops the driver and clears its profile (it also stops after 2 idle minutes)
  ```

## Troubleshooting

| Symptom | Cause |
|---|---|
| "This sandbox has no browser" | The sandbox's image wasn't built with `SANDBOX_IMAGE_BROWSER=1`. Existing sandboxes keep the image they were created from; delete them to pick up a new one |
| Every page fails with `ERR_CERT_AUTHORITY_INVALID` | Chromium doesn't trust the proxy's CA. The driver imports it from `/etc/ssl/certs/adc-egress-proxy-ca.crt` at start; check that the file exists and `certutil` is installed |
| Pages load without images or styles | Deny-mode egress: the page's other hosts aren't in `egressAllowHosts` |
| `blocked: true` | The site's bot protection refused the cloud IP |
| `challenge` in a result | The page asks for a human check; the agent hands the browser to the user, or tells them where it can't ([Bot walls and human checks](#bot-walls-and-human-checks)) |
| "Something on the page covers this element" | A cookie banner, dialog or menu is in the way; the agent can close it, including one in a frame (its refs start with the frame's id) |
| A run fails after a screenshot with an error about images | The model can't read images (some models behind a Chat Completions endpoint). Set `showScreenshots: false` |
| "The browser stopped during this action" | The driver or Chromium crashed; the next call starts a new one. Check memory, and `/tmp/afe-browser/driver.log` |
| "The action took longer than N s and was stopped" | A page that never finished loading; raise `navigationTimeoutSec` if your sites are slow |
| The browser did not start | The driver's log is `/tmp/afe-browser/driver.log` in the sandbox (read it with `sandbox_exec`) |
| The tool isn't offered | The browser is off, the user isn't in `users`, or the backend isn't ACA Sandboxes |
| "The live view could not connect" | The sandbox can't reach Web PubSub. With deny-by-default egress the gateway adds the host from `WEBPUBSUB_CONNECTION_STRING` to the allowlist; existing sandboxes pick it up on their next call |
| The agent never offers a handoff | The handoff needs the OpenAI Responses API with `chainResponses` on, a client that renders forms (not Telegram or WhatsApp), Web PubSub and the HITL store |
| The handoff form shows no picture | The viewer page couldn't join the group: its token expired (after `maxMinutes`), or the gateway's address (`handoff.viewerBaseUrl`, else `WEBSITE_HOSTNAME`) isn't reachable from the user's browser |

## Not built yet

- **Handoff on Telegram and WhatsApp**, by sending the viewer link straight to the chat.
- **Browser access by role or plan**, rather than a list of user ids. Roles don't reach the agent runner today, and scheduled runs have none.
- **Tools in isolated scheduled jobs.** They are a single model call; see [the scheduler](Crons.md#51-isolated-jobs).

## Configuration

`skills.sandbox.browser` in `agentforeach.json` (defaults in `skills/config.ts`):

| Key | Default | Notes |
|---|---|---|
| `enabled` | `false` | `SANDBOX_BROWSER_ENABLED` overrides it when set |
| `actionTimeoutSec` | 30 | Typing, waits; clicks and key presses wait at most 15 s |
| `navigationTimeoutSec` | 45 | Opening a page; every action is stopped 25 s past it |
| `maxSnapshotChars` | 8,000 | Longest snapshot or text returned to the model (at most 40,000) |
| `viewport` | `{ "width": 1280, "height": 800 }` | Window and screenshot size |
| `idleShutdownSec` | 120 | The browser closes after this long without a call; the next call starts it again |
| `maxActionsPerTurn` | 30 | Browser actions per run |
| `maxActionsPerScheduledRun` | 10 | Browser actions per scheduled run |
| `showScreenshots` | `true` | Show screenshots to the model as images; turn off for models that can't read images |
| `handoff.enabled` | `true` | Let the agent hand the browser to the user (needs Web PubSub and the HITL store) |
| `handoff.maxMinutes` | 10 | How long the user has, at most 30 |
| `handoff.hub` | `<hub>_browser` | The Web PubSub hub for live views: letters, digits and underscores only. Keep it apart from the chat hub |
| `handoff.viewerBaseUrl` | this Function App | Where the viewer page is served, if not at `https://$WEBSITE_HOSTNAME` |
| `users` | (everyone) | The only user ids offered the browser |

The per-user limit is `rateLimit.browser` (`perMinute` 30, `perDay` 300). The price per action is `credits.unitCoins.browserAction` (none by default).

## Code

`gateway/skills/browser/` (the tool, its checks, config types and the live view page, served by `gateway/handlers/browser-view.ts`) and `gateway/sandbox-container/browser/` (the driver with its handoff relay, the `afe-browser` command, the in-page snapshot and the URL guard). The browser runs through `SandboxToolHandler.runCommand`, so it gets the same per-turn credential rewrite as `sandbox_exec`. Live test against a real group: `scripts/test-browser-live.mjs`.
