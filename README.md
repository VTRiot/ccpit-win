# ccpit

An Electron application with React and TypeScript

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ npm install
```

### Development

```bash
$ npm run dev
```

### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```

## Debug Toolkit Skill (FMA Catalog)

This repository includes a Claude Code skill (`debug-toolkit`) that provides a symptom-indexed catalog of known failure modes (FM) for the application's feature set, written in Failure Mode Analysis (FMA) form.

The skill is shipped under `golden/common/`:

- Japanese (canonical): `golden/common/ja/skills/debug-toolkit/SKILL.md`
- English: `golden/common/en/skills/debug-toolkit/SKILL.md`

When you debug this codebase with Claude Code, the skill activates automatically on bug / defect / unexpected-behavior observations. It offers:

- A look-up menu of known failure modes by symptom
- Cause candidates, verification steps, files to modify, and prescriptive caveats per FM
- Guidance against heuristic over-fit (do not force-fit unfamiliar symptoms to existing FMs)
- A self-extension rule: when you discover a new generalizable technique while debugging, propose adding it to the skill in your completion report

The skill is intentionally framed as a **growing toolbox**, open to all CC users. Contributions (proposals via the self-extension rule) extend the catalog over time. For the full mindset, see the "Minor-Marque Mechanic Mindset" preface in the skill body.
