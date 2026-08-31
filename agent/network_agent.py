#!/usr/bin/env python3
"""Lightweight Raspberry Pi probe and iperf3 agent (standard library only)."""

import argparse
import concurrent.futures
import hmac
import json
import socket
import subprocess
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def utc_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def elapsed_ms(started):
    return round((time.perf_counter() - started) * 1000, 1)


def ping_once(target, timeout_ms):
    started = time.perf_counter()
    try:
        result = subprocess.run(
            ["ping", "-c", "1", "-W", str(max(1, (timeout_ms + 999) // 1000)), target],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=(timeout_ms / 1000) + 0.4,
            check=False,
        )
        return {"success": result.returncode == 0, "latencyMs": elapsed_ms(started) if result.returncode == 0 else None}
    except (subprocess.TimeoutExpired, OSError) as exc:
        return {"success": False, "latencyMs": None, "error": str(exc)}


def tcp_probe(host, port, timeout_ms):
    started = time.perf_counter()
    try:
        with socket.create_connection((host, int(port)), timeout=timeout_ms / 1000):
            return {"success": True, "latencyMs": elapsed_ms(started)}
    except OSError as exc:
        return {"success": False, "latencyMs": None, "error": str(exc)}


def dns_probe(hostname, timeout_ms):
    started = time.perf_counter()
    previous_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(timeout_ms / 1000)
    try:
        socket.getaddrinfo(hostname, 443, type=socket.SOCK_STREAM)
        return {"success": True, "latencyMs": elapsed_ms(started)}
    except OSError as exc:
        return {"success": False, "latencyMs": None, "error": str(exc)}
    finally:
        socket.setdefaulttimeout(previous_timeout)


def http_probe(url, timeout_ms):
    started = time.perf_counter()
    request = urllib.request.Request(url, headers={"User-Agent": "Network-System-Agent/0.1"})
    try:
        with urllib.request.urlopen(request, timeout=timeout_ms / 1000) as response:
            status = response.status
            response.read(32)
            return {"success": status < 500, "latencyMs": elapsed_ms(started), "status": status}
    except urllib.error.HTTPError as exc:
        return {"success": exc.code < 500, "latencyMs": elapsed_ms(started), "status": exc.code, "error": str(exc)}
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return {"success": False, "latencyMs": None, "status": None, "error": str(exc)}


def run_probe(payload):
    probe = payload["probe"]
    node = payload["node"]
    timeout_ms = int(probe.get("timeoutMs", 850))
    ping_targets = probe.get("publicPingTargets", [])
    internal_targets = payload.get("internalTargets", [])
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        public_ping_futures = [pool.submit(ping_once, target, timeout_ms) for target in ping_targets]
        internal_futures = [(target, pool.submit(ping_once, target["address"], timeout_ms)) for target in internal_targets]
        tcp_future = pool.submit(tcp_probe, probe["tcpTarget"]["host"], probe["tcpTarget"]["port"], timeout_ms)
        dns_future = pool.submit(dns_probe, probe["dnsHostname"], timeout_ms)
        http_future = pool.submit(http_probe, probe["httpUrl"], timeout_ms)
        public_pings = [future.result() for future in public_ping_futures]
        internal = []
        for target, future in internal_futures:
            internal.append({
                "targetId": target["id"], "targetName": target["name"],
                "targetAddress": target["address"], **future.result()
            })
        tcp_result, dns_result, http_result = tcp_future.result(), dns_future.result(), http_future.result()
    successful_pings = [item for item in public_pings if item["success"]]
    ping_result = {
        "success": bool(successful_pings),
        "latencyMs": min((item["latencyMs"] for item in successful_pings), default=None),
        "targetsSucceeded": len(successful_pings), "targetsTotal": len(public_pings),
    }
    score = sum(bool(item) for item in [ping_result["success"], tcp_result["success"], dns_result["success"], http_result["success"]])
    return {
        "recordedAt": utc_now(), "nodeId": node["id"], "nodeName": node["name"],
        "agentReachable": True,
        "public": {
            "online": score >= int(probe.get("onlineMinimumSignals", 2)), "score": score,
            "ping": ping_result, "tcp": tcp_result, "dns": dns_result, "http": http_result,
        },
        "internal": internal, "statusMessage": None,
    }


def run_iperf(payload):
    duration = max(1, min(60, int(payload.get("durationSeconds", 5))))
    protocol = payload.get("protocol", "tcp")
    if protocol not in ("tcp", "udp"):
        raise ValueError("protocol must be tcp or udp")
    args = ["iperf3", "-c", str(payload["target"]), "-p", str(int(payload.get("port", 5201))), "-t", str(duration), "-J"]
    if payload.get("reverse"):
        args.append("-R")
    if protocol == "udp":
        args.extend(["-u", "-b", str(payload.get("udpBandwidth", "10M"))])
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=duration + 8, check=False)
    except FileNotFoundError:
        return {"success": False, "error": "找不到 iperf3，請執行 sudo apt install iperf3"}
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "iperf3 執行逾時"}
    if result.returncode != 0:
        return {"success": False, "error": (result.stderr or "iperf3 failed").strip()[:500]}
    data = json.loads(result.stdout)
    if data.get("error"):
        return {"success": False, "error": data["error"]}
    if protocol == "udp":
        summary = data.get("end", {}).get("sum_received") or data.get("end", {}).get("sum", {})
        bits = summary.get("bits_per_second")
        return {
            "success": isinstance(bits, (int, float)), "mbps": round(bits / 1_000_000, 1) if bits is not None else None,
            "retransmits": None, "jitterMs": summary.get("jitter_ms"), "lostPercent": summary.get("lost_percent"),
        }
    end = data.get("end", {})
    received, sent = end.get("sum_received", {}), end.get("sum_sent", {})
    bits = received.get("bits_per_second", sent.get("bits_per_second"))
    return {
        "success": isinstance(bits, (int, float)), "mbps": round(bits / 1_000_000, 1) if bits is not None else None,
        "retransmits": sent.get("retransmits"), "jitterMs": None, "lostPercent": None,
    }


class AgentHandler(BaseHTTPRequestHandler):
    server_version = "NetworkAgent/0.1"

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {"ok": True, "time": utc_now()})
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if not hmac.compare_digest(self.headers.get("x-agent-token", ""), self.server.agent_token):
            self.send_json(401, {"error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            if length > 65536:
                raise ValueError("request too large")
            payload = json.loads(self.rfile.read(length) or b"{}")
            if self.path == "/probe":
                result = run_probe(payload)
            elif self.path == "/iperf":
                result = run_iperf(payload)
            else:
                self.send_json(404, {"error": "not found"})
                return
            self.send_json(200, result)
        except (ValueError, KeyError, json.JSONDecodeError) as exc:
            self.send_json(400, {"error": str(exc)})
        except Exception as exc:  # keep the agent alive and return a useful controller error
            self.send_json(500, {"error": str(exc)})

    def send_json(self, status, payload):
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} - {fmt % args}")


def main():
    parser = argparse.ArgumentParser(description="Network System Raspberry Pi agent")
    parser.add_argument("--config", default="agent/agent-config.json")
    args = parser.parse_args()
    with open(args.config, "r", encoding="utf-8") as handle:
        config = json.load(handle)
    server = ThreadingHTTPServer((config.get("host", "0.0.0.0"), int(config.get("port", 8765))), AgentHandler)
    server.agent_token = config["token"]
    print(f"Network agent listening on {server.server_address[0]}:{server.server_address[1]}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
