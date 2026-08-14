# Prompt for Claude Cowork — get Elbi running for the family

Copy everything below the line into a fresh Cowork session, running on the computer
that holds the films.

---

I have a self-hosted streaming site called **Elbi** at
`https://github.com/oltionselmani/Elbi` (default branch
`claude/elbi-netflix-replica-8y3y7t`). It's a Node.js app — no dependencies, no build
step, `node server.js` and it's up on port 8080. It already has a working PWA manifest,
service worker, offline downloads, four family profiles, and a full test suite
(`npm test`, 109 tests).

**Your job: make it reachable from our phones and TV, privately, and make it start
itself so it's simply always there.** Work on the machine you're running on — that's
where the films live.

## What I want, in order of importance

1. **No friction.** I open it and a film plays. I don't want to log in, approve
   anything, or click through a warning every time. One setup per device is fine;
   anything recurring is not.
2. **Private.** Only my family. I don't want this discoverable or attackable from the
   open internet.
3. **Feels like an app.** An icon on my iPhone home screen that opens full-screen with
   no Safari chrome, and something I can click on the PC without opening a terminal.
4. **Always on.** It should survive a reboot without me doing anything.

## Constraints — please don't work around these

- **Do not upload my films anywhere.** They're terabytes, they stay on this machine.
  Only the *access path* goes over the network.
- **free.nf, InfinityFree, 000webhost and that family of free hosts are out.** They're
  PHP-only shared hosting: they can't run Node, can't keep a process alive, cap disk at
  a few GB, and their terms forbid video streaming. I suggested free.nf before I
  understood that — don't try to make it work.
- **No paid hosting** unless you tell me first what it costs and why nothing free does
  the job.
- **Don't weaken the app's own security** to remove friction. Long sessions are the
  right way to avoid repeated logins, not disabling the password.

## What I think the answer is — argue with me if I'm wrong

Run Elbi here and reach it over a private network rather than publishing it:

- **Tailscale** (free personal plan) looks like the best fit. It puts my devices on
  their own private network, so Elbi is *not exposed to the public internet at all* —
  there's no address for a stranger to find or attack. Install it here and on our
  phones, then `tailscale serve` to get an HTTPS address. HTTPS matters beyond
  encryption: iOS only allows Add to Home Screen and the offline-download service
  worker on a secure origin.
- **Cloudflare Tunnel** as the fallback if Tailscale turns out to be awkward on
  someone's phone — free, no port forwarding, real HTTPS, and Cloudflare Access can
  gate it. But it does put a public hostname out there, so prefer Tailscale unless
  there's a reason not to.
- **Do not** tell me to forward a port on the router. I don't want my home IP answering
  strangers.

If you know a better option, say so and explain the trade-off before building it.

## Please do all of this

1. **Clone and get it running.** Confirm `npm test` passes before you change anything,
   so we know the baseline is good.
2. **Point it at my films.** Ask me where they are. Set `ELBI_MEDIA_DIR`, and
   `ELBI_SCAN_DIRS` for anything outside that folder. Note: Elbi follows symlinks, but
   a link whose *target* sits outside those folders is refused by design — so if my
   films are on another drive, that drive's real path needs listing.
3. **Set a password properly.** Generate a long random `ELBI_PASSWORD` and put it
   somewhere I can find it. Set `ELBI_SESSION_DAYS` high (say 365) so each device logs
   in once and then never asks again — that's how we get "no friction" without turning
   auth off. Elbi already throttles wrong guesses and revokes every session if the
   password changes.
4. **Private access.** Set up Tailscale (or your better idea), get an HTTPS URL, and
   verify it loads on a phone that is *not* on our home wifi.
5. **Make it always-on.** A proper service — Task Scheduler on Windows, `launchd` on
   macOS, `systemd --user` on Linux — that starts at boot, restarts on crash, and logs
   somewhere I can read. Then a desktop shortcut that just opens the app.
6. **Make it an app on the phone.** Walk me through Add to Home Screen on iOS Safari
   and confirm it opens full-screen with the Elbi icon, not a browser tab. Tell me if
   any manifest or `apple-` meta tag needs changing for that to work properly.
7. **Prove it works, don't assume.** Before telling me it's done, actually check:
   a film plays on a phone over cellular; seeking works; subtitles appear; the offline
   download button saves a film and it still plays with the phone in airplane mode;
   and it all still works after you reboot this machine.

## Then write me a one-page note

In plain language, no jargon: the URL, the password and where it's kept, how each
family member gets set up on their phone (numbered steps I can send them), how to
restart it if it breaks, and what to do if I later want to add someone.

## Ask me before

- spending any money,
- putting a publicly-reachable hostname on the internet,
- installing anything that runs with admin/root privileges,
- changing app code (the features and tests are in good shape — this task is about
  deployment, not development).

The four profiles are currently named Olti, Elbi, Oltion and Elbasana in
`src/server/store.js`. Ask me whether those are right before we set this up for real.
