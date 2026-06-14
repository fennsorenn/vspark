# vspark multiplayer coordination bundle

A drop-on-a-server `docker compose` stack with everything two vspark servers need
to find each other and connect **without port forwarding** on their side:

| Service | Role |
| --- | --- |
| **rendezvous** | signaling + presence + pairing + short-lived TURN-cred minting. The only piece that must be publicly reachable. |
| **coturn** | STUN (NAT hole-punch) + TURN (relay fallback), load-capped. |
| **caddy** | automatic HTTPS; proxies `wss://RDV_DOMAIN` → rendezvous. |

You host this **once** for your collab group; individual vspark servers stay
behind NAT and connect out to it. It holds no long-term state and is not trusted
for identity (peers authenticate each other end-to-end by Ed25519 key).

## Setup

1. **DNS:** point an A record (`RDV_DOMAIN`) at this host.
2. **Config:** `cp .env.example .env` and fill in `RDV_DOMAIN`, `PUBLIC_IP`, and a
   random `TURN_SECRET` (`openssl rand -hex 32`).
3. **Ports:** open inbound `80`, `443` (Caddy), `3478/udp+tcp` and the relay range
   `49160-49200/udp` (coturn). coturn runs in host-network mode for the relay.
4. **Run:** `docker compose up -d --build`.
5. In each vspark server's Connections settings, set the rendezvous URL to
   `wss://RDV_DOMAIN`.

## Keeping TURN cheap

TURN only relays when direct/STUN hole-punching fails (strict-NAT / CGNAT pairs),
so most sessions never touch it. It's still capped so a relayed session can't
saturate the host — see `coturn/turnserver.conf` (`bps-capacity`, `max-bps`,
`user-quota`, `total-quota`, bounded relay port range) and the `deploy.resources`
cpu/memory limits in `docker-compose.yml`. Credentials are short-lived HMAC
tokens minted by the rendezvous (shared `TURN_SECRET`), so coturn is never an
open relay.

## Optional: TURN over TLS (`turns:`)

Plain `turn:` (3478) is the default and works for most firewalls. For very
restrictive networks, enable `turns:` by setting `tls-listening-port=5349` +
`cert`/`pkey` in `turnserver.conf` (point them at the Caddy-obtained cert or a
certbot cert) and adding `turns:RDV_DOMAIN:5349` to `TURN_URLS`.

## Prototyping without this bundle

For early testing you can skip the bundle entirely: use a public STUN server and
PeerJS's free public PeerServer for signaling (rate-limited, no TURN — strict-NAT
pairs will fail). The bundle is the production path.
