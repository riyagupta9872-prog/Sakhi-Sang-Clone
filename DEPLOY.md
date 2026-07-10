# Deploying Online Sang to a new GitHub account/repo

This app has **no build step** (plain HTML/CSS/JS, no Vite/webpack/npm). Every
script, stylesheet, icon, and manifest reference in this repo already uses a
**relative path** (`js/config.js`, not `/js/config.js`) — so cloning this repo
into any GitHub account, under any repo name, and enabling Pages "just works."
There is nothing to rebuild and nothing to reconfigure per-deployment.

## One-time steps on a fresh clone/account

### 1. GitHub Pages
Repo → **Settings → Pages** → Source: **Deploy from a branch** → Branch:
**main**, folder **/(root)** → Save.

That's it — no workflow file needed. GitHub will publish at
`https://<account>.github.io/<repo-name>/` and every asset will resolve
correctly no matter what `<account>`/`<repo-name>` turns out to be, because
nothing in the app hardcodes either.

### 2. Firebase project
This app talks to Firebase (Firestore + Auth), configured in
[js/config.js](js/config.js). For a genuinely separate client:

1. Create a new Firebase project in the [Firebase Console](https://console.firebase.google.com/).
2. **Authentication → Sign-in method** → enable **Email/Password**.
3. **Firestore Database** → create the database → **Rules** tab → paste in
   [firestore.rules](firestore.rules) → Publish.
4. Copy the new project's config object (Project Settings → your web app) into
   the `firebaseConfig` object at the top of `js/config.js`, replacing the
   existing one.
5. **Authentication → Settings → Authorized domains** → add the new
   `<account>.github.io` domain. Firebase blocks sign-in from domains it
   doesn't recognize — this is the actual security-relevant step, not hiding
   the config values (see below).
6. Sign up as the first user in the deployed app — the first signup ever
   automatically becomes `superAdmin`.

### 3. Push to main
Push your changes (including the new `firebaseConfig`) to `main`. Pages
redeploys automatically within a minute or two of every push — no workflow to
trigger, no build to wait on.

## Why the Firebase keys are left in plain sight

`js/config.js`'s `apiKey`/`projectId`/etc. are **not secrets** — Firebase's own
docs say this config is meant to be public in client-side apps, the same way
every Firebase web app that has ever shipped has it visible in the browser.
The actual access control is `firestore.rules`, which checks *who's logged in*
and *what they're allowed to do* — not whether someone can see the config
object. Moving these values into GitHub Actions secrets would add a manual
step to every deployment without adding real protection, and since this app
has no build step, there'd be no mechanism to "inject" them at deploy time in
the first place.

## What you should NOT need to touch

- No `vite.config.js` — doesn't exist, this isn't a bundled app.
- No `VITE_BASE_PATH` or any base-path variable — every path is already
  relative, this class of bug can't happen here.
- No `.github/workflows/deploy.yml` — "Deploy from a branch" needs none.
- `sw.js`'s service worker registers with a relative path (`sw.js`) and its
  cache key is unrelated to the domain — bump the `CACHE` version string only
  when you ship new code, not per-deployment.
