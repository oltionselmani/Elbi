# Setting up Elbi for the family

Your films stay on your computer. Tailscale is a private network between your own
devices, so your phone can reach that computer from anywhere — while the rest of the
internet cannot see it at all. There is no public address, so there is nothing for a
stranger to find or attack.

Everything below is free and does not expire.

---

## On the computer with the films — once

**1. Install Tailscale and sign in**

- Windows / macOS: <https://tailscale.com/download>
- Linux: `curl -fsSL https://tailscale.com/install.sh | sh` then `sudo tailscale up`

Sign in with Google, Microsoft or GitHub. The free plan covers up to 100 devices.

**2. Turn on MagicDNS**

At <https://login.tailscale.com/admin/dns>, switch on **MagicDNS**. This is what gives
you an address like `media-pc.tail1234.ts.net` instead of a bare IP — something you can
actually say out loud.

**3. Set your sign-in**

```bash
cd path/to/elbi
npm run set-login
```

It asks for your email and a password. Choose one you have not used anywhere else. The
password is stored as a scrypt hash in `data/credentials.json` — never in the code, never
in a settings file, and it cannot be read back out.

**4. Run the setup**

```bash
# macOS / Linux
ELBI_MEDIA_DIR=/path/to/your/films bash scripts/tailscale-setup.sh

# Windows (PowerShell)
$env:ELBI_MEDIA_DIR="D:\Films"
powershell -ExecutionPolicy Bypass -File scripts\tailscale-setup.ps1
```

That installs Elbi as a background service that starts itself whenever the computer
starts, then publishes it on your tailnet over HTTPS. It prints your address at the end.

If your films live on more than one drive, add `ELBI_SCAN_DIRS=/other/drive:/another`
as well.

---

## On each phone — once per person

1. Install **Tailscale** from the App Store or Play Store.
2. Sign in. If it's not your account, accept the invite you send them from
   <https://login.tailscale.com/admin/users>.
3. Open the address (e.g. `https://media-pc.tail1234.ts.net`) in Safari or Chrome.
4. Sign in with the email and password, leaving **Remember this device** ticked.
   They will not be asked again on that phone.
5. **iPhone:** tap Share → *Add to Home Screen*. **Android:** menu → *Install app*.
   It then opens full screen with the Elbi icon, like any other app.

That's it. From then on: tap the icon, pick who's watching, press play.

---

## Someone outside the household — a friend far away

**Distance doesn't matter and you don't need hosting.** Tailscale is not a home-network
thing: it builds an encrypted link between two machines wherever they are. A friend
2,400 km away connects exactly as if they were in the next room. Nothing about the setup
changes.

```bash
bash scripts/tailscale-share.sh
```

That prints the steps and measures the one thing that *does* matter. In short:

**Share the machine, don't invite them to your network.** In the Tailscale admin at
<https://login.tailscale.com/admin/machines>, use the **...** menu on your computer →
**Share**, and send them the link. A shared machine gives them access to that one
computer and nothing else — not your phone, not your laptop. They sign in to Tailscale
with *their own* account, not yours, and you can revoke it on the same page.

Then they open your Elbi address, sign in once with the email and password you gave them,
and add it to their home screen. Same as everyone else.

### The real limit is your upload speed

The film is sent *from your computer*, so your broadband's **upload** figure sets the
ceiling — not the distance, and not their download speed. Per person watching at once:

| Quality | Needs about |
|---|---|
| 480p | 1–2 Mbit/s |
| 720p | 3–5 Mbit/s |
| 1080p | 5–10 Mbit/s |

Home connections often have far less upload than download, so check that number before
assuming 1080p will hold up.

If the link can't manage it, Elbi does two things rather than spinning:

- **It notices repeated stalling** and offers a smaller copy of the film, or offers to
  download it first. Taking the smaller copy keeps your place in the film.
- **The download button** saves a film to their phone. It then plays perfectly, even in
  aeroplane mode. A link too thin to stream in real time can still fetch a film in the
  background while they do something else.

For the smaller-copy offer to have something to switch to, keep a 480p or 720p version
next to the big one. Elbi lists every file a title has, so both show up in the quality
menu.

### Your computer has to be awake

Elbi runs on your machine, not in a cloud. If it's asleep or off, your friend sees
nothing. Turning off sleep — or at least disabling it while plugged in — is worth doing
if someone else depends on it.

---

## Why it's set up this way

**Nothing is on the public internet.** Elbi listens only on `127.0.0.1` — not even on
your home wifi, so a guest on your network cannot reach it. Tailscale is the single way
in, and only devices signed into your account are on it.

**One person's mistake doesn't lock out the house.** After five wrong passwords a device
is locked out for a doubling delay. Behind a proxy every request would otherwise look
like it came from the same place, so the setup script sets `ELBI_TRUST_PROXY=1` — which
is only safe *because* Elbi is bound to loopback. The two settings belong together, and
Elbi warns at startup if it ever sees one without the other.

**HTTPS is not just for encryption.** iPhones only allow *Add to Home Screen* and offline
downloads on a secure address. `tailscale serve` provides a real certificate, which is
what makes Elbi behave like an installed app.

**Signing in once really means once.** The remembered cookie lasts 400 days, the longest
any browser honours.

---

## Later

| I want to… | Do this |
|---|---|
| Change the password | `npm run set-login` — this signs every device out, everywhere |
| Add someone | Invite them at <https://login.tailscale.com/admin/users>, then send them the address |
| Remove someone | Remove their device at <https://login.tailscale.com/admin/machines> |
| See what's published | `tailscale serve status` |
| Stop publishing | `tailscale serve --https=443 off` |
| Restart Elbi | Linux: `systemctl --user restart elbi` · macOS: `launchctl kickstart -k gui/$UID/com.elbi.server` · Windows: restart the "Elbi" task |
| Read the logs | Linux: `journalctl --user -u elbi -f` · macOS: `tail -f ~/Library/Logs/elbi.log` |

**If a phone can't reach it:** check Tailscale is connected on that phone (the toggle in
the app), and that the computer shows as online at
<https://login.tailscale.com/admin/machines>. The computer has to be awake — Elbi is
running on it, not in a cloud.

---

## If you'd rather have a public address

You don't need one, and it's less private. But if someone genuinely can't install
Tailscale, the free combination that lasts is **Cloudflare Tunnel** (`cloudflared`, free,
no port forwarding, real HTTPS) with a free subdomain from **DuckDNS** — `elbi.duckdns.org`
is permanent and needs no monthly reconfirmation. Put **Cloudflare Access** in front of it
and keep Elbi's own sign-in underneath.

Avoid: free PHP hosts (free.nf, InfinityFree — they can't run Node at all), Freenom
`.tk`/`.ml` domains (no longer issued, and reclaimed), and No-IP's free tier (deletes your
host unless you reconfirm every 30 days).
