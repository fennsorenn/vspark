# Official plugin registry

`registry.json` is the list the Plugins window shows by default (vspark reads it
from `main` through its raw GitHub URL; the URL can be changed in the app). Each
entry names a plugin and its released versions:

```jsonc
{
  "schema": 1,
  "plugins": [{
    "id": "spotify",
    "name": { "en": "Spotify", "de": "Spotify" },
    "description": { "en": "…", "de": "…" },
    "author": "…",
    "homepage": "https://github.com/<owner>/vspark_spotify",
    "network": ["api.spotify.com", "accounts.spotify.com"],
    "versions": [{
      "version": "0.1.0", "apiVersion": 1, "vspark": ">=0.13.0", "channel": "stable",
      "url": "https://github.com/<owner>/vspark_spotify/releases/download/v0.1.0/spotify-0.1.0.zip",
      "sha256": "<64 hex chars>"
    }]
  }]
}
```

A plugin repository's release workflow prints the `versions` entry
(`registry-entry.json`); add it here in a pull request. vspark refuses a
download whose SHA-256 does not match. See
`dev-notes/modules/plugins.md#registry`.
