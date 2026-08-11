<div align="center">

# ELBI

**Your own streaming site.** Point it at the movies you already have, stream public-domain
films without downloading anything, and watch offline when you're not connected.

No dependencies. No build step. One command to start.

</div>

---

## Quick start

```bash
git clone <your-repo-url> elbi
cd elbi
node server.js
```

Open **http://localhost:8080**. That's it — there is nothing to install, no database to
set up, and no npm packages to fetch. Node 18 or newer is the only requirement.

Drop video files into the `media/` folder (or upload them from the browser) and they show
up in your library.

---

## What it does

### Add your own movies — three ways

| | How | Best for |
|---|---|---|
| **Upload** | Drag files onto the browser | Files on the machine you're browsing from |
| **Scan a folder** | Give Elbi a path; it registers everything inside | A NAS or drive already full of movies — nothing is copied or moved |
| **Add by URL** | Paste a direct link to a video | Anything hosted elsewhere |

Uploads are chunked and resumable, so a 40 GB remux survives a dropped connection and
picks up from the byte the server already has. Nothing is ever buffered in memory.

The folder scanner reads names like `The.Quiet.Harbour.2014.1080p.BluRay.x264.mkv` and
fills in the title, year and resolution. Files named `Show.S01E02.mkv` are grouped into a
series with seasons and episodes. Matching `.srt` / `.vtt` files sitting next to a video
are attached as subtitle tracks automatically.

### Watch without downloading

The **Free films** tab is a live browser over the Internet Archive's public-domain
collections — around 28,000 feature films, film noir, silent films and cartoons. Search
it, pick a title, and it streams straight through. Nothing is stored on your server, and
every rendition the Archive offers shows up as a quality option.

Remote sources stream *through* Elbi rather than redirecting your browser to the origin.
That costs a little server bandwidth and buys reliability: it works when the viewing
device can't reach the source itself (a phone on a LAN, a client behind a firewall, a host
that blocks hotlinking), and it's what lets those titles be saved for offline viewing.
Add `?redirect=1` to a stream URL to send the browser straight to the origin instead.
Adaptive playlists (HLS/DASH) always redirect, because their segment URLs only resolve at
their own origin.

The Archive labels each rendition's codec, and Elbi uses that: an H.264 file is offered
first even when a higher-resolution Theora or MPEG-4 Part 2 copy exists, because those two
are the ones browsers refuse. If a rendition fails to decode anyway, Elbi moves to the
next one automatically and tells you why.

### The player

- **Double-click the left or right of the picture** to skip back or forward 5 seconds.
  Keep tapping and the amount stacks up (−5s, −10s, −15s…), the way phone players do.
  Double-click the middle for fullscreen.
- **Quality / source menu** — a title can hold several files (1080p, 720p, a 4K remux) and
  you switch between them mid-playback without losing your place.
- **Resume slightly early** — stop at 27:47 and it picks up at 27:42. Five seconds of
  run-up beats landing mid-sentence; adjustable (or set to 0) in Settings.
- **Subtitles that behave** — pick a track while watching and Elbi remembers it for that
  title next time. Set the text size and background (drop shadow, black box or nothing),
  and if an `.srt` was cut for a different release, nudge its timing with `[` and `]`
  until it lines up.
- **Stats for nerds** (press `S`) — live resolution, **measured** frame rate, dropped
  frames, buffer ahead, average bitrate, and whether you're watching an offline copy.
  The frame rate comes from `requestVideoFrameCallback`, so it's what the browser is
  really painting, not a number copied out of a file header.
- **Fullscreen that always does something.** The standard API first; on iOS, where a
  `<div>` cannot go fullscreen at all, the native video presentation; and if the page is
  embedded somewhere that refuses the request, it fills the window with CSS instead of
  dead-ending.
- Playback speed, picture-in-picture, resume-where-you-left-off, and autoplay of the next
  episode with a countdown.

**There is no resolution ceiling.** Elbi plays the file you give it, so 4K plays as 4K —
the quality menu just lists whichever files a title actually has. Give one title a 4K
remux, a 1080p copy and a 720p copy and all three appear, highest first.

**Keyboard**

| Key | Action | | Key | Action |
|---|---|---|---|---|
| `Space` `K` | Play / pause | | `M` | Mute |
| `←` `→` | Skip 5s (configurable) | | `F` | Fullscreen |
| `J` `L` | Skip 10s | | `I` | Picture-in-picture |
| `↑` `↓` | Volume | | `C` | Cycle subtitles |
| `0`–`9` | Jump to 0 %–90 % | | `Q` | Cycle quality |
| `,` `.` | Previous / next frame | | `N` | Next episode |
| `[` `]` | Nudge subtitle timing | | | |
| `<` `>` | Slower / faster | | `S` | Stats for nerds |
| `Home` `End` | Start / end | | `Esc` | Leave the player |

Outside the player: `/` focuses search, `A` opens the add panel, `G` goes home.

### Watching offline

Two different things, and both work:

**1. Run Elbi on your own machine.** There is no cloud service behind it. If the movies
are on your laptop's disk and Elbi is running on that laptop, you can watch on a plane
with the Wi-Fi off. This is the simple path and needs no setup.

**2. Save a title into the browser.** Open a title, press **↓** next to a video file, and
Elbi streams it into the browser's Cache Storage. A service worker then answers playback
requests from that cache — including real HTTP range requests, so **seeking still works**
with the network completely cut. Useful for watching on a phone or tablet away from the
server.

Downloaded titles get a green **offline** badge, get their own row on the home page, and
the **Downloads** panel in the header shows what's saved and how much browser storage is
left. Browsers only allow service workers over **https** or on **localhost**, so option 2
needs one of those (see *Hosting online* below).

Adaptive streams (HLS `.m3u8`, DASH `.mpd`) can't be saved offline — they're stitched
together from thousands of segments at playback time. Elbi says so rather than failing
quietly.

### Profiles

Four fixed profiles — **Olti**, **Elbi**, **Oltion**, **Elbasana** — and no passwords.
Elbi asks who's watching on the way in for exactly one reason: so Continue Watching and My
List belong to one person instead of being shared. The last name used on a device is
marked *last used*, but never auto-selected.

The roster is fixed in code rather than editable in the UI, so nobody can accidentally add
or delete a profile. Change the names by editing `PROFILES` in `src/server/store.js`; watch
history is keyed to the profile ID, so renaming keeps it and changing an ID starts fresh.
Each profile can clear its own history from **Profile → All profiles**.

Profiles organise viewing history; they are not a security boundary. Use the password
below for that.

---

## How it looks

The design is a projection booth rather than a catalogue — this is your screening room,
not a streaming company, so the apparatus is on show: a warm lamp thrown across the
billboard, fine film grain over the whole room, and cards that catch the light on hover.

Three typefaces, and which one you get is a rule rather than a whim:

| Voice | Face | Used for |
|---|---|---|
| Marquee | **Bebas Neue** | the wordmark, titles, headings, profile names |
| Prose | **IBM Plex Sans** | anything you actually read |
| Instrument | **IBM Plex Mono** | anything *measured* — timecodes, resolutions, frame rates, file sizes |

That last rule is the one that makes the interface feel built rather than styled: a
runtime and a frame rate are readings off an instrument, so they are set like readings.

The palette commits to dark on purpose, with one bold colour spent in a single place —
`#ff4d2e`, the projector lamp. Semantic colours (good, warning, error) are kept clear of
it so a red button never reads as an alarm.

All three faces are SIL Open Font Licence and ship in `public/fonts` as 144 KB of woff2.
Nothing is fetched from a font CDN: Elbi has to work with the network switched off, and a
webfont that 404s offline would silently fall back to a system face.

Row headings carry a small monospace note stating something true about the row — how many
titles and files, how many episodes, how many seconds Continue Watching rewinds. Titles
with no artwork are not blank plates: they get their initial set large on a tint derived
from the name, so a library of unposterd files still reads as a library.

---

## Which files actually play?

This is the one thing worth understanding before you upload a library, and Elbi is honest
about it in the UI rather than showing you a black screen.

Elbi streams files; it does not transcode them. So playback depends on what **your
browser** can decode:

| Container | Verdict |
|---|---|
| `.mp4` / `.m4v` (H.264 + AAC) | **Always works.** This is the format to aim for. |
| `.webm` (VP8/VP9 + Opus/Vorbis) | **Always works.** |
| `.mkv` | **Sometimes.** Chrome and Edge play Matroska when the streams inside are H.264/VP9 with AAC/Opus. Firefox and Safari generally won't. HEVC, AC3, DTS and E-AC3 audio usually fail. |
| `.mov` | Only when it holds H.264/AAC. |
| `.avi`, `.mpg`, `.ts`, `.wmv`, `.flv` | **No.** Browsers don't decode these. |

Elbi flags every source it imports: a green tick, an amber *may not play*, or a red
warning with the reason. Files that need converting are listed at the end of a folder
scan. **Settings → What this browser can play** shows the decoders the browser you're
using actually has, which is the quickest way to tell "bad file" apart from "browser
without an H.264 licence" — some Linux Chromium builds ship without one, and Elbi says so
by name instead of showing a black screen.

To fix a file, remux it (fast — no quality loss, no re-encode) with
[ffmpeg](https://ffmpeg.org):

```bash
# .mkv that already holds H.264/AAC — just repackage it, a few seconds
ffmpeg -i movie.mkv -c copy -movflags +faststart movie.mp4

# Anything else — a real re-encode, slower but universally playable
ffmpeg -i movie.avi -c:v libx264 -crf 20 -preset medium \
       -c:a aac -b:a 192k -movflags +faststart movie.mp4
```

`-movflags +faststart` puts the index at the front of the file so playback starts
instantly instead of after a full download. It's worth doing on everything.

> **HLS in Chrome / Firefox**: Safari plays `.m3u8` natively; other browsers need
> [hls.js](https://github.com/video-dev/hls.js). Drop a copy at `public/vendor/hls.js` and
> Elbi picks it up automatically. Without it, HLS sources say so instead of failing.

---

## Configuration

Everything is an environment variable; none of them are required.

| Variable | Default | What it does |
|---|---|---|
| `ELBI_PORT` | `8080` | Port to listen on |
| `ELBI_HOST` | `0.0.0.0` | Interface to bind (`127.0.0.1` for local only) |
| `ELBI_PASSWORD` | *(unset)* | Require a password. **Set this before exposing Elbi to the internet.** |
| `ELBI_MEDIA_DIR` | `./media` | Where uploads are written and where scanning starts |
| `ELBI_DATA_DIR` | `./data` | Library index, artwork, session secret |
| `ELBI_SCAN_DIRS` | *(none)* | Extra folders you're allowed to scan, `:`-separated |
| `ELBI_ALLOW_REMOTE` | `1` | Set `0` to disable the Internet Archive browser and all remote URLs |
| `ELBI_SESSION_DAYS` | `30` | How long a login lasts |
| `ELBI_LOG` | `1` | Set `0` to silence request logging |

```bash
ELBI_PASSWORD='something-long' \
ELBI_SCAN_DIRS=/mnt/movies:/mnt/shows \
ELBI_PORT=8080 \
node server.js
```

Files are only ever served from `ELBI_MEDIA_DIR` and the folders in `ELBI_SCAN_DIRS`;
paths that try to climb out are rejected. Elbi will only *delete* files it uploaded
itself — a scanned library is never touched, even when you remove a title and tick
"delete files".

---

## Hosting it online

Elbi speaks plain HTTP. Put a reverse proxy in front for TLS, which also unlocks
service-worker offline downloads on your phone.

**Caddy** — the shortest path to a working certificate:

```caddyfile
elbi.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

**nginx** — note the two settings that matter for video:

```nginx
server {
    server_name elbi.example.com;
    listen 443 ssl http2;
    # ssl_certificate ... (certbot writes these)

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Large uploads must not be capped or buffered to disk first.
        client_max_body_size 0;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

**systemd**, so it survives a reboot:

```ini
[Unit]
Description=Elbi
After=network.target

[Service]
WorkingDirectory=/opt/elbi
ExecStart=/usr/bin/node server.js
Environment=ELBI_PASSWORD=something-long
Environment=ELBI_SCAN_DIRS=/mnt/movies
Restart=always
User=elbi

[Install]
WantedBy=multi-user.target
```

**Docker**, if you'd rather:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY . .
ENV ELBI_MEDIA_DIR=/media ELBI_DATA_DIR=/data
EXPOSE 8080
CMD ["node", "server.js"]
```

```bash
docker build -t elbi .
docker run -d -p 8080:8080 \
  -v /mnt/movies:/media -v elbi-data:/data \
  -e ELBI_PASSWORD=something-long elbi
```

Before you open it to the world: **set `ELBI_PASSWORD`**, put TLS in front of it, and
remember that you're responsible for what you host.

---

## How it works

```
server.js              HTTP server, static files, SPA fallback
src/server/
  api.js               every /api route
  library.js           titles, sources, episodes, folder scanning
  uploads.js           resumable chunked uploads
  store.js             library.json, written atomically
  http.js              range requests — the reason seeking works
  discover.js          Internet Archive proxy + SSRF guards
  auth.js              optional password, signed cookie sessions
  config.js  util.js
public/
  index.html  css/elbi.css
  js/player.js         the player
  js/views.js          browse, rows, detail sheet, free films
  js/add.js            upload / scan / URL / metadata editing
  js/offline.js        downloads into Cache Storage
  sw.js                service worker: app shell + offline range serving
```

**Storage** is a single `data/library.json`, written through a temp file and renamed, so a
crash mid-write can't corrupt it. It's plain JSON — readable, editable, and trivial to
back up. Your videos are never copied, rewritten or moved; Elbi only records where they
are.

**Streaming** is a real `206 Partial Content` implementation, which is what makes seeking
in a two-hour film instant instead of a download-the-whole-thing wait. The service worker
reimplements the same range logic against Cache Storage so offline playback behaves
identically.

**No dependencies** means no supply chain to audit, no `npm install` before it runs, and
nothing that rots when you come back to it in two years.

---

## Tests

```bash
npm test
```

29 tests covering filename parsing, range-request edge cases, path-traversal refusal,
SRT→VTT conversion, the resume-rewind arithmetic, the fixed profile roster (including that
it refuses to be added to or deleted from, and that one profile's history never leaks into
another's), and a full server round trip: chunked upload → byte-exact streaming → folder
scan → progress → deletion → restart.

The browser side was verified against real Chromium — 35 checks covering playback,
double-click seeking, mid-playback quality switching, live FPS measurement, subtitle
loading, subtitle timing offset and sizing, the profile gate, resuming five seconds before
the stop point, and a further 9 covering offline download plus seeking with the network
switched off.

---

## Answers to the obvious questions

**Can I use it on my TV or phone?** Yes — it's a website, so anything with a browser
works. Add it to your home screen and it runs as a standalone app. The layout is built for
phone portrait as well as landscape; the player keeps its controls on a single row down to
360px wide.

**Where do my files go?** Uploads land in `media/uploads/`. Scanned files stay exactly
where they are.

**Can I edit the library by hand?** Yes, `data/library.json` is plain JSON. Stop the
server first. The profile list is the one exception — it lives in `src/server/store.js`
and is rewritten into the file on every start.

**Why does it ask who's watching every time?** So Continue Watching stays yours. It takes
one click, there is no password, and the last name you used is marked.

**Does it transcode?** No. That would mean bundling ffmpeg and burning a lot of CPU. Remux
with the commands above instead — it takes seconds and doesn't touch quality.

**Does it download from streaming services?** No. Elbi plays files you already have and
public-domain films the Internet Archive hosts openly.

---

MIT licensed. Public-domain titles come from the Internet Archive under their own terms —
each title links back to its source page.
