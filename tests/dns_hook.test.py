"""python3 -I tests/dns_hook.test.py   (no network: the provider API is replaced by a small fake)"""
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

spec = importlib.util.spec_from_file_location("dns_hook", os.path.join(os.path.dirname(__file__), "..", "templates", "dns", "dns_hook.py"))
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)


class Fake:
    """Replaces h.http: answers from a table keyed by (method, path-with-query) and records every call."""

    def __init__(self, table):
        self.table, self.calls = table, []

    def __call__(self, method, url, token, body=None):
        path = url.split("//", 1)[1].split("/", 1)[1]
        self.calls.append((method, "/" + path, token, body))
        r = self.table.get((method, "/" + path))
        if r is None and method == "GET" and "zones?name=" in path:
            return 200, {"success": True, "result": [], "zones": []}  # an unknown zone name is an empty list at both providers
        if r is None:
            return 404, {}
        return r


def run(argv, creds, table, env=None):
    fake = Fake(table)
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(creds, f)
    h.CRED_FILE = f.name
    old = h.http, h.load.__defaults__
    h.http = fake
    h.load.__defaults__ = (f.name,)
    out, err = io.StringIO(), io.StringIO()
    waits = []
    try:
        with redirect_stdout(out), redirect_stderr(err):
            code = h.main(["x"] + argv, env=env or {}, sleep=waits.append)
    finally:
        h.http, h.load.__defaults__ = old
        os.unlink(f.name)
    return code, out.getvalue(), err.getvalue(), fake.calls, waits


CF = {"provider": "cloudflare", "token": "cf-secret", "wait": 7}
HZ = {"provider": "hetzner", "token": "hz-secret", "wait": 7}
V = {"CERTBOT_DOMAIN": "*.example.com", "CERTBOT_VALIDATION": "val123"}


class Helpers(unittest.TestCase):
    def test_candidates_longest_suffix_first(self):
        self.assertEqual(h.candidates("_acme-challenge.a.example.com"), ["_acme-challenge.a.example.com", "a.example.com", "example.com"])
        self.assertEqual(h.candidates("example.com"), ["example.com"])

    def test_txt_name_for_wildcard_and_plain(self):
        self.assertEqual(h.txt_name("*.Example.com"), "_acme-challenge.example.com")
        self.assertEqual(h.txt_name("sub.example.com."), "_acme-challenge.sub.example.com")

    def test_record_type_follows_the_address(self):
        self.assertEqual(h.addr_type("203.0.113.5"), "A")
        self.assertEqual(h.addr_type("2001:db8::1"), "AAAA")
        with self.assertRaises(ValueError):
            h.addr_type("not-an-ip")

    def test_hetzner_relative_names(self):
        self.assertEqual(h.Hetzner.rel("example.com", "example.com"), "@")
        self.assertEqual(h.Hetzner.rel("_acme-challenge.example.com", "example.com"), "_acme-challenge")
        self.assertEqual(h.Hetzner.rel("a.b.example.com", "example.com"), "a.b")


class Cloudflare(unittest.TestCase):
    ZONE = ("GET", "/client/v4/zones?name=example.com")

    def table(self, extra=None):
        t = {self.ZONE: (200, {"success": True, "result": [{"id": "z1", "name": "example.com"}]})}
        t.update(extra or {})
        return t

    def test_auth_sets_the_txt_record_and_waits(self):
        t = self.table({("POST", "/client/v4/zones/z1/dns_records"): (200, {"success": True})})
        code, out, err, calls, waits = run(["auth"], CF, t, V)
        self.assertEqual((code, err), (0, ""))
        post = [c for c in calls if c[0] == "POST"][0]
        self.assertEqual(post[3], {"type": "TXT", "name": "_acme-challenge.example.com", "content": "val123", "ttl": 60})
        self.assertEqual(post[2], "cf-secret")
        self.assertEqual(waits, [7])
        self.assertNotIn("cf-secret", out)

    def test_cleanup_removes_only_its_own_value(self):
        lst = ("GET", "/client/v4/zones/z1/dns_records?type=TXT&name=_acme-challenge.example.com&per_page=100")
        t = self.table({lst: (200, {"success": True, "result": [{"id": "r1", "content": "val123"}, {"id": "r2", "content": "other"}]}),
                        ("DELETE", "/client/v4/zones/z1/dns_records/r1"): (200, {"success": True})})
        code, _, err, calls, _ = run(["cleanup"], CF, t, V)
        self.assertEqual((code, err), (0, ""))
        self.assertEqual([c for c in calls if c[0] == "DELETE"][0][1], "/client/v4/zones/z1/dns_records/r1")
        self.assertEqual(len([c for c in calls if c[0] == "DELETE"]), 1)

    def test_api_errors_are_reported_without_the_token(self):
        t = {("GET", "/client/v4/zones?name=_acme-challenge.example.com"): (403, {"success": False, "errors": [{"message": "Authentication error"}]})}
        code, out, err, _, _ = run(["auth"], CF, t, V)
        self.assertEqual(code, 1)
        self.assertIn("Authentication error", err)
        self.assertNotIn("cf-secret", out + err)

    def test_unknown_zone(self):
        code, _, err, _, _ = run(["auth"], CF, {}, V)
        self.assertEqual(code, 1)
        self.assertIn("no zone for", err)

    def test_address_creates_updates_or_leaves(self):
        base = "/client/v4/zones/z1/dns_records"
        t = self.table({("GET", base + "?type=A&name=example.com&per_page=100"): (200, {"success": True, "result": []}),
                        ("POST", base): (200, {"success": True}),
                        ("GET", base + "?type=AAAA&name=example.com&per_page=100"): (200, {"success": True, "result": [{"id": "x", "content": "2001:db8::1"}]})})
        code, out, _, calls, _ = run(["address", "example.com", "203.0.113.5", "example.com", "2001:db8::1"], CF, t)
        self.assertEqual(code, 0)
        self.assertIn("created", out)
        self.assertIn("unchanged", out)
        self.assertEqual([c[3]["content"] for c in calls if c[0] == "POST"], ["203.0.113.5"])
        self.assertFalse([c for c in calls if c[0] == "POST"][0][3]["proxied"])


class Hetzner(unittest.TestCase):
    Z = ("GET", "/v1/zones?name=example.com")

    def table(self, extra=None):
        t = {self.Z: (200, {"zones": [{"id": 1, "name": "example.com"}]})}
        t.update(extra or {})
        return t

    def test_auth_adds_a_quoted_txt_record(self):
        t = self.table({("POST", "/v1/zones/example.com/rrsets/_acme-challenge/TXT/actions/add_records"): (201, {})})
        code, _, err, calls, waits = run(["auth"], HZ, t, V)
        self.assertEqual((code, err), (0, ""))
        post = [c for c in calls if c[0] == "POST"][0]
        self.assertEqual(post[3], {"records": [{"value": '"val123"'}]})
        self.assertEqual((post[2], waits), ("hz-secret", [7]))

    def test_auth_creates_the_rrset_when_it_does_not_exist(self):
        t = self.table({("POST", "/v1/zones/example.com/rrsets"): (201, {})})
        code, _, err, calls, _ = run(["auth"], HZ, t, V)
        self.assertEqual((code, err), (0, ""))
        created = [c for c in calls if c[1] == "/v1/zones/example.com/rrsets"][0]
        self.assertEqual(created[3], {"name": "_acme-challenge", "type": "TXT", "ttl": 60, "records": [{"value": '"val123"'}]})

    def test_cleanup_removes_the_record_and_ignores_a_missing_rrset(self):
        url = ("POST", "/v1/zones/example.com/rrsets/_acme-challenge/TXT/actions/remove_records")
        code, _, err, calls, _ = run(["cleanup"], HZ, self.table({url: (201, {})}), V)
        self.assertEqual((code, err), (0, ""))
        self.assertEqual([c for c in calls if c[1] == url[1]][0][3], {"records": [{"value": '"val123"'}]})
        code, _, _, _, _ = run(["cleanup"], HZ, self.table(), V)  # 404 for the RRSet
        self.assertEqual(code, 0)

    def test_apex_address_uses_the_at_sign(self):
        t = self.table({("GET", "/v1/zones/example.com/rrsets/@/A"): (404, {}), ("POST", "/v1/zones/example.com/rrsets/@/A/actions/add_records"): (404, {}),
                        ("POST", "/v1/zones/example.com/rrsets"): (201, {})})
        code, out, _, calls, _ = run(["address", "example.com", "203.0.113.5"], HZ, t)
        self.assertEqual(code, 0)
        self.assertIn("created", out)
        self.assertEqual([c for c in calls if c[1] == "/v1/zones/example.com/rrsets"][0][3]["name"], "@")

    def test_address_updates_a_different_value(self):
        t = self.table({("GET", "/v1/zones/example.com/rrsets/www/A"): (200, {"rrset": {"records": [{"value": "198.51.100.1"}]}}),
                        ("POST", "/v1/zones/example.com/rrsets/www/A/actions/set_records"): (201, {}),
                        ("GET", "/v1/zones?name=www.example.com"): (200, {"zones": []})})
        code, out, _, _, _ = run(["address", "www.example.com", "203.0.113.5"], HZ, t)
        self.assertEqual(code, 0)
        self.assertIn("updated", out)

    def test_error_message_of_the_provider_is_shown(self):
        code, _, err, _, _ = run(["auth"], HZ, {("GET", "/v1/zones?name=_acme-challenge.example.com"): (401, {"error": {"message": "unable to authenticate"}})}, V)
        self.assertEqual(code, 1)
        self.assertIn("unable to authenticate", err)


class Misc(unittest.TestCase):
    def test_missing_or_broken_credentials(self):
        code, _, err, _, _ = run(["test"], {"provider": "nope", "token": "x"}, {})
        self.assertEqual(code, 1)
        self.assertIn("incomplete", err)
        code, _, err, _, _ = run(["test"], {"provider": "hetzner"}, {})
        self.assertEqual(code, 1)

    def test_unknown_command_and_missing_environment(self):
        self.assertEqual(run(["frobnicate"], CF, {})[0], 1)
        self.assertEqual(run(["auth"], CF, {}, {})[0], 1)

    def test_wait_is_limited(self):
        t = {("GET", "/client/v4/zones?name=example.com"): (200, {"success": True, "result": [{"id": "z1"}]}), ("POST", "/client/v4/zones/z1/dns_records"): (200, {"success": True})}
        self.assertEqual(run(["auth"], dict(CF, wait=99999), t, V)[4], [300])
        self.assertEqual(run(["auth"], dict(CF, wait=-5), t, V)[4], [0])

    def test_test_command_lists_zones(self):
        t = {("GET", "/client/v4/zones?per_page=50"): (200, {"success": True, "result": [{"name": "example.com"}, {"name": "example.org"}]})}
        code, out, _, _, _ = run(["test"], CF, t)
        self.assertEqual(code, 0)
        self.assertIn("2 zone(s)", out)
        self.assertIn("example.org", out)


if __name__ == "__main__":
    unittest.main(verbosity=1)
