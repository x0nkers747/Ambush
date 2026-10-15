# Deploying Ambush! to GitHub Pages

Ambush! is a static site: the browser does everything, including generating battlefields from
the public map services. GitHub Pages serves the built files; nothing runs on a server.

## Website address

**https://x0nkers747.github.io/Ambush/**

The path is the repository's name, and it is case-sensitive: `/Ambush/`, not `/ambush/`.

## One-time setup

1. **Make the repository public** (Settings → General → Danger Zone → Change visibility). On a
   free GitHub account, Pages only works for public repositories. A paid plan (Pro, Team or
   Enterprise) can publish from a private repository, but the website is public either way.
2. **Enable Pages from GitHub Actions:** Settings → Pages → Build and deployment → Source:
   **GitHub Actions**.
3. **Run the workflow once** (see "Deploying by hand" below), or push a commit to `main`.

## How deployment works

`.github/workflows/deploy-pages.yml` runs on every push to `main` and when started by hand:

1. installs the dependencies from `package-lock.json` (`npm ci`, Node.js 24), and the
   character-animation prototype's, which the check lints;
2. runs `npm run check`: typecheck, lint, all tests and the formatting check;
3. builds the site (`npm run build`);
4. uploads `dist/` and deploys it to Pages.

If the check or the build fails, nothing is deployed and the site keeps the previous version.
Deployments run one at a time; a push made during a deployment waits for it.

The site's base path is set at build time (`vite.config.ts`): in GitHub Actions it is
`/<repository>/`, from the repository's name, so renaming the repository needs no code change.
`npm run dev` always serves at `/`, as before.

## Deploying by hand

Actions → **Deploy to GitHub Pages** → **Run workflow** → branch `main` → **Run workflow**.

## A failed deployment

Actions → **Deploy to GitHub Pages** → the failed run → the failed job and step. The usual
causes:

- **Check (typecheck, lint, tests, formatting):** the same failure `npm run check` shows
  locally. Fix it and push.
- **Configure GitHub Pages** fails with "Get Pages site failed": Pages is not enabled with the
  GitHub Actions source (one-time setup, step 2), or the repository is private on a free account.
- **Deploy:** Settings → Environments → `github-pages` may restrict which branches may deploy;
  `main` must be allowed.

## Rolling back

- **Revert and push (recommended):** `git revert <bad commit>` then `git push`. The workflow
  deploys the reverted code.
- **Redeploy an older version quickly:** Actions → **Deploy to GitHub Pages** → open the run of
  the last good commit → **Re-run all jobs**. It deploys that commit's code. The next push to
  `main` deploys the latest code again.

## Limitations

- **Saved battlefields and scenarios live in each browser** (IndexedDB), per website address.
  Battlefields generated at `localhost:5173` do not appear on the GitHub Pages site, nothing is
  shared between browsers or devices, and clearing the browser's site data deletes them. There is
  no server-side storage.
- **Generating a battlefield needs the internet:** elevation from AWS Terrain Tiles, buildings
  from Overture Maps, features from OpenStreetMap (Overpass) and place search from Nominatim, all
  free public services called directly from the visitor's browser, under their fair-use limits.
  The Overpass server is often slow at first (HTTP 504) and is retried for up to about three
  minutes. A saved battlefield opens without the network.
- **Reloading in stages 3 to 5 restarts the exercise** (plans are not stored), as in local use.
- **Browsers:** a current Chromium-based browser, Firefox or Safari (ES modules, module Web
  Workers, IndexedDB, `DecompressionStream`).

## A custom domain later

1. Add the domain in Settings → Pages → Custom domain, and create the DNS records GitHub shows
   there.
2. Set the repository variable `PAGES_BASE_PATH` to `/` (Settings → Secrets and variables →
   Actions → Variables), because the site is then served from the domain's root.
3. Run the workflow again.

No code change is needed. Saved battlefields do not move to the new address (they belong to the
old one in each browser).
