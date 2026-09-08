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
picks up from the byte the server already has — the byte count is read from the file on
disk rather than from a running tally, so an upload interrupted mid-chunk resumes at the
right offset instead of re-sending a stretch into the middle of the film. Nothing is ever
buffered in memory.

The folder scanner reads names like `The.Quiet.Harbour.2014.1080p.BluRay.x264.mkv` and
fills in the title, year and resolution. Files named `Show.S01E02.mkv` are grouped into a
series with seasons and episodes. Matching `.srt` / `.vtt` files sitting next to a video
are attached as subtitle tracks automatically.

**Symlinks are followed**, so the usual `ln -s /mnt/nas/movies ~/media/movies` works.
A film reachable through two different links is imported once, not twice, and a link
pointing back up its own tree won't send the scan round forever. Because a link can point
anywhere, each file is judged by where it *really* lives: if that's outside
`ELBI_MEDIA_DIR` and `ELBI_SCAN_DIRS`, the scan names the file and tells you to add its
location to `ELBI_SCAN_DIRS`, rather than quietly skipping it.

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
- **Subtitles that come on by themselves.** Set your language once and every film that
  has a track in it starts with subtitles on — you don't pick them per film. A track in
  a language you *didn't* ask for is never switched on by itself; subtitles you can't
  read are worse than none. Elbi treats `alb`, `sqi` and `sq` as the same language, so
  it doesn't matter which spelling a file or a download site uses.
- **Subtitles that behave** — pick a different track and Elbi remembers it for that
  title, including having deliberately switched them off. That choice belongs to your
  profile rather than to the browser, so turning them off on the laptop is still off
  when you pick the film up on your phone. Set the text size and background (drop
  shadow, black box or nothing), and if an `.srt` was cut for a different release,
  nudge its timing with `[` and `]` until it lines up.
- **Stats for nerds** (press `S`) — live resolution, **measured** frame rate, dropped
  frames, buffer ahead, average bitrate, and whether you're watching an offline copy.
  The frame rate comes from `requestVideoFrameCallback`, so it's what the browser is
  really painting, not a number copied out of a file header.
- **Fullscreen that always does something.** The standard API first; on iOS, where a
  `<div>` cannot go fullscreen at all, the native video presentation; and if the page is
  embedded somewhere that refuses the request, it fills the window with CSS instead of
  dead-ending.
- **Skip intro** — mark an intro once (⋮ menu, or `Shift+I` at its first frame and again
  at its last) and a *Skip intro* button appears over that stretch from then on, with a
  bar showing how much of it is left. On a series, one press applies the same marker to
  the whole season, because a show's titles run for the same seconds every week.
- **Sleep timer** — 15 to 90 minutes, or *end of this episode*. A countdown sits in the
  top bar; when it runs out, playback pauses, your place is saved, and you get *Keep
  watching* or *Close player*. It runs on the wall clock, not on playback position, so
  pausing the film doesn't pause the timer any more than it stops you falling asleep.
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
| `[` `]` | Nudge subtitle timing | | `⇧I` | Mark intro start / end |
| `<` `>` | Slower / faster | | `S` | Stats for nerds |
| `Home` `End` | Start / end | | `?` | Show this list |
| `Esc` | Close the list, leave fullscreen, then close the player | | | |

You don't have to memorise any of that: press `?` while watching and the whole list
appears over the film, grouped by what the keys do. The film keeps playing behind it.
The table above and the overlay are generated from the same source, and a test fails if
a key is added to one without the other.

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

### Posters, cast and synopses

Open a title and press **Find poster & details**. Elbi searches, shows you the candidates
with their artwork, and writes the one you pick onto the title: poster, backdrop, synopsis,
tagline, genres, runtime, director, cast, certification, and the IMDb id. A folder scan
offers to do the same automatically for everything it just imported, and only accepts a
match it's confident about — a wrong poster is worse than no poster.

There are two providers, and **which one you get depends on whether you set a key**:

| | TMDB | Wikipedia + Wikidata |
|---|---|---|
| Needs a key | **Yes** — `ELBI_TMDB_KEY` | No |
| Poster size | Up to 500px wide, plus a 1280px backdrop | ~220–900px, whatever en.wikipedia hosts |
| Certification (PG-13 etc.) | Yes | No |
| Per-episode data | Yes | No |
| Synopsis, genres, runtime, cast, director, IMDb id | Yes | Yes |

Every TMDB endpoint answers `401` without a key, so TMDB is opt-in. Without one Elbi falls
back to Wikipedia for the poster and synopsis and Wikidata for the structured fields, which
needs no signup and works on a fresh checkout — the trade-off is image quality, because
en.wikipedia hosts non-free film posters at low resolution. Get a free key at
[themoviedb.org/settings/api](https://www.themoviedb.org/settings/api) and set
`ELBI_TMDB_KEY`; both v3 keys and v4 read tokens work, and the key is never written to the
library file or sent to the browser.

### Subtitles from the internet — including Albanian

**Find subtitles online** on any title (or the `CC` button on an episode) searches
opensubtitles.org and attaches the track you choose. **Albanian is the default**;
nine other languages are in the picker, and you can change the default in Settings.

This needs no API key. What Elbi does to each download before it reaches the player:

1. Un-gzips it — the service hands out compressed SubRip.
2. Decodes the codepage the service declares (these files are usually CP1252 or CP1250,
   not UTF-8) and re-encodes to UTF-8, so **ë** and **ç** arrive intact rather than as
   mojibake. Correct UTF-8 is detected and left alone even when the declaration is wrong.
3. Converts SubRip to WebVTT, which is the only format `<track>` understands.
4. Strips the advertising the download site injects into the first and last cues. The
   translator's own credit is kept — that's not an advert.

Matching is by IMDb id when the title has one (which is why matching a poster first helps)
and by name otherwise; for a series it searches by season and episode. If the free download
quota runs out, Elbi says so instead of attaching an empty file.

### Finding things

**Search** looks at the title, year, genres, tags, episode names, synopsis — and the cast
and director, so *DiCaprio* finds the film even when you can't recall what it was called.
It folds accents on both sides, so **Shqiperia** finds *Shqipëria* and **Amelie** finds
*Amélie* — typing the diacritic is optional, never required. Results are ranked, so a word
in the title beats the same word buried in a synopsis, and a one-letter typo still finds
the film without ever outranking an exact match. Every word you type has to match
something: half a query is noise, not a result.

**My library** has a filter row above the grid: sort by A–Z, recently added, newest,
oldest or longest; narrow to films or series; narrow to not started, in progress or
finished; and narrow to a genre — each genre offered with the number of titles behind it,
so no chip is a dead end. The heading counts what's shown against what exists ("3 of 41
titles"), so a filter is never silently in effect, and your choice is remembered for next
time.

**Films** and **TV shows** are shelves of their own in the nav — the same grid pinned to
one kind, so you don't filter every time. The genre chips there count only what's on that
shelf.

**Has anyone seen this already?** Cards carry a small row of faces for everyone else in
the house who has started or finished a title, and the detail sheet says it in words —
*"Seen by: Olti, Elbi (part-way)"*. Someone half-way through is drawn as an outline, so
finished and part-way read differently at a glance. Only the *fact* is shared: how far
anyone got stays inside their own profile. A series counts as seen only when every
episode is. Turn it off with the `showWhoWatched` setting.

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
| `ELBI_ALLOW_REMOTE` | `1` | Set `0` to disable the Internet Archive browser, metadata lookups, subtitle search and all remote URLs |
| `ELBI_TMDB_KEY` | *(unset)* | TMDB API key or v4 read token. Without it, posters come from Wikipedia instead |
| `ELBI_SUBTITLE_LANG` | `alb` | Default subtitle language to search for (ISO 639-2/B; `alb` is Albanian) |
| `ELBI_SESSION_DAYS` | `400` | How long a remembered device stays signed in. 400 days is the most a browser will honour |
| `ELBI_TRUST_PROXY` | `0` | Set `1` **only** behind a reverse proxy you control, so `X-Forwarded-For` names the client for login throttling |
| `ELBI_LOG` | `1` | Set `0` to silence request logging |

```bash
ELBI_PASSWORD='something-long' \
ELBI_SCAN_DIRS=/mnt/movies:/mnt/shows \
ELBI_PORT=8080 \
node server.js
```

Files are only ever served from `ELBI_MEDIA_DIR` and the folders in `ELBI_SCAN_DIRS`;
paths that try to climb out are rejected, including through a symlink. Elbi will only
*delete* files it uploaded itself — a scanned library is never touched, even when you
remove a title and tick "delete files".

### Signing in

```bash
npm run set-login
```

It asks for an email and a password, and stores the password as a **scrypt** hash in
`data/credentials.json` — gitignored, written owner-only. The password is never in the
repo, never in an environment variable, never passed as a command argument (arguments are
visible to anyone who can run `ps`), and not recoverable from what's stored.

scrypt at N=2^15 costs roughly 100ms and 32MB per guess. A bare SHA-256 of a short
password falls to a wordlist in seconds; this makes the same wordlist take hours per
thousand guesses, and it stacks with the lockout below. A test pins that cost so it can't
quietly become cheap again.

**Remember this device** is ticked by default. The cookie then lasts 400 days — the most
a browser will honour — so a phone is asked once and not again. Untick it on a computer
that isn't yours and the cookie dies with the browser. Cookies are always `HttpOnly` and
`SameSite=Lax`, and `Secure` over https.

Wrong credentials always say *"Wrong email or password"*, whichever half was wrong, and a
wrong address costs the same time as a wrong password — otherwise the response time alone
would reveal which addresses exist.

`ELBI_PASSWORD` still works as a simpler shared-password mode for a home LAN; the
email/password credential takes precedence when one exists.

**Changing either the password or the email logs every device out**, everywhere,
immediately. The credential is part of what signs a session, so old cookies stop
verifying — which is the entire point of changing it. Neither the password nor its hash
ever leaves the server; they only contribute to the signing key.

Wrong passwords are throttled per client: five free attempts, then a lockout that doubles
with each further miss, capped at fifteen minutes and cleared the moment you get it
right. Mistyping your own password costs you nothing; guessing at a few hundred attempts
a second stops being possible. `X-Forwarded-For` is ignored unless you set
`ELBI_TRUST_PROXY=1`, because trusting it by default would let anyone forge a fresh
identity per request and walk straight past the limit.

---

## Hosting it online

**The short version:** run Elbi on the machine that holds the films and reach it over
Tailscale. Your films never leave that machine, nothing is published to the public
internet, and it costs nothing.

```bash
npm run set-login                                    # email + password, hashed
ELBI_MEDIA_DIR=/path/to/films bash scripts/tailscale-setup.sh
```

That installs a service that starts at boot, publishes Elbi on your tailnet over real
HTTPS, and prints the address. **[SETUP.md](SETUP.md)** has the full walkthrough,
including the steps to forward to each family member for their phone.

Two settings the script sets, which belong together:

- `ELBI_HOST=127.0.0.1` — Elbi listens only on that machine, so Tailscale is the single
  way in. It isn't on your home wifi either.
- `ELBI_TRUST_PROXY=1` — behind a proxy every request appears to come from `127.0.0.1`,
  so without this the login lockout is shared and one person mistyping their password
  five times locks out the whole household. It is only safe *because* of the line above;
  Elbi prints a warning at startup if it ever sees one without the other.

HTTPS matters beyond encryption: iOS only allows *Add to Home Screen* and the
offline-download service worker on a secure origin, so `tailscale serve` is what makes
Elbi behave like an installed app rather than a browser tab.

**Someone outside the household**, in another country, works the same way — Tailscale is
not a home-network thing, so distance is irrelevant and no hosting is involved.
`bash scripts/tailscale-share.sh` prints the steps for sharing just that one machine
(not your whole network) and measures the thing that actually limits them: your
broadband's *upload* speed, since the film is sent from your machine.

When a link can't sustain the bitrate, Elbi stops spinning silently — after three stalls
in a minute it offers a smaller copy of the film, or offers to download it first. Taking
the smaller copy keeps your place. Verified against a link throttled to 176 kbit/s with
220ms of latency.

If you would rather have a public address, Cloudflare Tunnel plus a DuckDNS subdomain is
the free combination that still works in a year — see SETUP.md for the trade-off.


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

164 tests covering filename parsing, range-request edge cases, path-traversal refusal,
SRT→VTT conversion (including the single-digit hour that makes a browser discard an entire
file), subtitle charset decoding, advert-cue stripping, subtitle-download URL containment,
skip-intro marker validation, the resume-rewind arithmetic, search ranking and accent
folding, subtitle-language matching across ISO 639-1/2B/2T, library filtering and
sorting, scrypt password hashing and its cost, session revocation when the password or
email changes, remember-this-device cookie lifetimes, login throttling, the fixed profile roster (including that it refuses to be added to or
deleted from, and that one profile's history never leaks into another's), and a full
server round trip: chunked upload → byte-exact streaming → folder scan → progress →
deletion → restart.

Several of them exist to stop two things drifting apart rather than to test a function:
the keyboard overlay is checked against the handler that implements it in both directions,
and the service worker's precache list is checked against everything actually shipped in
`public/`. Add a shortcut without documenting it, or a module without precaching it, and
the suite fails.

The browser side was verified against real Chromium — 37 checks covering playback,
double-click seeking, mid-playback quality switching, live FPS measurement, subtitle
loading, subtitle timing offset and sizing, the profile gate, resuming five seconds before
the stop point, and a further 9 covering offline download plus seeking with the network
switched off. Another 51 cover the newer work: the shortcut overlay, search by cast and
by unaccented spelling, the library filter row on desktop and phone, and every shipped
font and icon surviving with the network cut.

A further 25 checks drive the four newest features against the live services: a metadata
search that returns real candidates, the poster loading as actual image bytes and rendering
on a browse card, an Albanian track fetched from opensubtitles.org and parsed by the browser
into 1420 separate cues with its accents intact and its advert cue gone, the skip-intro
button appearing only inside its marked range and jumping to the right second, and the sleep
timer counting down, pausing playback and saving your place.

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
