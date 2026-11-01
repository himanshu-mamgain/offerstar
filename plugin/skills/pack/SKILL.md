---
name: pack
description: Write portal profile text from the user's evidence - Naukri headline, key skills and summary variants for scheduled refreshes, LinkedIn headline and About, or a Workday field sheet. Use when the user wants to update a job portal profile.
argument-hint: naukri | linkedin | workday
---

# Offerstar pack

You write profile text for a job portal from the user's evidence blocks, in the words recruiters search for. The same rule as every resume applies: **no evidence, no claim.** Every line cites the blocks it comes from, and every number must appear in them.

```
offerstar pack <portal> > "<temp dir>/pack.json"
```

Read it: the role, locations, contact details and evidence blocks.

## Naukri: variants for refreshes

Naukri recruiters find candidates by keyword search, and a recently updated profile ranks higher. Offerstar keeps the profile fresh by rotating 2 or 3 truthful variants every few days, so write variants that say the same true things with different emphasis (for example one leading with the backend work, one with the payments domain). Do not write one per job: a single profile serves every recruiter's search.

Write them as JSON and save them:

```json
{
  "variants": [
    {
      "name": "backend",
      "headline": { "text": "Backend engineer: Node.js, PostgreSQL, payment APIs", "cites": ["exp-acme"] },
      "summary": { "text": "...", "cites": ["exp-acme", "proj-taskboard"] },
      "keySkills": ["Node.js", "PostgreSQL", "REST APIs"]
    }
  ],
  "resume": "<optional: a resume PDF from offerstar resume build, uploaded unchanged with each refresh>"
}
```

```
offerstar naukri variants set "<temp dir>/variants.json"
```

If it lists problems, fix them. Then show the user the variants and tell them to approve them in their own terminal; scheduled refreshes use only approved variants, and any later edit needs approval again:

```
offerstar naukri variants approve
```

Key skills are not uploaded automatically; show them so the user can paste them into Naukri's key skills section.

## LinkedIn

Write a headline, an About section (three short paragraphs: what they do, the strongest evidence, what they are looking for), up to ten top skills, and experience bullets per role. Show them for the user to paste; Offerstar never logs in to LinkedIn.

## Workday

Workday pre-fills its forms from the uploaded resume and often gets fields wrong. Write a field-by-field sheet (each role's title, company, dates and description; education; skills) so the user can correct the pre-fill quickly, plus answers to common knockout questions taken only from config.yaml (notice period, CTC, relocation). Leave anything config.yaml does not cover for the user to answer.
