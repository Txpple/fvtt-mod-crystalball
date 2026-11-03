# Putting the Seer on a Linux box

The Seer runs beside Foundry on the same machine: it joins Foundry on `127.0.0.1`, listens on `127.0.0.1` only,
and is reached by players through a reverse proxy or tunnel rule that routes one path of Foundry's public origin to
it. Every value below in angle brackets is yours to choose; nothing here names a real machine.

## 1. Node, a service user and the clone

The Seer needs Node 24 or newer (Foundry 14's own); on an older one it refuses to start with one line saying so.
Make a service user that owns nothing of the code:

```sh
sudo useradd --system --no-create-home --shell /usr/sbin/nologin <service-user>
sudo -u <service-user> sh -c 'command -v node; node --version'
```

The second line prints the absolute path of the Node the service will run and its version; it must say v24 or
newer. Paste that path into the unit's `ExecStart=` (a distribution's `/usr/bin/node` is often 12 or 18; an nvm
install lives in a home directory the service user may not be able to enter).

As an admin (yourself, not the service user), clone the repository where the service user can read it and only
you can write, and install the runtime dependencies:

```sh
sudo git clone https://github.com/Txpple/fvtt-mod-crystalball.git <path-to-the-clone>
cd <path-to-the-clone>
sudo git checkout vX.Y.Z          # the release whose module the world runs
sudo npm ci --omit=dev            # the three runtime dependencies, nothing else
```

The admin runs `npm ci`: a `--system` user has no writable npm cache, and a service that can rewrite its own code is
a service an attacker can rewrite. `healthz` reports the version from `module.json`, so a Seer left on an older tag
shows it there (the window does not warn); the Updating steps below keep the two in step.

## 2. The ball's user

In Foundry, *User Management*: a user of role **Player** (never a GM: a GM-level socket would be elected to act for
the table while the DM is away), named as you like (*Crystal Ball*), no character, a long alphanumeric password.
The Seer logs in as it and reads the world; it writes nothing.

## 3. The environment file

Copy `seer/.env.example` somewhere outside the clone and fill it in. systemd reads the file before it drops
privileges, so it may be root's:

```sh
sudo install -m 0600 -o root -g root seer/.env.example <path-to-the-env-file>
sudoedit <path-to-the-env-file>
```

On the box: `FOUNDRY_URL=http://127.0.0.1:30000` (Foundry's own port), `BIND=127.0.0.1`,
`BASE_PATH=/crystalball`, `CORS_ORIGIN` left unset (the proxy makes the window and the Seer one origin), `DATA_DIR`
left unset (the unit's `StateDirectory=` gives the Seer `/var/lib/crystalball`), and `CONFIG`, if you override the
committed config at all, an absolute path (a relative one is taken from the clone's root). `ANTHROPIC_API_KEY` is a
key made for the Seer and nothing else, with a spend limit set in the Console; without it the Seer answers from its
stub. `docs/seer-contract.md` lists every variable.

**Write every value so both parsers agree** (Node's `--env-file` on a sandbox, systemd's `EnvironmentFile=` on the
box): letters, digits and `- _ . : / @` only, single spaces inside a value at most, no quotes, no backslash, no `#`,
no `$`, no `export`. An Anthropic key fits as it is; make the ball's password fit.

## 4. The unit

```sh
sudo cp seer/deploy/crystalball.service.example /etc/systemd/system/crystalball.service
sudoedit /etc/systemd/system/crystalball.service    # the placeholders, the node path
sudo systemctl daemon-reload
sudo systemctl enable --now crystalball
journalctl -u crystalball -f                        # "foundry: connected" when the world is up
curl -s http://127.0.0.1:30001/crystalball/healthz
```

The unit asks systemd for `StateDirectory=crystalball` (mode 0700, owned by the service user), the one place the
Seer writes under `ProtectSystem=strict`; sittings and the usage ledger live there. The commented
`StartLimitIntervalSec=`/`StartLimitBurst=` lines stop a unit that keeps failing instead of restarting it for ever.
`journalctl -u crystalball -p warning` shows only the Seer's warnings and errors.

**The time zone.** The limits' calendar day and month follow the process's zone, and a server is usually on UTC,
which resets every player's day around a US evening, mid-session. Uncomment `Environment=TZ=` with the DM's zone
(`America/Chicago` and the like) and restart; `healthz` reports the zone in effect. The ledger stores UTC times, so
changing the zone loses nothing.

## 5. The route from the public origin

Route `BASE_PATH` on Foundry's public hostname to the Seer, before the catch-all that sends everything else to
Foundry. Use `127.0.0.1`, not `localhost` (which can resolve to `::1`, where the Seer does not listen). Answers
stream as Server-Sent Events, so the proxy must not buffer that path; the Seer keeps idle connections 95 s, longer
than a tunnel's pool.

A Cloudflare Tunnel run from a local `config.yml`:

```yaml
ingress:
  - hostname: <foundry-hostname>
    path: ^/crystalball(/|$)
    service: http://127.0.0.1:30001
  - hostname: <foundry-hostname>
    service: http://127.0.0.1:30000
  - service: http_status:404
```

A tunnel managed from the Cloudflare dashboard (one run with a token) ignores `config.yml`: there the route is a
*Public Hostname* with the same hostname, the path `^/crystalball(/|$)` and the service `http://127.0.0.1:30001`,
ordered above Foundry's own hostname entry.

nginx:

```nginx
location /crystalball/ {
    proxy_pass http://127.0.0.1:30001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 120s;
}
```

Caddy:

```
handle /crystalball/* {
    reverse_proxy 127.0.0.1:30001 {
        flush_interval -1
    }
}
```

Then, in the world's settings, *Service URL* stays `/crystalball` (its default) and *Enabled* is on.

## Updating

```sh
cd <path-to-the-clone>
sudo git fetch --tags
sudo git checkout vX.Y.Z
sudo npm ci --omit=dev
sudo systemctl restart crystalball
journalctl -u crystalball -n 20                     # look for "foundry: connected"
```

Sittings and the usage ledger live in the state directory and survive an update. A Foundry upgrade needs no Seer
restart: the Seer reconnects by itself when Foundry restarts or the world returns to setup, backing off to one
attempt every fifteen seconds, and the window says the ball is dark meanwhile; "foundry: connected" in the journal is the sign
it is back. A Foundry build that reshapes `/join` keeps the Seer retrying until a Seer release verified on that
build (its fixtures under `seer/tests/fixtures/<version>/`) is deployed.
