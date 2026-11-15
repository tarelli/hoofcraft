# Hoofcraft

A bilingual pixel-art browser game about cleaning, trimming, and shoeing a horse hoof.

Open `index.html` through GitHub Pages or any static web server. The game has no build step or external runtime dependencies. It is an installable progressive web app: `manifest.webmanifest` and `sw.js` let it be added to a phone's home screen and played offline, with fonts and icons served from `fonts/` and `icons/`. Player preferences are stored locally; leaderboard scores are synchronized through the Cloudflare Worker in `worker/index.js`, backed by `scores.json` on the repository's `scores` branch.

The Worker expects a secret named `GITHUB_TOKEN` with read/write Contents access limited to this repository. Deploy it with the checked-in `wrangler.toml`; never place the token in source code or in the browser client.

## Leaderboard service

`GET /session` hands the game a signed token when a run starts; `POST /scores` only accepts a score that comes with a token at least 45 seconds old, used once, with a total that is plausible for the time played. This stops casual fake scores; it cannot stop someone who automates the real game.

Scores are stored in `scores.json` on the `scores` branch by default. For real traffic, create a Cloudflare KV namespace and bind it as `SCORES` (see the comment in `wrangler.toml`); the Worker then uses KV and no longer needs GitHub. Set an optional `SESSION_SECRET` secret to sign tokens with a key of your own.
