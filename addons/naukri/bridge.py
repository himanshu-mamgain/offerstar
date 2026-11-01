"""Offerstar's bridge to NopeRi, the unofficial Naukri client.

NopeRi has no licence, so it is never copied into Offerstar: `offerstar setup
naukri` downloads it next to this file on the user's own machine. This bridge
imports it from there and runs one command per call:

    python bridge.py <command> < payload.json

Credentials come from NAUKRI_USERNAME and NAUKRI_PASSWORD in the environment.
The result is one JSON object on stdout; logs go to stderr.
"""
import json
import logging
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "NopeRi"))
logging.basicConfig(stream=sys.stderr, level=logging.WARNING)


def client():
    from src.client.naukri_client import NaukriLoginClient

    user, password = os.environ.get("NAUKRI_USERNAME"), os.environ.get("NAUKRI_PASSWORD")
    if not user or not password:
        raise RuntimeError("NAUKRI_USERNAME and NAUKRI_PASSWORD are not set; run offerstar naukri login")
    c = NaukriLoginClient(user, password)
    # NopeRi prints the raw response on a failed login; keep stdout for our JSON.
    stdout, sys.stdout = sys.stdout, sys.stderr
    try:
        c.login()
    finally:
        sys.stdout = stdout
    return c


def job_dict(job):
    return {
        "jobId": job.job_id,
        "title": job.title,
        "company": job.company,
        "location": job.location,
        "experience": job.experience,
        "salary": job.salary,
        "posted": job.posted_date,
        "url": job.apply_link,
        "description": job.description,
        "tags": job.tags,
    }


def cmd_check(_payload):
    c = client()
    return {"ok": True, "profileId": c.fetch_profile_id()}


def cmd_search(payload):
    from src.client.job_client import NaukriJobClient

    jc = NaukriJobClient(client())
    seen, jobs = set(), []
    for q in payload.get("searches", []):
        for page in range(1, int(q.get("pages", 1)) + 1):
            batch = jc.search_jobs(
                keyword=q["keyword"],
                location=q.get("location", ""),
                page=page,
                experience=int(q.get("experience", 2)),
                job_age=int(q.get("jobAge", 7)),
            ) or []
            for job in batch:
                if job.job_id not in seen:
                    seen.add(job.job_id)
                    jobs.append(job_dict(job))
    return {"jobs": jobs}


def cmd_refresh(payload):
    c = client()
    result = {}
    fields = {k: payload[k] for k in ("headline", "summary") if payload.get(k)}
    if fields:
        r = c.update_profile(**fields)
        result["profile"] = r.status_code
    if payload.get("resume"):
        r = c.update_resume(payload["resume"])
        result["resume"] = r.status_code
    return result


def cmd_history(payload):
    c = client()
    raw = c.get_application_history(page_size=int(payload.get("pageSize", 50)), days=int(payload.get("days", 90)))
    return {
        "applications": [
            {
                "jobId": str(h.job_id),
                "title": h.job_title,
                "company": h.company,
                "location": h.location,
                "isOpen": h.is_open,
                "statuses": [{"value": s.status_value, "at": s.date_time} for s in h.statuses],
            }
            for h in c.parse_history(raw)
        ]
    }


COMMANDS = {"check": cmd_check, "search": cmd_search, "refresh": cmd_refresh, "history": cmd_history}


def main():
    name = sys.argv[1] if len(sys.argv) > 1 else ""
    if name not in COMMANDS:
        print(json.dumps({"error": f"unknown command {name!r}"}))
        return 2
    try:
        # utf-8-sig: tolerate a byte-order mark, which some Windows shells add.
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8-sig") or "{}")
        print(json.dumps(COMMANDS[name](payload)))
        return 0
    except Exception as err:  # reported to the CLI as JSON, never a traceback on stdout
        print(json.dumps({"error": f"{type(err).__name__}: {err}"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
