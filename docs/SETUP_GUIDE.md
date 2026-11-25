# ENGAGE: setup guide

This guide covers your own copy of ENGAGE: what each part is, what you set up yourself in
Azure, and how a change goes from your computer to the live site. It's written so you can
follow it without prior Azure experience.

---

## 1. The big picture

ENGAGE is one web page (`dist/Engage.html`) that does all its work in the browser.
Project data stays in the browser and in the project files people save. There is no
central project database.

Hosting it on the internet adds three things around the page:

| Part | What it does | Where it lives |
|---|---|---|
| **Sign-in page** (`web/index.html`) | Asks for an email address and the 6-digit code | Azure Static Web App |
| **Sign-in service** (`api/`) | Emails codes, checks them, keeps the approved list, and hands out ENGAGE only to signed-in people | The Static Web App's built-in API (Azure Functions) |
| **Admin page** (`web/admin.html`) | Lets administrators approve users and add administrators | Azure Static Web App |

Two small Azure services support the sign-in service:

- **Azure Table Storage** (inside a *Storage account*) holds the approved list, the
  administrators, the current codes and a record of every admin change.
- **Azure Communication Services Email** sends the code emails.

The ENGAGE page itself is never published as a plain file. The sign-in service hands it
out only to someone with a valid session. Without signing in, `/app` sends you back to
the sign-in page.

```
 Browser ──► https://<name>.azurestaticapps.net/           sign-in page (public)
         ──► /api/auth/request   {email}                     emails a code if approved
         ──► /api/auth/verify    {email, code}               sets a 3-hour session cookie
         ──► /app                                            ENGAGE (only with a session)
         ──► /admin.html                                     approved users (admins only)
```

### Sign-in rules

- Only approved addresses get a code. Everyone gets the same answer, after the same
  delay (about 4 seconds), so nobody can use the sign-in page to find out who is approved.
- A code has 6 digits, lasts 10 minutes, works once, and allows 5 wrong attempts.
  There must be at least 45 seconds between codes, with at most 5 codes an hour per
  address and 30 requests an hour per visitor.
- A session lasts 3 hours. Approval is checked on every request, so removing
  someone takes effect immediately.
- **Permanent administrators** are set in the Azure configuration (`ADMIN_EMAILS`). They
  can add other administrators. **Added administrators** can manage the approved list,
  but they can't add or remove administrators.

### What it costs

| Item | Plan | Expected cost |
|---|---|---|
| Static Web App, including the API | Free | 0 |
| Storage account (Table Storage) | Standard, locally redundant | a few cents a month |
| Communication Services Email | Pay as you go | a fraction of a cent per email |

Section 8 shows how to set a budget alert, so you're told if anything ever costs more
than you expect.

---

## 2. What's in the repository

| Path | What it is |
|---|---|
| `src/Engage.html` | The main app (edit this) |
| `src/ProjectBrief.html` | The Project brief app, shown inside the main app (edit this) |
| `data/register.json`, `data/statutory.json` | The interface register and statutory approvals register |
| `VERSION` | The version label and build date (the one place the version is set) |
| `tools/build.py` | Joins the above into `dist/Engage.html` |
| `tools/dev_server.js` | Runs the whole site on your computer, with codes printed instead of emailed |
| `tests/` | Browser tests of the app and of sign-in |
| `api/` | The sign-in service and its tests |
| `web/` | The sign-in page, the admin page and the Static Web App settings |
| `.github/workflows/test.yml` | Runs every test on every push |
| `.github/workflows/deploy.yml` | Builds, tests and deploys when `main` changes |

---

## 3. Working on your computer

You need **Python 3** and **Node.js 20 or later**.

```
python3 tools/build.py                 # builds dist/Engage.html
npm ci && npx playwright install chromium
npm test                               # builds, then runs the app tests
cd api && npm ci && npm test           # sign-in service tests
```

To try the whole site with sign-in:

```
node tools/dev_server.js 8788
```

Open http://localhost:8788 and sign in as `admin@example.com`. The code is printed in
the terminal window. Use `ADMIN_EMAILS=you@example.com node tools/dev_server.js` to
choose a different first administrator.

To open the app on its own without sign-in, open `dist/Engage.html` in a browser.

---

## 4. Setting up Azure (one time, about 45 minutes)

Do this in the [Azure portal](https://portal.azure.com) while signed in to your personal
Azure account. Where a step says **write down**, keep the value somewhere private, such
as a password manager. Never put those values in the repository or in an email.

### 4.1 A subscription and a resource group

1. If you don't have a subscription yet, create one (*Subscriptions → Add*). Pay-As-You-Go
   is fine.
2. Search for **Resource groups** and choose **Create**. Name it `rg-engage` and pick a
   region near you, for example *UAE North*. A resource group is just a folder that
   keeps all the ENGAGE pieces together, which makes costs easy to see and the
   pieces easy to remove.

### 4.2 The Static Web App

1. Search for **Static Web Apps** and choose **Create**.
2. Resource group `rg-engage`, name `engage-design-assurance`, plan type **Free**.
3. Under *Deployment details*, choose **Other**. GitHub Actions deploys it, using
   the workflow already in the repository.
4. Choose **Review + create**, then **Create**.
5. Open the new resource. On *Overview*, **write down the URL**
   (`https://<something>.azurestaticapps.net`). That is your site's address.
6. Choose **Manage deployment token** and **write down the token**.

### 4.3 The Storage account (for Table Storage)

1. Search for **Storage accounts** and choose **Create**.
2. Resource group `rg-engage`. The name must be lowercase letters and numbers only and
   unique across Azure, for example `stengage` followed by a few digits.
3. Primary service: *Azure Table Storage* (or leave it as the default). Performance
   **Standard**, redundancy **Locally-redundant storage (LRS)**.
4. On the *Advanced* tab, keep *Require secure transfer* on and *Minimum TLS version*
   1.2.
5. Create it, then open it and go to **Security + networking → Access keys**.
   **Write down the Connection string** for key1.

You don't need to create any tables. The sign-in service creates them the first time it
runs.

### 4.4 Email (Communication Services)

You need two linked resources:

1. Search for **Email Communication Services** and choose **Create**. Use resource group
   `rg-engage`, name `acsmail-engage`, data location for example *Europe*.
2. Open it, go to **Provision domains**, and choose **Add domain → Azure managed
   domain**. In a minute or two you get an address ending in `.azurecomm.net`.
   Open the domain and **write down the MailFrom sender address**
   (`DoNotReply@xxxxxxxx.azurecomm.net`).
3. Search for **Communication Services** and choose **Create**. Use resource group
   `rg-engage`, name `acs-engage`, and the same data location.
4. Open `acs-engage`, go to **Email → Domains**, choose **Connect domain** and pick the
   Azure managed domain from step 2.
5. Still in `acs-engage`, go to **Settings → Keys**. **Write down the Connection string**
   (Primary).

The Azure managed domain can send a few hundred emails an hour, which is far more than
sign-in needs. Later you can switch to your own domain, so emails come from your own
address, without changing any code.

### 4.5 A session secret

The sign-in service needs one long random value, which it uses to sign sessions and
protect stored codes. Create it once. In a terminal:

```
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

**Write it down.** If it ever changes, everyone is signed out and every code already
sent stops working. Nothing else is lost.

### 4.6 Tell the sign-in service its settings

Open the Static Web App, go to **Settings → Environment variables**, and add these
(*Production* environment). Then choose **Apply**.

| Name | Value |
|---|---|
| `SESSION_SECRET` | the value from 4.5 |
| `ADMIN_EMAILS` | your own email address. You can list more, separated by commas. These are the permanent administrators. |
| `ENGAGE_ALLOWED_ORIGIN` | the site address from 4.2, with no trailing slash |
| `ENGAGE_TABLES_CONNECTION` | the Storage connection string from 4.3 |
| `ACS_EMAIL_CONNECTION_STRING` | the Communication Services connection string from 4.4 |
| `ACS_EMAIL_SENDER` | the MailFrom address from 4.4 |
| `AUTH_ALLOWED_DOMAINS` | *optional.* For example `aecom.com`, to allow only addresses at that domain. Leave it out to allow any address you approve. |

The service checks these settings when it starts. If one is missing or wrong, the
sign-in page shows "The sign-in service is not configured yet". It never runs half set
up. The development switches (`ENGAGE_DEV_*`) are refused in Azure even if someone adds
them.

### 4.7 Connect GitHub to Azure

1. On GitHub, open the repository and go to **Settings → Secrets and variables →
   Actions**, then choose **New repository secret**.
2. Name it `AZURE_STATIC_WEB_APPS_API_TOKEN` and paste the deployment token from 4.2.
   Make sure no space or line break comes along with it. A stray line break was the
   reason v133's first deployment failed.

### 4.8 The first deployment

1. On GitHub, open **Actions → Deploy to Azure → Run workflow** (or merge a pull request
   into `main`).
2. The workflow builds ENGAGE, runs all the tests, and uploads the site and the
   sign-in service. It takes about 5 minutes.
3. Open your site address, enter your own email (the one in `ADMIN_EMAILS`), and sign in
   with the code from your inbox. Check the junk folder the first time.
4. Open `/admin.html` and approve your colleagues' addresses.

---

## 5. Day to day

| Task | How |
|---|---|
| Give someone access | `/admin.html` → *Approved users* → add their address |
| Remove someone | `/admin.html` → *Remove*. They're signed out immediately. |
| Add an administrator | `/admin.html` → *Administrators* (permanent administrators only) |
| Change a permanent administrator | Azure → Static Web App → *Environment variables* → `ADMIN_EMAILS` |
| Change the app | Edit `src/` on a branch, open a pull request, check that the tests pass, merge. The deploy workflow publishes it. |
| Change the version | Edit `VERSION`: line 1 is the label (e.g. `v134`), line 2 is the date |

Project data is not stored in Azure. Each person's work stays in their browser, so they
should keep using **Save** to keep a project file. A project kept in a browser at another
address moves to the live site with **Save** there and **Open** here.

---

## 6. Checks after a deployment

- `https://<site>/app` with no session takes you to the sign-in page.
- An address that isn't approved gets the usual message, and no email arrives.
- Your own address gets a code, and signing in opens ENGAGE.
- `/admin.html` lists you as a permanent administrator.

---

## 7. If something goes wrong

| Symptom | Likely cause |
|---|---|
| "The sign-in service is not configured yet" | A setting in 4.6 is missing or mistyped. Azure → Static Web App → *Environment variables*. |
| The deploy workflow says "nothing is deployed" | The GitHub secret from 4.7 is missing |
| The deploy step fails with an authorisation error | The token has a stray space or line break. Store it again. |
| The code email never arrives | The sender address or the domain connection in 4.4 is wrong, or the email is in junk. Azure → `acs-engage` → *Monitoring → Logs* shows each send. |
| Every request is refused (403) | `ENGAGE_ALLOWED_ORIGIN` doesn't exactly match the site address |

---

## 8. Keeping costs visible (recommended)

Azure portal → **Cost Management → Budgets → Add**. Set the scope to `rg-engage`, the
amount to 5 a month, and alerts at 80% and 100% of actual cost and 100% of forecast,
sent to your email. Alerts only notify you. They never stop the site.

---

## 9. What this setup does not do

- There is no shared project store. Each person's project lives in their browser and in
  the files they save. Logs inside a project file are a working record, not a
  tamper-proof audit trail.
- Sign-in controls who can open the tool. It doesn't control what someone does with a
  project file once they have it.
- These limits are the same as in v133 and are known: response timing is reduced
  but not perfectly constant, a failed clean-up can leave an unusable code until it
  expires, and the outcome line of an admin record can fail to write after its
  "requested" line.
