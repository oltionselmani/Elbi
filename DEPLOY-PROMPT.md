# Prompt for Claude Cowork — put Elbi online for the family

Copy everything below the line into a fresh Cowork session, **running on the computer
that holds the films**.

---

I have a self-hosted streaming site called **Elbi** at
`https://github.com/oltionselmani/Elbi` (default branch
`claude/elbi-netflix-replica-8y3y7t`). Node.js, no dependencies, no build step —
`node server.js` and it's up on port 8080. It already has a sign-in page (email +
password, scrypt-hashed, with "remember this device"), a working PWA manifest and
service worker, offline downloads, four family profiles, and 143 passing tests.

**Your job: give it a memorable address my family can reach from their phones, keep it
private, and make it start itself.** Work on the machine you're running on — that's where
the films are.

## What I want, in order

1. **No friction.** I open it and a film plays. Signing in once per device is fine.
   Anything I have to do *every* time is not.
2. **Private.** Only my family. I don't want it discoverable or attackable by strangers.
3. **A memorable address.** Something I can tell my mum over the phone.
4. **Free, and still working in a year.** Not a trial.
5. **Feels like an app** — an icon on the iPhone home screen that opens full-screen, and
   something clickable on the PC.
6. **Always on.** Survives a reboot without me doing anything.

## Constraints — please don't work around these

- **Do not upload my films anywhere.** They are terabytes and they stay on this machine.
  Only the *access path* goes over the network.
- **free.nf, InfinityFree, 000webhost and that whole family are out.** They are PHP-only
  shared hosting: no Node, no long-running process, a few GB of disk, and terms that
  forbid video streaming. I asked for free.nf before I understood that — don't try.
- **Freenom (.tk/.ml/.ga) is out.** It stopped issuing domains and reclaims them.
- **No port forwarding on the router.** I don't want my home IP answering strangers.
- **No paid hosting** without telling me the cost first and why nothing free works.
- **Don't weaken the sign-in** to reduce friction. The 400-day "remember this device"
  cookie is how we avoid repeated logins.

## The approach I think is right — argue if you disagree

Run Elbi here; reach it over a private network rather than publishing it.

**First choice — Tailscale** (free personal plan, up to 100 devices). It puts my devices
on their own private network, so Elbi is *not exposed to the public internet at all* —
there is no address for a stranger to find or attack, which is the strongest possible
answer to "can hackers get in". With MagicDNS the address is a stable name like
`elbi.<my-tailnet>.ts.net`, and `tailscale serve` gives it real HTTPS. HTTPS matters
beyond encryption: iOS only allows Add to Home Screen and the offline-download service
worker on a secure origin. It doesn't expire.

**If someone can't install Tailscale — Cloudflare Tunnel + a free subdomain.**
`cloudflared` is free, needs no port forwarding, and gives real HTTPS. For a memorable
name that lasts, pair it with **DuckDNS** (`elbi.duckdns.org` — free, permanent, no
monthly reconfirmation) or **FreeDNS at afraid.org**. Avoid No-IP's free tier: it makes
you reconfirm every 30 days or it deletes the host. This does put a public hostname on
the internet, so if we go this way, put Cloudflare Access in front of it as well, and
keep Elbi's own sign-in on underneath.

Tell me which you'd choose and why before you build it.

## Please do all of this

1. **Clone it and confirm `npm test` passes** before changing anything, so we know the
   baseline is good.
2. **Point it at my films.** Ask me where they are; set `ELBI_MEDIA_DIR` and
   `ELBI_SCAN_DIRS`. Elbi follows symlinks, but a link whose *target* is outside those
   folders is refused by design — so if the films are on another drive, that drive's real
   path needs listing too.
3. **Set up the sign-in.** Run `npm run set-login`. It asks for the email and password
   interactively and stores a scrypt hash in `data/credentials.json`. Do **not** put the
   password in a file, a script, an environment variable, or the repo. I'll type it
   myself when you tell me to — don't ask me to paste it into the chat.
4. **Private access.** Set up Tailscale (or your better idea) and get an HTTPS URL.
   Verify it loads on a phone that is *not* on our home wifi.
5. **Always-on.** A real service — Task Scheduler on Windows, `launchd` on macOS,
   `systemd --user` on Linux — that starts at boot, restarts on crash, and logs somewhere
   I can read. Plus a desktop shortcut that just opens it.
6. **Make it an app on the phone.** Walk me through Add to Home Screen in iOS Safari and
   confirm it opens full-screen with the Elbi icon, not a browser tab. Tell me if any
   manifest or `apple-` meta tag needs changing.
7. **Prove it, don't assume.** Before saying it's done, actually check: a film plays on a
   phone over cellular; seeking works; subtitles appear; signing in once means the phone
   isn't asked again; an offline download plays in airplane mode; and it all still works
   after you reboot this machine.

## Then write me a one-page note

Plain language, no jargon: the URL, how each person gets set up on their phone (numbered
steps I can forward), how to restart it if it breaks, how to change the password, and how
to add someone later.

## Ask me before

- spending money,
- putting a publicly-reachable hostname on the internet,
- installing anything that runs as admin/root,
- changing app code — this task is deployment, not development.

The four profiles are named Olti, Elbi, Oltion and Elbasana in `src/server/store.js`.
Check with me that those are right before setting it up for real.
