---
name: setup
description: Set up Offerstar for a job seeker - their role, contact details, screening facts, and an evidence profile built from their CV, GitHub and npm, confirming every block with them. Use when someone starts with Offerstar or wants to add to their profile.
---

# Offerstar setup

You are building the user's evidence profile: the single source of truth every resume is made from. One rule governs everything: **no evidence, no claim.** You may reword; you may never add a skill, number, employer, title or date the user has not confirmed.

The `offerstar` CLI does every mechanical step. Run it with Bash. Add `--json` when you need to read the result.

## 1. Check the install

Run `offerstar doctor --json`. If the home folder check fails, run `offerstar init`. If the CLI itself is missing, stop and tell the user to install Offerstar first.

## 2. Role and contact details

Ask, in one message: the role they are targeting, the cities they would work in (or Remote), their name as it should appear on a resume, email, phone, city, and profile links (GitHub, LinkedIn, portfolio). Then save them:

```
offerstar init --role "<role>" --name "<name>" --email "<email>" --phone "<phone>" --location "<city>" --link <url> --link <url>
offerstar config set locations '["Bengaluru", "Remote"]'
```

## 3. Screening facts

Ask for years of experience, notice period in days, current CTC and expected CTC (lakh per annum), and any deal-breakers (for example "night shift", "bond"). Save only what they give you; leave the rest unset rather than guessing:

```
offerstar config set experienceYears 3
offerstar config set noticePeriodDays 30
offerstar config set currentCtcLpa 12
offerstar config set expectedCtcLpa 18
offerstar config set dealBreakers '["night shift"]'
```

## 4. Evidence from public sources

Ask for their GitHub and npm usernames, then preview:

```
offerstar import github <user> --dry-run --json
offerstar import npm <user> --dry-run --json
```

Show the list and ask which projects they would actually put on a resume (old tutorials and course exercises usually not). Import, then remove the ones they rejected:

```
offerstar import github <user>
offerstar profile remove gh-<repo>
```

## 5. Evidence from their CV

If they have a CV, run `offerstar import cv "<path>" --json` and read the text. For each job, education entry, certification and notable project in it, draft one evidence block, show it, and save it only after they confirm or correct it.

A block looks like this (YAML):

```yaml
id: exp-acme              # lowercase words joined by hyphens, unique
type: experience          # experience | project | skill | achievement | certification | education
title: Software Engineer
organization: Acme Payments
start: 2023-04            # YYYY-MM
end: present              # YYYY-MM or present
location: Bengaluru
highlights:               # resume bullets; only facts the user confirms
  - Built the refunds API in Node.js and PostgreSQL
skills: [node.js, postgresql]
evidence:                 # links that back the claims, if any
  - kind: repo            # repo | package | app | certificate | link | document
    url: https://github.com/...
verified: self            # self (user's word) | linked (has evidence links) | issuer-signed
metrics: []               # only numbers the user explicitly confirmed
updated: 2026-11-01
```

Write each confirmed block to a temporary file and save it with `offerstar profile add <file>` (add `--replace` to update one). Ask the user directly for numbers ("roughly how many merchants used it?"); if they are unsure, leave the number out. Every fact the user confirms during this conversation must be saved now, or later grounding audits will strip it as unsupported.

## 6. Check the result

```
offerstar doctor
offerstar resume build
offerstar check "<path printed by resume build>"
```

Show what `check` reports and fix anything it fails. Finish by telling them the next step is `/offerstar:plan`.
