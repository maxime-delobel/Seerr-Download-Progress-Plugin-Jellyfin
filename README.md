# Seerr Progress for Jellyfin

A Jellyfin plugin that shows **download progress from Seerr** right on the item page in Jellyfin. Open a series or movie that is currently downloading and a green progress pill appears. Hover over it (or tap it) for a small menu with a progress bar and time left per download.

Seerr only shows download progress inside Seerr. If Seerr is only reachable on your local network, your Jellyfin users can't see it. This plugin runs on the Jellyfin server, talks to Seerr from there, and shows the result inside Jellyfin. Users only need access to Jellyfin.

<p align="center">
  <img src="./images/progress_bar.png" alt="Download progress pill" width="49%">
  <img src="./images/progress_bar_extended.png" alt="Hover menu with per-download progress" width="49%">
</p>

## Features

- Progress pill ("Downloading 28%") on the series or movie page, matched by TMDB ID.
- Hover or tap menu with one entry per download: release name, progress bar, percentage, time left.
- Season packs are grouped into one entry (Sonarr lists a pack once per episode).
- Seerr stays private. The Seerr API key is stored on the Jellyfin server and never reaches the browser.
- Status endpoint is protected by Jellyfin login.

Tested with **Jellyfin 12.2** and **Seerr 3.4.1**.

## How it works

```
Browser ──(Jellyfin login)──> Jellyfin plugin ──(API key)──> Seerr ──> Radarr / Sonarr ──> qBittorrent
```

1. The plugin exposes `GET /SeerrProgress/Status`, which requires a logged-in Jellyfin user.
2. On request, it calls Seerr's `/api/v1/request?filter=processing`, reads `downloadStatus` for each media item, and returns the progress per TMDB ID. Results are cached for 4 seconds.
3. A small script (`client.js`) loads in the Jellyfin web UI, finds the TMDB ID of the page you're on, and draws the pill and menu. It refreshes every 5 seconds.

## Requirements

- Jellyfin 12.x (.NET 10). Jellyfin 10.11 builds are not provided, see [Other Jellyfin versions](#other-jellyfin-versions).
- Seerr reachable from the Jellyfin server, plus a Seerr API key (Seerr → Settings → General).
- Radarr and/or Sonarr connected to Seerr. Progress comes from their download queues.
- The [JavaScript Injector](https://github.com/n00bcodr/Jellyfin-JavaScript-Injector) plugin, to load the script into the web UI.
- To build: the .NET 10 SDK.

## Build

```bash
dotnet publish -c Release -o out
```

The plugin DLL ends up at `out/Jellyfin.Plugin.SeerrProgress.dll`.

No SDK installed? Build in a container:

```bash
podman run --rm -v "$PWD":/src:Z -w /src mcr.microsoft.com/dotnet/sdk:10.0 dotnet publish -c Release -o out
```

(Use `docker` and drop `:Z` if you don't use Podman with SELinux.)

## Install

1. Create the plugin folder on the Jellyfin server and copy in the DLL and `meta.json`:

   ```bash
   mkdir -p /var/lib/jellyfin/plugins/SeerrProgress_1.0.0.0
   cp out/Jellyfin.Plugin.SeerrProgress.dll meta.json /var/lib/jellyfin/plugins/SeerrProgress_1.0.0.0/
   ```

   For a remote server, `scp` the files to a temporary folder first and move them into place on the server.

2. **Fix the ownership.** Jellyfin must be able to write to `meta.json`. If the files are owned by root, Jellyfin fails to start with `Access to the path '.../meta.json' is denied`.

   ```bash
   chown -R jellyfin:jellyfin /var/lib/jellyfin/plugins/SeerrProgress_1.0.0.0
   ```

   Run this after every update too.

3. Restart Jellyfin:

   ```bash
   systemctl restart jellyfin
   ```

   Docker users: put the folder under the `plugins/` directory of the volume mounted as `/config` and restart the container.

4. Open **Dashboard → Plugins → Seerr Progress → Settings** and fill in:
   - **Seerr URL**: as the Jellyfin server sees it, for example `http://192.168.1.20:5055`.
   - **Seerr API key**.

   A yellow "error occurred while getting the plugin details from the repository" banner on the plugin page is normal for manually installed plugins.

5. Install the **JavaScript Injector** plugin from the catalog, restart Jellyfin, then add a script with this content and turn on *Requires Authentication*:

   ```js
   import('/SeerrProgress/client.js');
   ```

6. Hard-refresh the browser (Ctrl+Shift+R) and open an item that is downloading.

## Updating

Rebuild, copy the DLL over the old one, run the `chown` from step 2, restart Jellyfin, and hard-refresh the browser. `client.js` is embedded in the DLL, so there is nothing else to copy.

## Limitations

- **Delay.** The numbers come from Seerr, which gets them from Sonarr/Radarr's queue. They trail your torrent client by a short while. The plugin itself adds only a few seconds.
- **Seerr requests only.** Downloads that were not requested through Seerr don't show up.
- **Items in your library only.** The pill is drawn on an item's page, which only exists once something has been imported. A brand-new request with nothing imported yet has no page to attach to.
- **TMDB ID required.** The Jellyfin item needs a TMDB ID, which the default metadata providers set.
- **UI selectors.** The pill is placed next to the item's info row. If your theme or a Jellyfin update moves those elements, the pill falls back to a floating position in the bottom-left corner.

## Troubleshooting

| Problem | Check |
|---|---|
| Jellyfin won't start, log says `Access to the path ... meta.json is denied` | Run the `chown` from the install steps. |
| Plugin doesn't show up | Check the Jellyfin log for a version mismatch. The plugin targets Jellyfin 12.0 or newer (`targetAbi` 12.0.0.0). |
| No pill | Open `https://<jellyfin>/SeerrProgress/client.js` in the browser. If it loads, the plugin works and the script injection is the problem. |
| Still no pill | In the browser console run `ApiClient.getJSON(ApiClient.getUrl('SeerrProgress/Status')).then(console.log)`. `401` means the request isn't authenticated, `502` means Jellyfin can't reach Seerr (check URL and key), and `[]` means Seerr reports nothing in processing. |
| Pill shows "Processing" with no percentage | Seerr has the request but no download info yet. Check Seerr's request in the Seerr UI. |
| Old behavior after an update | Hard-refresh the browser, and confirm the new DLL is on the server. |

## API

`GET /SeerrProgress/Status` returns the list of media currently processing:

```json
[
  {
    "tmdbId": 46331,
    "mediaType": "tv",
    "percent": 28.2,
    "items": [
      {
        "title": "Under.the.Dome.S02.720p.x265-ZMNT",
        "percent": 28.2,
        "timeLeft": "02:44:46",
        "status": "downloading",
        "count": 10
      }
    ]
  }
]
```

`GET /SeerrProgress/client.js` serves the UI script. It needs no login because it is loaded with a plain `import()`, and it contains no secrets.

## Security notes

- The Seerr API key is saved in the plugin's configuration file on the Jellyfin server, in plain text, like other Jellyfin plugin settings. Anyone with access to that file can read it.
- Use a Seerr URL on your internal network. Nothing about Seerr needs to be exposed.

## Other Jellyfin versions

This build targets Jellyfin 12 (.NET 10). For Jellyfin 10.11 you would change `TargetFramework` to `net9.0`, the `Jellyfin.Controller` package to `10.11.*`, and `targetAbi` in `meta.json` to `10.11.0.0`. This is untested.

## Project layout

```
SeerrProgress.csproj           project file
Plugin.cs                      plugin entry point, config page registration
PluginConfiguration.cs         Seerr URL and API key settings
SeerrProgressController.cs     /SeerrProgress/Status and /SeerrProgress/client.js
Web/config.html                settings page
Web/client.js                  pill and hover menu in the web UI
meta.json                      plugin manifest for manual installs
```

## License

Add a license of your choice (for example MIT) before publishing.