# ReviewRoom

**AI agents and humans review pull requests together in team chat, and nothing merges unless the checks pass.**

Built for the *Flip the Switch* hackathon (WeMakeDevs x DevTools Academy x Switch) · Track 01: Best Business Workflow

- Demo video: `[ADD LINK]`

- Author: `Kumar Kartikay & Khushboo Prajapati`

## The problem

Teams already use AI agents for code review, but each agent lives in one person's terminal. Findings get pasted into chat by hand, nobody knows what was actually checked, and "the AI said it's fine" is not an audit trail. The risky moment, the merge, is still a manual and unrecorded decision.

## What ReviewRoom does

A Switch room (a channel in Telegram, Slack, Teams, Discord or Mattermost) with four agents and your humans:

| Agent | What it does |
|---|---|
| **triager** | Summarises the PR, rates risk, hands off to the others |
| **security** | Runs the scanner, reads the diff for what a scanner misses, records findings with file and line, applies a fix only when a human says so |
| **tests** | Runs the suite on the branch in a clean worktree, writes missing tests |
| **gatekeeper** | Records human approval and merges only when every check passes |

The agents call a small deterministic toolkit (`reviewroom`, in this repo). The rules are enforced by code, not only by prompts:

| Merge gate check | Why |
|---|---|
| Scan ran on the **current** head commit | New commits invalidate old reviews |
| No open HIGH findings (unless a human waived with a reason) | Serious issues block |
| Tests passed on the **current** head | No stale green runs |
| A **human** approved the **current** head | Agents cannot approve; the tool rejects agent-looking names |

Every merge, block and waiver is written to a decision log.

## Why this needs Switch

Without Switch these are four disconnected terminal sessions and a human copy-pasting between them. With Switch, every agent appears in the channel under its own name, reads the same shared room history, and the team sees who found what and who approved. The human approval happens in the same place the review happens.

## Features

- PR summary with risk rating (sensitive paths, size, scan results)
- 15 security rules on added lines: NoSQL and SQL injection, command injection, eval, hard-coded secrets, committed `.env`, disabled TLS, weak hashes and randomness, XSS sinks, regex from user input, sensitive logging, CORS wildcard, unpinned dependencies
- "Source changed without tests" check
- Manual findings from the agent's own code reading (`finding add`), counted by the gate
- Test runs in an isolated git worktree, with optional setup command (`npm ci`)
- Approval is bound to a commit: a new push voids it
- Human-only approvals and waivers (waivers require a reason and are logged)
- Merge only through the gate (`--no-ff`, clean-tree and base-branch checks)
- Decision log and per-branch markdown report
- Zero dependencies, Node 18+, works on any git repo, any language (set `testCommand`)
- Published as an npm package with the room template and demo built in
- 7 automated tests including a full end-to-end block, fix, re-review, merge flow

## Install

```bash
npm install -g reviewroom
reviewroom help
```

Requires Node 18+ and git. The tool runs on **one review machine** (a team member's laptop or a small server) next to a clone of your repo. Team members do not install anything; they talk to the agents in the chat channel.

New to this? Read **GETTING-STARTED.md** first.

## Quick start with the demo (about 20 minutes)

Prerequisites: Node 18+, git, Switch Console, and an agent CLI signed in (OpenCode has free models; Claude Code and Codex also work). A chat app is needed for the room: Telegram needs only a free bot from @BotFather; the built-in chat needs Docker.

```bash
git clone https://github.com/Kartikay786/Coding-Buddy && cd reviewroom
npm test                          # 7 tests should pass
npm install -g .                  # puts `reviewroom` on your PATH
reviewroom demo ./demo-repo       # builds a demo repo with two PRs
```

Then in Switch Console (https://docs.switchagents.ai/switch-rooms/getting-started):

1. Start a local server, install and sign in to an agent provider, and connect a chat app (for Telegram: create a bot with @BotFather, give the token to switch-buddy, create a Telegram group, add the bot as admin and send a message so Switch sees you).
2. Open `review-agents.template.yaml` and change every `directory:` line to the full path of your `demo-repo` folder (keep `main` checked out). Change `provider:` if you do not use OpenCode.
3. Console, Templates, Import template, choose the file, Save, Use, Create all. This creates the four agents.
4. Add the four agents to your chat room (Your Rooms, open the room, Add agent; or ask switch-buddy). `review-room.template.yaml` also creates the room if your chat app allows Switch to create channels; Telegram does not, which is why the agents-only file exists.
5. In the chat, mention the triager: `@rr-triager review feature/user-search`. It posts the summary and hands off to `@rr-security` and `@rr-tests`. Then say `@rr-gatekeeper approve feature/user-search`.

Switch only wakes an agent when it is mentioned by name, so start every request with the agent's `@name`.

## Use it on your own project

```bash
git clone <your-github-repo> myproject && cd myproject
reviewroom init          # creates .reviewroom.json (kept out of git)
```

Edit `.reviewroom.json`: set `base` (usually `main`), `testSetup` (for example `npm ci`) and `testCommand` (for example `npm test` or `pytest`). Point the agents' working directory at this clone, keep `main` checked out, and run `git fetch` before reviewing so the branches are up to date. Merges happen in this clone, so push `main` afterwards.

The demo repo has two branches:
- `feature/user-search` has a NoSQL injection and one failing test.
- `feature/health-endpoint` is clean and merges.

## Demo script (2.5 minutes)

1. `@rr-triager review feature/user-search` → triager posts summary, risk HIGH; security and tests answer in parallel.
2. Security posts the NoSQL injection at `src/search.js:5`; tests report 1 failing test.
3. You say `approve feature/user-search` too early → gatekeeper replies **BLOCKED** and lists the two failed checks.
4. You say `apply fix` → security commits the patch; scan and tests re-run on the new head.
5. The old approval is now void. Say `approve feature/user-search` again → **MERGED**, decision logged.
6. `review feature/health-endpoint`, then `approve` → clean merge in one pass.

## Chat commands

| You say | What happens |
|---|---|
| `review <branch>` | Summary, scan, tests |
| `apply fix` | Security patches the branch via a worktree and re-checks |
| `waive F1 on <branch> because <reason>` | Records a human waiver (logged) |
| `approve <branch>` | Records approval and tries the gate |
| `status of <branch>` | Dry-run of the gate |

## Toolkit reference

```
reviewroom template [file]            write the Switch room template
reviewroom demo [dir]                 build the demo repo with two PRs
reviewroom init                       create .reviewroom.json in a repo
reviewroom summary <branch>
reviewroom scan <branch>
reviewroom finding add <branch> --sev HIGH --file src/a.js --line 12 --title "..." --fix "..."
reviewroom test <branch>
reviewroom waive <branch> <id> --by <human> --reason "..."
reviewroom approve <branch> --by <human>
reviewroom gate <branch> [--merge]    exit code 1 when blocked
reviewroom decisions
reviewroom report <branch>
```

Use it on your own repo: run `reviewroom init`, then set `base`, `testCommand` and `testSetup` in `.reviewroom.json`. State lives in `.reviewroom/` and is kept out of git automatically.

## Honest limitations

- The room template follows the one Switch template I could see (triage-pair). Field names and `addressing` or `provider` values should be checked against your Switch version.
- The scanner is pattern-based on added lines. It is fast and reproducible, but it is not a full static analyser; the security agent's own reading covers the rest.
- Approver identity is the name the gatekeeper passes from chat. The tool blocks agent-looking names, but it cannot cryptographically verify who typed in chat. For stronger guarantees, restrict who can message the room.
- Any room member can currently approve, including the PR author. Restricting approvals to named leads is a planned next step.
- Merges happen in the review machine's clone, so someone pushes `main` afterwards. Auto-fetch and auto-push are planned.
- A GitHub webhook that opens a room per PR is the natural next step.

## Hackathon mapping

- **Use of Switch:** four agents and humans share one room; approval and merge happen in the channel.
- **Technical execution:** `npm test` reproduces everything; no dependencies.
- **Creativity and impact:** an audit-ready, human-gated agent review loop for real teams.
- **Presentation:** this README plus the demo video.

Optional side tracks: Code with Wispr (dictate your prompts and submit the scorecard), Best Blog, and the #HowISwitch post.

## Repo layout

```
bin/reviewroom.js              the toolkit (CLI)
review-room.template.yaml      Switch agents, room and kickoff
scripts/seed-demo.js           builds the demo repo with two PRs
test/reviewroom.test.js        unit and end-to-end tests (git clone only)
```

License: MIT
