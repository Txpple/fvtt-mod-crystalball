# Putting the Seer on a Linux box

The Seer runs beside Foundry on the same machine: it joins Foundry on `localhost`, listens on `127.0.0.1` only,
and is reached by players through a reverse proxy or tunnel rule that routes one path of Foundry's public origin to
it. Every value below in angle brackets is yours to choose; nothing here names a real machine.

## 1. Node and the clone

The Seer needs Node 24 or newer (Foundry 14's own). As the service user, in its home or wherever it keeps services:

```sh
git clone https://github.com/Txpple/fvtt-mod-crystalball.git <path-to-the-clone>
cd <path-to-the-clone>
git checkout vX.Y.Z          # the release whose module the world runs
npm ci --omit=dev            # the three runtime dependencies, nothing else
```

`healthz` reports the version from `module.json`; the window warns when it differs from the module's.

## 2. The ball's user

In Foundry, *User Management*: a user of role **Player** (never a GM: a GM-level socket would be elected to act for
the table while the DM is away), named as you like (*Crystal Ball*), no character, a long password. The Seer logs
in as it and reads the world; it writes nothing.

## 3. The environment file

Copy `seer/.env.example` to a file only the service user can read and fill it in:

```sh
install -m 0600 -o <service-user> -g <service-group> seer/.env.example <path-to-the-env-file>
```

On the box: `FOUNDRY_URL` is Foundry's own port on localhost (`http://localhost:30000`), `BIND=127.0.0.1`,
`BASE_PATH=/crystalball`, `CORS_ORIGIN` empty (the proxy makes the window and the Seer one origin), `DATA_DIR`
an absolute path the service may write. `ANTHROPIC_API_KEY` is a key made for the Seer and nothing else, with a
spend limit set in the Console; without it the Seer answers from its stub. `docs/seer-contract.md` lists every
variable.

Create the data directory, owned by the service user, mode 0700:

```sh
install -d -m 0700 -o <service-user> -g <service-group> <path-to-the-data-dir>
```

## 4. The unit

```sh
sudo cp seer/deploy/crystalball.service.example /etc/systemd/system/crystalball.service
sudoedit /etc/systemd/system/crystalball.service    # the placeholders
sudo systemctl daemon-reload
sudo systemctl enable --now crystalball
journalctl -u crystalball -f                        # "foundry: connected" when the world is up
curl -s http://127.0.0.1:30001/crystalball/healthz
```

## 5. The route from the public origin

Route `BASE_PATH` on Foundry's public hostname to the Seer, before the catch-all that sends everything else to
Foundry. Answers stream as Server-Sent Events, so the proxy must not buffer that path.

A Cloudflare Tunnel (`config.yml` of `cloudflared`):

```yaml
ingress:
  - hostname: <foundry-hostname>
    path: ^/crystalball(/|$)
    service: http://localhost:30001
  - hostname: <foundry-hostname>
    service: http://localhost:30000
  - service: http_status:404
```

nginx:

```nginx
location /crystalball/ {
    proxy_pass http://127.0.0.1:30001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
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
git fetch --tags
git checkout vX.Y.Z
npm ci --omit=dev
sudo systemctl restart crystalball
```

Sittings and the usage ledger live in the data directory and survive an update. The Seer reconnects by itself when
Foundry restarts or the world returns to setup for an install; meanwhile the window says the ball is dark.
