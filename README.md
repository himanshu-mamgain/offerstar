# offerstar
Agentic job search CLI with Claude skills. Evidence-backed resume, job discovery from career pages and portals, fit ranking, tailored ATS-checked resumes and application tracking. You approve every application.

> Early development: the evidence profile, resume building and job discovery work; applying comes next.

## Development

Needs Node 22.18 or newer, which runs the TypeScript sources directly.

```sh
npm install
npm run offerstar -- init --role "Backend engineer" --name "Your Name" --email you@example.com --phone "+91 ..."
npm run offerstar -- import github <user>   # one project block per public repo you own
npm run offerstar -- import npm <user>      # one project block per npm package you maintain
npm run offerstar -- resume build           # renders a PDF from your evidence blocks
npm run offerstar -- check <pdf>            # round-trip parse test, as an ATS would read it
npm run offerstar -- companies add <name or careers URL>   # finds its Greenhouse, Lever or Ashby board
npm run offerstar -- scan                   # fetches, cleans and dedupes jobs from every tracked company
npm run offerstar -- paste --title "..." --company "..." < posting.txt   # a posting copied from anywhere
npm run offerstar -- plan                   # scores open jobs against your profile; prints the shortlist
npm run offerstar -- jobs show <id>         # one cleaned posting with its skills and guard flags
npm run offerstar -- doctor                 # checks the install and the Offerstar folder
npm run typecheck
npm test
```

Evidence blocks are YAML files in `~/.offerstar/profile/`; importers never overwrite a block you have edited. The first resume build downloads Typst into `~/.offerstar/bin` and verifies its checksum, unless `typst` is already on your PATH.

Set `OFFERSTAR_HOME` to use a folder other than `~/.offerstar`, for example while testing.

All personal data stays in that folder on your machine. The repo holds only the tool and tests that use a fictional profile.
