#!/usr/bin/env python3
"""
DNS provider access for WebManager, run inside the certificate tool container (Python from the certbot image, standard library only).

  dns_hook.py auth        certbot --manual-auth-hook: sets _acme-challenge.<CERTBOT_DOMAIN> TXT = CERTBOT_VALIDATION and waits
  dns_hook.py cleanup     certbot --manual-cleanup-hook: removes that value again
  dns_hook.py test        checks the token: prints the number of zones it can see
  dns_hook.py address NAME VALUE [NAME VALUE ...]   sets A/AAAA records (VALUE is an IPv4/IPv6 address; the type follows from it)

The provider and the token come from /dns/credentials.json ({"provider": "cloudflare"|"hetzner", "token": "...", "wait": 30}),
mounted read-only. Only the records named above are touched; other records of a name are left as they are.
"""
import ipaddress
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

CRED_FILE = os.environ.get("WM_DNS_CREDENTIALS", "/dns/credentials.json")
TIMEOUT = 20
TTL = 60


class DnsError(Exception):
    pass


def http(method, url, token, body=None):
    """JSON request with a Bearer token; returns (status, parsed JSON or {})."""
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", "webmanager-dns/1")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw) if raw else {}
        except ValueError:
            return e.code, {}
    except (urllib.error.URLError, OSError) as e:
        raise DnsError("The DNS provider cannot be reached: %s" % getattr(e, "reason", e))


def candidates(name):
    """example.com, www.example.com -> ['www.example.com', 'example.com'] (the zone is the longest suffix the account has)."""
    labels = name.strip(".").lower().split(".")
    return [".".join(labels[i:]) for i in range(0, len(labels) - 1)]


def txt_name(domain):
    d = domain.strip(".").lower()
    if d.startswith("*."):
        d = d[2:]
    return "_acme-challenge." + d


def addr_type(value):
    ip = ipaddress.ip_address(value)
    return "A" if ip.version == 4 else "AAAA"


class Cloudflare:
    API = "https://api.cloudflare.com/client/v4"

    def __init__(self, token):
        self.token = token

    def call(self, method, path, body=None):
        status, j = http(method, self.API + path, self.token, body)
        if status >= 300 or not j.get("success", False):
            errs = "; ".join(str(e.get("message", e)) for e in (j.get("errors") or [])) or "HTTP %d" % status
            raise DnsError("Cloudflare: " + errs)
        return j

    def zone(self, name):
        for c in candidates(name):
            res = self.call("GET", "/zones?name=" + urllib.parse.quote(c))["result"]
            if res:
                return res[0]["id"]
        raise DnsError("Cloudflare: no zone for %s in this account (does the token have Zone:Read?)" % name)

    def zones(self):
        return self.call("GET", "/zones?per_page=50")["result"]

    def add_txt(self, name, value):
        z = self.zone(name)
        self.call("POST", "/zones/%s/dns_records" % z, {"type": "TXT", "name": name, "content": value, "ttl": TTL})

    def remove_txt(self, name, value):
        z = self.zone(name)
        q = "type=TXT&name=%s&per_page=100" % urllib.parse.quote(name)
        for r in self.call("GET", "/zones/%s/dns_records?%s" % (z, q))["result"]:
            if r.get("content", "").strip('"') == value:
                self.call("DELETE", "/zones/%s/dns_records/%s" % (z, r["id"]))

    def set_address(self, name, value):
        z = self.zone(name)
        typ = addr_type(value)
        q = "type=%s&name=%s&per_page=100" % (typ, urllib.parse.quote(name))
        found = self.call("GET", "/zones/%s/dns_records?%s" % (z, q))["result"]
        body = {"type": typ, "name": name, "content": value, "ttl": 300, "proxied": False}
        if any(r.get("content") == value for r in found):
            return "unchanged"
        if found:
            self.call("PUT", "/zones/%s/dns_records/%s" % (z, found[0]["id"]), body)
            return "updated"
        self.call("POST", "/zones/%s/dns_records" % z, body)
        return "created"


class Hetzner:
    """Hetzner DNS in the Hetzner Console (Cloud API: zones and RRSets)."""
    API = "https://api.hetzner.cloud/v1"

    def __init__(self, token):
        self.token = token

    def call(self, method, path, body=None, ok=(200, 201)):
        status, j = http(method, self.API + path, self.token, body)
        if status not in ok:
            err = j.get("error") or {}
            raise DnsError("Hetzner: %s" % (err.get("message") or "HTTP %d" % status))
        return status, j

    def zone(self, name):
        for c in candidates(name):
            _, j = self.call("GET", "/zones?name=" + urllib.parse.quote(c))
            if j.get("zones"):
                return j["zones"][0]["name"]
        raise DnsError("Hetzner: no zone for %s in this project (the zone must be in the new Hetzner Console)" % name)

    def zones(self):
        return self.call("GET", "/zones?per_page=50")[1].get("zones", [])

    @staticmethod
    def rel(name, zone):
        n = name.strip(".").lower()
        if n == zone:
            return "@"
        return n[: -(len(zone) + 1)]

    def add_records(self, name, typ, value, ttl):
        zone = self.zone(name)
        rr = urllib.parse.quote(self.rel(name, zone), safe="@")
        path = "/zones/%s/rrsets/%s/%s" % (zone, rr, typ)
        status, j = http("POST", self.API + path + "/actions/add_records", self.token, {"records": [{"value": value}]})
        if status == 404:  # the RRSet does not exist yet
            self.call("POST", "/zones/%s/rrsets" % zone, {"name": self.rel(name, zone), "type": typ, "ttl": ttl, "records": [{"value": value}]})
        elif status not in (200, 201):
            raise DnsError("Hetzner: %s" % ((j.get("error") or {}).get("message") or "HTTP %d" % status))

    def add_txt(self, name, value):
        self.add_records(name, "TXT", '"%s"' % value, TTL)

    def remove_txt(self, name, value):
        zone = self.zone(name)
        rr = urllib.parse.quote(self.rel(name, zone), safe="@")
        status, j = http("POST", self.API + "/zones/%s/rrsets/%s/TXT/actions/remove_records" % (zone, rr), self.token, {"records": [{"value": '"%s"' % value}]})
        if status not in (200, 201, 404):
            raise DnsError("Hetzner: %s" % ((j.get("error") or {}).get("message") or "HTTP %d" % status))

    def set_address(self, name, value):
        zone = self.zone(name)
        typ = addr_type(value)
        rr = urllib.parse.quote(self.rel(name, zone), safe="@")
        status, j = http("GET", self.API + "/zones/%s/rrsets/%s/%s" % (zone, rr, typ), self.token)
        if status == 200:
            current = [r.get("value") for r in (j.get("rrset") or {}).get("records", [])]
            if value in current:
                return "unchanged"
            self.call("POST", "/zones/%s/rrsets/%s/%s/actions/set_records" % (zone, rr, typ), {"records": [{"value": value}]})
            return "updated"
        if status != 404:
            raise DnsError("Hetzner: %s" % ((j.get("error") or {}).get("message") or "HTTP %d" % status))
        self.add_records(name, typ, value, 300)
        return "created"


PROVIDERS = {"cloudflare": Cloudflare, "hetzner": Hetzner}


def load(path=CRED_FILE):
    try:
        with open(path) as f:
            c = json.load(f)
    except (OSError, ValueError):
        raise DnsError("No DNS credentials are stored.")
    cls = PROVIDERS.get(c.get("provider"))
    token = c.get("token")
    if cls is None or not isinstance(token, str) or not token:
        raise DnsError("The stored DNS credentials are incomplete.")
    return cls(token), c


def main(argv, env=None, sleep=time.sleep):
    env = os.environ if env is None else env
    cmd = argv[1] if len(argv) > 1 else ""
    try:
        prov, cred = load()
        if cmd == "auth":
            name = txt_name(env["CERTBOT_DOMAIN"])
            prov.add_txt(name, env["CERTBOT_VALIDATION"])
            wait = max(0, min(int(cred.get("wait", 30)), 300))
            print("TXT record set for %s, waiting %d s for the name servers" % (name, wait), flush=True)
            sleep(wait)
        elif cmd == "cleanup":
            name = txt_name(env["CERTBOT_DOMAIN"])
            prov.remove_txt(name, env["CERTBOT_VALIDATION"])
            print("TXT record removed for %s" % name, flush=True)
        elif cmd == "test":
            print("OK: the token sees %d zone(s): %s" % (len(prov.zones()), ", ".join(str(z.get("name")) for z in prov.zones()[:10])))
        elif cmd == "address":
            pairs = argv[2:]
            if not pairs or len(pairs) % 2:
                raise DnsError("usage: address NAME VALUE [NAME VALUE ...]")
            for name, value in zip(pairs[0::2], pairs[1::2]):
                print("%s %s -> %s: %s" % (name, addr_type(value), value, prov.set_address(name.strip(".").lower(), value)), flush=True)
        else:
            raise DnsError("unknown command")
    except DnsError as e:
        print("ERROR: %s" % e, file=sys.stderr)
        return 1
    except (KeyError, ValueError) as e:
        print("ERROR: invalid input (%s)" % e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
