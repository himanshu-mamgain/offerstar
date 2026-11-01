---
name: retro
description: Weekly look back at the user's job search - what got calls, what to change in ranking, search and resume angle, and the interview prep list - written to learnings.md and proposed for their approval. Use weekly (scheduled on Sundays) or when the user asks what is working.
---

# Offerstar retro

You read the user's results and help them decide what to change. Offerstar computes the numbers; you explain them honestly and propose. **Nothing changes without the user's approval, and nothing here ever changes the facts in their profile.** Learning changes targeting and emphasis only.

## 1. Bring the records up to date

```
offerstar track
offerstar status --json
```

If `status` lists applications waiting on news, ask the user what happened with each (a call? rejected? nothing?) and record it, because unrecorded outcomes make every number wrong:

```
offerstar outcome <jobId> call
offerstar outcome <jobId> rejected
offerstar outcome <jobId> interview --round "technical 1" --question "..." --rating 3
```

If they use the Naukri add-on, ask whether recruiters called or messaged through Naukri this week and record each with `offerstar naukri signal call|view|message`.

## 2. Compute

```
offerstar learn propose --json
offerstar insights --json
offerstar learn progress --json
offerstar prep --json
offerstar naukri insights --json      # only if the Naukri add-on is enabled
```

## 3. Explain, honestly

Tell the user in a few short paragraphs:

- **The funnel:** sent, calls, interviews, offers, and how this week compares.
- **What the numbers can and cannot say.** Every rate comes with a likely range; groups under 10 applications are too small to act on, so say so instead of drawing conclusions. Hiring seasons, referrals and luck all skew small samples.
- **Each proposal** from `learn propose`, with its evidence in plain words ("you got calls from 6 of 12 jobs you applied to within 3 days of posting, against 15% overall").
- **The gate:** whether the call rate since the first 30 applications is better than the first 30.
- **Naukri variants,** if any: calls and views per week each profile variant was live. A few weeks per variant are needed before a difference means anything.

Then suggest, without adopting anything:
- Companies or searches to add that resemble the ones that call back (they add them with `offerstar companies add`).
- If no resume-angle test is running and there are two truthful ways to present their evidence (for example "backend" and "payments"), a test: `offerstar learn angles backend payments`. Only angles their evidence supports.

## 4. Interview prep

From `offerstar prep`: the questions asked more than once and the rounds they rated 2 or lower. Offer to work through two or three of them now.

## 5. Write learnings.md

`learn propose` keeps the numbers section of `~/.offerstar/learnings.md` current. Below it, append a dated section with this week's observations in plain sentences, what the user decided, and the prep focus. Never edit the numbers section yourself, and never delete earlier weeks.

## 6. Hand over

Tell the user to review and adopt the proposals they agree with, in their own terminal:

```
offerstar learn approve
```

It asks about each proposal separately. Adopted ranking changes show up in `offerstar plan` as "learned:" lines with their evidence.
