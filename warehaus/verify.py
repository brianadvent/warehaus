"""Run the `verify_cmd` of each claim and judge the result.

The lint checks the FORM of a claim. This module checks what can be said
mechanically about its CONTENT, and is honest about where that ends.

The one point where a naive implementation goes wrong
-----------------------------------------------------
An exit convention of "0 confirmed, 1 refuted, 2 unverifiable" assumes that a
verify command tests an ASSERTION. Most verify commands do not; they FETCH:

    curl https://api.example.com/orders/count

That command exits 0 no matter whether the number in the claim is right.
Whoever books exit 0 as "confirmed" and advances the `as_of` date builds a
guard that reports every claim green and guards nothing. That is exactly the
failure class this whole system is built against.

Hence four verdicts instead of three:

    confirmed     The command is a real check (assertion) and was green, OR
                  the claim carries a generated range and the generator
                  returns the same value within tolerance.
    refuted       Assertion red (exit 1), or the generator value deviates
                  beyond tolerance, or a search no longer finds its pattern.
    executed      The fetch ran clean, but whether the claim text is right
                  this module cannot decide. The output is captured for the
                  report; the semantic cross-check is model or human work.
                  NEVER count this as confirmation.
    unverifiable  Placeholder in the command, timeout, suspected write
                  access, unexpected exit code.

Only `confirmed` advances the `as_of` date with --write. `executed`
explicitly does not.

Assertions are not guessed. They are declared: the built-in patterns cover
`warehaus lint` and `warehaus contradictions` (both exit 1 on failure), and a
project adds its own real checks via `[verify] assert_patterns` in
warehaus.toml. Everything else counts as a fetch, not a confirmation.

Searches (grep/rg) are a special case with a useful asymmetry: if the search
does NOT find its pattern (exit 1), the spot the claim relies on is gone and
the claim is refuted. If it finds it, only the existence of the spot is
proven, not the prose next to it. Absence proves; presence does not.

Cost levels via --budget, mirroring the claim field `budget`:
    free         local sources, code greps, cache, files. Default.
    single_call  additionally single API calls.
    bulk         never automatic, only by hand with --budget=bulk.

Exit: 0 nothing refuted, 1 at least one claim refuted, 2 not runnable.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import date
from pathlib import Path

from .claims import BLOCK_RE, BUDGET_LEVELS, GEN_RE, parse_header, read_claims
from .config import Config, ConfigError, die, load_config

# Built-in assertion patterns: commands that really test a statement and exit
# 1 on deviation. A project registers its own via [verify] assert_patterns.
BUILTIN_ASSERT_PATTERNS = (re.compile(r"\bwarehaus\s+(lint|contradictions)\b"),)

SEARCH_PATTERNS = (
    re.compile(r"^\s*grep\b"),
    re.compile(r"\|\s*grep\b"),
    re.compile(r"&&\s*grep\b"),
    re.compile(r"^\s*rg\b"),
)

# A verify command is read-only. These markers hint at a write; the module
# refuses to run them instead of trying.
FORBIDDEN = (
    re.compile(r"--commit\b"),
    re.compile(r"--write\b"),
    re.compile(r"-X\s*(POST|PUT|PATCH|DELETE)\b", re.I),
    re.compile(r"\b(rm|mv|dd|truncate)\s"),
    re.compile(r"\.(create|update|delete|cancel|void|commit)\b"),
)

PLACEHOLDER_RE = re.compile(r"<[^>]{2,}>")

VERDICT_ORDER = ("refuted", "unverifiable", "executed", "confirmed")


def environment(config: Config) -> dict:
    """Process environment plus the configured env file.

    Without this, every verify command that does not run through a CLI tool
    fails: the tools load their env file themselves, but a bare `curl` or
    `python3 -c` inside a verify command gets the keys from nowhere and
    strands as "unverifiable" although the claim is fine.
    """
    env = dict(os.environ)
    if not config.env_file or not config.env_file.exists():
        return env
    for line in config.env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        env.setdefault(key.strip(), value)
    return env


def secret_values(env: dict) -> list[str]:
    """Values that never belong in a report.

    The report is read by agents and lands on disk; a tool that writes its
    token into an error message would otherwise carry it there.
    """
    hits = []
    for key, value in env.items():
        if len(value or "") < 12:
            continue
        if re.search(r"(KEY|TOKEN|SECRET|PASS|CLIENT_ID|SERVICE_ROLE)", key, re.I):
            hits.append(value)
    return sorted(set(hits), key=len, reverse=True)


def redact(text: str, values: list[str]) -> str:
    for value in values:
        if value and value in text:
            text = text.replace(value, "<redacted>")
    return text


def is_assertion(cmd: str, extra: list[re.Pattern]) -> bool:
    return any(p.search(cmd) for p in (*BUILTIN_ASSERT_PATTERNS, *extra))


def is_search(cmd: str) -> bool:
    return any(p.search(cmd) for p in SEARCH_PATTERNS)


def write_suspicion(cmd: str) -> str | None:
    for p in FORBIDDEN:
        if p.search(cmd):
            return p.pattern
    return None


def generator_value(config: Config, gen_id: str, budget: str) -> tuple[str | None, str]:
    """Fetch the value of a generated claim from the project's generator.

    Returns (value, hint). `value` is None when the generator could not
    deliver; the hint says why. Contract: the command must accept
    --budget/--only/--format=json and print {"values": {...}, "errors":
    [...], "skipped": [...]}.
    """
    cmd = f"{config.generator_command} --budget={budget} --only={gen_id} --format=json"
    try:
        res = subprocess.run(
            cmd, shell=True, cwd=config.root, capture_output=True, text=True, timeout=600,
        )
    except subprocess.TimeoutExpired:
        return None, "generator timed out after 600 s"
    try:
        data = json.loads(res.stdout)
    except ValueError:
        return None, f"generator output not readable: {(res.stderr or res.stdout).strip()[:160]}"
    if gen_id in data.get("values", {}):
        return data["values"][gen_id], "from generator"
    reason = next(
        (f for f in list(data.get("errors", [])) + list(data.get("skipped", []))
         if str(f).startswith(gen_id)),
        None,
    )
    return None, (reason or "generator returned no value")


def as_number(value: str):
    raw = re.sub(r"[^\d]", "", value or "")
    return int(raw) if raw else None


def check(claim, config: Config, env: dict, secrets: list[str],
          assert_extra: list[re.Pattern], timeout: int, output_chars: int) -> dict:
    header = claim.header
    cmd = header.get("verify_cmd")
    result = {
        "id": claim.id,
        "type": header.get("type"),
        "sot": header.get("sot"),
        "maintenance": header.get("maintenance"),
        "budget": header.get("budget"),
        "as_of": header.get("as_of"),
        "file": claim.display,
        "path": str(claim.path),
        "line": claim.line,
        "cmd": cmd,
        "verdict": None,
        "reason": "",
        "output": "",
        "claim_text": " ".join(claim.text.split())[:600],
    }

    if not cmd:
        result["verdict"] = "unverifiable"
        result["reason"] = "no verify_cmd"
        return result

    # Placeholders only OUTSIDE quotes: a search pattern may contain angle
    # brackets (`grep 'Usage: x <a|b>' file`), and those are not a blank to
    # fill in but part of the searched text.
    without_strings = re.sub(r"'[^']*'|\"[^\"]*\"", " ", cmd)
    if PLACEHOLDER_RE.search(without_strings):
        result["verdict"] = "unverifiable"
        result["reason"] = (
            "placeholder in the command, not executable without filling in: "
            + ", ".join(PLACEHOLDER_RE.findall(without_strings))
        )
        return result

    suspicion = write_suspicion(cmd)
    if suspicion:
        result["verdict"] = "unverifiable"
        result["reason"] = f"possible write access, not executed (pattern {suspicion!r})"
        return result

    # Generated claims are held against the generator, not against an exit
    # code. This is the only place where a fetch becomes a real statement
    # about the claim's content.
    gen = GEN_RE.search(claim.text)
    if header.get("maintenance") == "generated" and gen:
        gen_id = gen.group(1)
        in_text = " ".join(gen.group(2).split())
        if not config.generator_command:
            result["verdict"] = "unverifiable"
            result["reason"] = "no [generator] command configured"
            return result
        value, hint = generator_value(config, gen_id, header.get("budget", "free"))
        result["output"] = f"generator: {value!r} | claim: {in_text!r} ({hint})"
        if value is None:
            result["verdict"] = "unverifiable"
            result["reason"] = hint
            return result
        if " ".join(str(value).split()) == in_text:
            result["verdict"] = "confirmed"
            result["reason"] = "generator value identical"
            return result
        a, b = as_number(in_text), as_number(str(value))
        tolerance = float((header.get("tolerance") or "0%").rstrip("%") or 0)
        if a and b and a != 0 and abs(b - a) / a * 100 <= tolerance:
            result["verdict"] = "confirmed"
            result["reason"] = f"within tolerance {tolerance:.0f} %"
            return result
        result["verdict"] = "refuted"
        result["reason"] = f"generator returns {value!r}, claim says {in_text!r}"
        return result

    try:
        res = subprocess.run(
            cmd, shell=True, cwd=config.root, capture_output=True, text=True,
            timeout=timeout, env=env,
        )
    except subprocess.TimeoutExpired:
        result["verdict"] = "unverifiable"
        result["reason"] = f"timeout after {timeout} s"
        return result

    stdout = (res.stdout or "").strip()
    stderr = (res.stderr or "").strip()
    result["output"] = redact(stdout or stderr, secrets)[:output_chars]

    # Some claims state that something does NOT work ("the API has no
    # sessions endpoint"). There a failing command is the confirmation. The
    # runner cannot see the polarity in the command, so the claim declares it.
    expected = header.get("expected_exit")
    if expected:
        matches = (res.returncode != 0) if expected == "non-zero" else (str(res.returncode) == expected)
        result["verdict"] = "confirmed" if matches else "refuted"
        result["reason"] = (
            f"expected_exit={expected}, actual {res.returncode}"
            + ("" if matches else " - the claim predicts the opposite")
        )
        return result

    if res.returncode == 0:
        if is_assertion(cmd, assert_extra):
            result["verdict"] = "confirmed"
            result["reason"] = "assertion green"
        elif is_search(cmd):
            result["verdict"] = "executed"
            result["reason"] = (
                "The search found its pattern, so the referenced spot exists. "
                "Whether the prose next to it is right, this does not say; "
                "semantic cross-check still open."
            )
        else:
            result["verdict"] = "executed"
            result["reason"] = (
                "Fetch command ran clean. Exit 0 says NOTHING about whether "
                "the claim text is right; semantic cross-check still open."
            )
    elif res.returncode == 1 and is_assertion(cmd, assert_extra):
        result["verdict"] = "refuted"
        result["reason"] = "assertion red (exit 1)"
    elif res.returncode == 1 and is_search(cmd):
        result["verdict"] = "refuted"
        result["reason"] = (
            "The search NO LONGER finds its pattern. The spot the claim "
            "relies on is gone, renamed or moved."
        )
    elif res.returncode == 2:
        result["verdict"] = "unverifiable"
        result["reason"] = "command reports not runnable (exit 2)"
    else:
        result["verdict"] = "unverifiable"
        result["reason"] = f"unexpected exit {res.returncode}"
    return result


def write_as_of(confirmed: list[dict]) -> int:
    """Advance `as_of` to today, only for confirmed claims."""
    today = date.today().isoformat()
    per_file: dict[Path, list[str]] = {}
    for r in confirmed:
        per_file.setdefault(Path(r["path"]), []).append(r["id"])
    written = 0
    for path, ids in per_file.items():
        content = path.read_text(encoding="utf-8")

        def replace(m):
            nonlocal written
            header, _ = parse_header(m.group("header"))
            if header.get("id") not in ids or header.get("as_of") == today:
                return m.group(0)
            written += 1
            new_header = re.sub(r"^as_of:.*$", f"as_of: {today}", m.group("header"), flags=re.M)
            return m.group(0).replace(m.group("header"), new_header, 1)

        path.write_text(BLOCK_RE.sub(replace, content), encoding="utf-8")
    return written


def register(subparsers) -> None:
    p = subparsers.add_parser(
        "verify",
        help="run the verify_cmd of every claim and judge the result",
        description="Runs verify commands and reports confirmed, refuted, "
                    "executed or unverifiable per claim. Executed is not "
                    "confirmed; see the module documentation.",
    )
    p.add_argument("--budget", choices=list(BUDGET_LEVELS), default="free")
    p.add_argument("--only", default="", help="comma-separated list of claim ids")
    p.add_argument("--file", default="", help="only claims from this knowledge file")
    p.add_argument("--type", default="", help="only claims of this type")
    p.add_argument("--timeout", type=int, default=0,
                   help="seconds per command (default: [verify] timeout from warehaus.toml)")
    p.add_argument("--output-chars", type=int, default=1200,
                   help="how much command output goes into the report")
    p.add_argument("--write", action="store_true",
                   help="advance as_of of CONFIRMED claims to today")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=run)


def run(args) -> int:
    try:
        config = load_config(args.config)
    except ConfigError as exc:
        return die(str(exc))

    only = {t.strip() for t in args.only.split(",") if t.strip()}
    level = BUDGET_LEVELS[args.budget]
    timeout = args.timeout or config.verify_timeout
    try:
        assert_extra = [re.compile(p) for p in config.assert_patterns]
    except re.error as exc:
        return die(f"invalid regex in [verify] assert_patterns: {exc}")

    all_claims = read_claims(config)
    due, skipped = [], 0
    for claim in all_claims:
        header = claim.header
        if only and header.get("id") not in only:
            continue
        if args.file and claim.path.name != args.file:
            continue
        if args.type and header.get("type") != args.type:
            continue
        if not only and BUDGET_LEVELS.get(header.get("budget", "free"), 0) > level:
            skipped += 1
            continue
        due.append(claim)

    if not args.json:
        print(f"Claims total {len(all_claims)}, checked {len(due)}, "
              f"skipped for budget {skipped} (level {args.budget})\n")

    env = environment(config)
    secrets = secret_values(env)
    results = []
    for i, claim in enumerate(due, 1):
        if not args.json:
            print(f"[{i}/{len(due)}] {claim.id} ...", flush=True)
        results.append(check(claim, config, env, secrets, assert_extra,
                             timeout, args.output_chars))

    by_verdict: dict[str, list[dict]] = {}
    for r in results:
        by_verdict.setdefault(r["verdict"], []).append(r)

    refuted = by_verdict.get("refuted", [])
    confirmed = by_verdict.get("confirmed", [])
    written = write_as_of(confirmed) if (args.write and confirmed) else 0

    if args.json:
        print(json.dumps({
            "budget": args.budget,
            "checked": len(due),
            "skipped": skipped,
            "summary": {k: len(v) for k, v in by_verdict.items()},
            "as_of_written": written,
            "results": results,
        }, ensure_ascii=False, indent=1))
    else:
        print("\n" + "=" * 70)
        for verdict in VERDICT_ORDER:
            items = by_verdict.get(verdict, [])
            if not items:
                continue
            print(f"\n{verdict.upper()} ({len(items)}):")
            for r in items:
                print(f"  {r['file']}:{r['line']}  {r['id']}")
                print(f"      {r['reason']}")
        print("\n" + "=" * 70)
        print(f"Summary: { {k: len(v) for k, v in by_verdict.items()} }")
        if written:
            print(f"as_of advanced for {written} claims.")
        if by_verdict.get("executed"):
            print(f"\nNOTE: {len(by_verdict['executed'])} fetch commands ran clean "
                  "but say nothing about whether the claim text is right. "
                  "Those need the semantic cross-check "
                  "(--json prints command output and claim text side by side).")

    return 1 if refuted else 0
