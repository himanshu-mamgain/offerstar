# offerstar
Agentic job search CLI with Claude skills. Evidence-backed resume, job discovery from career pages and portals, fit ranking, tailored ATS-checked resumes and application tracking. You approve every application.

> Early development. Only `init` and `doctor` work so far.

## Development

Needs Node 22.18 or newer, which runs the TypeScript sources directly.

```sh
npm install
npm run offerstar -- init     # creates ~/.offerstar with a default config and database
npm run offerstar -- doctor   # checks the install and the Offerstar folder
npm run typecheck
npm test
```

Set `OFFERSTAR_HOME` to use a folder other than `~/.offerstar`, for example while testing.

All personal data stays in that folder on your machine. The repo holds only the tool and tests that use a fictional profile.
